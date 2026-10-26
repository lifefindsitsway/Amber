import { monotonicFactory } from "ulid";
import { AmberError, amberError, appError, isAmberError } from "../domain/errors.ts";
import type { LlmCallAttribution, LlmCompletion, LlmRequest, LlmStopReason, LlmStreamEvent, RawUsage } from "../domain/llm.ts";
import type { ModelRef, ModelRefSnapshot } from "../domain/model-ref.ts";
import { effectiveCapability, type CapabilityFlags, type ModelCapability, type ProviderProfile } from "../domain/provider-profile.ts";
import type { TokenUsage, UsageOutcome } from "../domain/usage.ts";
import { isDeferredLlmRequest, LlmCallDeferred, type LlmInvoker, type LlmModelDescription, type LlmRequestInput } from "../pipeline/executor.ts";
import { backoffMs, mayRetry, sleep, toAppError } from "../pipeline/retry.ts";
import { FairSemaphore, taskGroup, type FairGroupRef, type SlotOrder } from "../pipeline/fair-semaphore.ts";
import type { Logger } from "../ports/logger.ts";
import type { LlmProbeFlag, LlmProvider } from "../ports/llm-provider.ts";
import { OutboundHttpError } from "../ports/outbound-http.ts";
import type { Repository } from "../ports/repository.ts";
import type { SecretStore } from "../ports/secret-store.ts";
import { LlmLanes, type LaneEffect, type LaneFeedback, type LaneTicket, type LlmLane } from "./llm-lanes.ts";

export interface LlmGatewayOptions {
  repository: Repository;
  secrets: Pick<SecretStore, "status">;
  /** One adapter per wire protocol. */
  providers: readonly LlmProvider[];
  /** Lane changes and upstream error classes; never names, URLs, keys or upstream text. */
  logger?: Logger;
  newId?: () => string;
  now?: () => number;
  /** Uniform in [0, 1); spreads locally computed cooldowns. */
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Why waiting calls of a lane were turned away: it started cooling down until `until`. */
class LaneCooling extends Error {
  readonly until: number;

  constructor(until: number) {
    super("model lane started cooling down");
    this.until = until;
  }
}

/** A foreground call rejected before sending because its lane was already cooling. */
class ForegroundLaneCooling extends AmberError {}

/** A call admitted by its lane: the slot to give back and what its lane must be told. */
interface Admitted {
  modelRef: ModelRef;
  lane: LlmLane;
  ticket: LaneTicket;
  release: () => void;
  settled: boolean;
}

/** A call's event stream; `invocationId` names the current attempt's TokenUsage row once the adapter was called. */
export interface LlmStream extends AsyncIterable<LlmStreamEvent> {
  readonly invocationId: string | undefined;
}

/** What "test connection" measured; the caller writes it back as the model's `observed` flags. */
export interface LlmProbeOutcome {
  observed: Pick<CapabilityFlags, LlmProbeFlag>;
  latencyMs: number;
}

export interface LlmCallOptions {
  signal: AbortSignal;
  /**
   * The Task's slot order, which also names its fair group: every call of one Task shares
   * a group. Without it the call belongs to its user's foreground group.
   */
  task?: SlotOrder;
  /** Runs once per attempt when the call was admitted and its request built, before the adapter is called. */
  onCallStart?: () => void;
}

interface Resolved {
  profile: ProviderProfile;
  capability: ModelCapability;
  provider: LlmProvider;
  snapshot: ModelRefSnapshot;
}

const PROBE_FLAGS: readonly LlmProbeFlag[] = ["stream", "structuredOutput", "tools"];

/**
 * The only way to an LLM: resolves the ModelRef for its owner, checks the
 * credential and the capabilities the request needs, picks the adapter by protocol, admits
 * the call through its model lane in the fair order of Tasks and each user's foreground
 * calls, and records one TokenUsage row per upstream request that crossed
 * the send boundary, in its own transaction, the moment it ends. There is
 * no fixed limit on calls in flight: each lane adapts to its upstream's answers.
 *
 * Calls made inside the pipeline are never retried here (the WorkUnit retries them, at the
 * time its lane names); a Task's call that a cooling lane turns away throws
 * `LlmCallDeferred` unsent. Other calls (chat, test connection) fail at once on a cooling
 * lane and retry `safe` / `policy` failures by the pipeline's policy.
 */
export class LlmGateway implements LlmInvoker {
  private readonly options: LlmGatewayOptions;
  private readonly semaphore = new FairSemaphore(() => Number.POSITIVE_INFINITY);
  private readonly lanes: LlmLanes;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: LlmGatewayOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.lanes = new LlmLanes(this.now, options.random ?? Math.random);
  }

  /**
   * A profile's endpoint, key or model list changed, or it was deleted: its lanes start
   * over, since what they learned was about the old upstream.
   */
  profileChanged(providerProfileId: string, modelIds?: readonly string[]): void {
    this.lanes.reset(providerProfileId, modelIds);
  }

  /**
   * Streams one call. Outside the pipeline a failed attempt is retried only while none of
   * its events reached the consumer; each attempt records its own usage row.
   */
  stream(call: LlmCallAttribution, request: LlmRequest, options: LlmCallOptions): LlmStream {
    const gateway = this;
    const state: { invocationId: string | undefined } = { invocationId: undefined };
    const events = async function* (): AsyncGenerator<LlmStreamEvent> {
      const resolved = gateway.resolveForRequest(call.userId, request);
      for (let retry = 1; ; retry += 1) {
        let delivered = false;
        try {
          for await (const event of gateway.attempt(resolved, call, request, options, state)) {
            delivered = true;
            yield event;
          }
          return;
        } catch (error) {
          if (delivered || !gateway.mayRetry(call, error, retry, options.signal)) {
            throw error;
          }
          await gateway.sleep(backoffMs(retry), options.signal);
        }
      }
    };
    return {
      get invocationId() {
        return state.invocationId;
      },
      [Symbol.asyncIterator]: () => events(),
    };
  }

  /**
   * One call collected into text. An error the upstream reported inside its stream is
   * thrown as `llm_failed`, a safety refusal as `llm_failed.refused` (never retried), once
   * the usage row is written; text streamed before a refusal is incomplete and dropped.
   */
  async complete(call: LlmCallAttribution, request: LlmRequestInput, options: LlmCallOptions): Promise<LlmCompletion> {
    // A request built later is checked once it exists; a ready one before anything waits.
    const resolved = isDeferredLlmRequest(request) ? this.resolve(call.userId, request.modelRef) : this.resolveForRequest(call.userId, request);
    for (let retry = 1; ; retry += 1) {
      const state: { invocationId: string | undefined } = { invocationId: undefined };
      try {
        let text = "";
        let usage: RawUsage | undefined;
        let stopReason: LlmStopReason | undefined;
        let raw: string | undefined;
        for await (const event of this.attempt(resolved, call, request, options, state)) {
          if (event.type === "text_delta") {
            text += event.delta;
          } else if (event.type === "usage") {
            usage = event.usage;
          } else {
            stopReason = event.stopReason;
            raw = event.raw;
          }
        }
        if (stopReason === "error") {
          throw amberError("llm_failed", "upstream reported an error inside the stream", raw === undefined ? {} : { upstreamMessage: raw });
        }
        if (stopReason === "refused") {
          throw amberError("llm_failed", "the model refused the request", { code: "llm_failed.refused", ...(raw === undefined ? {} : { upstreamMessage: raw }) });
        }
        return {
          invocationId: state.invocationId as string,
          text,
          stopReason: stopReason as LlmStopReason,
          ...(usage === undefined ? {} : { usage }),
        };
      } catch (error) {
        if (!this.mayRetry(call, error, retry, options.signal)) {
          throw error;
        }
        await this.sleep(backoffMs(retry), options.signal);
      }
    }
  }

  /**
   * What a caller may plan a request with: the effective capability, the audio formats the
   * profile's protocol can encode and the provenance snapshot. Nothing is sent or recorded;
   * it fails exactly like a call would before sending.
   */
  describe(userId: string, modelRef: ModelRef): LlmModelDescription {
    const resolved = this.resolve(userId, modelRef);
    return {
      capability: effectiveCapability(resolved.capability),
      audioMimeTypes: resolved.provider.audioMimeTypes,
      snapshot: resolved.snapshot,
    };
  }

  /**
   * "Test connection": runs the adapter's checks one by one, each in its own
   * slot and retried on its own, so a failing check never re-sends a completed one. Every
   * request that crossed the send boundary is recorded as `test_connection` usage at once,
   * and those rows stay even when a later check finally fails and the probe throws.
   */
  async probe(userId: string, modelRef: ModelRef, signal: AbortSignal): Promise<LlmProbeOutcome> {
    const resolved = this.resolve(userId, modelRef);
    const checks = resolved.provider.probe(resolved.profile, modelRef.modelId);
    const observed: Partial<Pick<CapabilityFlags, LlmProbeFlag>> = {};
    let latencyMs: number | undefined;
    const attribution: LlmCallAttribution = { userId, feature: "test_connection" };
    for (const check of checks) {
      for (let retry = 1; ; retry += 1) {
        try {
          const admitted = await this.admit(modelRef, this.foreground(userId), signal, undefined);
          let feedback: LaneFeedback = { kind: "none" };
          let outcome: Awaited<ReturnType<typeof check.run>>;
          try {
            outcome = await check.run({
              signal,
              onCall: (probeCall) => this.record(this.newId(), resolved, attribution, probeCall.outcome, probeCall.usage),
            });
            feedback = { kind: "success" };
          } catch (error) {
            feedback = laneFeedback(error);
            this.logClassified(error);
            throw this.withCooldown(error, admitted.lane, this.settle(admitted, feedback));
          } finally {
            this.settle(admitted, feedback);
          }
          observed[check.flag] = outcome.result;
          if (check.flag === "stream" || latencyMs === undefined) {
            latencyMs = outcome.latencyMs;
          }
          break;
        } catch (error) {
          if (signal.aborted || error instanceof ForegroundLaneCooling || !mayRetry(toAppError(error), retry)) {
            throw error;
          }
          await this.sleep(backoffMs(retry), signal);
        }
      }
    }
    const missing = PROBE_FLAGS.filter((flag) => observed[flag] === undefined);
    if (missing.length > 0 || latencyMs === undefined) {
      throw new AmberError(appError("internal"), `probe did not check ${missing.join(", ")}`);
    }
    return { observed: observed as Pick<CapabilityFlags, LlmProbeFlag>, latencyMs };
  }

  /**
   * One adapter call, admitted by its lane. Its usage row is written when it ends: before
   * `done` is handed on, when it fails after the send boundary, or when the consumer stops
   * early. A deferred request is built only once admitted, then checked like any other.
   */
  private async *attempt(
    resolved: Resolved,
    call: LlmCallAttribution,
    input: LlmRequestInput,
    options: LlmCallOptions,
    state: { invocationId: string | undefined },
  ): AsyncGenerator<LlmStreamEvent> {
    const { signal } = options;
    const id = this.newId();
    const group: FairGroupRef = options.task === undefined ? this.foreground(call.userId) : taskGroup(options.task);
    const admitted = await this.admit(input.modelRef, group, signal, options.task);
    let feedback: LaneFeedback = { kind: "none" };
    let request: LlmRequest;
    try {
      request = isDeferredLlmRequest(input) ? await input.prepare(signal) : input;
      if (isDeferredLlmRequest(input)) {
        this.checkCapabilities(resolved, request);
      }
      options.onCallStart?.();
    } catch (error) {
      // Nothing was sent, so no usage row and nothing for the lane to learn.
      this.settle(admitted, feedback);
      throw error;
    }
    let recorded = false;
    let usage: RawUsage | undefined;
    const record = (outcome: UsageOutcome | undefined): void => {
      if (!recorded) {
        recorded = true;
        if (outcome !== undefined) {
          this.record(id, resolved, call, outcome, usage);
        }
      }
    };
    try {
      state.invocationId = id;
      const events = resolved.provider.stream(request, { signal, effectiveCapability: resolved.capability, profile: resolved.profile });
      for await (const event of events) {
        if (recorded) {
          break;
        }
        if (event.type === "usage") {
          usage = event.usage;
        } else if (event.type === "done") {
          record(event.stopReason === "error" || event.stopReason === "refused" ? "failed" : event.stopReason === "aborted" ? "outcome_unknown" : "succeeded");
          if (event.stopReason !== "error" && event.stopReason !== "aborted") {
            feedback = { kind: "success" };
          }
        }
        yield event;
      }
      if (!recorded) {
        record("outcome_unknown");
        throw amberError("llm_outcome_unknown", "stream ended without done");
      }
    } catch (error) {
      record(failedOutcome(error, signal));
      feedback = laneFeedback(error);
      this.logClassified(error);
      throw this.withCooldown(error, admitted.lane, this.settle(admitted, feedback));
    } finally {
      // The consumer stopped before `done`: the request was sent and may be billed.
      record("outcome_unknown");
      this.settle(admitted, feedback);
    }
  }

  /**
   * Waits until the call's lane admits it, in its fair group. A cooling lane turns the call
   * away unsent: a Task's call as `LlmCallDeferred` until the lane's cooldown ends, a
   * foreground call as a rate limit carrying the remaining wait.
   */
  private async admit(modelRef: ModelRef, group: FairGroupRef, signal: AbortSignal, task: SlotOrder | undefined): Promise<Admitted> {
    const lane = this.lanes.get(modelRef);
    const cooling = lane.coolingUntil();
    if (cooling !== undefined) {
      throw this.turnedAway(cooling, task);
    }
    lane.waiting += 1;
    try {
      const { release, ticket } = await this.semaphore.acquireAdmitted(group, signal, lane);
      return { modelRef, lane, ticket, release, settled: false };
    } catch (error) {
      throw error instanceof LaneCooling ? this.turnedAway(error.until, task) : error;
    } finally {
      lane.waiting -= 1;
    }
  }

  /**
   * Ends an admitted call once (later calls are no-ops): tells its lane what the upstream
   * answered, turns away the lane's waiters when that started a cooldown, then frees the
   * slot so the next waiter is admitted against the lane's new state.
   */
  private settle(admitted: Admitted, feedback: LaneFeedback): LaneEffect | undefined {
    if (admitted.settled) {
      return undefined;
    }
    admitted.settled = true;
    const { lane } = admitted;
    const effect = lane.finish(admitted.ticket, feedback);
    if (effect.cooling) {
      this.semaphore.reject(lane, new LaneCooling(lane.cooldownUntil));
    }
    this.logLane(admitted.modelRef, lane, effect);
    admitted.release();
    return effect;
  }

  /**
   * A rate limit or overload carries how long its lane now waits, which may exceed the
   * upstream's own `retry-after` when the lane already cools down for longer; the WorkUnit
   * waits exactly that long before its next send.
   */
  private withCooldown(error: unknown, lane: LlmLane, effect: LaneEffect | undefined): unknown {
    if (effect?.cooling !== true || !isAmberError(error)) {
      return error;
    }
    const failure = error.appError;
    const options = {
      details: { retryAfterMs: Math.max(0, lane.cooldownUntil - this.now()) },
      ...(failure.upstreamMessage === undefined ? {} : { upstreamMessage: failure.upstreamMessage }),
    };
    if (failure.class === "llm_rate_limited") {
      return new AmberError(appError("llm_rate_limited", { code: "llm_rate_limited.retry_after", ...options }), error.message, { cause: error });
    }
    if (failure.code === "llm_failed.overloaded") {
      return new AmberError(appError("llm_failed", { code: "llm_failed.overloaded", ...options }), error.message, { cause: error });
    }
    return error;
  }

  private turnedAway(until: number, task: SlotOrder | undefined): Error {
    if (task !== undefined) {
      return new LlmCallDeferred(until);
    }
    return new ForegroundLaneCooling(
      appError("llm_rate_limited", {
        code: "llm_rate_limited.retry_after",
        details: { retryAfterMs: Math.max(0, until - this.now()) },
      }),
      "model lane is cooling down",
    );
  }

  /**
   * How an upstream error answer was classified. The adapter puts only the
   * status, codes and an evidence tag in its internal message, never upstream text.
   */
  private logClassified(error: unknown): void {
    if (!isAmberError(error)) {
      return;
    }
    const status = /HTTP (\d{3})/.exec(error.message)?.[1];
    if (status === undefined) {
      return;
    }
    const evidence = /evidence=([a-z_]+)/.exec(error.message)?.[1] ?? "status_rules";
    this.options.logger?.info("llm_error_classified", { status: Number(status), code: error.appError.code, evidence });
  }

  private logLane(modelRef: ModelRef, lane: LlmLane, effect: LaneEffect): void {
    const logger = this.options.logger;
    if (logger === undefined) {
      return;
    }
    if (effect.windowChange === "limited") {
      logger.info("llm_lane_window", { ...modelRef, window: lane.window, reason: "rate_limited", limitRounds: lane.limitRounds });
    } else if (effect.windowChange === "grown") {
      logger.debug("llm_lane_window", { ...modelRef, window: lane.window, reason: "grown" });
    }
    if (effect.cooldownSource !== undefined) {
      logger.info("llm_lane_cooldown", { ...modelRef, untilMs: lane.cooldownUntil, source: effect.cooldownSource, limitRounds: lane.limitRounds });
    }
  }

  /**
   * One group for all of a user's calls outside Tasks (chat, test connection), so repeated
   * chats or retries compete as one party instead of each as a new one.
   */
  private foreground(userId: string): FairGroupRef {
    return { key: `foreground:${userId}`, createdAt: this.now() };
  }

  private mayRetry(call: LlmCallAttribution, error: unknown, retry: number, signal: AbortSignal): boolean {
    const outsidePipeline = call.taskId === undefined && call.workUnitId === undefined;
    return outsidePipeline && !signal.aborted && !(error instanceof ForegroundLaneCooling) && mayRetry(toAppError(error), retry);
  }

  private record(id: string, resolved: Resolved, call: LlmCallAttribution, outcome: UsageOutcome, usage: RawUsage | undefined): void {
    const row: TokenUsage = {
      id,
      userId: call.userId,
      modelRef: resolved.snapshot,
      feature: call.feature,
      ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
      ...(call.workUnitId === undefined ? {} : { workUnitId: call.workUnitId }),
      ...(call.contentId === undefined ? {} : { contentId: call.contentId }),
      ...(call.chatMessageId === undefined ? {} : { chatMessageId: call.chatMessageId }),
      outcome,
      ...(usage === undefined
        ? {}
        : {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
            ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
            ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
            rawUsageJson: usage.rawJson,
          }),
      createdAt: this.now(),
    };
    this.options.repository.withTransaction((scope) => scope.tokenUsage.insert(row));
  }

  /** Resolution plus the capability checks the request needs; nothing is sent or recorded on failure. */
  private resolveForRequest(userId: string, request: LlmRequest): Resolved {
    const resolved = this.resolve(userId, request.modelRef);
    this.checkCapabilities(resolved, request);
    return resolved;
  }

  private checkCapabilities(resolved: Resolved, request: LlmRequest): void {
    const flags = effectiveCapability(resolved.capability).flags;
    const audio = request.messages.flatMap((message) => message.content).filter((part) => part.type === "audio");
    if (audio.length > 0) {
      if (flags.audioInput !== "supported") {
        throw amberError("llm_capability", "model does not accept audio input");
      }
      if (audio.some((part) => !resolved.provider.audioMimeTypes.includes(part.mimeType))) {
        throw amberError("llm_capability", "protocol cannot encode this audio format");
      }
    }
    if (request.responseFormat !== undefined && flags.structuredOutput === "unsupported") {
      throw amberError("llm_capability", "model does not support structured output");
    }
  }

  private resolve(userId: string, modelRef: ModelRef): Resolved {
    const profile = this.options.repository.withTransaction((scope) => scope.providerProfiles.get(userId, modelRef.providerProfileId));
    const capability = profile?.models.find((model) => model.modelId === modelRef.modelId);
    if (profile === undefined || capability === undefined) {
      throw amberError("llm_unconfigured", "modelRef does not name a model of the user's profiles");
    }
    const status = this.options.secrets.status(userId, profile.credentialRef);
    if (status === "missing") {
      throw amberError("llm_unconfigured", "provider profile has no credential");
    }
    if (status === "unavailable") {
      throw amberError("internal", "provider credential cannot be decrypted", { code: "internal.secret_unavailable" });
    }
    const provider = this.options.providers.find((candidate) => candidate.protocol === profile.protocol);
    if (provider === undefined) {
      throw amberError("internal", "no adapter for the profile's protocol");
    }
    return {
      profile,
      capability,
      provider,
      snapshot: { ...modelRef, providerNameSnapshot: profile.name, modelDisplaySnapshot: modelRef.modelId, protocolSnapshot: profile.protocol },
    };
  }
}

/**
 * Usage outcome of a failed adapter call, or `undefined` when nothing was sent: a
 * cancellation tells by its transport phase, a `safe` failure never left. Anything the
 * adapter did not classify counts as unknown once the call was cancelled mid-way.
 */
function failedOutcome(error: unknown, signal: AbortSignal): UsageOutcome | undefined {
  if (error instanceof OutboundHttpError && error.reason === "aborted") {
    return error.phase === "before_send" ? undefined : "outcome_unknown";
  }
  if (isAmberError(error)) {
    const disposition = error.appError.retryDisposition;
    return disposition === "safe" ? undefined : disposition === "outcome_unknown" ? "outcome_unknown" : "failed";
  }
  return signal.aborted ? "outcome_unknown" : "failed";
}

/** What a failed call tells its lane: only explicit rate limits and overloads say anything about load. */
function laneFeedback(error: unknown): LaneFeedback {
  if (!isAmberError(error)) {
    return { kind: "none" };
  }
  const { appError: failure } = error;
  const retryAfterMs = failure.details?.["retryAfterMs"];
  const after = typeof retryAfterMs === "number" ? { retryAfterMs } : {};
  if (failure.class === "llm_rate_limited") {
    return { kind: "rate_limited", ...after };
  }
  if (failure.code === "llm_failed.overloaded") {
    return { kind: "overloaded", ...after };
  }
  return { kind: "none" };
}
