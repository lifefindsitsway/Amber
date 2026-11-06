import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ElevenLabsAsrProviderFactory } from "../../src/server/adapters/asr/elevenlabs/index.ts";
import { LocalFileStore } from "../../src/server/adapters/file-store/local-file-store.ts";
import { AnthropicMessagesProvider } from "../../src/server/adapters/llm/anthropic-messages/index.ts";
import { FfmpegMediaIngest } from "../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { DirectOutboundHttpClient } from "../../src/server/adapters/outbound-http/direct.ts";
import { YoutubeAdapter } from "../../src/server/adapters/platform/youtube/index.ts";
import { YtDlp } from "../../src/server/adapters/platform/yt-dlp.ts";
import { NodeProcessRunner } from "../../src/server/adapters/process-runner/node-process-runner.ts";
import { AsrProfileService } from "../../src/server/application/asr-profile.ts";
import { ImportContentService } from "../../src/server/application/import-content.ts";
import { PlatformAccountService } from "../../src/server/application/platform-accounts.ts";
import { PlatformRegistry } from "../../src/server/application/platforms.ts";
import { ProviderService } from "../../src/server/application/providers.ts";
import { AsrStageExecutor } from "../../src/server/pipeline/stages/asr.ts";
import { ChapterStageExecutor } from "../../src/server/pipeline/stages/chapter.ts";
import type { PlatformAccess } from "../../src/server/pipeline/stages/platform-access.ts";
import { ProofreadStageExecutor } from "../../src/server/pipeline/stages/proofread.ts";
import { SourceStageExecutor } from "../../src/server/pipeline/stages/source.ts";
import { SubtitleStageExecutor } from "../../src/server/pipeline/stages/subtitle.ts";
import { SummaryStageExecutor } from "../../src/server/pipeline/stages/summary.ts";
import { childProcessEnv } from "../../src/server/ports/process-runner.ts";
import { createHarness, LOCAL, stageRunsOf, taskOf, waitFor, type Harness } from "../fixtures/pipeline/harness.ts";
import { toolsBinDir } from "../fixtures/tools.ts";

/**
 * Real short-video end-to-end run. Runs only with `AMBER_E2E_PLATFORM=1`,
 * `AMBER_E2E_ASR=1` and `AMBER_E2E_LLM=1` together, and a per-run approval
 * (no paid call without the env switch and per-run approval).
 * Endpoints, keys and the video come from the environment and never enter git or any
 * output written here:
 *
 * - `AMBER_E2E_YOUTUBE_CC_URL`: a public CC-licensed video, fetched as a guest;
 * - `AMBER_E2E_ELEVENLABS_API_KEY`: used only when the subtitle verdict calls for ASR;
 * - `AMBER_E2E_ANTHROPIC_BASE_URL` / `_API_KEY` / `_MODEL`: an Anthropic Messages endpoint;
 * - `AMBER_E2E_RECORD_DIR` (optional): where to write the redacted stage and usage summary.
 *
 * One `process_content` with proofreading on, after "test connection" so the stages see
 * measured capabilities (structured output for chapters). Every paid call is recorded as
 * usage and printed at the end.
 */

const enabled = process.env["AMBER_E2E_PLATFORM"] === "1" && process.env["AMBER_E2E_ASR"] === "1" && process.env["AMBER_E2E_LLM"] === "1";
/** Declared by the tester; probing cannot measure it. */
const DECLARED_CONTEXT_WINDOW = 200_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function record(name: string, value: unknown): void {
  const dir = process.env["AMBER_E2E_RECORD_DIR"];
  if (dir !== undefined && dir !== "") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

describe.skipIf(!enabled)("real short-video pipeline (YouTube guest + ElevenLabs + Claude)", () => {
  it(
    "every applicable stage succeeds, inapplicable ones are skipped, and usage is reported",
    async () => {
      const url = required("AMBER_E2E_YOUTUBE_CC_URL");
      const baseURL = required("AMBER_E2E_ANTHROPIC_BASE_URL");
      const llmKey = required("AMBER_E2E_ANTHROPIC_API_KEY");
      const model = required("AMBER_E2E_ANTHROPIC_MODEL");
      const asrKey = required("AMBER_E2E_ELEVENLABS_API_KEY");

      const http = new DirectOutboundHttpClient();
      let secretsHolder: Harness["secrets"] | undefined;
      const anthropic = new AnthropicMessagesProvider({
        http,
        secrets: { revealVersioned: (owner, ref) => (secretsHolder as Harness["secrets"]).revealVersioned(owner, ref) },
      });
      const h = createHarness({ llmProviders: [anthropic], executors: {} });
      open.push(h);
      secretsHolder = h.secrets;
      const { repository, newId } = h;
      const files = new LocalFileStore(h.dir);
      const runner = new NodeProcessRunner();
      const env = childProcessEnv(process.env);
      const ingest = new FfmpegMediaIngest({ runner, binDir: toolsBinDir(), env });
      const ytDlp = new YtDlp({ runner, binDir: toolsBinDir(["yt-dlp", "deno", "ffmpeg"]), dataDir: h.dir, env });
      const registry = new PlatformRegistry([new YoutubeAdapter({ ytDlp, newId })]);
      const accounts = new PlatformAccountService({ repository, secrets: h.secrets, platforms: registry, newId });
      const platforms: PlatformAccess = {
        adapterFor: (kind) => registry.adapterFor(kind),
        credentialFor: (owner, platform) => accounts.credentialFor(owner, platform),
        markExpired: (owner, platform) => accounts.markExpired(owner, platform),
      };
      const elevenLabs = new ElevenLabsAsrProviderFactory({ http, files, secrets: h.secrets });
      const asrFor = (provider: string) => (provider === elevenLabs.descriptor.provider ? elevenLabs : undefined);
      Object.assign(h.executors, {
        source: new SourceStageExecutor({ repository, platforms, newId }),
        subtitle: new SubtitleStageExecutor({ repository, platforms, newId }),
        asr: new AsrStageExecutor({ repository, files, ingest, platforms, asr: asrFor, newId }),
        proofread: new ProofreadStageExecutor({ repository, files, ingest, platforms, newId }),
        chapter: new ChapterStageExecutor({ repository, newId }),
        summary: new SummaryStageExecutor({ repository, newId }),
      });

      const providers = new ProviderService({ repository, secrets: h.secrets, prober: h.llm, newId });
      const profile = providers.create(LOCAL, {
        name: "anthropic",
        protocol: "anthropic_messages",
        baseURL,
        models: [{ modelId: model, contextWindowTokens: DECLARED_CONTEXT_WINDOW }],
      });
      expect(providers.putCredential(LOCAL, profile.id, llmKey)).toMatchObject({ credentialStatus: "configured" });
      const probed = await providers.probe(LOCAL, profile.id, model, AbortSignal.timeout(120_000));
      const asrProfiles = new AsrProfileService({ repository, secrets: h.secrets, factories: new Map([[elevenLabs.descriptor.provider, elevenLabs]]), newId });
      const asrProfile = await asrProfiles.create(LOCAL, { name: "ElevenLabs", provider: elevenLabs.descriptor.provider });
      expect(asrProfiles.putCredential(LOCAL, asrProfile.id, asrKey)).toMatchObject({ credentialStatus: "configured" });
      const asrModelRef = { asrProfileId: asrProfile.id, modelId: elevenLabs.descriptor.defaultModel };

      const importer = new ImportContentService({
        repository,
        bus: h.bus,
        control: { kick: () => h.scheduler.kick() },
        platforms: registry,
        credentials: accounts,
        disk: h.disk,
        settings: h.settings,
        newId,
      });
      const modelRef = { providerProfileId: profile.id, modelId: model };
      const imported = await importer.import(LOCAL, { items: [{ url }], settings: { modelRef, asrModelRef, autoProofread: true } });
      const taskId = imported.body.taskIds[0] as string;
      h.scheduler.start();
      await waitFor(() => TERMINAL.has(taskOf(h, taskId).statusProjection) || taskOf(h, taskId).statusProjection === "waiting", RUN_TIMEOUT_MS);

      const latest = new Map(stageRunsOf(h, taskId).map((run) => [run.stage, run]));
      const stages = Object.fromEntries([...latest].map(([stage, run]) => [stage, { status: run.status, ...(run.error === undefined ? {} : { error: run.error.code }) }]));
      const llmUsage = repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
      const asrUsage = repository.withTransaction((scope) => scope.asrUsage.list(LOCAL.userId));
      const usage = {
        llm: llmUsage.map((row) => ({ feature: row.feature, outcome: row.outcome, inputTokens: row.inputTokens, outputTokens: row.outputTokens })),
        llmTotals: {
          calls: llmUsage.length,
          inputTokens: llmUsage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
          outputTokens: llmUsage.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
        },
        asr: asrUsage.map((row) => ({ outcome: row.outcome, audioMs: row.audioMs })),
      };
      const summary = { probe: probed.body, stages, usage };
      console.info(`End-to-end run:\n${JSON.stringify(summary, null, 2)}`);
      record("pipeline-run.json", summary);

      expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
      for (const [stage, run] of latest) {
        expect([stage, run.status]).not.toEqual([stage, "failed"]);
        expect(["succeeded", "skipped"]).toContain(run.status);
      }
      for (const stage of ["source", "subtitle", "proofread", "summary"]) {
        expect(latest.get(stage as never)?.status).toBe("succeeded");
      }
      expect(llmUsage.length).toBeGreaterThan(0);
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});
