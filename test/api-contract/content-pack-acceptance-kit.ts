import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { monotonicFactory } from "ulid";
import { expect } from "vitest";
import { compose } from "../../src/server/compose.ts";
import type { Content } from "../../src/server/domain/content.ts";
import type { ContentFigure } from "../../src/server/domain/figure.ts";
import type { MediaAsset } from "../../src/server/domain/media-asset.ts";
import type { Note } from "../../src/server/domain/note.ts";
import type { TranscriptGeneration, TranscriptRevision, TranscriptSegment } from "../../src/server/domain/transcript.ts";
import type { NotPromise, RepositoryScope } from "../../src/server/ports/repository.ts";
import type { PackExportBuild } from "../../src/server/application/content-pack-engine.ts";
import { assetRef } from "../../src/server/pipeline/stages/source-media.ts";
import type { ChaptersDto } from "../../src/shared/dto/chapter.ts";
import type { ContentDetailDto, ContentListDto, TranscriptRevisionListDto } from "../../src/shared/dto/content.ts";
import type {
  ContentPackExportJobDto,
  ContentPackImportJobDto,
  ContentPackPreviewDto,
  ContentPackSelection,
  PackCollectionDecision,
  PackContentDecision,
  PackPreviewCollection,
  PackPreviewContent,
} from "../../src/shared/dto/content-pack.ts";
import type { FigureListDto } from "../../src/shared/dto/figure.ts";
import type { NoteDto } from "../../src/shared/dto/note.ts";
import type { SpeakerDto } from "../../src/shared/dto/speaker.ts";
import type { TranscriptSegmentPageDto } from "../../src/shared/dto/transcript.ts";
import type { AppError } from "../../src/shared/errors.ts";
import type { SegmentId } from "../../src/shared/ids.ts";
import { AVATAR_WEBP, FIGURE_WEBP, MP4_HEAD, sha256, writeSamplePack } from "../fixtures/content-pack/pack.ts";
import { composeServerStack, STACK_ORIGIN, STACK_PASSWORD, type ComposedStack, type StackRequest } from "../fixtures/server/composed-stack.ts";
import { tempDataDir } from "../tools/sqlite.ts";

/**
 * The content pack acceptance matrix's own kit: server stacks and their users, the pack
 * routes driven as the SPA drives them (export → download → upload → preview → decisions →
 * commit), libraries seeded straight through the repository, and readers that look at the
 * result through the API.
 */

export const T0 = 1_790_000_000_000;
const POLL_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 15;

// ---------------------------------------------------------------------------------------------
// Stacks and users

/** One user's library on one server instance; a fresh user is a fresh library. */
export interface Device {
  stack: ComposedStack;
  id: string;
  username: string;
  cookie: string;
}

const stacks: ComposedStack[] = [];
let userCount = 0;

/** A composed server-mode stack whose start-up recovery has run, as the real server's has before it takes requests. */
export async function openStack(): Promise<ComposedStack> {
  const stack = await composeServerStack();
  await stack.composition.startBackground();
  stacks.push(stack);
  return stack;
}

export async function closeStacks(): Promise<void> {
  for (const stack of stacks.splice(0)) await stack.close();
}

/** Shuts one stack down now, as a stopped server; it is not closed again at the end. */
export async function closeStack(stack: ComposedStack): Promise<void> {
  const at = stacks.indexOf(stack);
  if (at >= 0) stacks.splice(at, 1);
  await stack.close();
}

/** The password a new user is created with; the first login replaces it with `STACK_PASSWORD`. */
const FIRST_PASSWORD = "first-placeholder-pw";

function sessionCookieOf(response: LightMyRequestResponse): string | undefined {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return values.map((value) => /^(__Host-amber-session=[^;]+)/u.exec(value)?.[1]).find((value) => value !== undefined);
}

/**
 * A user created by the administrator and logged in once. Unlike the stack fixture's, it never
 * tries a wrong password first, so a case may create many users without the login throttle
 * (which counts failed attempts per address) refusing them.
 */
export async function addUser(stack: ComposedStack, prefix = "user"): Promise<Device> {
  userCount += 1;
  const username = `${prefix}-${userCount}`;
  const created = await stack.send({ method: "POST", url: "/api/admin/users", payload: { username, password: FIRST_PASSWORD, role: "user" } }, stack.adminCookie);
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { id: string }).id;
  const login = await stack.send({ method: "POST", url: "/api/auth/login", payload: { username, password: FIRST_PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  let cookie = sessionCookieOf(login) as string;
  if ((login.json() as { mustChangePassword: boolean }).mustChangePassword) {
    const changed = await stack.send({ method: "POST", url: "/api/auth/change-password", payload: { currentPassword: FIRST_PASSWORD, newPassword: STACK_PASSWORD } }, cookie);
    expect(changed.statusCode, changed.body).toBe(200);
    cookie = sessionCookieOf(changed) ?? cookie;
  }
  return { stack, id, username, cookie };
}

export function run<T>(device: Device, work: (scope: RepositoryScope) => NotPromise<T>): T {
  return device.stack.composition.repository.withTransaction(work);
}

export function send(device: Device, request: StackRequest): Promise<LightMyRequestResponse> {
  return device.stack.send(request, device.cookie);
}

export async function ok<T>(device: Device, request: StackRequest, status = 200): Promise<T> {
  const response = await send(device, request);
  expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(status);
  return (response.body === "" ? undefined : response.json()) as T;
}

/** The `AppError` of a request that must fail with `status`. */
export async function refused(device: Device, request: StackRequest, status: number): Promise<AppError> {
  const response = await send(device, request);
  expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(status);
  return (response.json() as { error: AppError }).error;
}

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    value = await read();
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Export

export type PickedContent = ContentPackSelection["contents"][number];

/** One Content of a selection: the given revisions, figures and notes off unless asked, the given media. */
export function pick(contentId: string, revisionIds: readonly string[] = [], options: { figures?: boolean; notes?: boolean; media?: readonly string[] } = {}): PickedContent {
  return { contentId, revisionIds: [...revisionIds], figures: options.figures ?? false, notes: options.notes ?? false, mediaAssetIds: [...(options.media ?? [])] };
}

/** Everything of a Content: every revision, figures, notes and the given media. */
export function everything(device: Device, contentId: string, media: readonly string[] = []): PickedContent {
  const revisionIds = run(device, (scope) => scope.transcripts.listRevisions(device.id, contentId).map((revision) => revision.id));
  return pick(contentId, revisionIds, { figures: true, notes: true, media });
}

export function selection(contents: readonly PickedContent[], collectionIds: readonly string[] = []): ContentPackSelection {
  return { contents: [...contents], collectionIds: [...collectionIds] };
}

export async function startExport(device: Device, picked: ContentPackSelection): Promise<string> {
  return (await ok<{ jobId: string }>(device, { method: "POST", url: "/api/content-packs/exports", payload: { selection: picked } }, 202)).jobId;
}

/** The export job once it stopped running. */
export function exportDone(device: Device, jobId: string): Promise<ContentPackExportJobDto> {
  return until(
    () => ok<ContentPackExportJobDto>(device, { method: "GET", url: `/api/content-packs/exports/${jobId}` }),
    (job) => job.status !== "running",
  );
}

/** Exports and downloads a pack; the bytes as the browser saved them. */
export async function exportPack(device: Device, picked: ContentPackSelection): Promise<Buffer> {
  const jobId = await startExport(device, picked);
  const job = await exportDone(device, jobId);
  expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
  const file = await send(device, { method: "GET", url: `/api/content-packs/exports/${jobId}/file` });
  expect(file.statusCode).toBe(200);
  return file.rawPayload;
}

// ---------------------------------------------------------------------------------------------
// Import

export type PreviewedJob = ContentPackImportJobDto & { preview: ContentPackPreviewDto };

/** The upload request exactly as the SPA sends it: the raw pack as the request body. */
export function upload(device: Device, pack: Buffer): Promise<LightMyRequestResponse> {
  return device.stack.composition.app.inject({
    method: "POST",
    url: "/api/content-packs/imports/upload",
    headers: { "x-amber-request": "1", origin: STACK_ORIGIN, cookie: device.cookie, "content-type": "application/octet-stream", "x-amber-filename": "pack.amberpack" },
    payload: pack,
  });
}

export function importJob(device: Device, jobId: string): Promise<ContentPackImportJobDto> {
  return ok<ContentPackImportJobDto>(device, { method: "GET", url: `/api/content-packs/imports/${jobId}` });
}

/** The import job once it left the given statuses. */
export function importSettled(device: Device, jobId: string, passing: readonly ContentPackImportJobDto["status"][]): Promise<ContentPackImportJobDto> {
  return until(
    () => importJob(device, jobId),
    (job) => !passing.includes(job.status),
  );
}

/** Uploads a pack and waits for its preview, which must succeed. */
export async function previewPack(device: Device, pack: Buffer): Promise<PreviewedJob> {
  const response = await upload(device, pack);
  expect(response.statusCode, response.body).toBe(202);
  const { jobId } = response.json() as { jobId: string };
  const job = await importSettled(device, jobId, ["receiving", "previewing"]);
  expect(job.status, JSON.stringify(job.error)).toBe("awaiting_decisions");
  return job as PreviewedJob;
}

/** Uploads a pack whose preview must fail; the job as it ended. */
export async function failedPreview(device: Device, pack: Buffer): Promise<ContentPackImportJobDto> {
  const response = await upload(device, pack);
  expect(response.statusCode, response.body).toBe(202);
  const { jobId } = response.json() as { jobId: string };
  const job = await importSettled(device, jobId, ["receiving", "previewing"]);
  expect(job.status).toBe("failed");
  return job;
}

/** Overrides of the default decision of one carried Content; `"skip"` leaves it out, `undefined` fields are removed. */
export type Decide = (item: PackPreviewContent) => { [K in keyof PackContentDecision]?: PackContentDecision[K] | undefined } | "skip";

/** What the import dialog offers by default: a new Content or a merge into the single match, every category, every new or missing file. */
export function defaultDecision(item: PackPreviewContent): PackContentDecision {
  return {
    key: item.key,
    action: item.diff.targetContentId === undefined ? "import" : "merge",
    ...(item.diff.targetContentId === undefined ? {} : { targetContentId: item.diff.targetContentId }),
    revisions: true,
    figures: true,
    notes: true,
    mediaKeys: item.diff.media.filter((media) => media.state === "new" || media.state === "fill").map((media) => media.key),
  };
}

export const collectionDefault = (item: PackPreviewCollection): PackCollectionDecision =>
  item.match === "same" ? { key: item.key, action: "join", targetCollectionId: (item.candidates[0] as { collectionId: string }).collectionId } : { key: item.key, action: "create" };

export function decisionsOf(job: PreviewedJob, decide: Decide = () => ({})): { contents: PackContentDecision[]; collections: PackCollectionDecision[] } {
  const contents = job.preview.contents.map((item): PackContentDecision => {
    const chosen = decide(item);
    if (chosen === "skip") return { key: item.key, action: "skip", revisions: false, figures: false, notes: false };
    const merged: Record<string, unknown> = { ...defaultDecision(item), ...chosen };
    for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
    return merged as unknown as PackContentDecision;
  });
  return { contents, collections: job.preview.collections.map(collectionDefault) };
}

/** Commits the decisions and waits for the import to end; the job as it ended. */
export async function commitPack(device: Device, job: PreviewedJob, decide: Decide = () => ({})): Promise<ContentPackImportJobDto> {
  await ok(device, { method: "POST", url: `/api/content-packs/imports/${job.jobId}/commit`, payload: decisionsOf(job, decide) }, 202);
  return importSettled(device, job.jobId, ["importing"]);
}

/** Preview and commit; the import must finish. */
export async function importPack(device: Device, pack: Buffer, decide: Decide = () => ({})): Promise<{ preview: ContentPackPreviewDto; done: ContentPackImportJobDto }> {
  const job = await previewPack(device, pack);
  const done = await commitPack(device, job, decide);
  expect(done.status, JSON.stringify(done.error)).toBe("finished");
  return { preview: job.preview, done };
}

export async function discard(device: Device, jobId: string): Promise<void> {
  await ok(device, { method: "DELETE", url: `/api/content-packs/imports/${jobId}` }, 204);
}

export function only<T>(items: readonly T[] | undefined): T {
  expect(items).toHaveLength(1);
  return (items as readonly T[])[0] as T;
}

// ---------------------------------------------------------------------------------------------
// Seeding a library

const nextId = monotonicFactory();
export const newId = (): string => nextId();

export function addContent(device: Device, overrides: Partial<Content> = {}): string {
  const id = overrides.id ?? newId();
  run(device, (scope) =>
    scope.contents.insert({ id, userId: device.id, source: { kind: "local" }, processingStatus: "succeeded", title: "讲座", durationMs: 60_000, createdAt: T0, updatedAt: T0, ...overrides }),
  );
  return id;
}

export interface SeededRevision {
  id: string;
  segments: TranscriptSegment[];
}

export function addRevision(
  device: Device,
  contentId: string,
  options: {
    kind: TranscriptRevision["kind"];
    parent?: SeededRevision;
    texts: readonly string[];
    speakers?: ReadonlyArray<string | undefined>;
    words?: boolean;
    paragraphs?: boolean;
    language?: string;
    generation?: TranscriptGeneration;
    createdAt?: number;
    originId?: string;
  },
): SeededRevision {
  const id = newId();
  const segments = options.texts.map((text, ordinal): TranscriptSegment => {
    const speakerId = options.speakers?.[ordinal];
    return {
      id: newId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text,
      ...(options.words === true ? { words: [{ text, startMs: ordinal * 1000, endMs: ordinal * 1000 + 800 }] } : {}),
      ...(speakerId === undefined ? {} : { speakerId }),
      ...(options.paragraphs === true ? { paragraphStart: ordinal % 2 === 0 } : {}),
      sourceSegmentIds: options.parent === undefined ? [] : [(options.parent.segments[ordinal] as TranscriptSegment).id],
    };
  });
  const revision: TranscriptRevision = {
    id,
    contentId,
    kind: options.kind,
    ...(options.parent === undefined ? {} : { parentRevisionId: options.parent.id }),
    language: options.language ?? "zh-CN",
    timingFidelity: options.words === true ? "exact_words" : options.kind === "corrected" || options.kind === "manual" ? "inherited_segment" : "segment_only",
    generation: options.generation ?? { kind: "imported", format: "srt" },
    segmentCount: segments.length,
    ...(options.originId === undefined ? {} : { originId: options.originId }),
    createdAt: options.createdAt ?? T0,
  };
  run(device, (scope) => scope.transcripts.insertRevision(device.id, revision, segments));
  return { id, segments };
}

export function addFigure(device: Device, contentId: string, bytes: Uint8Array, overrides: Partial<ContentFigure> = {}): string {
  const id = overrides.id ?? newId();
  run(device, (scope) =>
    scope.figures.insert(
      { id, contentId, userId: device.id, source: "upload", displayMs: 5000, sortKey: 0, widthRatio: 0.7, image: { width: 64, height: 48, bytes: bytes.length, sha256: sha256(bytes) }, version: 1, createdAt: T0, updatedAt: T0, ...overrides },
      bytes,
    ),
  );
  return id;
}

export function addNote(device: Device, contentId: string, revision: SeededRevision, overrides: Partial<Note> = {}): string {
  const id = overrides.id ?? newId();
  const segment = revision.segments[0] as TranscriptSegment;
  run(device, (scope) =>
    scope.notes.insert({
      id,
      userId: device.id,
      contentId,
      transcriptRevisionId: revision.id,
      startSegmentId: segment.id,
      startOffset: 0,
      endSegmentId: segment.id,
      endOffset: 2,
      quote: segment.text.slice(0, 2),
      mark: "underline",
      color: "yellow",
      comment: "评论",
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    }),
  );
  return id;
}

/** Bytes an MP4 container sniff accepts: the `ftyp` box first, the rest noise. */
export function mp4Bytes(size = 4096): Buffer {
  return Buffer.concat([MP4_HEAD, randomBytes(Math.max(0, size - MP4_HEAD.length))]);
}

/** Absolute path of a data-store ref (managed uploads) or cache ref on a stack. */
export function dataPath(stack: ComposedStack, ref: string): string {
  return join(stack.dataDir, ...ref.split("/"));
}

/** A server-mode original: the file in managed storage and its row. */
export function addOriginal(device: Device, contentId: string, bytes: Buffer = mp4Bytes(), overrides: Partial<MediaAsset> = {}): MediaAsset {
  const id = overrides.id ?? newId();
  const asset: MediaAsset = {
    id,
    userId: device.id,
    contentId,
    kind: "managed_upload",
    storageRef: assetRef({ userId: device.id, contentId, id }),
    displayName: "lecture.mp4",
    mimeType: "video/mp4",
    sizeBytes: bytes.length,
    fingerprint: `sha256:${sha256(bytes)}`,
    availability: "available",
    retentionPolicy: "keep",
    createdAt: T0,
    ...overrides,
  };
  if (asset.availability === "available") {
    const path = dataPath(device.stack, asset.storageRef);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  run(device, (scope) => scope.mediaAssets.insert(asset));
  return asset;
}

/** A platform cache: the file in the cache directory under its name and its row. */
export function addCache(device: Device, contentId: string, fileName: string, bytes: Buffer, overrides: Partial<MediaAsset> = {}, options: { digest?: boolean } = {}): MediaAsset {
  const recorded: MediaAsset = {
    id: newId(),
    userId: device.id,
    contentId,
    kind: "platform_cache",
    storageRef: `media/${fileName}`,
    mimeType: "video/mp4",
    sizeBytes: bytes.length,
    quality: /\[(\d+)P\]/u.exec(fileName)?.[1] ?? "",
    qualityVerified: true,
    fingerprint: `sha256:${sha256(bytes)}`,
    availability: "available",
    retentionPolicy: "evictable",
    createdAt: T0,
    ...overrides,
  };
  // A cache downloaded without its digest recorded.
  const { fingerprint: _fingerprint, ...unrecorded } = recorded;
  const asset: MediaAsset = options.digest === false ? unrecorded : recorded;
  const path = dataPath(device.stack, asset.storageRef);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  run(device, (scope) => scope.mediaAssets.insert(asset));
  return asset;
}

export const ASR_GENERATION: TranscriptGeneration = { kind: "asr", asrProfileId: "profile-a", modelId: "paraformer-v2" };
export const LLM_GENERATION: TranscriptGeneration = {
  kind: "llm",
  modelRef: { providerProfileId: "profile-llm", modelId: "deepseek-chat", providerNameSnapshot: "中转", modelDisplaySnapshot: "DeepSeek V3" },
  promptRef: { id: "proofread", version: 1 },
  promptSnapshot: "PROMPT TEXT THAT MUST NOT TRAVEL",
};

export const LECTURE_TEXTS = ["大家好今天讲检索", "检索增强生成是什么", "我们先看一个例子", "谢谢大家"] as const;
/** The anchored figure's caption: long enough for the trigram search. */
export const FIGURE_CAPTION = "检索增强架构示意图";
export const SECOND_FIGURE_WEBP = new Uint8Array(readFileSync(join(import.meta.dirname, "../fixtures/images/lossless.webp")));

export interface Lecture {
  contentId: string;
  original: MediaAsset;
  originalBytes: Buffer;
  asr: SeededRevision;
  corrected: SeededRevision;
  translated: SeededRevision;
  archived: SeededRevision;
  noteId: string;
  figures: { anchored: string; loose: string };
}

/**
 * A lecture: its managed original, speakers 0 (named, confirmed, with a photo) and 1, an ASR
 * transcript, its proofread (the primary, speakers reviewed), an English translation of that
 * (the current one), an archived import, a note on the proofread and two figures, one anchored
 * to a sentence of the proofread and one placed by time.
 */
export function seedLecture(device: Device, title = "讲座"): Lecture {
  const contentId = addContent(device, { title });
  const originalBytes = mp4Bytes(8192);
  const original = addOriginal(device, contentId, originalBytes);
  run(device, (scope) => {
    scope.speakers.insert(device.id, contentId, [{ id: "0", name: "甲老师", nameConfirmedAt: T0 }, { id: "1", name: "乙同学" }], T0);
    scope.speakers.update(device.id, contentId, "0", { avatar: { mime: "image/webp", bytes: AVATAR_WEBP } }, T0);
  });
  const speakers = ["0", "1", "0", undefined];
  const asr = addRevision(device, contentId, { kind: "asr", texts: LECTURE_TEXTS, speakers, words: true, generation: ASR_GENERATION, createdAt: T0 + 1 });
  const corrected = addRevision(device, contentId, {
    kind: "corrected",
    parent: asr,
    texts: LECTURE_TEXTS.map((text) => `${text}。`),
    speakers,
    paragraphs: true,
    generation: LLM_GENERATION,
    createdAt: T0 + 2,
  });
  const translated = addRevision(device, contentId, {
    kind: "translated",
    parent: corrected,
    texts: ["Hello.", "What is RAG?", "An example.", "Thanks."],
    speakers,
    language: "en",
    generation: LLM_GENERATION,
    createdAt: T0 + 3,
  });
  const archived = addRevision(device, contentId, { kind: "imported", texts: ["旧字幕"], createdAt: T0 + 4 });
  run(device, (scope) => {
    scope.contents.setPrimaryTranscript(device.id, contentId, corrected.id, T0);
    scope.translations.setCurrent(device.id, contentId, "en", translated.id, newId());
    scope.transcripts.setArchived(device.id, archived.id, T0 + 10);
    scope.speakerConfirmations.set(device.id, contentId, corrected.id, T0 + 11);
  });
  const noteId = addNote(device, contentId, corrected);
  const anchored = addFigure(device, contentId, FIGURE_WEBP, {
    source: "capture",
    capturedAtMs: 2100,
    displayMs: 2100,
    caption: FIGURE_CAPTION,
    anchor: { revisionId: corrected.id, segmentId: (corrected.segments[2] as TranscriptSegment).id, side: "before" },
  });
  const loose = addFigure(device, contentId, SECOND_FIGURE_WEBP, { displayMs: 3500, sortKey: 1 });
  return { contentId, original, originalBytes, asr, corrected, translated, archived, noteId, figures: { anchored, loose } };
}

/** Every revision of a lecture, oldest first. */
export const lectureRevisions = (lecture: Lecture): string[] => [lecture.asr.id, lecture.corrected.id, lecture.translated.id, lecture.archived.id];

// ---------------------------------------------------------------------------------------------
// Reading a library through the API

export const contentOf = (device: Device, contentId: string): Promise<ContentDetailDto> => ok<ContentDetailDto>(device, { method: "GET", url: `/api/contents/${contentId}` });

export const contentsOf = async (device: Device): Promise<ContentListDto["items"]> => (await ok<ContentListDto>(device, { method: "GET", url: "/api/contents?limit=100" })).items;

export const revisionsOf = (device: Device, contentId: string): Promise<TranscriptRevisionListDto> =>
  ok<TranscriptRevisionListDto>(device, { method: "GET", url: `/api/contents/${contentId}/transcript/revisions` });

export const segmentsOf = async (device: Device, revisionId: string): Promise<TranscriptSegmentPageDto["items"]> =>
  (await ok<TranscriptSegmentPageDto>(device, { method: "GET", url: `/api/transcript/revisions/${revisionId}/segments?limit=500` })).items;

export const speakersOf = async (device: Device, contentId: string): Promise<SpeakerDto[]> =>
  (await ok<{ items: SpeakerDto[] }>(device, { method: "GET", url: `/api/contents/${contentId}/speakers` })).items;

export const figuresOf = (device: Device, contentId: string): Promise<FigureListDto> => ok<FigureListDto>(device, { method: "GET", url: `/api/contents/${contentId}/figures` });

export const notesOf = async (device: Device, contentId: string): Promise<NoteDto[]> => (await ok<{ items: NoteDto[] }>(device, { method: "GET", url: `/api/contents/${contentId}/notes` })).items;

export const chaptersOf = (device: Device, contentId: string): Promise<ChaptersDto> => ok<ChaptersDto>(device, { method: "GET", url: `/api/contents/${contentId}/chapters` });

export async function figureImage(device: Device, figureId: string): Promise<Buffer> {
  const response = await send(device, { method: "GET", url: `/api/figures/${figureId}/image` });
  expect(response.statusCode).toBe(200);
  return response.rawPayload;
}

export async function mediaBytes(device: Device, assetId: string): Promise<Buffer> {
  const response = await send(device, { method: "GET", url: `/api/media/${assetId}` });
  expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
  return response.rawPayload;
}

/** A revision as a reader sees it: sentences with their timing, words, paragraphs and speaker names. */
export async function readingOf(device: Device, contentId: string, revisionId: string) {
  const names = new Map((await speakersOf(device, contentId)).map((speaker) => [speaker.id, speaker.name ?? `#${speaker.ordinal}`]));
  return (await segmentsOf(device, revisionId)).map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    words: segment.words,
    speaker: segment.speakerId === undefined ? undefined : names.get(segment.speakerId),
    paragraphStart: segment.paragraphStart,
  }));
}

/** A Content's revisions here by the identity they came with (or their own id). */
export function revisionsByOrigin(device: Device, contentId: string): Map<string, TranscriptRevision> {
  return new Map(run(device, (scope) => scope.transcripts.listRevisions(device.id, contentId)).map((revision) => [revision.originId ?? revision.id, revision]));
}

/** The local Contents carrying an identity. */
export const contentsWithIdentity = (device: Device, key: string): Content[] => run(device, (scope) => scope.transferOrigins.contentsByIdentity(device.id, key));

// ---------------------------------------------------------------------------------------------
// Packs built by hand

/** A pack of a sample build, written by the real writer; its bytes. */
export async function packOf(build: PackExportBuild, dir: string): Promise<Buffer> {
  const target = join(dir, `${newId()}.amberpack`);
  await writeSamplePack(target, build);
  return readFileSync(target);
}

/** Replaces the first figure image of the build's first Content, its document following the bytes. */
export function swapFigureImage(build: PackExportBuild, bytes: Uint8Array): string {
  const content = build.contents[0] as PackExportBuild["contents"][number];
  const figure = content.document.figures[0] as PackExportBuild["contents"][number]["document"]["figures"][number];
  const at = content.images.findIndex((image) => image.entry === figure.entry);
  content.images[at] = { entry: figure.entry, bytes };
  figure.image = { ...figure.image, bytes: bytes.length, sha256: sha256(bytes) };
  return figure.entry;
}

const le32 = (bytes: Uint8Array, at: number): number => (bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16) | (((bytes[at + 3] as number) << 24) >>> 0);
function setLe32(bytes: Buffer, at: number, value: number): void {
  bytes.writeUInt32LE(value >>> 0, at);
}

/** A still WebP with one more RIFF chunk appended (and the RIFF size kept exact). */
export function webpWithChunk(webp: Uint8Array, type: string, payload: Uint8Array): Buffer {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
  chunk.write(type, 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  chunk.set(payload, 8);
  const out = Buffer.concat([Buffer.from(webp), chunk]);
  setLe32(out, 4, out.length - 8);
  return out;
}

/** A WebP whose RIFF size disagrees with its length by `delta`. */
export function webpWithRiffSize(webp: Uint8Array, delta: number): Buffer {
  const out = Buffer.from(webp);
  setLe32(out, 4, le32(webp, 4) + delta);
  return out;
}

/** A lossy (`VP8 `) WebP whose frame claims another width, every length still exact. */
export function webpWithWidth(webp: Uint8Array, width: number): Buffer {
  const out = Buffer.from(webp);
  // RIFF header (12) + chunk header (8) + frame tag (3) + start code (3): the 14-bit width.
  out.writeUInt16LE(width, 12 + 8 + 6);
  return out;
}

// ---------------------------------------------------------------------------------------------
// A crash, as a kill would leave it

/**
 * Copies a stack's data directory as a crash at this instant would leave it. Called between
 * transactions (the repository is synchronous), the database file and its WAL are consistent;
 * the shared-memory index is left out and rebuilt from the WAL on the next open.
 */
export function snapshotDataDir(stack: ComposedStack): string {
  const target = tempDataDir("amber-crash-");
  cpSync(stack.dataDir, target, { recursive: true, filter: (source) => !source.endsWith("-shm") });
  return target;
}

/** The import journals waiting in a data directory, parsed. */
export function journalsIn(dataDir: string): Array<{ jobId: string; owner: string; files: Array<{ assetId: string; finalPath: string; tempPath: string; contentKey: string }>; contents: Record<string, string> }> {
  const dir = join(dataDir, "tmp", "content-packs", "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(dir, name), "utf8"))];
      } catch {
        return [];
      }
    });
}

/**
 * The server-mode composition started again on an existing data directory, as a restarted
 * server would be; users log in with the password the stack fixture gave them.
 */
export async function reopen(dataDir: string): Promise<{ stack: ComposedStack; login(username: string): Promise<string> }> {
  const webRoot = tempDataDir("amber-stack-web-");
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><div id=root></div>");
  const composition = await compose({
    mode: "server",
    dataDir,
    binDir: dataDir,
    logLevel: "error",
    logDestination: { write: () => undefined },
    env: { AMBER_LOW_WATER_FREE_GB: "0.001", AMBER_LOW_WATER_FREE_RATIO: "0" },
    publicOrigin: STACK_ORIGIN,
    trustedProxyCidrs: [],
    webRoot,
  });
  const sendRaw: ComposedStack["send"] = (request, cookie) =>
    composition.app.inject({
      method: request.method,
      url: request.url,
      headers: {
        "x-amber-request": "1",
        origin: STACK_ORIGIN,
        ...(cookie === undefined ? {} : { cookie }),
        ...(request.payload === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.payload === undefined ? {} : { payload: JSON.stringify(request.payload) }),
    });
  const stack: ComposedStack = {
    composition,
    dataDir,
    send: sendRaw,
    login: () => Promise.reject(new Error("use reopen().login")),
    adminCookie: "",
    createUser: () => Promise.reject(new Error("not on a reopened stack")),
    close: () => composition.shutdown(),
  };
  stacks.push(stack);
  return {
    stack,
    async login(username) {
      const response = await sendRaw({ method: "POST", url: "/api/auth/login", payload: { username, password: STACK_PASSWORD } });
      expect(response.statusCode, response.body).toBe(200);
      const cookie = sessionCookieOf(response);
      if (cookie === undefined) throw new Error("no session cookie");
      return cookie;
    },
  };
}
