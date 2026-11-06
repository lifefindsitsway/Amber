import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import type { StageExecutionContext, StageExecutor } from "../../../../src/server/pipeline/executor.ts";
import { ensureExtractedAudio, type ExtractedAudioDeps } from "../../../../src/server/pipeline/stages/extracted-audio.ts";
import type { AsrSyncProvider } from "../../../../src/server/ports/asr-provider.ts";
import type { LocalMediaIngest } from "../../../../src/server/ports/local-media-ingest.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import {
  configureAsr,
  configureLlm,
  countingExecutor,
  createHarness,
  LOCAL,
  stageRunsOf,
  stageStatuses,
  taskOf,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { toolPath } from "../../../fixtures/tools.ts";

const open: MediaStack[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
  for (const h of harnesses.splice(0)) await h.close();
});

interface Observed {
  asset: MediaAsset;
  exists: boolean;
  probe: { format: string; channels: number; sampleRate: string; durationMs: number };
}

/** A stub ASR provider: records the audio it was handed and never calls anything. */
function stubAsr(calls: MediaAsset[]): AsrSyncProvider {
  return {
    id: "stub",
    capabilities: {
      wordTimestamps: true, segmentTimestamps: true, diarization: false, terminologyBias: false,
      maxFileBytes: 1, maxDurationSec: 1, chunkingStrategy: "providerManaged", delivery: "sync",
    },
    async transcribe(input) {
      // The stage hands over its extracted audio asset; the port only promises its file fields.
      calls.push(input.audio as MediaAsset);
      throw new Error("stub provider does not transcribe");
    },
  };
}

function ffprobeFlac(path: string): Observed["probe"] {
  const result = spawnSync(
    toolPath("ffprobe"),
    ["-v", "error", "-print_format", "json", "-show_entries", "format=format_name,duration:stream=channels,sample_rate", "-i", `file:${path}`],
    { encoding: "utf8" },
  );
  const json = JSON.parse(result.stdout) as { format: { format_name: string; duration: string }; streams: Array<{ channels: number; sample_rate: string }> };
  return {
    format: json.format.format_name,
    channels: json.streams[0]?.channels ?? 0,
    sampleRate: json.streams[0]?.sample_rate ?? "",
    durationMs: Math.round(Number(json.format.duration) * 1000),
  };
}

describe("on-demand audio extraction", () => {
  it("the media stage probes the fixture and the ASR stage's sub-step extracts FLAC that ffprobe recognizes", async () => {
    const observed: Observed[] = [];
    const providerCalls: MediaAsset[] = [];
    let stack: MediaStack;
    const asrStage: StageExecutor = {
      async run(context) {
        const { asset, path } = await ensureExtractedAudio(context, { repository: stack.h.repository, files: stack.files, ingest: stack.ingest });
        observed.push({ asset, exists: existsSync(path), probe: ffprobeFlac(path) });
        await stubAsr(providerCalls).transcribe({ audio: asset, terminology: [] }, { signal: context.signal, onRequestStart: () => undefined }).catch(() => undefined);
        return { resultJson: { reasons: [] } };
      },
    };
    const proofreadStage: StageExecutor = {
      async run(context) {
        const { asset } = await ensureExtractedAudio(context, { repository: stack.h.repository, files: stack.files, ingest: stack.ingest });
        observed.push({ asset, exists: true, probe: observed[0]?.probe as Observed["probe"] });
        return {};
      },
    };
    stack = createMediaStack({ executors: { asr: asrStage, proofread: proofreadStage } });
    open.push(stack);
    const asrModelRef = configureAsr(stack.h);
    const modelRef = configureLlm(stack.h);
    const { withAudio } = mediaFixtures();
    const created = await stack.localImport.importLocalFile(LOCAL, {
      path: withAudio.path,
      grant: stack.grant(withAudio.path),
      settings: { autoProofread: true, modelRef, asrModelRef },
      allowDuplicate: false,
    });
    const taskId = created.body.taskIds[0] as string;
    const contentId = created.body.contentIds[0] as string;
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded");

    const content = stack.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
    expect(Math.abs((content?.durationMs ?? 0) - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
    expect(stageStatuses(stack.h, taskId)).toMatchObject({ media: "succeeded", asr: "succeeded", proofread: "succeeded" });

    const [first, second] = observed;
    expect(first?.exists).toBe(true);
    expect(first?.asset).toMatchObject({ kind: "extracted_audio", taskId, mimeType: "audio/flac", retentionPolicy: "ephemeral", availability: "available" });
    expect(first?.probe).toMatchObject({ format: "flac", channels: 1, sampleRate: "16000" });
    expect(Math.abs((first?.probe.durationMs ?? 0) - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
    expect(providerCalls.map((audio) => audio.id)).toEqual([first?.asset.id]);
    // The proofread stage reuses the Task's audio instead of extracting again.
    expect(second?.asset.id).toBe(first?.asset.id);
    expect(workUnitsOf(stack.h, taskId).filter((unit) => unit.key === "media:extract_audio")).toHaveLength(1);

    // Terminal state: the janitor removes the Task's audio, row and file.
    await stack.janitor.whenIdle();
    expect(stack.h.repository.withTransaction((scope) => scope.mediaAssets.listByTask(LOCAL.userId, taskId))).toEqual([]);
    expect(await stack.files.stat(first?.asset.storageRef as string)).toBeNull();
    expect(existsSync(withAudio.path)).toBe(true);
  });

  it("fails with media_no_audio when the original has no audio track", async () => {
    let stack: MediaStack;
    const asrStage: StageExecutor = {
      async run(context) {
        await ensureExtractedAudio(context, { repository: stack.h.repository, files: stack.files, ingest: stack.ingest });
        return {};
      },
    };
    // The media stage is replaced so the no-audio file reaches the ASR stage.
    stack = createMediaStack({ executors: { media: { run: async () => ({}) }, asr: asrStage } });
    open.push(stack);
    const asrModelRef = configureAsr(stack.h);
    const { noAudio } = mediaFixtures();
    const created = await stack.localImport.importLocalFile(LOCAL, { path: noAudio.path, grant: stack.grant(noAudio.path), settings: { autoProofread: false, asrModelRef }, allowDuplicate: true });
    const taskId = created.body.taskIds[0] as string;
    stack.h.scheduler.start();
    await waitFor(() => stageStatuses(stack.h, taskId).asr === "failed");
    const asr = stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr");
    expect(asr?.error).toMatchObject({ code: "media_no_audio", retryDisposition: "never" });
    // Neither a committed nor a partial audio file is left behind.
    expect(await stack.files.list("assets")).toEqual([]);
  });
});

/**
 * Extraction without ffmpeg: the "FLAC" is the input's bytes behind a marker, so tests can
 * see what was read. Reports half-way and done, as the real adapter does, and records the
 * duration hint it was given.
 */
function stubIngest(inputs: string[], hints: Array<number | undefined>): LocalMediaIngest {
  return {
    probe: async () => Promise.reject(new Error("not used")),
    transcodeAudio: async () => Promise.reject(new Error("not used")),
    async extractAudio(input, output, _signal, options) {
      hints.push(options?.durationMs);
      const bytes = Buffer.concat([Buffer.from("flac:"), await readFile(input.path)]);
      inputs.push(bytes.toString("utf8"));
      options?.onProgress?.(0.5);
      await writeFile(output.path, bytes);
      options?.onProgress?.(1);
      return { sizeBytes: bytes.length, durationMs: 600_000 };
    },
    clipAudio: async () => Promise.reject(new Error("not used")),
  };
}

interface PlatformRun {
  h: Harness;
  files: LocalFileStore;
  inputs: string[];
  /** The duration hint of every extraction. */
  hints: Array<number | undefined>;
  /** What the stage itself reported. */
  progress: number[];
  taskId: string;
  contentId: string;
}

/**
 * A YouTube Content whose ASR stage calls `work` with the platform-aware extraction deps.
 * The platform subtitle is judged invalid so ASR runs; everything else is a stub.
 */
async function platformRun(work: (context: StageExecutionContext, deps: ExtractedAudioDeps) => Promise<void>, before?: (run: Omit<PlatformRun, "taskId">) => Promise<void>): Promise<PlatformRun> {
  const h = createHarness();
  harnesses.push(h);
  const files = new LocalFileStore(h.dir);
  const inputs: string[] = [];
  const hints: Array<number | undefined> = [];
  const progress: number[] = [];
  const deps: ExtractedAudioDeps = { repository: h.repository, files, ingest: stubIngest(inputs, hints), platforms: h.platformAccess, newId: h.newId };
  h.executors.subtitle = countingExecutor({ verdict: "invalid", reasons: ["subtitle_incomplete", "subtitle_coverage_low"] });
  h.executors.asr = {
    async run(context) {
      await work({ ...context, reportProgress: (value) => progress.push(value) }, deps);
      return {};
    },
  };
  const asrModelRef = configureAsr(h);
  const modelRef = configureLlm(h);
  const { body } = await h.importContent.import(LOCAL, { items: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }], settings: { autoProofread: false, modelRef, asrModelRef } });
  const contentId = body.contentIds[0] as string;
  await before?.({ h, files, inputs, hints, progress, contentId });
  h.scheduler.start();
  await h.scheduler.whenIdle();
  return { h, files, inputs, hints, progress, taskId: body.taskIds[0] as string, contentId };
}

function assetsOf(h: Harness, contentId: string): MediaAsset[] {
  return h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
}

describe("audio of a platform Content", () => {
  it("downloads the audio once into a temporary asset fingerprinted by its digest, then extracts from it", async () => {
    const fetched: number[] = [];
    const extracted: number[] = [];
    const alone: number[] = [];
    const run = await platformRun(
      async (context, deps) => {
        await ensureExtractedAudio(context, deps, {
          fetch: (value) => fetched.push(value),
          extract: (value) => extracted.push(value),
          extractAlone: (value) => alone.push(value),
        });
      },
      async ({ h, contentId }) => {
        h.repository.withTransaction((scope) => scope.contents.setMetadata(LOCAL.userId, contentId, { durationMs: 754_000 }, 1));
      },
    );
    const { h, files, taskId, contentId } = run;
    expect(stageStatuses(h, taskId).asr).toBe("succeeded");
    expect(h.platforms.youtube.callsOf("fetchAudio")).toEqual([{ method: "fetchAudio", target: "dQw4w9WgXcQ", withAuth: false }]);
    const downloaded = assetsOf(h, contentId).find((asset) => asset.kind === "temporary");
    expect(downloaded).toMatchObject({ taskId, mimeType: "application/octet-stream", retentionPolicy: "ephemeral", availability: "available", sizeBytes: Buffer.byteLength("audio of dQw4w9WgXcQ") });
    expect(downloaded?.fingerprint).toBe(await files.digest(downloaded?.storageRef as string));
    expect(run.inputs).toEqual(["flac:audio of dQw4w9WgXcQ"]);
    expect(assetsOf(h, contentId).filter((asset) => asset.kind === "extracted_audio")).toHaveLength(1);
    // Each step's own progress goes to its sink; mapping it onto the stage is the caller's business.
    expect(fetched).toEqual([0.5, 1]);
    expect(extracted).toEqual([0.5, 1]);
    expect(alone).toEqual([]);
    expect(run.progress).toEqual([]);
    // The downloaded audio has no probed duration, so the Content's duration is the hint.
    expect(run.hints).toEqual([754_000]);
    expect(workUnitsOf(h, taskId).map((unit) => unit.key).sort()).toEqual(["media:extract_audio", "media:fetch_audio"]);
  });

  it("reuses the Task's downloaded audio when only the extracted file is gone", async () => {
    const run = await platformRun(async (context, deps) => {
      const first = await ensureExtractedAudio(context, deps);
      await deps.files.remove(first.asset.storageRef);
      await ensureExtractedAudio(context, deps);
    });
    expect(run.h.platforms.youtube.callsOf("fetchAudio")).toHaveLength(1);
    expect(assetsOf(run.h, run.contentId).filter((asset) => asset.kind === "temporary")).toHaveLength(1);
  });

  it("extracts from a cached platform video without going online, reporting to the no-download sink", async () => {
    const extracted: number[] = [];
    const alone: number[] = [];
    const run = await platformRun(
      async (context, deps) => {
        await ensureExtractedAudio(context, deps, { extract: (value) => extracted.push(value), extractAlone: (value) => alone.push(value) });
      },
      async ({ h, files, contentId }) => {
        const id = h.newId();
        const storageRef = `assets/${LOCAL.userId}/${contentId}/${id}`;
        await files.writeAtomic(storageRef, Buffer.from("cached video"));
        h.repository.withTransaction((scope) =>
          scope.mediaAssets.insert({
            id, userId: LOCAL.userId, contentId, kind: "platform_cache", storageRef, mimeType: "video/mp4", sizeBytes: 12,
            availability: "available", retentionPolicy: "evictable", createdAt: 1,
          }),
        );
      },
    );
    expect(run.h.platforms.youtube.callsOf("fetchAudio")).toEqual([]);
    expect(run.inputs).toEqual(["flac:cached video"]);
    expect(alone).toEqual([0.5, 1]);
    expect(extracted).toEqual([]);
  });
});
