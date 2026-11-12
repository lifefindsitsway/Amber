import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { monotonicFactory } from "ulid";
import type { SubtitleExportRequest } from "../../../shared/dto/export.ts";
import type { BurnMode } from "../../../shared/enums.ts";
import { exportFile } from "../../../shared/i18n/zh-CN/export-file.ts";
import type { SubtitleStyle } from "../../../shared/subtitle-style.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import { STYLED_ASS_PLAY_RES_Y, type AssPlayRes } from "../../domain/export/ass.ts";
import { mp4CopiesAudio, type MediaStreamInfo } from "../../domain/export/container-policy.ts";
import { MULTIPLE_LANGUAGES, trackLanguageCode } from "../../domain/export/language-code.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import type { MediaAsset } from "../../domain/media-asset.ts";
import { burnTaskRequestSchema, type BurnTaskRequest, type BurnTaskRequestV1, type BurnTaskRequestV2 } from "../../domain/task-request.ts";
import type { FileStore } from "../../ports/file-store.ts";
import type { Repository } from "../../ports/repository.ts";
import type { MediaInspection, SubtitleMuxer, SubtitleTrack } from "../../ports/subtitle-muxer.ts";
import type { BurnOptions, VideoBurner } from "../../ports/video-burner.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import type { MediaFiles } from "../media-files.ts";
import { assetPath, assetRef, availableVideoSource, markMissing, singleStore, taskScratchRef } from "./source-media.ts";

/** The ASS text of a Content's revision(s), rendered the way subtitle export renders it, in the fixed ASS styles. */
export type BurnSubtitleSource = (ownerUserId: string, contentId: string, request: SubtitleExportRequest) => AsyncIterable<string>;

/** What a styled ASS is rendered from: the display mode, its revisions, the style and the canvas. */
export interface StyledSubtitleRequest {
  mode: BurnMode;
  revisionId: string;
  translationRevisionId?: string;
  style: SubtitleStyle;
  playRes: AssPlayRes;
  textOnly: boolean;
  /** The speaker labels frozen with the request: label lines never read the names as they are when the export runs. */
  speakerLabels?: Readonly<Record<string, string>>;
}

/** The styled ASS text of a Content's revision(s), rendered by the subtitle export service. */
export type StyledSubtitleSource = (ownerUserId: string, contentId: string, request: StyledSubtitleRequest) => AsyncIterable<string>;

export interface BurnStageDeps {
  repository: Repository;
  /** The data store: the ASS file and the burn product live here. */
  files: FileStore;
  /** Where the source video is read from by its kind; defaults to `files` for every kind. */
  media?: Pick<MediaFiles, "storeFor">;
  burner: VideoBurner;
  subtitles: BurnSubtitleSource;
  /** Styled exports (schema version 2): track muxing and source inspection. */
  muxer: SubtitleMuxer;
  styledSubtitles: StyledSubtitleSource;
  /** `sha256:<hex>` of the bundled subtitle font: another font draws another picture. */
  fontDigest: () => Promise<string>;
  now?: () => number;
  newId?: () => string;
}

const BURN_UNIT_KEY = "burn:encode";
const MP4_MIME = "video/mp4";
const CONTAINER_MIME = { mp4: MP4_MIME, mkv: "video/x-matroska" } as const;

/** What subtitle export renders for each mode: the translation alone is a plain ASS of the translated revision. */
export function burnSubtitleRequest(request: BurnTaskRequestV1): SubtitleExportRequest {
  switch (request.mode) {
    case "original":
      return { format: "ass", revisionId: request.revisionId };
    case "translation":
      return { format: "ass", revisionId: request.translationRevisionId as string };
    case "bilingual":
      return { format: "ass-bilingual", revisionId: request.revisionId, translationRevisionId: request.translationRevisionId as string };
  }
}

async function* utf8(lines: AsyncIterable<string>): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const line of lines) {
    yield encoder.encode(line);
  }
}

/**
 * The `burn` stage (client only): burns the frozen revision(s) into the
 * Content's available original or cached video and registers the product as the Task's
 * `temporary` asset, which the janitor leaves for the client to save. `resultJson` =
 * `{ assetId }`.
 *
 * The ASS file goes to the Task's scratch directory; the encode is one file-backed
 * WorkUnit under the heavy semaphore whose input digest covers the source and the exact
 * subtitle text, so a crash after the file was committed does not encode again.
 */
export class BurnStageExecutor implements StageExecutor {
  private readonly deps: BurnStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: BurnStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { task } = context;
    const owner = task.userId;
    const contentId = task.contentId;
    if (contentId === undefined) {
      throw new TypeError("the burn stage needs a Content target");
    }
    const request = burnTaskRequestSchema.parse(context.request);
    const output = request.requestSchemaVersion === 1 ? await this.burnLegacy(context, owner, contentId, request) : await this.exportStyled(context, owner, contentId, request);
    const sizeBytes = (await this.deps.files.stat(output.outputRef))?.sizeBytes ?? 0;
    return { resultJson: { assetId: this.register(owner, contentId, task.id, { ...output, sizeBytes }).id } };
  }

  /** Schema version 1: the fixed ASS style burned into whichever video is available when the stage runs. */
  private async burnLegacy(context: StageExecutionContext, owner: string, contentId: string, request: BurnTaskRequestV1): Promise<Omit<Product, "sizeBytes">> {
    const { task } = context;
    const { files, repository } = this.deps;
    const source = repository.withTransaction((scope) => availableVideoSource(scope, owner, contentId));
    if (source === undefined) {
      throw amberError("media_missing", "no available video to burn subtitles into");
    }

    const subtitleRef = `${taskScratchRef(task.id)}/burn.ass`;
    const subtitle = await files.writeAtomic(subtitleRef, utf8(this.deps.subtitles(owner, contentId, burnSubtitleRequest(request))));

    const output = await context.runUnit({
      key: BURN_UNIT_KEY,
      inputDigest: `${source.fingerprint ?? `asset:${source.id}`}|${subtitle.digest}`,
      storage: "file",
      run: (signal) =>
        context.withHeavySlot(async () => {
          const ref = assetRef({ userId: owner, contentId, id: this.newId() });
          const stored = await files.writeAtomic(ref, async (partial) => {
            await this.burnFrom(source, files.pathOf(subtitleRef), partial, (progress) => context.reportProgress(progress), signal);
          });
          return { outputRef: ref, outputDigest: stored.digest };
        }),
    });

    return { ...output, mimeType: MP4_MIME };
  }

  /**
   * Schema version 2, the styled export: only the frozen source is used. Its
   * display geometry sets the ASS canvas; a hard export re-encodes with the subtitles drawn
   * in, a soft one adds one track per line set (three for bilingual: both lines, then each
   * alone). The unit's digest covers everything that shapes the file — source, delivery,
   * container, geometry, track plan and text, font and tool — so a changed input never
   * reuses an earlier output.
   */
  private async exportStyled(context: StageExecutionContext, owner: string, contentId: string, request: BurnTaskRequestV2): Promise<Omit<Product, "sizeBytes">> {
    const { task, signal } = context;
    const { files, repository, muxer } = this.deps;
    const source = repository.withTransaction((scope) => scope.mediaAssets.get(owner, request.source.assetId));
    if (source === undefined || source.contentId !== contentId || source.availability !== "available") {
      throw amberError("media_missing", "the frozen source video is no longer available");
    }
    const path = assetPath(source, this.deps.media ?? singleStore(files));
    const inspection = await context.withHeavySlot(() =>
      this.markingMissing(source, async () => {
        if (request.source.fingerprint !== undefined && (await fileDigest(path, signal)) !== request.source.fingerprint) {
          throw amberError("media_changed", "the source video no longer matches the frozen fingerprint");
        }
        return muxer.inspect(path, signal);
      }),
    );
    const geometry = displayGeometry(inspection);
    const playRes: AssPlayRes = { width: Math.round((STYLED_ASS_PLAY_RES_Y * geometry.displayWidth) / geometry.displayHeight), height: STYLED_ASS_PLAY_RES_Y };
    const scratch = taskScratchRef(task.id);
    const subtitleOf = async (name: string, mode: BurnMode, textOnly: boolean) => {
      const ref = `${scratch}/${name}`;
      const stored = await files.writeAtomic(
        ref,
        utf8(
          this.deps.styledSubtitles(owner, contentId, {
            mode,
            revisionId: request.revisionId,
            ...(mode === "original" ? {} : { translationRevisionId: request.translationRevisionId as string }),
            style: request.style,
            playRes,
            textOnly,
            ...(request.speakerLabels === undefined ? {} : { speakerLabels: request.speakerLabels }),
          }),
        ),
      );
      return { path: files.pathOf(ref), digest: stored.digest };
    };
    const common = {
      v: 2,
      source: request.source.fingerprint ?? `asset:${source.id}`,
      assetId: source.id,
      delivery: request.delivery,
      container: request.container,
      geometry,
      font: await this.deps.fontDigest(),
      tool: await muxer.version(signal),
    };

    let work: (partial: string, onProgress: (progress: number) => void, signal: AbortSignal) => Promise<unknown>;
    let digest: string;
    if (request.delivery === "hard") {
      const subtitle = await subtitleOf("burn.ass", request.mode, false);
      const audioCopy = inspection.streams.filter((stream) => stream.type === "audio").map((stream) => mp4CopiesAudio(stream.codec));
      const options: BurnOptions = { geometry, audioCopy };
      digest = digestOf(canonicalJson({ ...common, audioCopy, subtitle: subtitle.digest }));
      work = (partial, onProgress, unitSignal) => this.deps.burner.burn({ video: path, subtitle: subtitle.path }, { path: partial }, onProgress, unitSignal, options);
    } else {
      const plan = this.trackPlan(owner, request);
      const tracks: Array<SubtitleTrack & { digest: string }> = [];
      for (const [index, track] of plan.entries()) {
        const subtitle = await subtitleOf(`track-${index + 1}.ass`, track.mode, request.container === "mp4");
        tracks.push({ subtitle: subtitle.path, language: track.language, title: track.title, isDefault: index === 0, digest: subtitle.digest });
      }
      digest = digestOf(
        canonicalJson({ ...common, tracks: tracks.map(({ language, title, isDefault, digest: text }) => ({ language, title, isDefault, text })) }),
      );
      work = (partial, onProgress, unitSignal) =>
        muxer.mux({ video: path, tracks: tracks.map(({ digest: _digest, ...track }) => track) }, { path: partial, container: request.container }, onProgress, unitSignal);
    }

    const output = await context.runUnit({
      key: BURN_UNIT_KEY,
      inputDigest: digest,
      storage: "file",
      run: (unitSignal) =>
        context.withHeavySlot(async () => {
          const ref = assetRef({ userId: owner, contentId, id: this.newId() });
          const stored = await files.writeAtomic(ref, async (partial) => {
            await this.markingMissing(source, () => work(partial, (progress) => context.reportProgress(progress), unitSignal));
          });
          return { outputRef: ref, outputDigest: stored.digest };
        }),
    });
    return { ...output, mimeType: request.delivery === "hard" ? MP4_MIME : CONTAINER_MIME[request.container] };
  }

  /**
   * The subtitle tracks of a soft export: one for a single line set; for
   * bilingual, both lines first (the default track, language `mul`), then each alone.
   * Languages are the revisions' own, as ISO 639-2/T codes.
   */
  private trackPlan(owner: string, request: BurnTaskRequestV2): Array<{ mode: BurnMode; language: string; title: string }> {
    const languageOf = (revisionId: string | undefined) =>
      trackLanguageCode(
        revisionId === undefined ? undefined : this.deps.repository.withTransaction((scope) => scope.transcripts.getRevision(owner, revisionId))?.language,
      );
    const original = { mode: "original" as const, language: languageOf(request.revisionId), title: exportFile.subtitleTrack.original };
    const translation = { mode: "translation" as const, language: languageOf(request.translationRevisionId), title: exportFile.subtitleTrack.translation };
    switch (request.mode) {
      case "original":
        return [original];
      case "translation":
        return [translation];
      case "bilingual":
        return [{ mode: "bilingual", language: MULTIPLE_LANGUAGES, title: exportFile.subtitleTrack.bilingual }, original, translation];
    }
  }

  /** The product as the Task's `temporary` asset; a re-run after a crash finds the one already registered. */
  private register(owner: string, contentId: string, taskId: string, product: Product): MediaAsset {
    const { repository } = this.deps;
    const ref = product.outputRef;
    return repository.withTransaction((scope) => {
      const registered = scope.mediaAssets.listByTask(owner, taskId).find((candidate) => candidate.storageRef === ref);
      if (registered !== undefined) {
        return registered;
      }
      const created: MediaAsset = {
        id: ref.slice(ref.lastIndexOf("/") + 1),
        userId: owner,
        contentId,
        kind: "temporary",
        taskId,
        storageRef: ref,
        mimeType: product.mimeType,
        sizeBytes: product.sizeBytes,
        fingerprint: product.outputDigest,
        availability: "available",
        retentionPolicy: "ephemeral",
        createdAt: this.now(),
      };
      scope.mediaAssets.insert(created);
      return created;
    });
  }

  /** A vanished source is marked so the detail page can offer relinking or caching again. */
  private async markingMissing<T>(source: MediaAsset, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isAmberError(error) && error.appError.class === "media_missing") {
        markMissing(this.deps.repository, source);
      }
      throw error;
    }
  }

  private async burnFrom(source: MediaAsset, subtitlePath: string, partial: string, onProgress: (progress: number) => void, signal: AbortSignal): Promise<void> {
    await this.markingMissing(source, () =>
      this.deps.burner.burn({ video: assetPath(source, this.deps.media ?? singleStore(this.deps.files)), subtitle: subtitlePath }, { path: partial }, onProgress, signal),
    );
  }
}

/** A committed output file, before it is registered as an asset. */
interface Product {
  outputRef: string;
  outputDigest: string;
  sizeBytes: number;
  mimeType: string;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** `sha256:<hex>` of a file, the fingerprint format of every asset; a vanished file is `media_missing`. */
async function fileDigest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      hash.update(chunk as Buffer);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw amberError("media_missing", "input file does not exist");
    }
    throw error;
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * What the picture looks like on screen, which sizes the ASS canvas: the first video stream that is not a
 * cover image, its width stretched by the sample aspect ratio, and width and height swapped
 * for a 90° or 270° rotation, which ffmpeg applies before any filter.
 */
export function displayGeometry(inspection: MediaInspection): NonNullable<BurnOptions["geometry"]> {
  const video = inspection.streams.find((stream: MediaStreamInfo) => stream.type === "video" && stream.attachedPic !== true);
  if (video?.width === undefined || video.height === undefined || video.width <= 0 || video.height <= 0) {
    throw amberError("internal", "the source video has no picture to draw subtitles on");
  }
  const sar = video.sar ?? { num: 1, den: 1 };
  const width = Math.round((video.width * sar.num) / sar.den);
  const sideways = video.rotation === 90 || video.rotation === 270;
  return { sar, displayWidth: sideways ? video.height : width, displayHeight: sideways ? width : video.height };
}
