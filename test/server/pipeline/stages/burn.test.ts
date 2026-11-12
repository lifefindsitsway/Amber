import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FfmpegVideoBurner } from "../../../../src/server/adapters/media-ingest/ffmpeg-burner.ts";
import { FfmpegSubtitleMuxer } from "../../../../src/server/adapters/media-ingest/ffmpeg-subtitle-muxer.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import { NodeProcessRunner } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";
import { latestAttempts } from "../../../../src/server/pipeline/projection.ts";
import { BurnStageExecutor, burnSubtitleRequest, displayGeometry } from "../../../../src/server/pipeline/stages/burn.ts";
import type { MediaInspection, SubtitleMuxer, SubtitleTrack } from "../../../../src/server/ports/subtitle-muxer.ts";
import type { BurnOptions, VideoBurner } from "../../../../src/server/ports/video-burner.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement, type SubtitleStyle } from "../../../../src/shared/subtitle-style.ts";
import { childProcessEnv } from "../../../../src/server/ports/process-runner.ts";
import { ASR_LINES, seedExportContent, type ExportFixture } from "../../../fixtures/export/export-data.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import { createTaskOfKind, LOCAL, stageRunsOf, taskOf, waitFor } from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { toolPath, toolsBinDir } from "../../../fixtures/tools.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

function realMuxer(): SubtitleMuxer {
  const binDir = toolsBinDir();
  return new FfmpegSubtitleMuxer({ runner: new NodeProcessRunner(), binDir, fontPath: join(binDir, "..", "fonts", "NotoSansSC-Regular.otf"), env: childProcessEnv(process.env) });
}

function setup(burner?: VideoBurner, extra: { muxer?: SubtitleMuxer; fontDigest?: () => Promise<string> } = {}) {
  let stack: MediaStack | undefined;
  const binDir = toolsBinDir();
  const executor = new BurnStageExecutor({
    get repository() {
      return (stack as MediaStack).h.repository;
    },
    get files() {
      return (stack as MediaStack).files;
    },
    get media() {
      return (stack as MediaStack).stores;
    },
    burner: burner ?? new FfmpegVideoBurner({ runner: new NodeProcessRunner(), binDir, fontsDir: join(binDir, "..", "fonts"), env: childProcessEnv(process.env) }),
    subtitles: (owner, contentId, request) => (stack as MediaStack).h.exports.exportContentOf(owner, contentId, request).body,
    muxer: extra.muxer ?? realMuxer(),
    styledSubtitles: (owner, contentId, request) => (stack as MediaStack).h.exports.styledAssOf(owner, contentId, request),
    fontDigest: extra.fontDigest ?? (async () => "sha256:font"),
  });
  stack = createMediaStack({ executors: { burn: executor } });
  open.push(stack);
  const fixture = seedExportContent(stack.h, LOCAL.userId, "local");
  return { stack, fixture };
}

function addOriginal(stack: MediaStack, fixture: ExportFixture, path: string, fingerprint?: string): string {
  const id = stack.h.newId();
  stack.h.repository.withTransaction((scope) =>
    scope.mediaAssets.insert({
      id,
      userId: LOCAL.userId,
      contentId: fixture.contentId,
      kind: "external_local",
      storageRef: path,
      displayName: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      availability: "available",
      retentionPolicy: "never_delete",
      createdAt: 1,
    }),
  );
  return id;
}

const sha256Of = (path: string): string => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

function boxedStyle(): SubtitleStyle {
  const appearance = defaultSubtitleAppearance();
  return { appearance: { ...appearance, background: { ...appearance.background, enabled: true } }, placement: defaultSubtitlePlacement() };
}

/** A schema-version-2 request as the submission service freezes it. */
function styledRequest(
  fixture: ExportFixture,
  source: { assetId: string; fingerprint?: string },
  fields: { mode?: "original" | "translation" | "bilingual"; delivery?: "hard" | "soft"; container?: "mp4" | "mkv"; style?: SubtitleStyle } = {},
): Record<string, unknown> {
  const mode = fields.mode ?? "bilingual";
  return {
    requestSchemaVersion: 2,
    mode,
    revisionId: fixture.corrected.revision.id,
    ...(mode === "original" ? {} : { translationRevisionId: fixture.translated.revision.id }),
    source,
    delivery: fields.delivery ?? "soft",
    container: fields.container ?? "mkv",
    style: fields.style ?? boxedStyle(),
  };
}

function inputDigests(stack: MediaStack, taskId: string): string[] {
  return (
    stack.h.db
      .prepare("SELECT w.input_digest AS digest FROM work_unit w JOIN stage_run r ON r.id = w.stage_run_id WHERE r.task_id = ?")
      .all(taskId) as Array<{ digest: string }>
  ).map((row) => row.digest);
}

/** A muxer that reports a fixed inspection and records what it is asked to mux. */
function fakeMuxer(inspection: MediaInspection, version = "ffmpeg version test") {
  const muxed: Array<{ tracks: Array<SubtitleTrack & { text: string }>; container: string }> = [];
  const muxer: SubtitleMuxer = {
    inspect: async () => inspection,
    version: async () => version,
    async mux(input, output) {
      muxed.push({ tracks: await Promise.all(input.tracks.map(async (track) => ({ ...track, text: await readFile(track.subtitle, "utf8") }))), container: output.container });
      await writeFile(output.path, "muxed");
      return { sizeBytes: 5 };
    },
  };
  return { muxer, muxed };
}

const H264_AAC: MediaInspection = {
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  streams: [
    { index: 0, type: "video", codec: "h264", width: 1280, height: 720 },
    { index: 1, type: "audio", codec: "aac" },
  ],
};

describe("burnSubtitleRequest", () => {
  it("renders the original, the translation alone, or both lines", () => {
    const base = { requestSchemaVersion: 1 as const, kind: "burn" as const };
    expect(burnSubtitleRequest({ ...base, mode: "original", revisionId: "r" })).toEqual({ format: "ass", revisionId: "r" });
    expect(burnSubtitleRequest({ ...base, mode: "translation", revisionId: "r", translationRevisionId: "t" })).toEqual({ format: "ass", revisionId: "t" });
    expect(burnSubtitleRequest({ ...base, mode: "bilingual", revisionId: "r", translationRevisionId: "t" })).toEqual({
      format: "ass-bilingual",
      revisionId: "r",
      translationRevisionId: "t",
    });
  });
});

describe("BurnStageExecutor", () => {
  it("burns the bilingual ASS into the original with the pinned ffmpeg and keeps the product as the Task's temporary asset", async () => {
    const { stack, fixture } = setup();
    const { withAudio } = mediaFixtures();
    addOriginal(stack, fixture, withAudio.path);
    const taskId = createTaskOfKind(
      stack.h,
      "burn",
      { mode: "bilingual", revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id },
      { contentId: fixture.contentId },
    );
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded", 60_000);

    const [run] = latestAttempts(stageRunsOf(stack.h, taskId));
    const { assetId } = JSON.parse(run?.resultJson ?? "{}") as { assetId: string };
    const asset = stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, assetId));
    expect(asset).toMatchObject({ kind: "temporary", taskId, mimeType: "video/mp4", retentionPolicy: "ephemeral", availability: "available" });
    expect(asset?.storageRef).toBe(`assets/${LOCAL.userId}/${fixture.contentId}/${assetId}`);
    const path = stack.files.pathOf(asset?.storageRef as string);
    const probe = spawnSync(toolPath("ffprobe"), ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", `file:${path}`], { encoding: "utf8" });
    expect(probe.stdout).toContain("h264,video");
    expect(asset?.sizeBytes).toBe((await readFile(path)).length);

    // The janitor leaves the product for the client to save; the scratch ASS goes.
    await stack.janitor.whenIdle();
    expect(await stack.files.stat(asset?.storageRef as string)).not.toBeNull();
    expect(await stack.files.list(`tmp/tasks/${taskId}`)).toEqual([]);
  }, 90_000);

  it("hands the translation-only ASS to the burner and fails with media_missing, marking the vanished original", async () => {
    const seen: string[] = [];
    const burner: VideoBurner = {
      async burn(input) {
        seen.push(await readFile(input.subtitle, "utf8"));
        throw amberError("media_missing", "input file does not exist");
      },
    };
    const { stack, fixture } = setup(burner);
    const assetId = addOriginal(stack, fixture, "/nonexistent/clip.mp4");
    const taskId = createTaskOfKind(
      stack.h,
      "burn",
      { mode: "translation", revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id },
      { contentId: fixture.contentId },
    );
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "failed");
    expect(seen[0]).toContain("EN 1");
    expect(seen[0]).not.toContain("Hi world.");
    const [run] = latestAttempts(stageRunsOf(stack.h, taskId));
    expect(run?.error?.class).toBe("media_missing");
    expect(stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, assetId))?.availability).toBe("missing");

    // With nothing available left, the stage refuses before writing anything.
    const second = createTaskOfKind(stack.h, "burn", { mode: "original", revisionId: fixture.corrected.revision.id }, { contentId: fixture.contentId });
    stack.h.scheduler.kick();
    await waitFor(() => taskOf(stack.h, second).statusProjection === "failed");
    expect(latestAttempts(stageRunsOf(stack.h, second))[0]?.error?.class).toBe("media_missing");
    expect(seen).toHaveLength(1);
  });

  it("burns into a video cache, never an audio cache, and without a video fails with media_missing", async () => {
    const inputs: string[] = [];
    const burner: VideoBurner = {
      async burn(input, output) {
        inputs.push(input.video);
        await writeFile(output.path, "burned");
        return { sizeBytes: 6, encoder: "libx264" };
      },
    };
    const { stack, fixture } = setup(burner);
    const cache = (storageRef: string, mimeType: string, createdAt: number) =>
      stack.h.repository.withTransaction((scope) =>
        scope.mediaAssets.insert({
          id: stack.h.newId(), userId: LOCAL.userId, contentId: fixture.contentId, kind: "platform_cache", storageRef, mimeType, sizeBytes: 1,
          availability: "available", retentionPolicy: "evictable", createdAt,
        }),
      );
    // The audio cache is newer than the video cache; burn-in still takes the video.
    cache("media/lecture.mp4", "video/mp4", 1);
    cache("media/lecture.mp3", "audio/mpeg", 2);
    const taskId = createTaskOfKind(stack.h, "burn", { mode: "original", revisionId: fixture.corrected.revision.id }, { contentId: fixture.contentId });
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded");
    expect(inputs).toEqual([join(stack.stores.cache.directory(), "lecture.mp4")]);

    stack.h.db.prepare("UPDATE media_asset SET availability = 'evicted' WHERE storage_ref = ?").run("media/lecture.mp4");
    const second = createTaskOfKind(stack.h, "burn", { mode: "original", revisionId: fixture.corrected.revision.id }, { contentId: fixture.contentId });
    stack.h.scheduler.kick();
    await waitFor(() => taskOf(stack.h, second).statusProjection === "failed");
    expect(latestAttempts(stageRunsOf(stack.h, second))[0]?.error?.class).toBe("media_missing");
    expect(inputs).toHaveLength(1);
  });
});

describe("displayGeometry", () => {
  it("stretches by the sample aspect ratio, swaps for a quarter turn and skips cover images", () => {
    expect(displayGeometry({ container: "", streams: [{ index: 0, type: "video", codec: "h264", width: 721, height: 575, sar: { num: 16, den: 11 } }] })).toEqual({
      sar: { num: 16, den: 11 },
      displayWidth: 1049,
      displayHeight: 575,
    });
    expect(
      displayGeometry({
        container: "",
        streams: [
          { index: 0, type: "video", codec: "mjpeg", width: 300, height: 300, attachedPic: true },
          { index: 1, type: "video", codec: "h264", width: 1280, height: 720, rotation: 270 },
        ],
      }),
    ).toEqual({ sar: { num: 1, den: 1 }, displayWidth: 720, displayHeight: 1280 });
  });
});

describe("BurnStageExecutor, styled exports", () => {
  it("muxes three tracks into MKV with the pinned ffmpeg and registers a Matroska product", async () => {
    const { stack, fixture } = setup();
    const { withAudio } = mediaFixtures();
    const assetId = addOriginal(stack, fixture, withAudio.path, sha256Of(withAudio.path));
    const taskId = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId, fingerprint: sha256Of(withAudio.path) }), { contentId: fixture.contentId });
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded", 60_000);

    const [run] = latestAttempts(stageRunsOf(stack.h, taskId));
    const { assetId: productId } = JSON.parse(run?.resultJson ?? "{}") as { assetId: string };
    const product = stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, productId));
    expect(product).toMatchObject({ kind: "temporary", taskId, mimeType: "video/x-matroska", retentionPolicy: "ephemeral" });
    const path = stack.files.pathOf(product?.storageRef as string);
    const probe = spawnSync(toolPath("ffprobe"), ["-v", "error", "-show_entries", "stream=codec_type,codec_name:stream_tags=language,title:stream_disposition=default", "-of", "json", `file:${path}`], { encoding: "utf8" });
    const streams = (JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; codec_name?: string; tags?: Record<string, string>; disposition?: Record<string, number> }> }).streams;
    const subtitles = streams.filter((stream) => stream.codec_type === "subtitle");
    expect(subtitles.map((stream) => [stream.codec_name, stream.tags?.["language"], stream.tags?.["title"], stream.disposition?.["default"]])).toEqual([
      ["ass", "mul", "Amber 双语", 1],
      ["ass", "zho", "Amber 原文", 0],
      ["ass", "eng", "Amber 译文", 0],
    ]);
    expect(streams.some((stream) => stream.codec_type === "attachment")).toBe(true);
    await stack.janitor.whenIdle();
    expect(await stack.files.list(`tmp/tasks/${taskId}`)).toEqual([]);
  }, 90_000);

  it("burns a boxed bilingual subtitle into an MP4 with the pinned ffmpeg", async () => {
    const { stack, fixture } = setup();
    const { withAudio } = mediaFixtures();
    const assetId = addOriginal(stack, fixture, withAudio.path, sha256Of(withAudio.path));
    const taskId = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId, fingerprint: sha256Of(withAudio.path) }, { delivery: "hard", container: "mp4" }), {
      contentId: fixture.contentId,
    });
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded", 60_000);
    const [run] = latestAttempts(stageRunsOf(stack.h, taskId));
    const { assetId: productId } = JSON.parse(run?.resultJson ?? "{}") as { assetId: string };
    const product = stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, productId));
    expect(product?.mimeType).toBe("video/mp4");
    const probe = spawnSync(toolPath("ffprobe"), ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", `file:${stack.files.pathOf(product?.storageRef as string)}`], { encoding: "utf8" });
    expect(probe.stdout.trim().split("\n").sort()).toEqual(["aac,audio", "h264,video"]);
  }, 90_000);

  it("sizes the canvas from the display geometry and hands geometry and audio handling to the burner", async () => {
    const calls: Array<{ subtitle: string; options: BurnOptions | undefined }> = [];
    const burner: VideoBurner = {
      async burn(input, output, _progress, _signal, options) {
        calls.push({ subtitle: await readFile(input.subtitle, "utf8"), options });
        await writeFile(output.path, "burned");
        return { sizeBytes: 6, encoder: "libx264" };
      },
    };
    const inspection: MediaInspection = {
      container: "matroska,webm",
      streams: [
        { index: 0, type: "video", codec: "h264", width: 721, height: 575, sar: { num: 16, den: 11 } },
        { index: 1, type: "audio", codec: "flac" },
        { index: 2, type: "audio", codec: "mp3" },
      ],
    };
    const { stack, fixture } = setup(burner, { muxer: fakeMuxer(inspection).muxer });
    const assetId = addOriginal(stack, fixture, "/nonexistent/clip.mkv");
    const taskId = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId }, { mode: "original", delivery: "hard", container: "mp4" }), { contentId: fixture.contentId });
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded");
    expect(calls[0]?.options).toEqual({ geometry: { sar: { num: 16, den: 11 }, displayWidth: 1049, displayHeight: 575 }, audioCopy: [false, true] });
    // round(1080 x 1049 / 575) = 1970; a background box under the text.
    expect(calls[0]?.subtitle).toContain("PlayResX: 1970\nPlayResY: 1080\n");
    expect(calls[0]?.subtitle).toContain(",Box,,0,0,0,,{\\an2\\pos(985,994)}");
    expect(calls[0]?.subtitle).not.toContain("EN 1");
  });

  it("plans a text-only track per line set for MP4, in the revisions' languages", async () => {
    const { muxer, muxed } = fakeMuxer(H264_AAC);
    const { stack, fixture } = setup(undefined, { muxer });
    const assetId = addOriginal(stack, fixture, "/nonexistent/clip.mp4");
    const taskId = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId }, { container: "mp4" }), { contentId: fixture.contentId });
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded");
    expect(muxed[0]?.container).toBe("mp4");
    expect(muxed[0]?.tracks.map(({ language, title, isDefault }) => [language, title, isDefault])).toEqual([
      ["mul", "Amber 双语", true],
      ["zho", "Amber 原文", false],
      ["eng", "Amber 译文", false],
    ]);
    for (const track of muxed[0]?.tracks ?? []) {
      expect(track.text).not.toContain("Style: Box");
      expect(track.text).not.toContain("Dialogue: 0,");
    }
    expect(muxed[0]?.tracks[1]?.text).not.toContain("EN 1");
    expect(muxed[0]?.tracks[2]?.text).toContain("EN 1");
    const [run] = latestAttempts(stageRunsOf(stack.h, taskId));
    const { assetId: productId } = JSON.parse(run?.resultJson ?? "{}") as { assetId: string };
    expect(stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, productId))?.mimeType).toBe("video/mp4");
  });

  it("uses only the frozen source: gone is media_missing, a different file is media_changed", async () => {
    const { muxer, muxed } = fakeMuxer(H264_AAC);
    const { stack, fixture } = setup(undefined, { muxer });
    const { withAudio } = mediaFixtures();
    const changed = addOriginal(stack, fixture, withAudio.path, "sha256:0000");
    const first = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId: changed, fingerprint: "sha256:0000" }), { contentId: fixture.contentId });
    stack.h.scheduler.start();
    await waitFor(() => taskOf(stack.h, first).statusProjection === "failed");
    expect(latestAttempts(stageRunsOf(stack.h, first))[0]?.error?.class).toBe("media_changed");

    // Another available video does not stand in for the frozen one.
    stack.h.db.prepare("UPDATE media_asset SET availability = 'missing' WHERE id = ?").run(changed);
    addOriginal(stack, fixture, withAudio.path, sha256Of(withAudio.path));
    const second = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId: changed, fingerprint: "sha256:0000" }), { contentId: fixture.contentId });
    stack.h.scheduler.kick();
    await waitFor(() => taskOf(stack.h, second).statusProjection === "failed");
    expect(latestAttempts(stageRunsOf(stack.h, second))[0]?.error?.class).toBe("media_missing");

    // A file that vanished while still registered is marked missing.
    const vanished = addOriginal(stack, fixture, "/nonexistent/clip.mp4", "sha256:1111");
    const third = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId: vanished, fingerprint: "sha256:1111" }), { contentId: fixture.contentId });
    stack.h.scheduler.kick();
    await waitFor(() => taskOf(stack.h, third).statusProjection === "failed");
    expect(latestAttempts(stageRunsOf(stack.h, third))[0]?.error?.class).toBe("media_missing");
    expect(stack.h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, vanished))?.availability).toBe("missing");
    expect(muxed).toEqual([]);
  });

  it("draws label lines from the labels frozen with the request on every track, never the names as they are now", async () => {
    const { muxer, muxed } = fakeMuxer(H264_AAC);
    const { stack } = setup(undefined, { muxer });
    const lines = ASR_LINES.map((line, index) => ({ ...line, speakerId: index < 3 ? "s-a" : "s-b" }));
    const fixture = seedExportContent(stack.h, LOCAL.userId, "local", { lines, speakerNames: { "s-a": "新名", "s-b": "乙" } });
    const assetId = addOriginal(stack, fixture, "/nonexistent/clip.mkv");
    const appearance = defaultSubtitleAppearance();
    const style: SubtitleStyle = { appearance: { ...appearance, speaker: "every" }, placement: defaultSubtitlePlacement() };
    const run = async (speakerLabels: Record<string, string>): Promise<{ texts: string[]; digest: string }> => {
      const taskId = createTaskOfKind(stack.h, "burn", { ...styledRequest(fixture, { assetId }, { style }), speakerLabels }, { contentId: fixture.contentId });
      stack.h.scheduler.kick();
      await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded");
      return { texts: (muxed.at(-1)?.tracks ?? []).map((track) => track.text), digest: inputDigests(stack, taskId)[0] as string };
    };
    stack.h.scheduler.start();
    const first = await run({ "s-a": "旧名", "s-b": "乙" });
    expect(first.texts).toHaveLength(3);
    for (const text of first.texts) {
      // A label copies the first line its cue shows: the original's look, or the translation's on a translation-only track.
      expect(text).toMatch(/\nStyle: Speaker(Translation)?,/u);
      expect(text).toContain("}旧名\\N{\\r");
      expect(text).not.toContain("新名");
    }
    // Other frozen labels draw another text, so the earlier output is never reused.
    const second = await run({ "s-a": "甲", "s-b": "乙" });
    expect(second.texts[0]).toContain("}甲\\N{\\r");
    expect(second.digest).not.toBe(first.digest);
  });

  it("digests the font and the tool: the same inputs give the same digest, another font another", async () => {
    let font = "sha256:font-a";
    const { muxer } = fakeMuxer(H264_AAC);
    const { stack, fixture } = setup(undefined, { muxer, fontDigest: async () => font });
    const assetId = addOriginal(stack, fixture, "/nonexistent/clip.mp4");
    const run = async (): Promise<string> => {
      const taskId = createTaskOfKind(stack.h, "burn", styledRequest(fixture, { assetId }), { contentId: fixture.contentId });
      stack.h.scheduler.kick();
      await waitFor(() => taskOf(stack.h, taskId).statusProjection === "succeeded");
      return inputDigests(stack, taskId)[0] as string;
    };
    stack.h.scheduler.start();
    const first = await run();
    expect(await run()).toBe(first);
    font = "sha256:font-b";
    expect(await run()).not.toBe(first);
  });
});
