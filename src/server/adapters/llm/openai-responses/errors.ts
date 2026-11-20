import { amberError, sanitizeUpstreamText, type AmberError } from "../../../domain/errors.ts";
import type { LlmProbeFlag } from "../../../ports/llm-provider.ts";
import { classifyLimit, evidenceCodes, internalMessage, limitError, readUpstreamError, UPSTREAM_MESSAGE_MAX_CHARS, upstreamOptions } from "../upstream-error.ts";

const PREFIX = "responses";
/** Client-side statuses that describe a passing condition (request timeout, concurrent edit). */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409]);
const CONTEXT_LENGTH_CODES: ReadonlySet<string> = new Set(["context_length_exceeded", "string_above_max_length"]);
const CONTEXT_LENGTH_WORDING = /context[ _]length|context window|maximum context|too many (input )?tokens|prompt is too long/i;

/** Words of an explicit refusal of a parameter or feature, as opposed to any other bad request. */
const REFUSAL_WORDING =
  /not support|unsupported|unrecognized|unknown (parameter|field|argument|name)|invalid (parameter|field|argument)|not allowed|not permitted|not available|unavailable|does not accept/i;
/** What a refusal must be about for a probe check to learn `unsupported`, in this protocol's parameter names. */
const PROBED_SUBJECT: Readonly<Record<LlmProbeFlag, RegExp>> = {
  stream: /\bstream\b|streaming/i,
  structuredOutput: /text\.format|json_schema|json schema|structured outputs?/i,
  tools: /\btools?\b|tool_choice|function[ _]call/i,
};

/** The fields of an upstream error: `{ error: { code, message, param, type } }`, a stream `error` event or a failed response's `error`. */
export interface ErrorDetail {
  code?: string;
  type?: string;
  param?: string;
  message?: string;
}

/** Reads the error fields from an object that either is the error or wraps it under `error`. */
export function errorFields(value: unknown): ErrorDetail {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const inner = record["error"];
  if (typeof inner === "string") {
    return { message: inner };
  }
  const source = typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : record;
  const result: ErrorDetail = {};
  for (const key of ["code", "type", "param", "message"] as const) {
    const field = source[key];
    if (typeof field === "string" && field !== "") {
      result[key] = field;
    } else if (key === "code" && typeof field === "number") {
      result.code = String(field);
    }
  }
  return result;
}

/** The error fields of an answer body; a body that is not JSON keeps nothing. */
export function errorDetail(body: string): ErrorDetail {
  try {
    return errorFields(JSON.parse(body));
  } catch {
    return {};
  }
}

/** Upstream text kept for display: sanitized and capped; undefined when there is none. */
export function keptText(text: string): string | undefined {
  const kept = sanitizeUpstreamText(text).slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
  return kept === "" ? undefined : kept;
}

/** `code: message` of an upstream error, capped; undefined when the upstream said nothing usable. */
export function upstreamText(detail: ErrorDetail): string | undefined {
  // A stream `error` event's `type` is the event name, not an error type.
  const code = detail.code ?? (detail.type === "error" ? undefined : detail.type);
  return keptText([code, detail.message].filter((part) => part !== undefined).join(": "));
}

/**
 * An HTTP error answer as an LLM error class. An error status means the request was
 * refused, so none of these is `outcome_unknown`. Limits (quota, rate, overload) are read
 * by the shared evidence tiers first; what remains is told apart by status: context length,
 * auth, unknown model, server errors that retry by policy, and bad requests that need the user.
 */
export function httpError(status: number, body: string, headers?: ReadonlyMap<string, string>): AmberError {
  const evidence = readUpstreamError(status, body, headers);
  const limit = classifyLimit(evidence);
  if (limit !== undefined) {
    return limitError(limit, evidence, PREFIX);
  }
  const options = upstreamOptions(evidence);
  const message = evidence.message ?? "";
  if (evidenceCodes(evidence).some((code) => CONTEXT_LENGTH_CODES.has(code)) || (status < 500 && CONTEXT_LENGTH_WORDING.test(message))) {
    return amberError("llm_capability", internalMessage(PREFIX, evidence, "context_length"), { ...options, code: "llm_capability.context_length" });
  }
  if (status === 401 || status === 403) {
    return amberError("llm_failed", internalMessage(PREFIX, evidence, "auth"), { ...options, code: "llm_failed.auth" });
  }
  if (status === 404) {
    return amberError("llm_failed", internalMessage(PREFIX, evidence, "not_found"), { ...options, code: "llm_failed.model_not_found" });
  }
  if (status >= 500 || TRANSIENT_CLIENT_STATUSES.has(status)) {
    return amberError("llm_failed", internalMessage(PREFIX, evidence, "transient"), options);
  }
  return amberError("llm_failed", internalMessage(PREFIX, evidence, "invalid_request"), { ...options, code: "llm_failed.invalid_request" });
}

/**
 * Whether an error answer explicitly rejects the parameter or feature a probe check sent:
 * a validation status whose error names that subject in refusal wording, or names it as
 * the offending `param`. Anything vaguer teaches nothing.
 */
export function refusesProbedFeature(flag: LlmProbeFlag, status: number, body: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  const detail = errorDetail(body);
  const subject = PROBED_SUBJECT[flag];
  if (detail.param !== undefined && subject.test(detail.param)) {
    return true;
  }
  const text = [detail.code, detail.type, detail.message].filter((part) => part !== undefined).join(" ");
  return subject.test(text) && REFUSAL_WORDING.test(text);
}
