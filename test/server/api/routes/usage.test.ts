import { afterEach, describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "../../../../src/server/adapters/llm/anthropic-messages/index.ts";
import { OpenAiCompatibleProvider } from "../../../../src/server/adapters/llm/openai-compatible/index.ts";
import { registerProviderRoutes } from "../../../../src/server/api/routes/providers.ts";
import { registerUsageRoutes } from "../../../../src/server/api/routes/usage.ts";
import { ProviderService } from "../../../../src/server/application/providers.ts";
import { UsageService } from "../../../../src/server/application/usage.ts";
import { API_PAGE_SIZE_MAX } from "../../../../src/shared/defaults.ts";
import { anthropicFixture } from "../../../fixtures/llm/anthropic-messages/index.ts";
import { openAiStream } from "../../../fixtures/llm/openai-compatible/index.ts";
import { ReplayHttp } from "../../../fixtures/llm/replay-http.ts";
import { BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const usage = new UsageService({ repository: h.repository });
  h.repository.withTransaction((scope) => {
    scope.tokenUsage.insert({
      id: "u1",
      userId: LOCAL.userId,
      modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
      feature: "test_connection",
      outcome: "succeeded",
      inputTokens: 12,
      outputTokens: 1,
      rawUsageJson: "{}",
      createdAt: 10,
    });
    scope.asrUsage.insert({ id: "a1", userId: LOCAL.userId, provider: "elevenlabs", model: "scribe_v2", feature: "transcribe", outcome: "succeeded", audioMs: 50_008, createdAt: 20 });
  });
  const { app } = await h.app({ extraRoutes: (instance) => registerUsageRoutes(instance, { usage }) });
  return { app };
}

describe("/api/usage", () => {
  it("returns the owner's rows and totals and validates the query", async () => {
    const { app } = await setup();
    const all = await app.inject({ method: "GET", url: "/api/usage", headers: auth });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({
      llm: [{ id: "u1", feature: "test_connection", inputTokens: 12, outputTokens: 1 }],
      asr: [{ id: "a1", audioMs: 50_008 }],
    });
    expect(all.json().totals).toHaveLength(2);
    const paged = await app.inject({ method: "GET", url: "/api/usage?limit=1", headers: auth });
    expect(paged.json().asr).toHaveLength(1);
    expect(paged.json().nextCursor).toEqual(expect.any(String));
    const next = await app.inject({ method: "GET", url: `/api/usage?limit=1&cursor=${paged.json().nextCursor as string}`, headers: auth });
    expect(next.json().llm.map((row: { id: string }) => row.id)).toEqual(["u1"]);
    const filtered = await app.inject({ method: "GET", url: "/api/usage?feature=test_connection&from=0&to=11", headers: auth });
    expect(filtered.json()).toMatchObject({ llm: [{ id: "u1" }], asr: [] });
    expect((await app.inject({ method: "GET", url: "/api/usage", headers: bob })).json()).toEqual({ llm: [], asr: [], totals: [] });
    for (const query of ["feature=asr", `limit=${API_PAGE_SIZE_MAX + 1}`, "from=-1", "cursor=%21%21", "other=1"]) {
      expect((await app.inject({ method: "GET", url: `/api/usage?${query}`, headers: auth })).statusCode).toBe(400);
    }
  });
});

describe("usage of replayed calls through the API", () => {
  it("lists one row per call under the profile and model created through /api/providers, with the fixtures' token counts", async () => {
    let harness: Harness | undefined;
    const secrets = { revealVersioned: (owner: string, ref: string) => (harness as Harness).secrets.revealVersioned(owner, ref) };
    const openAiHttp = new ReplayHttp(() => ({ status: 200, body: openAiStream("regression") }));
    const anthropicHttp = new ReplayHttp(() => ({ status: 200, body: anthropicFixture("realistic.sse") }));
    const h = createHarness({
      llmProviders: [
        new OpenAiCompatibleProvider({ http: openAiHttp, secrets, files: { read: async function* () {} } }),
        new AnthropicMessagesProvider({ http: anthropicHttp, secrets }),
      ],
    });
    harness = h;
    open.push(h);
    const providers = new ProviderService({ repository: h.repository, secrets: h.secrets, prober: h.llm });
    const usage = new UsageService({ repository: h.repository });
    const { app } = await h.app({
      extraRoutes: (instance) => {
        registerProviderRoutes(instance, { providers });
        registerUsageRoutes(instance, { usage });
      },
    });
    const create = async (protocol: string, baseURL: string): Promise<string> => {
      const created = await app.inject({
        method: "POST",
        url: "/api/providers",
        headers: auth,
        payload: { name: protocol, protocol, baseURL, models: [{ modelId: "model-under-test", contextWindowTokens: 128_000 }] },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const key = await app.inject({ method: "PUT", url: `/api/providers/${id}/credential`, headers: auth, payload: { value: "<placeholder-llm-key>" } });
      expect(key.statusCode).toBe(200);
      return id;
    };
    const openAiId = await create("openai_compatible", "https://llm.invalid/v1/");
    const anthropicId = await create("anthropic_messages", "https://llm.invalid");
    for (const providerProfileId of [openAiId, anthropicId]) {
      await h.llm.complete({ userId: LOCAL.userId, feature: "summary" }, {
        modelRef: { providerProfileId, modelId: "model-under-test" },
        system: "be brief",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }, { signal: new AbortController().signal });
    }

    const listed = await app.inject({ method: "GET", url: "/api/usage?feature=summary", headers: auth });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json().llm as Array<Record<string, unknown>>;
    // Newest first: the Anthropic call came second.
    expect(rows.map(({ modelRef, outcome, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }) => ({
      modelRef,
      outcome,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
    }))).toEqual([
      {
        modelRef: { providerProfileId: anthropicId, modelId: "model-under-test", providerNameSnapshot: "anthropic_messages", modelDisplaySnapshot: "model-under-test" },
        outcome: "succeeded",
        inputTokens: 12 + 2048 + 100,
        outputTokens: 64,
        cacheReadTokens: 2048,
        cacheWriteTokens: 100,
        reasoningTokens: undefined,
      },
      {
        modelRef: { providerProfileId: openAiId, modelId: "model-under-test", providerNameSnapshot: "openai_compatible", modelDisplaySnapshot: "model-under-test" },
        outcome: "succeeded",
        inputTokens: 1200,
        outputTokens: 64,
        cacheReadTokens: 1024,
        cacheWriteTokens: undefined,
        reasoningTokens: 48,
      },
    ]);
    expect(listed.json().totals).toHaveLength(2);
    expect(listed.json().totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "llm", feature: "summary", calls: 1, inputTokens: 2160, outputTokens: 64, incomplete: false }),
        expect.objectContaining({ kind: "llm", feature: "summary", calls: 1, inputTokens: 1200, outputTokens: 64, incomplete: false }),
      ]),
    );
    expect(JSON.stringify(listed.json())).not.toContain("<placeholder-llm-key>");
  });
});
