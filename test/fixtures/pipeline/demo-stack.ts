import { copyFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { LocalAuthAdapter } from "../../../src/server/adapters/auth/local/index.ts";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { FfmpegMediaIngest } from "../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import { buildApp, type BuiltApp } from "../../../src/server/app.ts";
import { AsrProfileService } from "../../../src/server/application/asr-profile.ts";
import { OtherModelService } from "../../../src/server/application/other-models.ts";
import { ProviderService } from "../../../src/server/application/providers.ts";
import { TerminologyService } from "../../../src/server/application/terminology.ts";
import { UsageService } from "../../../src/server/application/usage.ts";
import { AsrStageExecutor } from "../../../src/server/pipeline/stages/asr.ts";
import { ChapterStageExecutor } from "../../../src/server/pipeline/stages/chapter.ts";
import { HighlightStageExecutor } from "../../../src/server/pipeline/stages/highlight.ts";
import { TranslateStageExecutor } from "../../../src/server/pipeline/stages/translate.ts";
import { CollectionSummaryStageExecutor } from "../../../src/server/pipeline/stages/collection-summary.ts";
import { ProofreadStageExecutor } from "../../../src/server/pipeline/stages/proofread.ts";
import { DescriptionClock } from "../../../src/server/domain/content-description.ts";
import { SourceStageExecutor } from "../../../src/server/pipeline/stages/source.ts";
import { SubtitleStageExecutor } from "../../../src/server/pipeline/stages/subtitle.ts";
import { SummaryStageExecutor } from "../../../src/server/pipeline/stages/summary.ts";
import type { FileStore } from "../../../src/server/ports/file-store.ts";
import { childProcessEnv } from "../../../src/server/ports/process-runner.ts";
import { FakeAsrFactory } from "../asr/fake-asr.ts";
import { PipelineLlmProvider } from "../llm/pipeline-llm.ts";
import { mediaFixtures } from "../media/index.ts";
import { toolsBinDir } from "../tools.ts";
import { createHarness, LOCAL_TOKEN, type Harness } from "./harness.ts";

/**
 * The whole processing pipeline behind a real HTTP server on `127.0.0.1:0`, composed like
 * `main.ts` but with replayed edges: scripted platform adapters (audio downloads answer
 * with a generated tone), the scripted ASR factory and the pipeline-aware fake LLM behind
 * the real LlmGateway. FileStore, ffmpeg extraction and every stage executor are real.
 * Nothing leaves the machine.
 */
export interface DemoStack {
  h: Harness;
  llm: PipelineLlmProvider;
  asr: FakeAsrFactory;
  files: FileStore;
  built: BuiltApp;
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  close(): Promise<void>;
}

export async function createDemoStack(): Promise<DemoStack> {
  const llm = new PipelineLlmProvider();
  const asr = new FakeAsrFactory();
  const h = createHarness({ llmProviders: [llm], executors: {} });
  const files = new LocalFileStore(h.dir);
  const ingest = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env) });
  const tone = mediaFixtures().audioOnly.path;
  for (const adapter of [h.platforms.bilibili, h.platforms.youtube]) {
    adapter.fetchAudio = async (_ref, _auth, output, onProgress = () => undefined) => {
      await copyFile(tone, output.path);
      onProgress(1);
      return { sizeBytes: (await stat(output.path)).size };
    };
  }
  const { repository, newId } = h;
  const platforms = h.platformAccess;
  const asrFor = (provider: string) => (provider === asr.descriptor.provider ? asr : undefined);
  Object.assign(h.executors, {
    source: new SourceStageExecutor({ repository, platforms, newId, descriptionClock: new DescriptionClock(Date.now) }),
    subtitle: new SubtitleStageExecutor({ repository, platforms, newId }),
    asr: new AsrStageExecutor({ repository, files, ingest, platforms, asr: asrFor, newId }),
    proofread: new ProofreadStageExecutor({ repository, files, ingest, platforms, newId }),
    chapter: new ChapterStageExecutor({ repository, newId }),
    highlight: new HighlightStageExecutor({ repository, newId }),
    translate: new TranslateStageExecutor({ repository, newId }),
    summary: new SummaryStageExecutor({ repository, newId }),
    collection_summary: new CollectionSummaryStageExecutor({ repository, newId }),
  });

  const built = await buildApp({
    mode: "local",
    auth: new LocalAuthAdapter(LOCAL_TOKEN),
    bus: h.bus,
    tasks: h.tasks,
    instanceSettings: h.settings,
    settings: h.userSettings,
    importContent: h.importContent,
    contents: h.contents,
    trash: h.trash,
    platformAccounts: h.platformAccounts,
    asrProfiles: new AsrProfileService({ repository, secrets: h.secrets, factories: new Map([[asr.descriptor.provider, asr]]), files, newId }),
    otherModels: new OtherModelService({ repository, newId }),
    providers: new ProviderService({ repository, secrets: h.secrets, prober: h.llm, newId }),
    terminology: new TerminologyService({ repository, newId }),
    usage: new UsageService({ repository }),
    transcripts: h.transcripts,
    chapters: h.chapters,
    highlights: h.highlights,
    translations: h.translations,
    exports: h.exports,
    derivedTasks: h.derivedTasks,
    summaryTemplates: h.summaryTemplates,
    summaries: h.summaries,
    collections: h.collections,
    search: h.search,
    chat: h.chat,
    version: "0.0.0-demo",
    log: false,
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = built.app.server.address() as AddressInfo;
  h.scheduler.start();
  return {
    h,
    llm,
    asr,
    files,
    built,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await h.close();
      await built.app.close();
    },
  };
}
