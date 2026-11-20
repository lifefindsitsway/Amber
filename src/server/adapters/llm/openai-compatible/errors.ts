import { amberError, sanitizeUpstreamText, type AmberError } from "../../../domain/errors.ts";
import type { LlmProbeFlag } from "../../../ports/llm-provider.ts";
import { classifyLimit, evidenceCodes, internalMessage, limitError, readUpstreamError, UPSTREAM_MESSAGE_MAX_CHARS, upstreamOptions } from "../upstream-error.ts";

const PREFIX = "chat completions";
/** Client-side statuses that describe a passing condition (request timeout, concurrent edit). */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409]);
const CONTEXT_LENGTH_CODES: ReadonlySet<string> = new Set(["context_length_exceeded", "string_above_max_length"]);
const CONTEXT_LENGTH_WORDING = /context[ _]length|context window|maximum context|too many (input )?tokens|prompt is too long/i;

/** Words of an explicit refusal of a parameter or feature, as opposed to any other bad request. */
const REFUSAL_WORDING =
  /not support|unsupported|unrecognized|unknown (parameter|field|argument|name)|invalid (parameter|field|argument)|not allowed|not permitted|not available|unavailable|does not accept/i;
/** What a refusal must be about for a probe check to learn `unsupported`. */
const PROBED_SUBJECT: Readonly<Record<LlmProbeFlag, RegExp>> = {
  stream: /\bstream(_options)?\b|streaming/i,
  structuredOutput: /response_format|json_schema|json schema|structured output/i,
  tools: /\btools?\b|tool_choice|function[ _]call/i,
};

export interface ErrorDetail {
  code?: string;
  type?: string;
  param?: string;
  message?: string;
}

/** The `error` object of an answer (`{ error: { message, type, param, code } }`), or a bare message. */
export function errorDetail(body: string): ErrorDetail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: nothing is kept from it.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const inner = record["error"];
  if (typeof inner === "string") {
    return { message: inner };
  }
  const source = typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : record;
  const result: ErrorDetail = {};
  for (const key of ["code", "type", "param", "message"] as const) {
    const value = source[key];
    if (typeof value === "string" && value !== "") {
      result[key] = value;
    } else if (key === "code" && typeof value === "number") {
      result.code = String(value);
    }
  }
  return result;
}

/** `code: message` of an upstream error, capped; undefined when the upstream said nothing usable. */
export function upstreamText(detail: ErrorDetail): string | undefined {
  const code = detail.code ?? detail.type;
  const text = sanitizeUpstreamText([code, detail.message].filter((part) => part !== undefined).join(": ")).slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
  return text === "" ? undefined : text;
}

/**
 * An HTTP error answer as an LLM error class. An error status
 * means the request was refused, so none of these is `outcome_unknown`. Limits (quota,
 * rate, overload) are read by the shared evidence tiers first; what remains is told
 * apart by status: context length, auth, unknown model, server errors that retry by
 * policy, and bad requests that need the user.
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
 * the offending `param`. Anything vaguer stays an error and teaches nothing.
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

const MAX_TOKENS_NAME = /\bmax_tokens\b/;
const MAX_COMPLETION_TOKENS_NAME = /\bmax_completion_tokens\b/;

/**
 * Whether an error answer explicitly rejects `max_tokens` in favour of
 * `max_completion_tokens`: a validation status whose `param` is `max_tokens`, or whose error
 * names both parameters (OpenAI's wording for models that only take the newer one). Vaguer
 * answers do not qualify, so an unrelated bad request is never sent twice.
 */
export function rejectsMaxTokens(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  const detail = errorDetail(body);
  if (detail.param === "max_tokens") {
    return true;
  }
  const text = [detail.code, detail.type, detail.message].filter((part) => part !== undefined).join(" ");
  return MAX_TOKENS_NAME.test(text) && MAX_COMPLETION_TOKENS_NAME.test(text);
}

/**
 * Whether an error answer is about the output cap parameter at all: a validation status whose
 * `param` is either cap parameter or whose error names `max_completion_tokens`. After falling
 * back, such an answer means the fallback did not settle which parameter the endpoint takes.
 */
export function rejectsTokenParam(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  const detail = errorDetail(body);
  if (detail.param === "max_tokens" || detail.param === "max_completion_tokens") {
    return true;
  }
  const text = [detail.code, detail.type, detail.message].filter((part) => part !== undefined).join(" ");
  return MAX_COMPLETION_TOKENS_NAME.test(text);
}
