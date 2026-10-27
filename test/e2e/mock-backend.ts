import type { Page, Request, Route } from "@playwright/test";
import { contentDetailDtoSchema, contentDtoSchema, contentListDtoSchema, transcriptRevisionListDtoSchema } from "../../src/shared/dto/content.ts";
import {
  asrModelTestRequestSchema,
  asrModelTestResultDtoSchema,
  asrProfileCreateSchema,
  asrProfileDtoSchema,
  asrProfileListDtoSchema,
  asrProfileOrderRequestSchema,
  asrProfilePatchSchema,
  type AsrProfileDto,
  type AsrProfileModelInput,
} from "../../src/shared/dto/asr-profile.ts";
import { ASR_PRESETS, asrModelFamily } from "../../src/shared/asr-presets.ts";
import { modelPricingRequestSchema } from "../../src/shared/dto/model-pricing.ts";
import type { ModelPricing } from "../../src/shared/model-pricing.ts";
import { chaptersDtoSchema } from "../../src/shared/dto/chapter.ts";
import { collectionListDtoSchema } from "../../src/shared/dto/collection.ts";
import { importResponseSchema } from "../../src/shared/dto/import.ts";
import { platformAccountListDtoSchema } from "../../src/shared/dto/platform-account.ts";
import { providerListDtoSchema, providerProfileDtoSchema, type ProviderProfileDto } from "../../src/shared/dto/provider.ts";
import { userSettingsDtoSchema, userSettingsPatchSchema, type UserSettingsDto } from "../../src/shared/dto/settings.ts";
import { contentSummariesDtoSchema, summaryTemplateListDtoSchema } from "../../src/shared/dto/summary.ts";
import { authMeDtoSchema, versionDtoSchema } from "../../src/shared/dto/system.ts";
import { taskDetailDtoSchema, taskListDtoSchema, type StageRunDto, type TaskDetailDto } from "../../src/shared/dto/task.ts";
import { noteCreateRequestSchema, noteDtoSchema, noteGroupsDtoSchema, noteListDtoSchema, notePatchRequestSchema, type NoteDto, type NoteViewDto } from "../../src/shared/dto/note.ts";
import { segmentMapDtoSchema, transcriptSegmentPageDtoSchema, type TranscriptSegmentDto } from "../../src/shared/dto/transcript.ts";
import { API_PAGE_SIZE_DEFAULT, NOTE_SPAN_MAX_SEGMENTS, NOTES_PER_CONTENT_MAX } from "../../src/shared/defaults.ts";
import type { NoteColor, NoteMark, StageId, StageStatus } from "../../src/shared/enums.ts";
import { ERROR_CLASS_DEFAULTS, errorResponseSchema, type AppErrorDetails, type ErrorClass } from "../../src/shared/errors.ts";
import { isMarked, readingSeparator } from "../../src/shared/reading.ts";
import { handleChat } from "./mock-chat.ts";
import { handleOtherModels, OtherModelsState } from "./mock-other-models.ts";
import { handleOutputs } from "./mock-outputs.ts";
import { handleSearch } from "./mock-search.ts";
import { handleTrash, TrashState, type LibraryContent, type MockTrash } from "./mock-trash.ts";

/**
 * A deterministic fake of `/api` for the browser smoke: one YouTube lecture imported from
 * /new, processed stage by stage over SSE, then readable with a cited summary; one bilibili
 * lecture already processed. Every body is parsed with the shared schema before it is sent,
 * so the fake cannot drift from the contracts. External hosts are stubbed or aborted: the
 * smoke makes no network request beyond the preview server.
 */

export const YOUTUBE_CONTENT = "01J0000000000000000000YT01";
export const BILIBILI_CONTENT = "01J0000000000000000000BL01";
const TASK = "01J000000000000000000TASK1";
export const REVISION = "01J0000000000000000000REV1";
export const BILI_REVISION = "01J0000000000000000000REV2";
export const PROFILE = "01J0000000000000000000PRF1";
const YOUTUBE_VIDEO = "mockVideo01";
export const BILIBILI_BVID = "BV1mock00001";
export const LOCAL_CONTENT = "01J0000000000000000000LC01";
const LOCAL_ASSET = "01J0000000000000000000AST1";
const LOCAL_REVISION = "01J0000000000000000000REV3";
/** The clip server of the Playwright global setup (CLIP_SERVER_PORT), range-capable like /api/media. */
const LOCAL_CLIP_URL = "http://127.0.0.1:4174/local-player.webm";
export const YOUTUBE_URL = `https://www.youtube.com/watch?v=${YOUTUBE_VIDEO}`;

/** Synthetic library rows of `MockOptions.libraryContents`, numbered from 1, newest first. */
export const syntheticContentId = (index: number): string => `01J0000000000000000000S${String(index).padStart(3, "0")}`;
export const syntheticContentTitle = (index: number): string => `合成内容 ${String(index).padStart(2, "0")}`;

const SEGMENT_COUNT = 12;
const SEGMENT_MS = 10_000;
export const segmentId = (revision: string, index: number): string => `${revision.slice(0, 22)}${String(index).padStart(4, "0")}`;
/** The sentence the summary cites. */
export const CITED_INDEX = 7;
export const CITED_START_MS = CITED_INDEX * SEGMENT_MS;

/** The processing order the SSE events walk through, one stage per event. */
const STAGES: Array<[StageId, StageStatus]> = [
  ["source", "succeeded"],
  ["subtitle", "succeeded"],
  ["asr", "skipped"],
  ["proofread", "succeeded"],
  ["chapter", "succeeded"],
  ["summary", "succeeded"],
];

/** Request bodies POSTed / PUT / PATCHed / DELETEd, for "no model call" assertions. */
export interface MockBackend {
  mutations: Array<{ method: string; path: string; body: unknown }>;
  /** Events delivered so far (0 … STAGES.length + 1). */
  delivered(): number;
  /** The in-memory notes, their request log and fault injection. */
  notes: MockNotes;
  /** The trash: what deletion moved there, plus seeding for the trash page. */
  trash: MockTrash;
}

const now = 1_790_000_000_000;

function stageRun(stage: StageId, status: StageStatus, index: number): StageRunDto {
  return {
    id: `01J000000000000000STAGE${String(index).padStart(3, "0")}`,
    taskId: TASK,
    stage,
    attempt: 1,
    status,
    progress: status === "succeeded" || status === "skipped" ? 1 : 0,
    dependencies: index === 0 ? [] : [STAGES[index - 1]?.[0] as StageId],
    ...(stage === "summary" || stage === "proofread" || stage === "chapter"
      ? { engine: { kind: "llm" as const, modelRef: { providerProfileId: PROFILE, modelId: "mock-model" } } }
      : {}),
  };
}

function taskDetail(done: number): TaskDetailDto {
  const finished = done > STAGES.length;
  return taskDetailDtoSchema.parse({
    id: TASK,
    contentId: YOUTUBE_CONTENT,
    kind: "process_content",
    statusProjection: finished ? "succeeded" : "running",
    targetTitle: "第一讲：模拟课程",
    createdAt: now,
    ...(finished ? { finishedAt: now + 1 } : {}),
    stageRuns: STAGES.map(([stage, status], index) =>
      stageRun(stage, index < done ? status : index === done ? "running" : "pending", index),
    ),
    workUnits: [],
    eventSeq: done,
  });
}

function content(id: string, done: boolean) {
  const youtube = id === YOUTUBE_CONTENT;
  return {
    id,
    source: youtube
      ? { kind: "youtube", sourceUrl: YOUTUBE_URL, platformContentId: YOUTUBE_VIDEO }
      : { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${BILIBILI_BVID}`, platformContentId: BILIBILI_BVID, platformPartId: "1" },
    title: youtube ? "第一讲：模拟课程" : "第二讲：B 站模拟课程",
    durationMs: SEGMENT_COUNT * SEGMENT_MS,
    rawLanguage: "zh-CN",
    ...(done ? { primaryTranscriptRevisionId: youtube ? REVISION : BILI_REVISION } : {}),
    processingStatus: done ? "succeeded" : "running",
    collections: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Processed local uploads, older than every hand-made fixture and a minute apart. */
function syntheticContent(index: number) {
  const createdAt = now - index * 60_000;
  return {
    id: syntheticContentId(index),
    source: { kind: "local" },
    title: syntheticContentTitle(index),
    processingStatus: "succeeded",
    collections: [],
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * A listing answered the way the server pages it: `page` (from 1) of `limit` rows, no
 * `nextCursor`. Without `page` it is the first `limit` rows, as a cursor-less request gets.
 */
function numberedPage<T>(ordered: readonly T[], url: URL): { items: T[]; total: number } {
  const limit = Number(url.searchParams.get("limit") ?? API_PAGE_SIZE_DEFAULT);
  const page = Number(url.searchParams.get("page") ?? 1);
  return { items: ordered.slice((page - 1) * limit, page * limit), total: ordered.length };
}

/** A revision as the revision list returns it: unarchived, nothing blocking. */
export function revisionListItem<T extends object>(revision: T) {
  return {
    ...revision,
    archived: false,
    deletable: false,
    blockers: { children: 0, draft: 0, notes: 0, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0, history: 0 },
    historyArtifacts: [] as unknown[],
    descendantIds: [] as string[],
  };
}

function revision(id: string, contentId: string) {
  return {
    id,
    contentId,
    kind: "platform",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "platform" },
    segmentCount: SEGMENT_COUNT,
    createdAt: now,
  };
}

function segments(revisionId: string) {
  return Array.from({ length: SEGMENT_COUNT }, (_, index) => ({
    id: segmentId(revisionId, index),
    revisionId,
    ordinal: index,
    startMs: index * SEGMENT_MS,
    endMs: (index + 1) * SEGMENT_MS - 500,
    text: `第 ${index + 1} 句模拟字幕。`,
    sourceSegmentIds: [],
  }));
}

const TEMPLATES = [
  { id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false },
  { id: "summary.detailed", builtin: true, name: "summaryTemplate.detailed", currentVersion: 1, deleted: false },
  { id: "summary.terms", builtin: true, name: "summaryTemplate.terms", currentVersion: 1, deleted: false },
];

function summaries(revisionId: string, contentId: string, generated: boolean) {
  const cited = segmentId(revisionId, CITED_INDEX);
  return contentSummariesDtoSchema.parse({
    templates: TEMPLATES.map((template, index) => ({
      template,
      stale: false,
      ...(generated && index === 0
        ? {
            artifactId: `01J00000000000000000ART${contentId.slice(-3)}`,
            current: {
              id: `01J00000000000000000SUM${contentId.slice(-3)}`,
              artifactId: `01J00000000000000000ART${contentId.slice(-3)}`,
              body: `## 摘要\n模拟总结正文 [[seg:${cited}]]。\n## 要点\n- 要点一 [[seg:${segmentId(revisionId, 1)}]]`,
              citations: [
                { transcriptRevisionId: revisionId, segmentId: cited },
                { transcriptRevisionId: revisionId, segmentId: segmentId(revisionId, 1) },
              ],
              transcriptRevisionId: revisionId,
              quality: "normal",
              qualityReasons: [],
              stale: false,
              createdAt: now,
            },
          }
        : {}),
    })),
  });
}

const EMPTY_CAPABILITY = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };

/** Blank pages for the player iframes and a scripted YouTube IFrame API. */
const YT_API_STUB = `
window.__ytSeeks = [];
window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 }, Player: function (el, opts) {
  var self = this; self.t = 0;
  var frame = typeof el === "string" ? document.getElementById(el) : el;
  self.getIframe = function () { return frame; };
  self.seekTo = function (s) { self.t = s; window.__ytSeeks.push(s); };
  self.getCurrentTime = function () { return self.t; };
  self.playVideo = function () {}; self.pauseVideo = function () {}; self.destroy = function () {};
  setTimeout(function () { opts && opts.events && opts.events.onReady && opts.events.onReady({ target: self }); }, 0);
} };
setTimeout(function () { window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 0);
`;

/**
 * An ASR profile's models after a create or update: a kept model keeps its family, price and
 * test time; a new one takes the family it names or the one its provider knows it by.
 */
function asrModels(provider: AsrProfileDto["provider"], previous: AsrProfileDto["models"], input: readonly AsrProfileModelInput[]): AsrProfileDto["models"] {
  const preset = ASR_PRESETS[provider];
  return input.map((model) => {
    const kept = previous.find((item) => item.modelId === model.modelId);
    if (kept !== undefined) return kept;
    const family = asrModelFamily(preset, model);
    return { modelId: model.modelId, ...(family === undefined ? {} : { family: family.id }), available: family !== undefined };
  });
}

/** The single fake Profile; without a context window its model stands for historical data whose context window is unknown. */
export function providerProfile(contextWindowTokens: number | undefined, pricing?: ModelPricing): ProviderProfileDto {
  const limits = contextWindowTokens === undefined ? {} : { contextWindowTokens };
  return providerProfileDtoSchema.parse({
    id: PROFILE,
    name: "模拟模型",
    protocol: "openai_compatible",
    baseURL: "https://llm.example.com/v1",
    models: [
      {
        modelId: "mock-model",
        flags: { declared: EMPTY_CAPABILITY },
        limits: { declared: {}, ...(contextWindowTokens === undefined ? {} : { userOverride: limits }) },
        effective: { flags: EMPTY_CAPABILITY, limits },
        ...(pricing === undefined ? {} : { pricing }),
      },
    ],
    createdAt: now,
    credentialStatus: "configured",
    hasCredential: true,
  });
}


/*
 * Notes. A third, already processed bilibili lecture carries them: an ASR
 * original and its proofread revision (the primary), long enough that the reading view
 * windows its rows, with chapters to select across. The fake keeps notes per page, cuts
 * `quote` and places notes on other revisions the way the server does, simplified to what
 * these revisions need.
 */

export const NOTES_CONTENT = "01J0000000000000000000NT01";
export const NOTES_TITLE = "第三讲：笔记模拟课程";
export const NOTES_BVID = "BV1mocknote1";
export const NOTES_ASR_REVISION = "01J0000000000000000000NTA1";
/** The proofread revision, primary: notes are made on it unless a test picks the ASR original. */
export const NOTES_REVISION = "01J0000000000000000000NTC1";
export const NOTES_SEGMENT_COUNT = 320;
const NOTES_SEGMENT_MS = 4_000;
/** Sentences in [NOTES_LONG_FROM, NOTES_LONG_TO) are long and each a paragraph of its own, so a few of them fill several screens. */
export const NOTES_LONG_FROM = 200;
const NOTES_LONG_TO = 260;
/** First sentence of each chapter; the second chapter starts close to the top for cross-chapter selections. */
export const NOTES_CHAPTER_STARTS = [0, 4, 100, NOTES_LONG_FROM] as const;
/** The one sentence proofreading reworded: notes on it show as whole sentences on the ASR original. */
export const NOTES_EDITED_INDEX = 2;
/** A proofread sentence without a source: notes on it cannot be placed on the ASR original. */
export const NOTES_UNSOURCED_INDEX = 5;

/** Segment ids of the notes lecture; unlike `segmentId`, the two revisions never share one. */
export const noteSegmentId = (revision: string, index: number): string => `${revision.slice(0, 20)}${revision.slice(-2)}${String(index).padStart(4, "0")}`;

/** The text of a sentence of the notes lecture; the ASR original misheard 笔记 in NOTES_EDITED_INDEX. */
export function noteSentence(revisionId: string, index: number): string {
  if (index >= NOTES_LONG_FROM && index < NOTES_LONG_TO) {
    return `第 ${index + 1} 句：${"这是一段很长的讲解，用来撑开阅读区域，".repeat(6)}到此结束。`;
  }
  const word = revisionId === NOTES_ASR_REVISION && index === NOTES_EDITED_INDEX ? "比记" : "笔记";
  return `第 ${index + 1} 句：学习${word}要点在这里展开说明。`;
}

function notesRevision(id: string) {
  const asr = id === NOTES_ASR_REVISION;
  return {
    id,
    contentId: NOTES_CONTENT,
    kind: asr ? "asr" : "corrected",
    ...(asr ? {} : { parentRevisionId: NOTES_ASR_REVISION }),
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: asr ? "asr" : "llm" },
    segmentCount: NOTES_SEGMENT_COUNT,
    createdAt: asr ? now : now + 1,
  } as const;
}

export function notesSegments(revisionId: string): TranscriptSegmentDto[] {
  const asr = revisionId === NOTES_ASR_REVISION;
  return Array.from({ length: NOTES_SEGMENT_COUNT }, (_, index) => ({
    id: noteSegmentId(revisionId, index),
    revisionId,
    ordinal: index,
    startMs: index * NOTES_SEGMENT_MS,
    endMs: (index + 1) * NOTES_SEGMENT_MS - 200,
    text: noteSentence(revisionId, index),
    paragraphStart: (index >= NOTES_LONG_FROM && index < NOTES_LONG_TO) || index % 2 === 0,
    sourceSegmentIds: asr || index === NOTES_UNSOURCED_INDEX ? [] : [noteSegmentId(NOTES_ASR_REVISION, index)],
  }));
}

function notesChapters() {
  const revision = {
    id: "01J0000000000000000000NTCH",
    artifactId: "01J0000000000000000000NTCA",
    origin: { kind: "platform" },
    chapters: NOTES_CHAPTER_STARTS.map((start, index) => ({
      startMs: start * NOTES_SEGMENT_MS,
      endMs: (NOTES_CHAPTER_STARTS[index + 1] ?? NOTES_SEGMENT_COUNT) * NOTES_SEGMENT_MS,
      title: `第 ${index + 1} 章`,
    })),
    quality: "normal",
    qualityReasons: [],
    stale: false,
    createdAt: now,
  };
  return chaptersDtoSchema.parse({ artifactId: revision.artifactId, current: revision, revisions: [revision] });
}

function notesContent() {
  return {
    id: NOTES_CONTENT,
    source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${NOTES_BVID}`, platformContentId: NOTES_BVID, platformPartId: "1" },
    title: NOTES_TITLE,
    durationMs: NOTES_SEGMENT_COUNT * NOTES_SEGMENT_MS,
    rawLanguage: "zh-CN",
    primaryTranscriptRevisionId: NOTES_REVISION,
    processingStatus: "succeeded",
    collections: [],
    createdAt: now,
    updatedAt: now,
  };
}

interface KnownRevision {
  contentId: string;
  kind: string;
  parentRevisionId?: string;
  segments: () => TranscriptSegmentDto[];
}

/** Every revision a note may be anchored on or shown in. */
function knownRevisions(): Map<string, KnownRevision> {
  return new Map<string, KnownRevision>([
    [REVISION, { contentId: YOUTUBE_CONTENT, kind: "platform", segments: () => segments(REVISION) }],
    [BILI_REVISION, { contentId: BILIBILI_CONTENT, kind: "platform", segments: () => segments(BILI_REVISION) }],
    [NOTES_ASR_REVISION, { contentId: NOTES_CONTENT, kind: "asr", segments: () => notesSegments(NOTES_ASR_REVISION) }],
    [NOTES_REVISION, { contentId: NOTES_CONTENT, kind: "corrected", parentRevisionId: NOTES_ASR_REVISION, segments: () => notesSegments(NOTES_REVISION) }],
  ]);
}

const CONTENT_TITLES: Record<string, string> = {
  [YOUTUBE_CONTENT]: "第一讲：模拟课程",
  [BILIBILI_CONTENT]: "第二讲：B 站模拟课程",
  [NOTES_CONTENT]: NOTES_TITLE,
};

/** The anchor of a note, as POSTed. */
export interface NoteAnchorInput {
  transcriptRevisionId: string;
  startSegmentId: string;
  startOffset: number;
  endSegmentId: string;
  endOffset: number;
}

/** A fault the next note creation runs into, once. */
export type NoteCreateFault =
  /** The note and its idempotency record are stored, then the connection drops: the outcome is unknown to the client. */
  | "drop_response"
  /** A 500 before anything is written. */
  | "fail_before_write";

/** One request to the notes endpoints, with the Idempotency-Key it carried and what the fake did with it. */
export interface NoteRequestRecord {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey?: string;
  outcome: "ok" | "created" | "replayed" | "dropped" | "failed" | "rejected";
}

export interface MockNotes {
  /** Stored notes, in creation order. */
  list(): NoteDto[];
  /** Every request to a notes endpoint, reads included. */
  requests: NoteRequestRecord[];
  /** Makes the next POST of a note run into `fault`; queued faults apply one per request. */
  injectCreateFault(fault: NoteCreateFault): void;
  /** Stores a note as if the user had made it earlier; the anchor is checked like a POST. */
  seed(input: NoteAnchorInput & { mark?: NoteMark; color?: NoteColor; comment?: string }): NoteDto;
}

type NoteFailure = { status: number; errorClass: ErrorClass; code: string; details?: AppErrorDetails };

class NoteRejected extends Error {
  readonly failure: NoteFailure;
  constructor(failure: NoteFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

function errorBody(failure: NoteFailure): unknown {
  return errorResponseSchema.parse({
    error: {
      class: failure.errorClass,
      code: failure.code,
      retryDisposition: ERROR_CLASS_DEFAULTS[failure.errorClass].retryDisposition ?? "never",
      userMessage: "",
      ...(failure.details === undefined ? {} : { details: failure.details }),
    },
  });
}

const anchorInvalid = (): NoteRejected => new NoteRejected({ status: 400, errorClass: "invalid_request", code: "invalid_request.note_anchor" });

/** Code units at `offset` must not split a surrogate pair. */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** The sentences a valid anchor covers, in order; throws the server's errors otherwise. */
function anchorSentences(contentId: string, anchor: NoteAnchorInput): TranscriptSegmentDto[] {
  const revision = knownRevisions().get(anchor.transcriptRevisionId);
  if (revision === undefined || revision.contentId !== contentId || revision.kind === "translated") throw anchorInvalid();
  const list = revision.segments();
  const start = list.find((segment) => segment.id === anchor.startSegmentId);
  const end = list.find((segment) => segment.id === anchor.endSegmentId);
  if (start === undefined || end === undefined || start.ordinal > end.ordinal) throw anchorInvalid();
  if (anchor.startOffset < 0 || anchor.startOffset >= start.text.length || anchor.endOffset <= 0 || anchor.endOffset > end.text.length) throw anchorInvalid();
  if (start.id === end.id && anchor.startOffset >= anchor.endOffset) throw anchorInvalid();
  if (splitsPair(start.text, anchor.startOffset) || splitsPair(end.text, anchor.endOffset)) throw anchorInvalid();
  const covered = list.filter((segment) => segment.ordinal >= start.ordinal && segment.ordinal <= end.ordinal);
  if (covered.length > NOTE_SPAN_MAX_SEGMENTS) {
    throw new NoteRejected({ status: 400, errorClass: "invalid_request", code: "invalid_request.note_span", details: { limit: NOTE_SPAN_MAX_SEGMENTS } });
  }
  return covered;
}

/** Same sentence: the slice; across sentences: start tail, middle sentences, end head, joined by the reading separator of the whole sentences. */
function noteQuote(covered: readonly TranscriptSegmentDto[], startOffset: number, endOffset: number): string {
  if (covered.length === 1) return (covered[0] as TranscriptSegmentDto).text.slice(startOffset, endOffset);
  let quote = "";
  covered.forEach((segment, index) => {
    const piece = index === 0 ? segment.text.slice(startOffset) : index === covered.length - 1 ? segment.text.slice(0, endOffset) : segment.text;
    quote = index === 0 ? piece : `${quote}${readingSeparator((covered[index - 1] as TranscriptSegmentDto).text, segment.text, isMarked(covered[index - 1] as TranscriptSegmentDto))}${piece}`;
  });
  return quote;
}

function rootRevision(id: string, revisions: Map<string, KnownRevision>): string {
  let current = id;
  for (let parent = revisions.get(current)?.parentRevisionId; parent !== undefined; parent = revisions.get(current)?.parentRevisionId) current = parent;
  return current;
}

/**
 * Where a note lands in `targetRevisionId`: its own revision exactly; a revision of the same
 * lineage through `sourceSegmentIds` (exact only when every sentence maps 1:1 to the same
 * text); an unrelated one by time overlap, as whole sentences.
 */
function noteView(note: NoteDto, targetRevisionId: string): NoteViewDto | null {
  const revisions = knownRevisions();
  const anchor = revisions.get(note.transcriptRevisionId);
  const target = revisions.get(targetRevisionId);
  if (anchor === undefined || target === undefined) return null;
  const anchorList = anchor.segments();
  const first = anchorList.findIndex((segment) => segment.id === note.startSegmentId);
  const last = anchorList.findIndex((segment) => segment.id === note.endSegmentId);
  const covered = anchorList.slice(first, last + 1);
  const exactSegments = (list: readonly TranscriptSegmentDto[]) =>
    list.map((segment, index) => ({
      segmentId: segment.id,
      startOffset: index === 0 ? note.startOffset : 0,
      endOffset: index === list.length - 1 ? note.endOffset : segment.text.length,
    }));
  if (targetRevisionId === note.transcriptRevisionId) return { segments: exactSegments(covered), exact: true };

  const targetList = target.segments();
  const lineage = rootRevision(note.transcriptRevisionId, revisions) === rootRevision(targetRevisionId, revisions);
  const perSentence = covered.map((segment) =>
    targetList.filter((candidate) =>
      lineage
        ? candidate.sourceSegmentIds.includes(segment.id) || segment.sourceSegmentIds.includes(candidate.id)
        : candidate.startMs < segment.endMs && segment.startMs < candidate.endMs,
    ),
  );
  const mapped = [...new Map(perSentence.flat().map((segment) => [segment.id, segment])).values()].sort((a, b) => a.ordinal - b.ordinal);
  if (mapped.length === 0) return null;
  const exact =
    lineage &&
    mapped.length === covered.length &&
    perSentence.every((targets, index) => targets.length === 1 && targets[0]?.text === covered[index]?.text);
  return exact
    ? { segments: exactSegments(mapped), exact: true }
    : { segments: mapped.map((segment) => ({ segmentId: segment.id, startOffset: 0, endOffset: segment.text.length })), exact: false };
}

interface NotesState {
  notes: NoteDto[];
  /** Idempotency records by key: what the request was and the response it got. */
  keys: Map<string, { digest: string; note: NoteDto }>;
  faults: NoteCreateFault[];
  requests: NoteRequestRecord[];
  clock: number;
  next: number;
  /** Contents in the trash: their notes leave the notes page and their endpoints answer 404. */
  hidden: (contentId: string) => boolean;
}

function createNote(state: NotesState, contentId: string, body: unknown): NoteDto {
  const parsed = noteCreateRequestSchema.safeParse(body);
  if (!parsed.success) throw new NoteRejected({ status: 400, errorClass: "invalid_request", code: "invalid_request" });
  const request = parsed.data;
  const covered = anchorSentences(contentId, request);
  if (state.notes.filter((note) => note.contentId === contentId).length >= NOTES_PER_CONTENT_MAX) {
    throw new NoteRejected({ status: 400, errorClass: "invalid_request", code: "invalid_request.note_limit", details: { limit: NOTES_PER_CONTENT_MAX } });
  }
  state.clock += 1;
  state.next += 1;
  const note = noteDtoSchema.parse({
    id: `01J0000000000000000NOTE${String(state.next).padStart(3, "0")}`,
    contentId,
    contentTitle: CONTENT_TITLES[contentId] ?? "",
    transcriptRevisionId: request.transcriptRevisionId,
    startSegmentId: request.startSegmentId,
    startOffset: request.startOffset,
    endSegmentId: request.endSegmentId,
    endOffset: request.endOffset,
    startMs: (covered[0] as TranscriptSegmentDto).startMs,
    quote: noteQuote(covered, request.startOffset, request.endOffset),
    mark: request.mark,
    color: request.color,
    ...(request.comment === undefined ? {} : { comment: request.comment.trim() }),
    createdAt: state.clock,
    updatedAt: state.clock,
  });
  state.notes.push(note);
  return note;
}

function readingOrder(a: NoteDto, b: NoteDto): number {
  return a.startMs - b.startMs || a.startOffset - b.startOffset || a.createdAt - b.createdAt;
}

/** `/api/contents/:id/notes`, `/api/notes/:id` and `/api/notes/groups`; false for anything else. */
async function handleNotes(state: NotesState, route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const contentMatch = /^\/api\/contents\/([^/]+)\/notes$/.exec(path);
  const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(path);
  if (contentMatch === null && noteMatch === null) return false;

  const body: unknown = method === "GET" || method === "DELETE" ? undefined : (request.postDataJSON() as unknown);
  const key = request.headers()["idempotency-key"];
  const record = (outcome: NoteRequestRecord["outcome"]): void => {
    state.requests.push({ method, path: `${path}${url.search}`, body, ...(key === undefined ? {} : { idempotencyKey: key }), outcome });
  };
  const json = (payload: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
  const reject = (failure: NoteFailure) => {
    record(failure.status >= 500 ? "failed" : "rejected");
    return json(errorBody(failure), failure.status);
  };
  const notFound = () => reject({ status: 404, errorClass: "not_found", code: "not_found" });

  try {
    if (noteMatch !== null && noteMatch[1] === "groups" && method === "GET") {
      const groups = new Map<string, { contentId: string; title: string; count: number; latestAt: number }>();
      for (const note of state.notes.filter((candidate) => !state.hidden(candidate.contentId))) {
        const group = groups.get(note.contentId) ?? { contentId: note.contentId, title: note.contentTitle, count: 0, latestAt: 0 };
        group.count += 1;
        group.latestAt = Math.max(group.latestAt, note.updatedAt);
        groups.set(note.contentId, group);
      }
      const ordered = [...groups.values()].sort((a, b) => b.latestAt - a.latestAt || (a.contentId < b.contentId ? 1 : -1));
      if (url.searchParams.has("page")) {
        record("ok");
        return (await json(noteGroupsDtoSchema.parse(numberedPage(ordered, url))), true);
      }
      const cursor = url.searchParams.get("cursor");
      const from = cursor === null ? 0 : ordered.findIndex((group) => `${group.latestAt}:${group.contentId}` === cursor) + 1;
      const limit = Number(url.searchParams.get("limit") ?? API_PAGE_SIZE_DEFAULT);
      const items = ordered.slice(from, from + limit);
      const lastItem = items.at(-1);
      record("ok");
      return (
        await json(
          noteGroupsDtoSchema.parse({
            items,
            total: ordered.length,
            ...(from + limit < ordered.length && lastItem !== undefined ? { nextCursor: `${lastItem.latestAt}:${lastItem.contentId}` } : {}),
          }),
        ),
        true
      );
    }

    if (contentMatch !== null) {
      const contentId = decodeURIComponent(contentMatch[1] as string);
      if (CONTENT_TITLES[contentId] === undefined) return (await notFound(), true);
      if (method === "GET") {
        const revisionId = url.searchParams.get("revision");
        const revision = revisionId === null ? undefined : knownRevisions().get(revisionId);
        if (revisionId !== null && (revision === undefined || revision.contentId !== contentId)) return (await notFound(), true);
        if (revision?.kind === "translated") return (await reject({ status: 400, errorClass: "invalid_request", code: "invalid_request" }), true);
        const items = state.notes
          .filter((note) => note.contentId === contentId)
          .sort(readingOrder)
          .map((note) => (revisionId === null ? note : { ...note, view: noteView(note, revisionId) }));
        record("ok");
        return (await json(noteListDtoSchema.parse({ items })), true);
      }
      if (method === "POST") {
        const digest = JSON.stringify([contentId, body]);
        const stored = key === undefined ? undefined : state.keys.get(key);
        if (stored !== undefined) {
          if (stored.digest !== digest) {
            return (await reject({ status: 409, errorClass: "idempotency_conflict", code: "idempotency_conflict" }), true);
          }
          record("replayed");
          return (await json(stored.note, 201), true);
        }
        const fault = state.faults.shift();
        if (fault === "fail_before_write") {
          return (await reject({ status: 500, errorClass: "internal", code: "internal" }), true);
        }
        const note = createNote(state, contentId, body);
        if (key !== undefined) state.keys.set(key, { digest, note });
        if (fault === "drop_response") {
          record("dropped");
          await route.abort("connectionreset");
          return true;
        }
        record("created");
        return (await json(note, 201), true);
      }
      return false;
    }

    const noteId = decodeURIComponent((noteMatch as RegExpExecArray)[1] as string);
    const index = state.notes.findIndex((note) => note.id === noteId);
    if (method === "PATCH") {
      const patch = notePatchRequestSchema.safeParse(body);
      if (!patch.success) return (await reject({ status: 400, errorClass: "invalid_request", code: "invalid_request" }), true);
      const current = state.notes[index];
      if (current === undefined) return (await notFound(), true);
      state.clock += 1;
      const { comment: _old, ...rest } = current;
      const comment = patch.data.comment === undefined ? current.comment : patch.data.comment === null ? undefined : patch.data.comment.trim();
      const updated = noteDtoSchema.parse({
        ...rest,
        ...(patch.data.mark === undefined ? {} : { mark: patch.data.mark }),
        ...(patch.data.color === undefined ? {} : { color: patch.data.color }),
        ...(comment === undefined ? {} : { comment }),
        updatedAt: state.clock,
      });
      state.notes[index] = updated;
      record("ok");
      return (await json(updated), true);
    }
    if (method === "DELETE") {
      if (index === -1) return (await notFound(), true);
      state.notes.splice(index, 1);
      record("ok");
      return (await route.fulfill({ status: 204, body: "" }), true);
    }
    return false;
  } catch (error) {
    if (error instanceof NoteRejected) return (await reject(error.failure), true);
    throw error;
  }
}

function mockNotes(state: NotesState): MockNotes {
  return {
    list: () => [...state.notes],
    requests: state.requests,
    injectCreateFault: (fault) => {
      state.faults.push(fault);
    },
    seed: (input) => {
      const contentId = knownRevisions().get(input.transcriptRevisionId)?.contentId ?? "";
      return createNote(state, contentId, {
        transcriptRevisionId: input.transcriptRevisionId,
        startSegmentId: input.startSegmentId,
        startOffset: input.startOffset,
        endSegmentId: input.endSegmentId,
        endOffset: input.endOffset,
        mark: input.mark ?? "background",
        color: input.color ?? "yellow",
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      });
    },
  };
}

/** `GET /api/transcript/segments/:sid/map` for the notes lecture: the same ordinal on the other revision. */
function notesSegmentMap(path: string, url: URL): unknown {
  const match = /^\/api\/transcript\/segments\/([^/]+)\/map$/.exec(path);
  const target = url.searchParams.get("targetRevision");
  if (match === null || target === null) return undefined;
  const revisions = knownRevisions();
  for (const revision of revisions.values()) {
    const source = revision.segments().find((segment) => segment.id === match[1]);
    const targetRevision = revisions.get(target);
    if (source === undefined || targetRevision === undefined) continue;
    const found = targetRevision.segments().find((segment) => segment.ordinal === source.ordinal);
    return segmentMapDtoSchema.parse(found === undefined ? { segmentId: null, method: "none" } : { segmentId: found.id, method: "lineage" });
  }
  return undefined;
}

export interface MockOptions {
  /** Server mode serves uploads over /api/media, so the `<video>` player gets a URL. */
  mode?: "local" | "server";
  /** Adds this many synthetic processed Contents to the library, after the fixtures, for paging. */
  libraryContents?: number;
}

export async function installMockBackend(page: Page, options: MockOptions = {}): Promise<MockBackend> {
  const mode = options.mode ?? "local";
  const mutations: MockBackend["mutations"] = [];
  let imported = false;
  // The user's ASR profiles and settings, kept in memory so the settings page round-trips.
  const asrProfiles: AsrProfileDto[] = [
    asrProfileDtoSchema.parse({
      id: "01J0000000000000000000ASR1",
      name: "阿里云百炼",
      provider: "dashscope",
      models: [
        { modelId: "qwen-audio-3.1-asr-flash-filetrans", family: "qwen_audio", available: true },
        { modelId: "fun-asr", family: "fun_asr", available: true },
      ],
      baseURL: "https://dashscope.aliyuncs.com",
      credentialStatus: "configured",
      hasCredential: true,
      inUse: false,
      createdAt: now,
    }),
  ];
  let settings: UserSettingsDto = userSettingsDtoSchema.parse({ theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: now });
  // The price of the single LLM model, set from the models section.
  let providerPricing: ModelPricing | undefined;
  const otherModels = new OtherModelsState();
  let done = 0;
  const synthetic = Array.from({ length: options.libraryContents ?? 0 }, (_, index) => syntheticContent(index + 1));
  // The library a deletion can move to the trash: what the routes below serve as `GET /api/contents/:id`.
  const libraryContent = (contentId: string): LibraryContent | undefined => {
    const finished = done > STAGES.length;
    const known: Record<string, () => [unknown, number]> = {
      ...(imported ? { [YOUTUBE_CONTENT]: () => [content(YOUTUBE_CONTENT, finished), 0] } : {}),
      [BILIBILI_CONTENT]: () => [content(BILIBILI_CONTENT, true), 0],
      [NOTES_CONTENT]: () => [notesContent(), 0],
      [LOCAL_CONTENT]: () => [{ ...content(LOCAL_CONTENT, true), source: { kind: "local" }, title: "本地上传的模拟讲座", primaryTranscriptRevisionId: LOCAL_REVISION }, 1],
      ...Object.fromEntries(synthetic.map((item) => [item.id, () => [item, 0]])),
    };
    const found = known[contentId]?.();
    return found === undefined ? undefined : { content: contentDtoSchema.parse(found[0]), mediaBytes: found[1] };
  };
  const trash = new TrashState(libraryContent);
  const notesState: NotesState = { notes: [], keys: new Map(), faults: [], requests: [], clock: now, next: 0, hidden: (contentId) => trash.hidden(contentId) };

  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async (route: Route) => {
    const url = route.request().url();
    if (url.startsWith("https://www.youtube.com/iframe_api")) {
      await route.fulfill({ contentType: "text/javascript", body: YT_API_STUB });
    } else if (url.startsWith("https://www.youtube.com/embed/") || url.startsWith("https://player.bilibili.com/")) {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>player</title>" });
    } else {
      await route.abort();
    }
  });

  await page.route("**/api/**", async (route: Route) => {
    const request: Request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (method !== "GET") {
      mutations.push({ method, path, body: request.postDataJSON() as unknown });
    }
    if (
      (await handleTrash(trash, route, request, url)) ||
      (await handleNotes(notesState, route, request, url)) ||
      (await handleSearch(route, request, url, (contentId) => trash.hidden(contentId))) ||
      (await handleChat(route, request, url)) ||
      (await handleOutputs(route, request, url)) ||
      (await handleOtherModels(otherModels, route, request, url))
    ) {
      return;
    }
    const mapped = method === "GET" ? notesSegmentMap(path, url) : undefined;
    if (mapped !== undefined) {
      return json(mapped);
    }
    if (path === "/api/tasks/events") {
      // One stage per connection: the client reconnects after SSE_RECONNECT_BASE_MS and
      // re-reads the snapshot, which then already contains everything delivered before.
      // Before the import nothing happens; after the last event the stream stays quiet.
      for (let waited = 0; (!imported || done > STAGES.length) && waited < 60_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!imported || done > STAGES.length) {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" }).catch(() => undefined);
      }
      done += 1;
      const event =
        done > STAGES.length
          ? `event: task.finished\ndata: ${JSON.stringify({ task: { ...taskDetail(done), stageRuns: undefined, workUnits: undefined, eventSeq: undefined } })}\nid: ${done}\n\n`
          : `event: stage.updated\ndata: ${JSON.stringify({ stageRun: taskDetail(done).stageRuns[done - 1] })}\nid: ${done}\n\n`;
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: event });
    }

    const finished = done > STAGES.length;
    const routes: Record<string, () => unknown> = {
      "GET /api/version": () => versionDtoSchema.parse({ version: "0.0.0-e2e", mode }),
      "GET /api/auth/me": () => authMeDtoSchema.parse({ userId: "local", role: "admin", mode, mustChangePassword: false }),
      "GET /api/settings": () => settings,
      "PATCH /api/settings": () => {
        const patch = userSettingsPatchSchema.parse(request.postDataJSON());
        const next: Record<string, unknown> = { ...settings };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        settings = userSettingsDtoSchema.parse(next);
        return settings;
      },
      "GET /api/asr-profiles": () => asrProfileListDtoSchema.parse({ items: asrProfiles }),
      "POST /api/asr-profiles": () => {
        const body = asrProfileCreateSchema.parse(request.postDataJSON());
        const created = asrProfileDtoSchema.parse({
          id: `01J0000000000000000000ASR${asrProfiles.length + 1}`,
          name: body.name,
          provider: body.provider,
          models: asrModels(body.provider, [], body.models ?? ASR_PRESETS[body.provider].recommendedModels.map((modelId) => ({ modelId }))),
          ...(body.baseURL === undefined ? {} : { baseURL: body.baseURL }),
          credentialStatus: "missing",
          hasCredential: false,
          inUse: false,
          createdAt: now,
        });
        asrProfiles.push(created);
        return created;
      },
      "PUT /api/asr-profiles/order": () => {
        const { profileIds } = asrProfileOrderRequestSchema.parse(request.postDataJSON());
        const byId = new Map(asrProfiles.map((profile) => [profile.id, profile]));
        asrProfiles.splice(0, asrProfiles.length, ...profileIds.flatMap((id) => byId.get(id) ?? []));
        return asrProfileListDtoSchema.parse({ items: asrProfiles });
      },
      ...Object.fromEntries(
        asrProfiles.flatMap((profile, index) => {
          const at = `/api/asr-profiles/${profile.id}`;
          return [
            [
              `PATCH ${at}`,
              () => {
                const patch = asrProfilePatchSchema.parse(request.postDataJSON());
                const { baseURL: _old, ...rest } = profile;
                const baseURL = patch.baseURL === undefined ? profile.baseURL : (patch.baseURL ?? undefined);
                const next = asrProfileDtoSchema.parse({ ...rest, ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.models === undefined ? {} : { models: asrModels(profile.provider, profile.models, patch.models) }), ...(baseURL === undefined ? {} : { baseURL }) });
                asrProfiles[index] = next;
                return next;
              },
            ],
            [`PUT ${at}/credential`, () => (asrProfiles[index] = asrProfileDtoSchema.parse({ ...profile, credentialStatus: "configured", hasCredential: true }))],
            [`POST ${at}/probe`, () => ({})],
            [
              `POST ${at}/test`,
              () => {
                // A fixed outcome: the test sound transcribes to an empty text.
                const { modelId } = asrModelTestRequestSchema.parse(request.postDataJSON());
                const testedAt = Date.now();
                asrProfiles[index] = asrProfileDtoSchema.parse({ ...profile, models: profile.models.map((model) => (model.modelId === modelId ? { ...model, testedAt } : model)) });
                return asrModelTestResultDtoSchema.parse({ modelId, result: "transcribed", textPreview: "", latencyMs: 1234, testedAt });
              },
            ],
            [
              `PUT ${at}/model-pricing`,
              () => {
                const { modelId, pricing } = modelPricingRequestSchema.parse(request.postDataJSON());
                const models = profile.models.map((model) => {
                  if (model.modelId !== modelId) return model;
                  const { pricing: _old, ...rest } = model;
                  return pricing === null ? rest : { ...rest, pricing };
                });
                return (asrProfiles[index] = asrProfileDtoSchema.parse({ ...profile, models }));
              },
            ],
          ];
        }),
      ),
      "GET /api/providers": () => providerListDtoSchema.parse({ items: [providerProfile(128000, providerPricing)] }),
      [`PUT /api/providers/${PROFILE}/model-pricing`]: () => {
        const { pricing } = modelPricingRequestSchema.parse(request.postDataJSON());
        providerPricing = pricing ?? undefined;
        return providerProfile(128000, providerPricing);
      },
      "GET /api/platform-accounts": () =>
        platformAccountListDtoSchema.parse({
          accounts: [
            { platform: "bilibili", credentialStatus: "missing", hasCredential: false },
            { platform: "youtube", credentialStatus: "missing", hasCredential: false },
          ],
        }),
      "GET /api/summary-templates": () => summaryTemplateListDtoSchema.parse({ items: TEMPLATES }),
      "GET /api/collections": () => collectionListDtoSchema.parse({ items: [] }),
      "GET /api/contents": () => {
        const all = [...(imported ? [content(YOUTUBE_CONTENT, finished)] : []), content(BILIBILI_CONTENT, true), ...synthetic].filter((item) => !trash.hidden(item.id));
        // The sidebar's 「最近」 asks for Contents in no collection.
        const unfiled = url.searchParams.get("uncollected") === "1" ? all.filter((item) => item.collections.length === 0) : all;
        // The library's search hits are read back by id.
        const ids = url.searchParams.get("ids");
        const wanted = ids === null ? undefined : new Set(ids.split(","));
        const items = wanted === undefined ? unfiled : unfiled.filter((item) => wanted.has(item.id));
        return contentListDtoSchema.parse(numberedPage(items, url));
      },
      ...Object.fromEntries(synthetic.map((item) => [`GET /api/contents/${item.id}`, () => contentDetailDtoSchema.parse({ ...item, media: [] })])),
      [`GET /api/contents/${YOUTUBE_CONTENT}`]: () => contentDetailDtoSchema.parse({ ...content(YOUTUBE_CONTENT, finished), media: [] }),
      [`GET /api/contents/${BILIBILI_CONTENT}`]: () => contentDetailDtoSchema.parse({ ...content(BILIBILI_CONTENT, true), media: [] }),
      [`GET /api/contents/${YOUTUBE_CONTENT}/summaries`]: () => summaries(REVISION, YOUTUBE_CONTENT, finished),
      [`GET /api/contents/${BILIBILI_CONTENT}/summaries`]: () => summaries(BILI_REVISION, BILIBILI_CONTENT, true),
      [`GET /api/contents/${YOUTUBE_CONTENT}/chapters`]: () => chaptersDtoSchema.parse({ revisions: [] }),
      [`GET /api/contents/${BILIBILI_CONTENT}/chapters`]: () => chaptersDtoSchema.parse({ revisions: [] }),
      [`GET /api/contents/${YOUTUBE_CONTENT}/transcript/revisions`]: () =>
        transcriptRevisionListDtoSchema.parse({ ...(finished ? { primaryTranscriptRevisionId: REVISION } : {}), revisions: finished ? [revisionListItem(revision(REVISION, YOUTUBE_CONTENT))] : [] }),
      [`GET /api/contents/${BILIBILI_CONTENT}/transcript/revisions`]: () =>
        transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: BILI_REVISION, revisions: [revisionListItem(revision(BILI_REVISION, BILIBILI_CONTENT))] }),
      [`GET /api/transcript/revisions/${REVISION}/segments`]: () =>
        transcriptSegmentPageDtoSchema.parse({ revision: revision(REVISION, YOUTUBE_CONTENT), items: segments(REVISION) }),
      [`GET /api/transcript/revisions/${BILI_REVISION}/segments`]: () =>
        transcriptSegmentPageDtoSchema.parse({ revision: revision(BILI_REVISION, BILIBILI_CONTENT), items: segments(BILI_REVISION) }),
      [`GET /api/contents/${LOCAL_CONTENT}`]: () =>
        contentDetailDtoSchema.parse({
          ...content(LOCAL_CONTENT, true),
          source: { kind: "local" },
          title: "本地上传的模拟讲座",
          primaryTranscriptRevisionId: LOCAL_REVISION,
          media: [
            {
              id: LOCAL_ASSET,
              kind: "managed_upload",
              displayName: "lecture.webm",
              mimeType: "video/webm",
              sizeBytes: 1,
              durationMs: 130_000,
              availability: "available",
              retentionPolicy: "keep",
              createdAt: now,
            },
          ],
        }),
      [`GET /api/contents/${LOCAL_CONTENT}/summaries`]: () => summaries(LOCAL_REVISION, LOCAL_CONTENT, true),
      [`GET /api/contents/${LOCAL_CONTENT}/chapters`]: () => chaptersDtoSchema.parse({ revisions: [] }),
      [`GET /api/contents/${LOCAL_CONTENT}/transcript/revisions`]: () =>
        transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: LOCAL_REVISION, revisions: [revisionListItem(revision(LOCAL_REVISION, LOCAL_CONTENT))] }),
      [`GET /api/transcript/revisions/${LOCAL_REVISION}/segments`]: () =>
        transcriptSegmentPageDtoSchema.parse({ revision: revision(LOCAL_REVISION, LOCAL_CONTENT), items: segments(LOCAL_REVISION) }),
      [`GET /api/contents/${NOTES_CONTENT}`]: () => contentDetailDtoSchema.parse({ ...notesContent(), media: [] }),
      [`GET /api/contents/${NOTES_CONTENT}/summaries`]: () => summaries(NOTES_REVISION, NOTES_CONTENT, false),
      [`GET /api/contents/${NOTES_CONTENT}/chapters`]: () => notesChapters(),
      [`GET /api/contents/${NOTES_CONTENT}/transcript/revisions`]: () =>
        transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: NOTES_REVISION, revisions: [notesRevision(NOTES_ASR_REVISION), notesRevision(NOTES_REVISION)].map(revisionListItem) }),
      [`GET /api/transcript/revisions/${NOTES_ASR_REVISION}/segments`]: () =>
        transcriptSegmentPageDtoSchema.parse({ revision: notesRevision(NOTES_ASR_REVISION), items: notesSegments(NOTES_ASR_REVISION) }),
      [`GET /api/transcript/revisions/${NOTES_REVISION}/segments`]: () =>
        transcriptSegmentPageDtoSchema.parse({ revision: notesRevision(NOTES_REVISION), items: notesSegments(NOTES_REVISION) }),
      [`GET /api/tasks/${TASK}`]: () => taskDetail(done),
      "GET /api/tasks": () => {
        const forOther = url.searchParams.has("contentId") && url.searchParams.get("contentId") !== YOUTUBE_CONTENT;
        const unfinishedOnly = url.searchParams.get("unfinished") === "1";
        const finishedOnly = url.searchParams.get("finished") === "1";
        const kind = url.searchParams.get("kind");
        // A trashed Content's tasks leave the task list with it.
        const include =
          imported &&
          !trash.hidden(YOUTUBE_CONTENT) &&
          !forOther &&
          !(unfinishedOnly && finished) &&
          !(finishedOnly && !finished) &&
          (kind === null || kind === "process_content");
        const { stageRuns: _runs, workUnits: _units, eventSeq: _seq, ...task } = taskDetail(done);
        return taskListDtoSchema.parse({ items: include ? [task] : [], eventSeq: done });
      },
      "POST /api/contents/import": () => {
        // Importing the trashed video again restores it first; once expired it is skipped.
        const skipped = trash.restoreForImport(YOUTUBE_CONTENT) === "expired";
        imported = true;
        return importResponseSchema.parse({
          importBatchId: "01J00000000000000000BATCH1",
          taskIds: skipped ? [] : [TASK],
          contentIds: skipped ? [] : [YOUTUBE_CONTENT],
          skippedTrashedContentIds: skipped ? [YOUTUBE_CONTENT] : [],
        });
      },
    };
    if (method === "GET" && path === `/api/media/${LOCAL_ASSET}`) {
      return route.continue({ url: LOCAL_CLIP_URL });
    }
    const deleted = method === "DELETE" ? asrProfiles.findIndex((profile) => path === `/api/asr-profiles/${profile.id}`) : -1;
    if (deleted >= 0) {
      const [gone] = asrProfiles.splice(deleted, 1);
      if (settings.defaultAsrModelRef?.asrProfileId === gone?.id) {
        const { defaultAsrModelRef: _cleared, ...rest } = settings;
        settings = rest;
      }
      return route.fulfill({ status: 204 });
    }
    const handler = routes[`${method} ${path}`];
    if (handler === undefined) {
      return json({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }, 404);
    }
    return json(handler(), method === "POST" ? 202 : 200);
  });

  return { mutations, delivered: () => done, notes: mockNotes(notesState), trash: trash.mock() };
}
