import { monotonicFactory } from "ulid";
import { asrModelFamily } from "../../shared/asr-presets.ts";
import { ASR_TEST_AUDIO_MS } from "../../shared/defaults.ts";
import type {
  AsrModelTestResultDto,
  AsrProbeDto,
  AsrProfileCreate,
  AsrProfileDto,
  AsrProfileListDto,
  AsrProfileModelInput,
  AsrProfilePatch,
} from "../../shared/dto/asr-profile.ts";
import type { ModelPricingRequest } from "../../shared/dto/model-pricing.ts";
import type { AsrProviderId } from "../../shared/enums.ts";
import { pricingFitsScope } from "../../shared/model-pricing.ts";
import { amberError } from "../domain/errors.ts";
import type { AsrModelEntry, AsrProviderProfile } from "../domain/provider-profile.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { AsrJobOutcome, UsageOutcome } from "../domain/usage.ts";
import { captureAsrSend, fillAsrJobReport } from "../pipeline/asr-usage.ts";
import { sleep } from "../pipeline/retry.ts";
import type { AsrJobReport, AsrProviderDescriptor, AsrProviderFactory } from "../ports/asr-provider.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { Logger } from "../ports/logger.ts";
import { PERMISSIVE_TARGET_CHECK, type NetworkTargetCheck } from "../ports/network-target-check.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { SecretStore } from "../ports/secret-store.ts";
import { runAsrModelTest } from "./asr-model-test.ts";
import { normalizeBaseUrl } from "./base-url.ts";
import { tasksAwaitingAsrJob, unfinishedTasksUsingAsrModel } from "./profile-references.ts";

export interface AsrProfileServiceOptions {
  repository: Repository;
  secrets: SecretStore;
  /** One factory per provider with an adapter; their descriptors are what new profiles may use. */
  factories: ReadonlyMap<AsrProviderId, AsrProviderFactory>;
  /** Save-time network policy; permissive unless the server mode composes the strict one. */
  targets?: NetworkTargetCheck;
  /** The data store the adapters read audio from; a model test writes its sound there. Without it model tests fail with `internal`. */
  files?: Pick<FileStore, "writeAtomic" | "remove">;
  newId?: () => string;
  now?: () => number;
  /** Diagnostics only: never keys, URLs or upstream text. */
  logger?: Logger;
  /** The wait between a test job's state queries; injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * `/api/asr-profiles*`: a user's several ASR profiles, each
 * one service account with its models in the user's order. What a profile may add (models,
 * endpoints) comes from its adapter's descriptor, so this layer names no provider. Keys are
 * written through SecretStore in the same transaction as the profile and never returned.
 * Creating a profile never sets a default, and saving does not resume stages waiting for
 * configuration, since no model is ever called without an explicit user action: the user
 * does both.
 *
 * While unfinished Tasks are bound to a profile: a bound model cannot be
 * removed, the endpoint cannot change and the profile cannot be deleted; while a submitted
 * job awaits its result, a usable key cannot be replaced either. Renaming, reordering,
 * adding models, pricing and testing a model are always allowed.
 */
export class AsrProfileService {
  private readonly options: AsrProfileServiceOptions;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly targets: NetworkTargetCheck;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Model tests in flight, by owner, profile and model: one at a time per model. */
  private readonly testsRunning = new Set<string>();

  constructor(options: AsrProfileServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
    this.now = options.now ?? Date.now;
    this.targets = options.targets ?? PERMISSIVE_TARGET_CHECK;
    this.sleep = options.sleep ?? sleep;
  }

  list(principal: RequestPrincipal): AsrProfileListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => ({
      items: scope.asrProfiles.list(owner).map((profile) => this.dto(scope, profile)),
    }));
  }

  /** The user's own order of their profiles: every profile exactly once. */
  reorder(principal: RequestPrincipal, profileIds: readonly string[]): AsrProfileListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const present = scope.asrProfiles.list(owner).map((profile) => profile.id);
      const given = new Set(profileIds);
      if (given.size !== profileIds.length || given.size !== present.length || present.some((id) => !given.has(id))) {
        throw amberError("invalid_request", "profileIds must list every profile exactly once", { params: { detail: "profileIds" } });
      }
      scope.asrProfiles.reorder(owner, profileIds);
      return { items: scope.asrProfiles.list(owner).map((profile) => this.dto(scope, profile)) };
    });
  }

  async create(principal: RequestPrincipal, body: AsrProfileCreate): Promise<AsrProfileDto> {
    const owner = principal.userId;
    const descriptor = this.descriptorOf(body.provider, "provider");
    const models = checkModels(descriptor, body.models ?? descriptor.recommendedModels.map((modelId) => ({ modelId })), []);
    const baseURL = await this.resolveBaseUrl(descriptor, body.baseURL);
    return this.options.repository.withTransaction((scope) => {
      const profile: AsrProviderProfile = {
        id: this.newId(),
        userId: owner,
        name: body.name.trim(),
        provider: descriptor.provider,
        models,
        ...(baseURL === undefined ? {} : { baseURL }),
        createdAt: this.now(),
      };
      scope.asrProfiles.insert(profile);
      return this.dto(scope, profile);
    });
  }

  async update(principal: RequestPrincipal, profileId: string, body: AsrProfilePatch): Promise<AsrProfileDto> {
    const owner = principal.userId;
    const stored = this.options.repository.withTransaction((scope) => scope.asrProfiles.get(owner, profileId));
    if (stored === undefined) {
      throw amberError("not_found", "no such ASR profile");
    }
    const descriptor = this.descriptorOf(stored.provider, "provider");
    if (body.models !== undefined) {
      // Refused early, before the network check of the Base URL; checked again below.
      checkModels(descriptor, body.models, stored.models);
    }
    const baseURL = body.baseURL === undefined ? stored.baseURL : await this.resolveBaseUrl(descriptor, body.baseURL ?? undefined);
    return this.options.repository.withTransaction((scope) => {
      const current = scope.asrProfiles.get(owner, profileId);
      if (current === undefined) {
        throw amberError("not_found", "no such ASR profile");
      }
      // Kept entries come from the row as it is now, so a price or test time written meanwhile stays.
      const models = body.models === undefined ? current.models : checkModels(descriptor, body.models, current.models);
      const kept = new Set(models.map((model) => model.modelId));
      for (const removed of current.models.filter((model) => !kept.has(model.modelId))) {
        if (unfinishedTasksUsingAsrModel(scope, owner, profileId, removed.modelId).length > 0) {
          throw amberError("conflict", "an unfinished task is bound to a removed model");
        }
      }
      if (baseURL !== current.baseURL && unfinishedTasksUsingAsrModel(scope, owner, profileId).length > 0) {
        throw amberError("conflict", "an unfinished task is bound to the ASR profile's endpoint");
      }
      const { baseURL: _previous, ...rest } = current;
      const next: AsrProviderProfile = {
        ...rest,
        ...(body.name === undefined ? {} : { name: body.name.trim() }),
        models,
        ...(baseURL === undefined ? {} : { baseURL }),
      };
      scope.asrProfiles.update(next);
      // A default must keep naming a listed model.
      scope.userSettings.clearAsrModelRefs(owner, profileId, [...kept]);
      return this.dto(scope, next);
    });
  }

  /**
   * Removes the profile, its Secret (through the schema) and a default naming it.
   * Refused while an unfinished Task is bound to it.
   */
  delete(principal: RequestPrincipal, profileId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      if (scope.asrProfiles.get(owner, profileId) === undefined) {
        throw amberError("not_found", "no such ASR profile");
      }
      if (unfinishedTasksUsingAsrModel(scope, owner, profileId).length > 0) {
        throw amberError("conflict", "an unfinished task still needs the ASR profile");
      }
      scope.asrProfiles.delete(owner, profileId);
      scope.userSettings.clearAsrModelRefs(owner, profileId);
    });
  }

  /**
   * Stores or replaces the key; the reference stays the same on replacement. A usable key
   * is not replaced while a job it submitted awaits its result: the job belongs to that
   * key's account. A missing or undecryptable key may always be set, since
   * a stage waiting for configuration needs exactly that.
   */
  putCredential(principal: RequestPrincipal, profileId: string, value: string): AsrProfileDto {
    const owner = principal.userId;
    const { secrets } = this.options;
    return this.options.repository.withTransaction((scope) => {
      const current = scope.asrProfiles.get(owner, profileId);
      if (current === undefined) {
        throw amberError("not_found", "no such ASR profile");
      }
      if (current.credentialRef !== undefined) {
        if (secrets.status(owner, current.credentialRef) === "configured" && tasksAwaitingAsrJob(scope, owner, profileId).length > 0) {
          throw amberError("conflict", "a submitted transcription job is still waiting for its result under the current key");
        }
        secrets.replace(owner, current.credentialRef, value);
        return this.dto(scope, current);
      }
      const next: AsrProviderProfile = { ...current, credentialRef: secrets.store(owner, value) };
      scope.asrProfiles.update(next);
      return this.dto(scope, next);
    });
  }

  /** "Test connection": a free, read-only request; proves the key, not the model. */
  async probe(principal: RequestPrincipal, profileId: string, signal: AbortSignal): Promise<AsrProbeDto> {
    const owner = principal.userId;
    const profile = this.options.repository.withTransaction((scope) => scope.asrProfiles.get(owner, profileId));
    if (profile === undefined) {
      throw amberError("not_found", "no such ASR profile");
    }
    if (this.options.secrets.status(owner, profile.credentialRef) === "missing") {
      throw amberError("asr_unconfigured", "no ASR key to test");
    }
    const factory = this.options.factories.get(profile.provider);
    if (factory === undefined) {
      throw amberError("internal", "no ASR adapter for the profile's provider");
    }
    const result = await factory.probe(profile, signal);
    return {
      ...(result.subscriptionStatus === undefined ? {} : { subscriptionStatus: result.subscriptionStatus }),
      ...(result.usedUnits === undefined ? {} : { usedUnits: result.usedUnits }),
      ...(result.limitUnits === undefined ? {} : { limitUnits: result.limitUnits }),
    };
  }

  /**
   * Sets or clears one model's price: display only, so it is not subject to
   * the runtime locks. Units must be those the transcription section offers.
   */
  setModelPricing(principal: RequestPrincipal, profileId: string, body: ModelPricingRequest): AsrProfileDto {
    const owner = principal.userId;
    if (body.pricing !== null && !pricingFitsScope(body.pricing, "asr")) {
      throw amberError("invalid_request", "a price unit is not offered for transcription models", { params: { detail: "pricing" } });
    }
    const { pricing } = body;
    return this.options.repository.withTransaction((scope) => {
      const current = scope.asrProfiles.get(owner, profileId);
      if (current === undefined) {
        throw amberError("not_found", "no such ASR profile");
      }
      if (!current.models.some((model) => model.modelId === body.modelId)) {
        throw amberError("not_found", "model not on this ASR profile");
      }
      const next: AsrProviderProfile = {
        ...current,
        models: current.models.map((model) => {
          if (model.modelId !== body.modelId) {
            return model;
          }
          const { pricing: _previous, ...rest } = model;
          return pricing === null ? rest : { ...rest, pricing };
        }),
      };
      scope.asrProfiles.update(next);
      return this.dto(scope, next);
    });
  }

  /**
   * "Test connection" of one model (`runAsrModelTest`): one test per model at
   * a time, recorded as `AsrUsage(feature = test_connection)` once a paid request may have
   * left. A result or "no speech" stores `testedAt` on the model; an accepted job without a
   * result in time proves less and stores nothing.
   */
  async testModel(principal: RequestPrincipal, profileId: string, modelId: string, signal: AbortSignal): Promise<AsrModelTestResultDto> {
    const owner = principal.userId;
    const profile = this.options.repository.withTransaction((scope) => scope.asrProfiles.get(owner, profileId));
    if (profile === undefined) {
      throw amberError("not_found", "no such ASR profile");
    }
    const entry = profile.models.find((model) => model.modelId === modelId);
    if (entry === undefined) {
      throw amberError("not_found", "model not on this ASR profile");
    }
    const key = JSON.stringify([owner, profileId, modelId]);
    if (this.testsRunning.has(key)) {
      throw amberError("conflict", "a test of this model is already running");
    }
    const factory = this.options.factories.get(profile.provider);
    const { files } = this.options;
    if (factory === undefined || files === undefined) {
      throw amberError("internal", "no ASR adapter or file store for model tests");
    }
    const family = asrModelFamily(factory.descriptor, entry);
    if (family === undefined) {
      throw amberError("asr_failed", "the model's request family is no longer offered", { code: "asr_failed.model_unavailable" });
    }
    if (this.options.secrets.status(owner, profile.credentialRef) === "missing") {
      throw amberError("asr_unconfigured", "no ASR key to test with");
    }
    this.testsRunning.add(key);
    try {
      const { repository, logger } = this.options;
      const send = captureAsrSend(repository, logger, profile, modelId);
      const recordUsage = (usage: { outcome: UsageOutcome; jobId?: string; jobOutcome?: AsrJobOutcome }): string => {
        const id = this.newId();
        repository.withTransaction((scope) =>
          scope.asrUsage.insert({
            id,
            userId: owner,
            asrProfileId: profile.id,
            profileIdSnapshot: profile.id,
            profileNameSnapshot: profile.name,
            provider: profile.provider,
            model: modelId,
            feature: "test_connection",
            outcome: usage.outcome,
            ...(usage.jobId === undefined ? {} : { jobId: usage.jobId }),
            ...(usage.jobOutcome === undefined ? {} : { jobOutcome: usage.jobOutcome }),
            audioMs: ASR_TEST_AUDIO_MS,
            ...send.context(),
            createdAt: this.now(),
          }),
        );
        return id;
      };
      const fillJobReport = (usageId: string, report: AsrJobReport): void => fillAsrJobReport(repository, logger, owner, usageId, report);
      const deps = { files, newId: this.newId, now: this.now, sleep: this.sleep, onRequestStart: send.onRequestStart, recordUsage, fillJobReport };
      const outcome = await runAsrModelTest(deps, { factory, profile, modelId, family, signal });
      const testedAt = outcome.result === "accepted" ? undefined : this.storeTestedAt(owner, profileId, modelId);
      return {
        modelId,
        result: outcome.result,
        ...(outcome.textPreview === undefined ? {} : { textPreview: outcome.textPreview }),
        latencyMs: outcome.latencyMs,
        ...(outcome.remoteCancelled === true ? { remoteCancelled: true } : {}),
        ...(testedAt === undefined ? {} : { testedAt }),
      };
    } finally {
      this.testsRunning.delete(key);
    }
  }

  /** Writes the test time on the model as it is stored now; `undefined` when the model or profile went meanwhile. */
  private storeTestedAt(owner: string, profileId: string, modelId: string): number | undefined {
    const testedAt = this.now();
    return this.options.repository.withTransaction((scope) => {
      const current = scope.asrProfiles.get(owner, profileId);
      if (current === undefined || !current.models.some((model) => model.modelId === modelId)) {
        return undefined;
      }
      scope.asrProfiles.update({ ...current, models: current.models.map((model) => (model.modelId === modelId ? { ...model, testedAt } : model)) });
      return testedAt;
    });
  }

  private descriptorOf(provider: AsrProviderId, field: string): AsrProviderDescriptor {
    const factory = this.options.factories.get(provider);
    if (factory === undefined) {
      throw amberError("invalid_request", "no ASR adapter for this provider", { params: { detail: field } });
    }
    return factory.descriptor;
  }

  /**
   * The Base URL to store. A `preset_only` provider takes one of its endpoints (the first
   * by default); any other is refused. An `any` provider keeps none by default (its adapter
   * uses its first endpoint), and a given one passes the save-time network policy
   * before it is stored; every request is checked again anyway.
   */
  private async resolveBaseUrl(descriptor: AsrProviderDescriptor, given: string | undefined): Promise<string | undefined> {
    if (descriptor.baseUrlPolicy === "preset_only") {
      const endpoints = descriptor.endpoints.map((endpoint) => normalizeBaseUrl(endpoint.baseURL));
      if (given === undefined) {
        return endpoints[0];
      }
      const normalized = normalizeBaseUrl(given);
      if (!endpoints.includes(normalized)) {
        throw amberError("invalid_request", "baseURL is not an endpoint of this provider", { params: { detail: "baseURL" } });
      }
      return normalized;
    }
    if (given === undefined) {
      return undefined;
    }
    const normalized = normalizeBaseUrl(given);
    await this.targets.check(normalized);
    return normalized;
  }

  private dto(scope: RepositoryScope, profile: AsrProviderProfile): AsrProfileDto {
    const credentialStatus = this.options.secrets.status(profile.userId, profile.credentialRef);
    const descriptor = this.options.factories.get(profile.provider)?.descriptor;
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      models: profile.models.map((entry) => {
        const family = descriptor === undefined ? undefined : asrModelFamily(descriptor, entry)?.id;
        return {
          modelId: entry.modelId,
          ...(family === undefined ? {} : { family }),
          available: family !== undefined,
          ...(entry.pricing === undefined ? {} : { pricing: entry.pricing }),
          ...(entry.testedAt === undefined ? {} : { testedAt: entry.testedAt }),
        };
      }),
      ...(profile.baseURL === undefined ? {} : { baseURL: profile.baseURL }),
      credentialStatus,
      hasCredential: credentialStatus !== "missing",
      inUse: unfinishedTasksUsingAsrModel(scope, profile.userId, profile.id).length > 0,
      createdAt: profile.createdAt,
    };
  }
}

/**
 * The model list to store, in the given order and without repeated ids. A
 * model already on the profile is kept as stored (family, price, test time), even when its
 * family no longer resolves; naming another family for it is refused (remove, then add). A
 * new model the provider knows takes its own family, any other names one of the provider's
 * families; either way the family is stored, so the entry outlives a later change of the
 * provider's known models.
 */
function checkModels(descriptor: AsrProviderDescriptor, models: readonly AsrProfileModelInput[], kept: readonly AsrModelEntry[]): AsrModelEntry[] {
  const ids = models.map((model) => model.modelId.trim());
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw amberError("invalid_request", "models must be a non-empty list without repeats", { params: { detail: "models" } });
  }
  return models.map((model, index): AsrModelEntry => {
    const modelId = ids[index] as string;
    const stored = kept.find((entry) => entry.modelId === modelId);
    if (stored !== undefined) {
      const storedFamily = Object.hasOwn(descriptor.knownModels, modelId) ? descriptor.knownModels[modelId] : stored.family;
      if (model.family !== undefined && model.family !== storedFamily) {
        throw amberError("invalid_request", "a kept model keeps its family; remove it and add it again", { params: { detail: "models" } });
      }
      return stored;
    }
    const known = Object.hasOwn(descriptor.knownModels, modelId) ? descriptor.knownModels[modelId] : undefined;
    if (known !== undefined && model.family !== undefined && model.family !== known) {
      throw amberError("invalid_request", "a known model has its own family", { params: { detail: "models" } });
    }
    const familyId = known ?? model.family;
    const family = descriptor.families.find((candidate) => candidate.id === familyId);
    if (family === undefined) {
      throw amberError("invalid_request", "a new model must follow one of the provider's families", { params: { detail: "models" } });
    }
    return { modelId, family: family.id };
  });
}
