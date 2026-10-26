import { monotonicFactory } from "ulid";
import { z } from "zod";
import {
  CHAT_SEARCH_PLAN_TURNS,
  WEB_SEARCH_QUERIES_MAX,
  WEB_SEARCH_QUERY_MAX_CHARS,
  WEB_SEARCH_RESULTS_PER_QUERY,
  WEB_SEARCH_SNIPPET_MAX_CHARS,
  WEB_SEARCH_SOURCES_MAX,
  WEB_SEARCH_TITLE_MAX_CHARS,
} from "../../shared/defaults.ts";
import type { WebSearchProfileDto, WebSearchProfilePut, WebSearchTestResult } from "../../shared/dto/web-search.ts";
import { WEB_SEARCH_SERVICES } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import { amberError, appError, isAmberError } from "../domain/errors.ts";
import type { LlmRequest } from "../domain/llm.ts";
import type { ModelRef } from "../domain/model-ref.ts";
import { CHAT_SEARCH_PLAN_FORCE_RULE, CHAT_SEARCH_PLAN_NO_RECENT, CHAT_SEARCH_PLAN_PROMPT, renderPrompt } from "../domain/prompts.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { ChatWebSearch, WebSearchProfile, WebSource } from "../domain/web-search.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { SecretStore } from "../ports/secret-store.ts";
import type { WebSearchProvider, WebSearchResult } from "../ports/web-search.ts";
import type { LlmGateway } from "./llm-gateway.ts";

/** What the chat hands the search planner for one answer. */
export interface ChatSearchPlanRequest {
  owner: string;
  mode: "auto" | "force";
  /** The answering model; the planning call runs on it. */
  modelRef: ModelRef;
  /** The model's effective `structuredOutput` is `supported`: the call asks for a JSON schema. */
  structuredOutput: boolean;
  title?: string;
  /** The thread's latest user questions before this one, oldest first. */
  recentQuestions: readonly string[];
  question: string;
  /** Today in Beijing time, `YYYY-MM-DD`. */
  today: string;
  contentId: string;
  /** The answer the planning call's usage belongs to. */
  chatMessageId: string;
  signal: AbortSignal;
}

/**
 * The planned queries of one answer, each within `WEB_SEARCH_QUERY_MAX_CHARS`, at most
 * `WEB_SEARCH_QUERIES_MAX`. No query means the search is skipped for `reason`; `force`
 * always has at least one.
 */
export interface ChatSearchPlan {
  mode: "auto" | "force";
  queries: string[];
  reason?: "not_needed" | "planner_failed";
}

/**
 * The web search side of the chat. Apart from an abort, `plan` and `search` never throw: a
 * failed planning call or failed queries end up in the plan and the record.
 */
export interface ChatWebSearcher {
  /** The owner has a search service with a usable key. */
  isConfigured(owner: string): boolean;
  plan(request: ChatSearchPlanRequest): Promise<ChatSearchPlan>;
  /**
   * Sends the planned queries in parallel and returns the record with every usable source,
   * de-duplicated and ranked, at most `WEB_SEARCH_SOURCES_MAX`, numbered from 1; the chat
   * then fits them to its budget.
   */
  search(owner: string, plan: ChatSearchPlan, signal: AbortSignal): Promise<ChatWebSearch>;
}

/** The planning call's JSON; the root is an object so structured output can describe it. */
const PLAN_SCHEMA = {
  type: "object",
  properties: { search: { type: "boolean" }, queries: { type: "array", items: { type: "string" } } },
  required: ["search", "queries"],
  additionalProperties: false,
} as const;

const planOutputSchema = z.object({ search: z.boolean(), queries: z.array(z.unknown()).optional() });

/** Longer URLs are dropped: no page worth citing needs one, and they bloat the request. */
const URL_MAX_CHARS = 2048;

/**
 * Control characters, and the bidirectional overrides that can make page text display
 * differently from what it says.
 */
const CONTROL = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** The harmless query "test" sends: one real search, one unit of the service's quota. */
const TEST_QUERY = "Amber";

export interface WebSearchServiceOptions {
  repository: Repository;
  secrets: Pick<SecretStore, "store" | "replace" | "reveal" | "remove" | "status">;
  /** One adapter per search service. */
  providers: readonly WebSearchProvider[];
  /** The planning call goes through the gateway like every LLM call, on the answering model. */
  llm: Pick<LlmGateway, "complete">;
  /** Error codes only; never queries, results or keys. */
  logger?: Logger;
  newId?: () => string;
  now?: () => number;
}

/**
 * Web search for the chat and `/api/web-search*`. The search runs in the application, not
 * in the model: one planning call turns the question into a few short queries, the queries
 * go to the user's search service, and the results are cleaned, de-duplicated and ranked
 * into the answer's sources. Only the planned queries reach the search service, never the
 * transcript, the summary or the conversation. The key is held by the SecretStore, revealed
 * for one search at a time and never put in a DTO, an error or a log.
 */
export class WebSearchService implements ChatWebSearcher {
  private readonly options: WebSearchServiceOptions;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(options: WebSearchServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
    this.now = options.now ?? Date.now;
  }

  isConfigured(owner: string): boolean {
    const profile = this.profileOf(owner);
    return (
      profile !== undefined &&
      this.providerFor(profile) !== undefined &&
      this.options.secrets.status(owner, profile.credentialRef) === "configured"
    );
  }

  /**
   * One planning call. `auto` searches only when the model says so and gave a usable query;
   * `force` always ends with at least one query, the question's first line when the model
   * gave none. A failed or unreadable call is a plan too; only an abort throws.
   */
  async plan(request: ChatSearchPlanRequest): Promise<ChatSearchPlan> {
    const prompt = renderPrompt(CHAT_SEARCH_PLAN_PROMPT.text, {
      today: request.today,
      max_queries: String(WEB_SEARCH_QUERIES_MAX),
      max_query_chars: String(WEB_SEARCH_QUERY_MAX_CHARS),
      force_rule: request.mode === "force" ? CHAT_SEARCH_PLAN_FORCE_RULE : "",
      title: oneLine(request.title ?? ""),
      recent_questions: recentQuestions(request.recentQuestions),
      question: request.question,
    });
    const llmRequest: LlmRequest = {
      modelRef: request.modelRef,
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      ...(request.structuredOutput ? { responseFormat: { type: "json_schema" as const, schema: PLAN_SCHEMA } } : {}),
    };
    let output: { search: boolean; queries: string[] } | undefined;
    try {
      const completion = await this.options.llm.complete(
        { userId: request.owner, feature: "chat_search_plan", contentId: request.contentId, chatMessageId: request.chatMessageId },
        llmRequest,
        { signal: request.signal },
      );
      output = parsePlan(completion.text);
      if (output === undefined) {
        this.options.logger?.warn("web_search_plan_unreadable");
      }
    } catch (error) {
      if (request.signal.aborted) {
        throw error;
      }
      this.options.logger?.warn("web_search_plan_failed", { code: toAppError(error).code });
    }
    const queries = output === undefined ? [] : usableQueries(output.queries);
    if (request.mode === "force") {
      return { mode: "force", queries: queries.length > 0 ? queries : usableQueries([firstLine(request.question)]) };
    }
    if (output === undefined) {
      return { mode: "auto", queries: [], reason: "planner_failed" };
    }
    if (!output.search) {
      return { mode: "auto", queries: [], reason: "not_needed" };
    }
    return queries.length > 0 ? { mode: "auto", queries } : { mode: "auto", queries: [], reason: "planner_failed" };
  }

  /**
   * Sends every planned query at once and folds the answers into the record: `searched` when
   * all came back, `partial` when some failed, `failed` when none did (with the last error).
   * `requested` counts the requests handed to the service. Only an abort throws.
   */
  async search(owner: string, plan: ChatSearchPlan, signal: AbortSignal): Promise<ChatWebSearch> {
    const base = { mode: plan.mode, planned: plan.queries.length, queries: [...plan.queries] };
    if (plan.queries.length === 0) {
      return { ...base, status: "skipped", reason: plan.reason ?? "not_needed", requested: 0, succeeded: 0, sources: [] };
    }
    let access: { provider: WebSearchProvider; apiKey: string };
    try {
      access = this.access(owner);
    } catch (error) {
      return { ...base, status: "failed", requested: 0, succeeded: 0, sources: [], error: toAppError(error) };
    }
    const settled = await Promise.allSettled(
      plan.queries.map((query) => access.provider.search(query, { maxResults: WEB_SEARCH_RESULTS_PER_QUERY, apiKey: access.apiKey, signal })),
    );
    signal.throwIfAborted();
    const answered: WebSearchResult[][] = [];
    let error: AppError | undefined;
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        answered.push(outcome.value);
      } else {
        error = toAppError(outcome.reason);
        this.options.logger?.warn("web_search_query_failed", { code: error.code });
      }
    }
    const succeeded = answered.length;
    const status = succeeded === settled.length ? "searched" : succeeded === 0 ? "failed" : "partial";
    return {
      ...base,
      status,
      requested: settled.length,
      succeeded,
      sources: this.sources(answered),
      ...(error === undefined ? {} : { error }),
    };
  }

  /** `GET /api/web-search`. */
  getProfile(principal: RequestPrincipal): WebSearchProfileDto {
    return this.dto(principal.userId, this.profileOf(principal.userId));
  }

  /** `PUT /api/web-search`: chooses the service, creating the row on first use; a key of another service is dropped. */
  putProfile(principal: RequestPrincipal, body: WebSearchProfilePut): WebSearchProfileDto {
    const owner = principal.userId;
    const profile = this.options.repository.withTransaction((scope) => {
      const existing = scope.webSearchProfiles.get(owner);
      const now = this.now();
      if (existing === undefined) {
        const created: WebSearchProfile = { userId: owner, service: body.service, createdAt: now, updatedAt: now };
        scope.webSearchProfiles.put(created);
        return created;
      }
      if (existing.service === body.service) {
        return existing;
      }
      const { credentialRef, ...rest } = existing;
      const updated: WebSearchProfile = { ...rest, service: body.service, updatedAt: now };
      // The reference goes first: the profile's foreign key still points at the Secret.
      scope.webSearchProfiles.put(updated);
      if (credentialRef !== undefined) {
        this.options.secrets.remove(owner, credentialRef);
      }
      return updated;
    });
    return this.dto(owner, profile);
  }

  /**
   * `PUT /api/web-search/credential`: stores the key as the profile's own Secret; entering it
   * again re-encrypts it under the same reference. Before a service was chosen the first
   * one is assumed.
   */
  putCredential(principal: RequestPrincipal, value: string): WebSearchProfileDto {
    const owner = principal.userId;
    const { secrets } = this.options;
    const profile = this.options.repository.withTransaction((scope) => {
      const now = this.now();
      const existing = scope.webSearchProfiles.get(owner) ?? { userId: owner, service: WEB_SEARCH_SERVICES[0], createdAt: now, updatedAt: now };
      if (existing.credentialRef !== undefined) {
        secrets.replace(owner, existing.credentialRef, value);
        const updated = { ...existing, updatedAt: now };
        scope.webSearchProfiles.put(updated);
        return updated;
      }
      const updated: WebSearchProfile = { ...existing, credentialRef: secrets.store(owner, value), updatedAt: now };
      scope.webSearchProfiles.put(updated);
      return updated;
    });
    return this.dto(owner, profile);
  }

  /** `DELETE /api/web-search`: the profile and, through the schema trigger, its Secret; past answers keep their records. */
  deleteProfile(principal: RequestPrincipal): void {
    this.options.repository.withTransaction((scope) => scope.webSearchProfiles.delete(principal.userId));
  }

  /** `POST /api/web-search/test`: one real search with a fixed harmless query; a failure is thrown as it came. */
  async test(principal: RequestPrincipal, signal: AbortSignal): Promise<WebSearchTestResult> {
    const { provider, apiKey } = this.access(principal.userId);
    const results = await provider.search(TEST_QUERY, { maxResults: WEB_SEARCH_RESULTS_PER_QUERY, apiKey, signal });
    return { ok: true, resultCount: results.length };
  }

  private profileOf(owner: string): WebSearchProfile | undefined {
    return this.options.repository.withTransaction((scope) => scope.webSearchProfiles.get(owner));
  }

  private providerFor(profile: WebSearchProfile): WebSearchProvider | undefined {
    return this.options.providers.find((provider) => provider.service === profile.service);
  }

  /** The adapter and the revealed key for one search; `unconfigured` unless the key can be used. */
  private access(owner: string): { provider: WebSearchProvider; apiKey: string } {
    const profile = this.profileOf(owner);
    const provider = profile === undefined ? undefined : this.providerFor(profile);
    if (profile?.credentialRef === undefined || provider === undefined || this.options.secrets.status(owner, profile.credentialRef) !== "configured") {
      throw amberError("web_search_failed", "no usable web search service", { code: "web_search_failed.unconfigured" });
    }
    return { provider, apiKey: this.options.secrets.reveal(owner, profile.credentialRef) };
  }

  private dto(owner: string, profile: WebSearchProfile | undefined): WebSearchProfileDto {
    return {
      ...(profile === undefined ? {} : { service: profile.service }),
      credentialStatus: this.options.secrets.status(owner, profile?.credentialRef),
    };
  }

  /**
   * The answer's sources: http(s) URLs within `URL_MAX_CHARS` only, text cleaned and cut,
   * one source per page (fragment and trailing slash ignored), best score first with ties
   * in query and result order, at most `WEB_SEARCH_SOURCES_MAX`, numbered from 1.
   */
  private sources(answered: readonly WebSearchResult[][]): WebSource[] {
    const ranked = answered
      .flatMap((results, queryIndex) => results.map((result, resultIndex) => ({ result, queryIndex, resultIndex })))
      .sort((a, b) => (b.result.score ?? 0) - (a.result.score ?? 0) || a.queryIndex - b.queryIndex || a.resultIndex - b.resultIndex);
    const seen = new Set<string>();
    const sources: WebSource[] = [];
    const fetchedAt = this.now();
    for (const { result } of ranked) {
      if (sources.length === WEB_SEARCH_SOURCES_MAX) {
        break;
      }
      const url = httpUrl(result.url);
      if (url === undefined) {
        continue;
      }
      const key = pageKey(url);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const title = clean(result.title, WEB_SEARCH_TITLE_MAX_CHARS);
      sources.push({
        id: this.newId(),
        index: sources.length + 1,
        url: url.href,
        title: title === "" ? url.hostname : title,
        excerpt: clean(result.content, WEB_SEARCH_SNIPPET_MAX_CHARS),
        ...(result.publishedAt === undefined ? {} : { publishedAt: result.publishedAt }),
        fetchedAt,
      });
    }
    return sources;
  }
}

function toAppError(error: unknown): AppError {
  return isAmberError(error) ? error.appError : appError("internal");
}

/**
 * The first JSON object in the model's text, tolerating code fences and prose around it;
 * undefined when there is none or it is not `{ search, queries }`.
 */
export function parsePlan(text: string): { search: boolean; queries: string[] } | undefined {
  const json = firstJsonObject(text);
  if (json === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = planOutputSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return { search: parsed.data.search, queries: (parsed.data.queries ?? []).filter((query): query is string => typeof query === "string") };
}

/** The text of the first balanced `{…}`, braces inside JSON strings not counted. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

/**
 * Queries as they may be sent: one line each, cut to `WEB_SEARCH_QUERY_MAX_CHARS` whatever
 * the model wrote (pasted text in a question must not travel on in full), blank and repeated
 * ones dropped, at most `WEB_SEARCH_QUERIES_MAX`.
 */
export function usableQueries(raw: readonly string[]): string[] {
  const queries: string[] = [];
  for (const query of raw) {
    const cut = cutChars(query.replace(CONTROL, " ").replace(/\s+/g, " ").trim(), WEB_SEARCH_QUERY_MAX_CHARS).trim();
    if (cut !== "" && !queries.includes(cut)) {
      queries.push(cut);
    }
    if (queries.length === WEB_SEARCH_QUERIES_MAX) {
      break;
    }
  }
  return queries;
}

function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/).find((line) => line.trim() !== "") ?? "";
}

function recentQuestions(questions: readonly string[]): string {
  const lines = questions
    .slice(-CHAT_SEARCH_PLAN_TURNS)
    .map((question) => oneLine(question).trim())
    .filter((question) => question !== "");
  return lines.length === 0 ? CHAT_SEARCH_PLAN_NO_RECENT : lines.join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

function httpUrl(raw: string): URL | undefined {
  const trimmed = raw.trim();
  if (trimmed.length > URL_MAX_CHARS) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.href.length <= URL_MAX_CHARS ? url : undefined;
}

/** The page a URL names, for de-duplication: without fragment and trailing slashes. */
function pageKey(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/**
 * Page text as the model may see it: control characters out, whitespace folded, doubled
 * brackets single so no page can pass for a citation marker, cut to `max` characters.
 */
function clean(text: string, max: number): string {
  const flat = text.replace(CONTROL, " ").replace(/\[{2,}/g, "[").replace(/\]{2,}/g, "]").replace(/\s+/g, " ").trim();
  return cutChars(flat, max).trimEnd();
}

/** The first `max` code points, so a surrogate pair is never split. */
function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
