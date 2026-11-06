import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "../../src/server/adapters/llm/anthropic-messages/index.ts";
import { OpenAiCompatibleProvider } from "../../src/server/adapters/llm/openai-compatible/index.ts";
import { DirectOutboundHttpClient } from "../../src/server/adapters/outbound-http/direct.ts";
import { ProviderService } from "../../src/server/application/providers.ts";
import { isAmberError } from "../../src/server/domain/errors.ts";
import type { LlmStreamEvent } from "../../src/server/domain/llm.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../src/server/ports/outbound-http.ts";
import type { LlmProtocol } from "../../src/shared/enums.ts";
import { createHarness, LOCAL, type Harness } from "../fixtures/pipeline/harness.ts";

/**
 * Real LLM smoke test. Runs only with `AMBER_E2E_LLM=1` and a per-run approval
 * (no paid call without the env switch and per-run approval). Endpoints, keys and models
 * come from the environment and never enter git or any output written here:
 *
 * - `AMBER_E2E_OPENAI_BASE_URL` / `_API_KEY` / `_MODEL`: an OpenAI-compatible endpoint;
 * - `AMBER_E2E_ANTHROPIC_BASE_URL` / `_API_KEY` / `_MODEL`: an Anthropic Messages endpoint;
 * - `AMBER_E2E_RECORD_DIR` (optional): where to write the redacted streams and evidence.
 *
 * Per protocol: one very short streamed request, then "test connection" (three requests
 * capped at `LLM_PROBE_MAX_OUTPUT_TOKENS`). Every request is recorded as usage.
 */

const enabled = process.env["AMBER_E2E_LLM"] === "1";
const TIMEOUT_MS = 120_000;
/** Declared by the tester; probing cannot measure it. */
const DECLARED_CONTEXT_WINDOW = 128_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** Keeps response bodies (never request headers, which carry the key). */
class CapturingHttp implements OutboundHttpClient {
  readonly bodies: Array<{ status: number; text: string }> = [];
  private readonly inner = new DirectOutboundHttpClient();

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const response = await this.inner.request(request);
    const text = await response.text();
    this.bodies.push({ status: response.status, text });
    return {
      status: response.status,
      headers: response.headers,
      body: (async function* () {
        yield Buffer.from(text, "utf8");
      })(),
      text: async () => text,
    };
  }
}

/** Identifiers and fingerprints replaced by placeholders; the endpoint never appears in a body. */
function redacted(text: string, model: string): string {
  return text
    .replace(/"id":"[^"]*"/g, '"id":"<redacted>"')
    .replace(/"system_fingerprint":"[^"]*"/g, '"system_fingerprint":"<redacted>"')
    .replace(/"created":\d+/g, '"created":0')
    .split(model)
    .join("model-under-test");
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const PROTOCOLS: Array<{ protocol: LlmProtocol; env: string; fixture: string }> = [
  { protocol: "openai_compatible", env: "AMBER_E2E_OPENAI", fixture: "openai-compatible-recorded.sse" },
  { protocol: "anthropic_messages", env: "AMBER_E2E_ANTHROPIC", fixture: "anthropic-messages-recorded.sse" },
];

describe.skipIf(!enabled)("real LLM", () => {
  it.each(PROTOCOLS)(
    "one short streamed request and test connection over $protocol, with usage and a redacted fixture",
    async ({ protocol, env, fixture }) => {
      const recordDir = process.env["AMBER_E2E_RECORD_DIR"];
      const evidence: Record<string, unknown> = { protocol };
      const writeEvidence = (): void => {
        if (recordDir !== undefined) {
          mkdirSync(recordDir, { recursive: true });
          writeFileSync(join(recordDir, `llm-evidence-${protocol}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
        }
      };
      const baseURL = required(`${env}_BASE_URL`);
      const apiKey = required(`${env}_API_KEY`);
      const model = required(`${env}_MODEL`);

      let harness: Harness | undefined;
      const secrets = { revealVersioned: (owner: string, ref: string) => (harness as Harness).secrets.revealVersioned(owner, ref) };
      const http = new CapturingHttp();
      const h = createHarness({
        llmProviders: [
          new OpenAiCompatibleProvider({ http, secrets, files: { read: async function* () {} } }),
          new AnthropicMessagesProvider({ http, secrets }),
        ],
      });
      harness = h;
      open.push(h);
      const providers = new ProviderService({ repository: h.repository, secrets: h.secrets, prober: h.llm });
      const created = providers.create(LOCAL, { name: protocol, protocol, baseURL, models: [{ modelId: model, contextWindowTokens: DECLARED_CONTEXT_WINDOW }] });
      expect(providers.putCredential(LOCAL, created.id, apiKey)).toMatchObject({ credentialStatus: "configured", hasCredential: true });
      const modelRef = { providerProfileId: created.id, modelId: model };
      const usageRows = () =>
        h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId)).map(
          ({ feature, outcome, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }) => ({
            feature, outcome, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
          }),
        );
      // An upstream refusal keeps only its code and message (never the endpoint or the key).
      const failure = (error: unknown): string => {
        evidence["error"] = isAmberError(error) ? { code: error.appError.code, upstreamMessage: error.appError.upstreamMessage } : String(error);
        evidence["usage"] = usageRows();
        evidence["httpStatuses"] = http.bodies.map((body) => body.status);
        writeEvidence();
        return JSON.stringify(evidence["error"]);
      };

      const events: LlmStreamEvent[] = [];
      try {
        const stream = h.llm.stream(
          { userId: LOCAL.userId, feature: "chat" },
          { modelRef, system: "Answer in one word.", messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word OK." }] }] },
          { signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        for await (const event of stream) {
          events.push(event);
        }
      } catch (error) {
        expect.fail(`streamed request failed: ${failure(error)}`);
      }
      expect(events.map((event) => event.type).join(" ")).toMatch(/^(text_delta )+(usage )?done$/);
      const done = events.at(-1);
      expect(done?.type === "done" ? done.stopReason : undefined).toMatch(/^(stop|length)$/);
      const streamed = http.bodies[0];
      expect(streamed?.status).toBe(200);
      evidence["text"] = events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");
      evidence["stopReason"] = done?.type === "done" ? done.stopReason : undefined;
      if (recordDir !== undefined && streamed !== undefined) {
        mkdirSync(recordDir, { recursive: true });
        writeFileSync(join(recordDir, fixture), redacted(streamed.text, model));
      }

      try {
        evidence["probe"] = (await providers.probe(LOCAL, created.id, model, AbortSignal.timeout(TIMEOUT_MS))).body;
      } catch (error) {
        expect.fail(`test connection failed: ${failure(error)}`);
      }
      const rows = h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
      expect(rows[0]).toMatchObject({ feature: "chat", outcome: "succeeded", modelRef: { providerProfileId: created.id, modelId: model } });
      expect(rows.filter((row) => row.feature === "test_connection").length).toBeGreaterThanOrEqual(3);
      evidence["usage"] = usageRows();
      evidence["httpStatuses"] = http.bodies.map((body) => body.status);
      writeEvidence();
    },
    TIMEOUT_MS * 2,
  );
});
