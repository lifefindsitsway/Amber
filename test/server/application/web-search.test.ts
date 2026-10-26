import { afterEach, describe, expect, it } from "vitest";
import type { LlmGateway } from "../../../src/server/application/llm-gateway.ts";
import { parsePlan, usableQueries, WebSearchService, type ChatSearchPlanRequest } from "../../../src/server/application/web-search.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { LlmCallAttribution, LlmRequest } from "../../../src/server/domain/llm.ts";
import { CHAT_SEARCH_PLAN_PROMPT, renderPrompt } from "../../../src/server/domain/prompts.ts";
import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "../../../src/server/ports/web-search.ts";
import {
  CHAT_SEARCH_PLAN_TURNS,
  WEB_SEARCH_QUERIES_MAX,
  WEB_SEARCH_QUERY_MAX_CHARS,
  WEB_SEARCH_RESULTS_PER_QUERY,
  WEB_SEARCH_SNIPPET_MAX_CHARS,
  WEB_SEARCH_SOURCES_MAX,
  WEB_SEARCH_TITLE_MAX_CHARS,
} from "../../../src/shared/defaults.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const KEY = "tvly-test";
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

interface PlanCall {
  call: LlmCallAttribution;
  request: LlmRequest;
}

/** Answers every planning call with `answer` (a text, or an error to throw). */
function fakeLlm(answer: string | Error) {
  const calls: PlanCall[] = [];
  const llm: Pick<LlmGateway, "complete"> = {
    complete: async (call, request) => {
      calls.push({ call, request: request as LlmRequest });
      if (answer instanceof Error) throw answer;
      return { invocationId: "inv", text: answer, stopReason: "stop" };
    },
  };
  return { llm, calls };
}

/** Results per query; an Error entry fails that query. */
class FakeProvider implements WebSearchProvider {
  readonly service = "tavily";
  readonly calls: Array<{ query: string; options: WebSearchOptions }> = [];
  private readonly answers: Record<string, WebSearchResult[] | Error>;
  constructor(answers: Record<string, WebSearchResult[] | Error> = {}) {
    this.answers = answers;
  }
  async search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]> {
    this.calls.push({ query, options });
    const answer = this.answers[query] ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function setup(options: { llm?: Pick<LlmGateway, "complete">; provider?: FakeProvider; configure?: boolean } = {}) {
  const h = createHarness();
  open.push(h);
  let next = 0;
  const provider = options.provider ?? new FakeProvider();
  const service = new WebSearchService({
    repository: h.repository,
    secrets: h.secrets,
    providers: [provider],
    llm: options.llm ?? fakeLlm('{"search":false,"queries":[]}').llm,
    newId: () => `01JWEB${String((next += 1)).padStart(20, "0")}`,
    now: () => NOW,
  });
  if (options.configure !== false) service.putCredential(LOCAL, KEY);
  return { h, service, provider };
}

function planRequest(overrides: Partial<ChatSearchPlanRequest> = {}): ChatSearchPlanRequest {
  return {
    owner: LOCAL.userId,
    mode: "auto",
    modelRef: { providerProfileId: "p1", modelId: "m1" },
    structuredOutput: false,
    title: "第三讲：注意力机制",
    recentQuestions: [],
    question: "Transformer 现在最新的变体有哪些？",
    today: "2026-10-26",
    contentId: "c1",
    chatMessageId: "m-answer",
    signal: new AbortController().signal,
    ...overrides,
  };
}

const appErr = (code: "web_search_failed.auth" | "web_search_failed.unreachable") => amberError("web_search_failed", code, { code });

describe("planning", () => {
  it("makes one call on the answering model, attributed to the answer, with every slot of the planning prompt filled", async () => {
    const { llm, calls } = fakeLlm('{"search":true,"queries":["Transformer variants 2026"]}');
    const { service } = setup({ llm });
    const plan = await service.plan(planRequest({ recentQuestions: ["第一问", "第二问\n续行", "第三问"] }));
    expect(plan).toEqual({ mode: "auto", queries: ["Transformer variants 2026"] });
    expect(calls).toHaveLength(1);
    const { call, request } = calls[0] as PlanCall;
    expect(call).toEqual({ userId: LOCAL.userId, feature: "chat_search_plan", contentId: "c1", chatMessageId: "m-answer" });
    expect(request.modelRef).toEqual({ providerProfileId: "p1", modelId: "m1" });
    expect(request).not.toHaveProperty("responseFormat");
    const prompt = request.messages[0]?.content[0];
    const recent = ["第二问 续行", "第三问"];
    expect(recent).toHaveLength(CHAT_SEARCH_PLAN_TURNS);
    expect(prompt?.type === "text" && prompt.text).toBe(
      renderPrompt(CHAT_SEARCH_PLAN_PROMPT.text, {
        today: "2026-10-26",
        max_queries: String(WEB_SEARCH_QUERIES_MAX),
        max_query_chars: String(WEB_SEARCH_QUERY_MAX_CHARS),
        force_rule: "",
        title: "第三讲：注意力机制",
        recent_questions: recent.join("\n"),
        question: "Transformer 现在最新的变体有哪些？",
      }),
    );
  });

  it("asks for a JSON schema when the model supports structured output, and states the forced search", async () => {
    const { llm, calls } = fakeLlm('{"search":true,"queries":["q"]}');
    const { service } = setup({ llm });
    await service.plan(planRequest({ structuredOutput: true, mode: "force" }));
    const { request } = calls[0] as PlanCall;
    expect(request.responseFormat?.type).toBe("json_schema");
    const prompt = request.messages[0]?.content[0];
    const text = prompt?.type === "text" ? prompt.text : "";
    expect(text).toContain("\n本轮用户已要求联网搜索：search 必须为 true，并至少给出一条查询。\n");
    expect(text).toContain("【最近的提问】\n（无）\n");
  });

  it("auto: search false is not_needed; an unreadable or failed call is planner_failed", async () => {
    for (const [answer, expected] of [
      ['{"search":false,"queries":["x"]}', { mode: "auto", queries: [], reason: "not_needed" }],
      ["I think we should search.", { mode: "auto", queries: [], reason: "planner_failed" }],
      ['{"search":true,"queries":["  ", ""]}', { mode: "auto", queries: [], reason: "planner_failed" }],
      [appErr("web_search_failed.unreachable"), { mode: "auto", queries: [], reason: "planner_failed" }],
    ] as const) {
      const { service } = setup({ llm: fakeLlm(answer).llm });
      expect(await service.plan(planRequest())).toEqual(expected);
    }
  });

  it("force: searches although the model said no, and falls back to the question's first line cut to the limit", async () => {
    const { service } = setup({ llm: fakeLlm('{"search":false,"queries":["Tauri 2.11 release"]}').llm });
    expect(await service.plan(planRequest({ mode: "force" }))).toEqual({ mode: "force", queries: ["Tauri 2.11 release"] });

    const longFirstLine = `${"最新版本是多少".repeat(40)}\n第二行不算`;
    for (const answer of ["not json", '{"search":false,"queries":[]}', new Error("boom")]) {
      const { service: forced } = setup({ llm: fakeLlm(answer).llm });
      const plan = await forced.plan(planRequest({ mode: "force", question: `\n  ${longFirstLine}` }));
      expect(plan.mode).toBe("force");
      expect(plan.queries).toEqual([Array.from("最新版本是多少".repeat(40)).slice(0, WEB_SEARCH_QUERY_MAX_CHARS).join("")]);
      expect(plan).not.toHaveProperty("reason");
    }
  });

  it("keeps pasted transcript text out of the queries: each is cut to the limit, and the prompt carries only what the user typed", async () => {
    const pasted = "这是一段从字幕里粘贴过来的原文，讲的是注意力机制在机器翻译中的应用。".repeat(16).slice(0, 500);
    const question = `${pasted}\n这段话里提到的方法现在还有人用吗？`;
    const { llm, calls } = fakeLlm(JSON.stringify({ search: true, queries: [pasted, `${pasted}2`, "注意力机制 机器翻译 现状", "第四条"] }));
    const { service } = setup({ llm });
    const { title: _title, ...untitled } = planRequest({ question });
    const plan = await service.plan(untitled);
    expect(plan.queries).toHaveLength(WEB_SEARCH_QUERIES_MAX);
    for (const query of plan.queries) expect(Array.from(query).length).toBeLessThanOrEqual(WEB_SEARCH_QUERY_MAX_CHARS);
    // The planning prompt has no transcript slot: it is the template with title, recent questions and the question only.
    const prompt = calls[0]?.request.messages[0]?.content[0];
    const text = prompt?.type === "text" ? prompt.text : "";
    expect(text.replace(question, "")).toBe(
      renderPrompt(CHAT_SEARCH_PLAN_PROMPT.text, {
        today: "2026-10-26",
        max_queries: String(WEB_SEARCH_QUERIES_MAX),
        max_query_chars: String(WEB_SEARCH_QUERY_MAX_CHARS),
        force_rule: "",
        title: "",
        recent_questions: "（无）",
        question: "",
      }),
    );
  });

  it("rethrows a cancellation instead of planning around it", async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = setup({ llm: fakeLlm(new Error("aborted")).llm });
    await expect(service.plan(planRequest({ signal: controller.signal }))).rejects.toThrow("aborted");
  });

  it("parses fenced or chatty JSON, and normalizes queries", () => {
    expect(parsePlan('```json\n{"search": true, "queries": ["a {b}", 3, "c"]}\n```')).toEqual({ search: true, queries: ["a {b}", "c"] });
    expect(parsePlan('Sure: {"search": false} done')).toEqual({ search: false, queries: [] });
    expect(parsePlan('{"search": "yes", "queries": []}')).toBeUndefined();
    expect(parsePlan("{broken")).toBeUndefined();
    expect(usableQueries([" a\n b ", "a b", "", "c\u0000d", "e", "f"])).toEqual(["a b", "c d", "e"]);
  });
});

function hit(url: string, score: number, extra: Partial<WebSearchResult> = {}): WebSearchResult {
  return { url, title: `T ${url}`, content: `C ${url}`, score, ...extra };
}

describe("searching", () => {
  it("sends every query in parallel with the owner's key and folds the answers into ranked, numbered sources", async () => {
    const provider = new FakeProvider({
      q1: [hit("https://a.example.com/x", 0.5), hit("https://b.example.com/y/", 0.9, { publishedAt: Date.UTC(2026, 0, 2) })],
      q2: [hit("https://b.example.com/y#part", 0.95), hit("https://c.example.com/z", 0.5)],
    });
    const { service } = setup({ provider });
    const record = await service.search(LOCAL.userId, { mode: "force", queries: ["q1", "q2"] }, new AbortController().signal);
    expect(provider.calls.map((call) => [call.query, call.options.maxResults, call.options.apiKey])).toEqual([
      ["q1", WEB_SEARCH_RESULTS_PER_QUERY, KEY],
      ["q2", WEB_SEARCH_RESULTS_PER_QUERY, KEY],
    ]);
    expect(record).toMatchObject({ mode: "force", status: "searched", planned: 2, requested: 2, succeeded: 2, queries: ["q1", "q2"] });
    expect(record).not.toHaveProperty("error");
    // The same page twice keeps its best entry; ties keep query order.
    expect(record.sources.map((source) => [source.index, source.url])).toEqual([
      [1, "https://b.example.com/y#part"],
      [2, "https://a.example.com/x"],
      [3, "https://c.example.com/z"],
    ]);
    expect(new Set(record.sources.map((source) => source.id)).size).toBe(3);
    expect(record.sources.every((source) => source.fetchedAt === NOW)).toBe(true);
    expect(JSON.stringify(record)).not.toContain(KEY);
  });

  it("drops non-http(s) and overlong URLs, strips control characters and cuts title and excerpt", async () => {
    const provider = new FakeProvider({
      q: [
        hit("ftp://files.example.com/a", 0.99),
        hit("javascript:alert(1)", 0.98),
        hit(`https://long.example.com/${"a".repeat(2048)}`, 0.97),
        { url: "https://ok.example.com/", title: `标题\u0000\u202E${"长".repeat(WEB_SEARCH_TITLE_MAX_CHARS + 50)}`, content: `摘录[[s1]]\n${"文".repeat(WEB_SEARCH_SNIPPET_MAX_CHARS + 50)}`, score: 0.5, publishedAt: 7 },
        { url: "https://untitled.example.com/p", title: " \u0007 ", content: "", score: 0.4 },
      ],
    });
    const { service } = setup({ provider });
    const { sources } = await service.search(LOCAL.userId, { mode: "auto", queries: ["q"] }, new AbortController().signal);
    expect(sources.map((source) => source.url)).toEqual(["https://ok.example.com/", "https://untitled.example.com/p"]);
    const [first, second] = sources;
    expect(Array.from(first?.title ?? "")).toHaveLength(WEB_SEARCH_TITLE_MAX_CHARS);
    expect(first?.title.startsWith("标题 ")).toBe(true);
    expect(first?.title).not.toMatch(/[\u0000-\u001f\u202E]/);
    expect(Array.from(first?.excerpt ?? "")).toHaveLength(WEB_SEARCH_SNIPPET_MAX_CHARS);
    expect(first?.excerpt.startsWith("摘录[s1] 文")).toBe(true);
    expect(first?.publishedAt).toBe(7);
    expect(second?.title).toBe("untitled.example.com");
  });

  it("caps the sources at WEB_SEARCH_SOURCES_MAX", async () => {
    const many = Array.from({ length: WEB_SEARCH_SOURCES_MAX + 4 }, (_, i) => hit(`https://s${i}.example.com/`, 1 - i / 100));
    const { service } = setup({ provider: new FakeProvider({ q1: many.slice(0, 6), q2: many.slice(6) }) });
    const record = await service.search(LOCAL.userId, { mode: "auto", queries: ["q1", "q2"] }, new AbortController().signal);
    expect(record.sources.map((source) => source.index)).toEqual(Array.from({ length: WEB_SEARCH_SOURCES_MAX }, (_, i) => i + 1));
    expect(record.sources.map((source) => source.url)).toEqual(many.slice(0, WEB_SEARCH_SOURCES_MAX).map((entry) => new URL(entry.url).href));
  });

  it("counts a partial and a failed search, with the last query error", async () => {
    const provider = new FakeProvider({ ok: [hit("https://a.example.com/", 1)], bad1: appErr("web_search_failed.unreachable"), bad2: appErr("web_search_failed.auth") });
    const { service } = setup({ provider });
    const partial = await service.search(LOCAL.userId, { mode: "auto", queries: ["bad1", "ok", "bad2"] }, new AbortController().signal);
    expect(partial).toMatchObject({ status: "partial", planned: 3, requested: 3, succeeded: 1 });
    expect(partial.sources).toHaveLength(1);
    expect(partial.error?.code).toBe("web_search_failed.auth");
    const failed = await service.search(LOCAL.userId, { mode: "force", queries: ["bad2", "bad1"] }, new AbortController().signal);
    expect(failed).toMatchObject({ status: "failed", planned: 2, requested: 2, succeeded: 0, sources: [] });
    expect(failed.error?.code).toBe("web_search_failed.unreachable");
  });

  it("skips without queries and fails without sending when the key is gone", async () => {
    const { service, provider } = setup();
    expect(await service.search(LOCAL.userId, { mode: "auto", queries: [], reason: "not_needed" }, new AbortController().signal)).toEqual({
      mode: "auto", status: "skipped", reason: "not_needed", planned: 0, requested: 0, succeeded: 0, queries: [], sources: [],
    });
    const record = await service.search(BOB.userId, { mode: "force", queries: ["q"] }, new AbortController().signal);
    expect(record).toMatchObject({ status: "failed", planned: 1, requested: 0, succeeded: 0 });
    expect(record.error?.code).toBe("web_search_failed.unconfigured");
    expect(provider.calls).toEqual([]);
  });

  it("rethrows a cancellation", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider();
    provider.search = async () => {
      controller.abort();
      throw new Error("aborted");
    };
    const { service } = setup({ provider });
    await expect(service.search(LOCAL.userId, { mode: "auto", queries: ["q"] }, controller.signal)).rejects.toBeDefined();
  });
});

describe("the search service profile", () => {
  it("is configured only with a stored, decryptable key, per owner", () => {
    const { h, service } = setup({ configure: false });
    expect(service.isConfigured(LOCAL.userId)).toBe(false);
    expect(service.getProfile(LOCAL)).toEqual({ credentialStatus: "missing" });
    expect(service.putProfile(LOCAL, { service: "tavily" })).toEqual({ service: "tavily", credentialStatus: "missing" });
    expect(service.isConfigured(LOCAL.userId)).toBe(false);
    const stored = service.putCredential(LOCAL, KEY);
    expect(stored).toEqual({ service: "tavily", credentialStatus: "configured" });
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(service.isConfigured(LOCAL.userId)).toBe(true);
    expect(service.isConfigured(BOB.userId)).toBe(false);
    expect(service.getProfile(BOB)).toEqual({ credentialStatus: "missing" });

    const ref = h.repository.withTransaction((scope) => scope.webSearchProfiles.get(LOCAL.userId))?.credentialRef as string;
    service.putCredential(LOCAL, "tvly-other");
    expect(h.repository.withTransaction((scope) => scope.webSearchProfiles.get(LOCAL.userId))?.credentialRef).toBe(ref);
    expect(h.secrets.reveal(LOCAL.userId, ref)).toBe("tvly-other");
  });

  it("deletes the profile together with its Secret", () => {
    const { h, service } = setup();
    const ref = h.repository.withTransaction((scope) => scope.webSearchProfiles.get(LOCAL.userId))?.credentialRef as string;
    service.deleteProfile(LOCAL);
    expect(service.getProfile(LOCAL)).toEqual({ credentialStatus: "missing" });
    expect(h.db.prepare("SELECT count(*) AS n FROM secret WHERE id = ?").get(ref)).toEqual({ n: 0 });
    service.deleteProfile(LOCAL);
  });

  it("tests with one real search of a fixed query, and refuses without a key", async () => {
    const provider = new FakeProvider({ Amber: [hit("https://a.example.com/", 1), hit("https://b.example.com/", 1)] });
    const { service } = setup({ provider });
    expect(await service.test(LOCAL, new AbortController().signal)).toEqual({ ok: true, resultCount: 2 });
    expect(provider.calls.map((call) => [call.query, call.options.apiKey])).toEqual([["Amber", KEY]]);
    try {
      await service.test(BOB, new AbortController().signal);
      expect.unreachable();
    } catch (error) {
      expect(isAmberError(error) && error.appError).toMatchObject({ code: "web_search_failed.unconfigured", action: "configure_web_search" });
    }
  });
});
