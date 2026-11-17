import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { contentDetailDtoSchema, transcriptRevisionDtoSchema, transcriptRevisionListDtoSchema } from "../../src/shared/dto/content.ts";
import { contentExportRequestSchema } from "../../src/shared/dto/export.ts";
import { chaptersDtoSchema } from "../../src/shared/dto/chapter.ts";
import { speakerCreateRequestSchema, speakerDtoSchema, speakerListDtoSchema, speakerPatchRequestSchema, type SpeakerDto } from "../../src/shared/dto/speaker.ts";
import { errorResponseSchema } from "../../src/shared/errors.ts";
import { defaultSpeakerColorIndex, normalizeSpeakerName, type DiarizationUnavailableReason } from "../../src/shared/speakers.ts";
import { hasExplicitParagraphs, inheritedParagraphStarts } from "../../src/shared/paragraph-marks.ts";
import { taskAcceptedDtoSchema } from "../../src/shared/dto/task.ts";
import {
  draftCommitRequestSchema,
  draftVersionSchema,
  speakerReviewDtoSchema,
  speakersConfirmedRequestSchema,
  transcriptDraftDtoSchema,
  transcriptDraftRequestSchema,
  transcriptSegmentPageDtoSchema,
  type TranscriptDraftRequest,
  type TranscriptSegmentDto,
} from "../../src/shared/dto/transcript.ts";
import { VTT_HEADER, vttCue } from "../../src/server/domain/export/vtt.ts";
import { speakerLabels } from "../../src/server/domain/export/speaker-labels.ts";
import { revisionListItem, segmentId, summaries } from "./mock-backend.ts";

/**
 * A processed lecture whose ASR original names two speakers, for the speaker specs: the
 * content page, its sentences and speakers, and VTT exports written by the real VTT writer
 * so a browser can be asked to parse what the product would produce. Anything else about
 * the content falls to the shared fakes.
 */
export const SPEAKERS_CONTENT = "01J0000000000000000000SP01";
export const SPEAKERS_REVISION = "01J0000000000000000000SPR1";
export const SPEAKERS_TITLE = "第四讲：发言人模拟课程";
export const SPEAKER_TEACHER = "01J0000000000000000000SPK1";
export const SPEAKER_STUDENT = "01J0000000000000000000SPK2";
/**
 * An earlier recognition of the lecture, listed only when a spec asks for it
 * (`SpeakersRequests.earlierRevision`): the teacher alone, then a sentence nobody was
 * assigned to. Its id differs from the primary's in the part segment ids are built from.
 */
export const SPEAKERS_EARLIER_REVISION = "01J0000000000000000002SPR2";
const EARLIER_SEQUENCE = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_TEACHER, undefined] as const;
export const SEGMENT_MS = 10_000;
/** How much of its slot a sentence lasts: each one ends this long before the next starts. */
export const SEGMENT_GAP_MS = 500;
const now = 1_790_000_000_000;

/** The speakers: a named teacher and an unnamed second speaker, shown as 「发言人 2」. */
export const SPEAKERS: SpeakerDto[] = [
  { id: SPEAKER_TEACHER, ordinal: 1, name: "林老师", colorIndex: 0, avatarVersion: 1, used: true, referenced: true },
  { id: SPEAKER_STUDENT, ordinal: 2, colorIndex: 1, used: true, referenced: true },
];

/** Who says each sentence: two turns of the teacher around one of the student, and a last sentence nobody was assigned to. */
export const SPEAKER_SEQUENCE = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKER_TEACHER, undefined] as const;

/** Who says each sentence of a revision, in reading order; `undefined` = nobody was assigned. */
export type SpeakerSequence = ReadonlyArray<string | undefined>;

export const speakerSentence = (index: number): string => `第 ${index + 1} 句发言人模拟字幕。`;

function revision(id: string = SPEAKERS_REVISION, segmentCount: number = SPEAKER_SEQUENCE.length) {
  const earlier = id === SPEAKERS_EARLIER_REVISION;
  return {
    id,
    contentId: SPEAKERS_CONTENT,
    kind: "asr",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "asr", modelId: earlier ? "qwen-audio-3.1-asr-flash-filetrans" : "fun-asr", diarization: { status: "applied" } },
    segmentCount,
    createdAt: earlier ? now - 86_400_000 : now,
  } as const;
}

function segments(
  sequence: SpeakerSequence = SPEAKER_SEQUENCE,
  texts: Readonly<Record<number, string>> = {},
  revisionId: string = SPEAKERS_REVISION,
  offsetMs = 0,
  paragraphStarts?: ReadonlySet<number>,
): TranscriptSegmentDto[] {
  return sequence.map((speakerId, index) => ({
    // Paragraph marks are all-or-nothing in a revision: with them, every sentence says whether it opens a paragraph.
    ...(paragraphStarts === undefined ? {} : { paragraphStart: paragraphStarts.has(index) }),
    id: segmentId(revisionId, index),
    revisionId,
    ordinal: index,
    startMs: offsetMs + index * SEGMENT_MS,
    endMs: offsetMs + (index + 1) * SEGMENT_MS - SEGMENT_GAP_MS,
    text: texts[index] ?? speakerSentence(index),
    ...(speakerId === undefined ? {} : { speakerId }),
    sourceSegmentIds: [],
  }));
}

/** The lecture's segment page with some sentences' text replaced, for a spec that needs other text in the same turns. */
export function speakerSegmentPage(texts: Readonly<Record<number, string>> = {}) {
  return transcriptSegmentPageDtoSchema.parse({ revision: revision(), items: segments().map((item) => ({ ...item, text: texts[item.ordinal] ?? item.text })) });
}

function content(primary: string) {
  return {
    id: SPEAKERS_CONTENT,
    source: { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1mock00004", platformContentId: "BV1mock00004", platformPartId: "1" },
    title: SPEAKERS_TITLE,
    durationMs: SPEAKER_SEQUENCE.length * SEGMENT_MS,
    rawLanguage: "zh-CN",
    primaryTranscriptRevisionId: primary,
    processingStatus: "succeeded",
    collections: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** The VTT the export writer produces for the lecture with speaker names on every cue. */
export function speakerVtt(): string {
  const names = speakerLabels(SPEAKERS);
  return segments().reduce(
    (text, segment) => text + vttCue({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text }, segment.speakerId === undefined ? undefined : names.get(segment.speakerId)),
    VTT_HEADER,
  );
}

/** A 1x1 PNG: the photo the teacher has. */
const AVATAR_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

/**
 * What the speakers lecture keeps for a browser context: its speakers (edited by PATCH, so
 * every page of the context sees the same ones), and the requests the pages made.
 */
export interface SpeakersRequests {
  /** Bodies of the export requests. */
  exports: unknown[];
  /** The speakers as the server now holds them. */
  speakers: SpeakerDto[];
  /** Who says each sentence of the primary revision; set before the page loads for a lecture of another shape. */
  sequence: SpeakerSequence;
  /** Sentence texts replacing the numbered ones of the primary revision, by ordinal. */
  texts: Record<number, string>;
  /** Lists the earlier recognition (`SPEAKERS_EARLIER_REVISION`) beside the primary. */
  earlierRevision: boolean;
  /** When each revision's speakers were marked as reviewed. */
  confirmedAt: Map<string, number>;
  /** Sentences of the lecture's transcript draft still marked for review; 0 = no such sentence. */
  draftNeedsReview: number;
  /** Bodies of the review confirmations and withdrawals, refused ones included. */
  confirmations: unknown[];
  /** Headers of every request for a speaker's photo. */
  avatarHeaders: Array<Record<string, string>>;
  /** Refuses the next re-transcribe with `invalid_request.diarization_unavailable` and this reason. */
  refuseNextRetranscribe?: DiarizationUnavailableReason;
  /** Chapters of the primary revision, each opening at the sentence with index `start`; absent = the lecture has no chapters. */
  chapters?: ReadonlyArray<{ start: number; title: string }>;
  /** Where the primary revision's first sentence starts, in ms; absent = 0. Every later sentence moves with it. */
  offsetMs?: number;
  /**
   * Sentences of the primary revision that open a paragraph, as proofreading marks them; absent =
   * no marks, and paragraphs follow the readability rules (pauses, length).
   */
  paragraphStarts?: ReadonlySet<number>;
  /** The lecture's single transcript draft, as saved; absent = none. */
  draft: StoredDraft | undefined;
  /** The `manual` revisions committed from the draft that still exist, oldest first. */
  manual: ManualRevision[];
  /** How many manual revisions were ever committed: numbers the next one's id. */
  manualCommitted: number;
  /** The primary revision; the ASR original until a commit replaces it. */
  primary: string;
  /** Bodies of the draft commits, refused ones included. */
  commits: unknown[];
  /** Answers every revision list request with a server error while set. */
  failRevisionList: boolean;
  /** Runs right after a commit succeeded, before it is answered: another window's doings. */
  afterCommit?: (state: SpeakersRequests) => void;
  /** Speakers an archived revision names: referenced, so not deletable, though no listed revision names them. */
  archivedReferences: Set<string>;
  /** How many speakers were ever created: numbers the next one's id. */
  speakersCreated: number;
  /** Bodies of the speaker creations. */
  creations: unknown[];
  /** Ids of the speakers whose deletion was asked for, refused ones included. */
  deletions: string[];
}

/** The transcript draft as the server keeps it. */
export interface StoredDraft {
  baseRevisionId: string;
  version: number;
  segments: TranscriptDraftRequest["segments"];
  updatedAt: number;
}

/** A committed `manual` revision of the lecture. */
export interface ManualRevision {
  id: string;
  parentRevisionId: string;
  segments: TranscriptSegmentDto[];
  createdAt: number;
}

/**
 * The id of the `n`th manual revision committed (from 1). The 22 characters segment ids are
 * built from differ from every other revision's, so no two revisions share a segment id.
 */
export const manualRevisionId = (n: number): string => `01J0000000000000000M${String(n).padStart(2, "0")}MANR`;

/** Where a sentence of the primary revision starts in this browser context. */
export function speakerStartMs(state: Pick<SpeakersRequests, "offsetMs">, index: number): number {
  return (state.offsetMs ?? 0) + index * SEGMENT_MS;
}

const states = new WeakMap<BrowserContext, SpeakersRequests>();

/** What the pages of this browser context sent to the speakers lecture's endpoints so far. */
export function speakersRequests(page: Page): SpeakersRequests {
  const context = page.context();
  let state = states.get(context);
  if (state === undefined) {
    state = {
      exports: [],
      speakers: SPEAKERS.map((speaker) => ({ ...speaker })),
      sequence: SPEAKER_SEQUENCE,
      texts: {},
      earlierRevision: false,
      confirmedAt: new Map(),
      draftNeedsReview: 0,
      confirmations: [],
      avatarHeaders: [],
      draft: undefined,
      manual: [],
      manualCommitted: 0,
      primary: SPEAKERS_REVISION,
      commits: [],
      failRevisionList: false,
      archivedReferences: new Set(),
      speakersCreated: 0,
      creations: [],
      deletions: [],
    };
    states.set(context, state);
  }
  return state;
}

/** The sentences a revision of the lecture has in this browser context. */
function revisionSegments(state: SpeakersRequests, revisionId: string): TranscriptSegmentDto[] {
  if (revisionId === SPEAKERS_EARLIER_REVISION) return segments(EARLIER_SEQUENCE, {}, revisionId);
  const manual = state.manual.find((item) => item.id === revisionId);
  if (manual !== undefined) return manual.segments;
  return segments(state.sequence, state.texts, SPEAKERS_REVISION, state.offsetMs ?? 0, state.paragraphStarts);
}

/** The revisions of the lecture that exist in this browser context, in creation order. */
function revisionIds(state: SpeakersRequests): string[] {
  return [...(state.earlierRevision ? [SPEAKERS_EARLIER_REVISION] : []), SPEAKERS_REVISION, ...state.manual.map((item) => item.id)];
}

function conflict(code: string, details?: Record<string, unknown>) {
  return errorResponseSchema.parse({ error: { class: "conflict", code, retryDisposition: "never", userMessage: "", ...(details === undefined ? {} : { details }) } });
}

/** `conflict.draft_changed` naming the draft's current version, or none when there is no draft. */
const draftChanged = (state: SpeakersRequests) => conflict("conflict.draft_changed", state.draft === undefined ? undefined : { currentVersion: state.draft.version });

function draftDto(state: SpeakersRequests, draft: StoredDraft) {
  return transcriptDraftDtoSchema.parse({ id: "01J0000000000000000000SPDR", contentId: SPEAKERS_CONTENT, baseRevisionId: draft.baseRevisionId, version: draft.version, segments: draft.segments, updatedAt: draft.updatedAt });
}

/**
 * Commits the draft the way the server does: a `manual` revision with one sentence per draft
 * sentence, in draft order, with new ids and the draft's times, becomes the primary and the
 * draft is gone. A manual base that is the primary and that nothing else builds on is folded
 * into the new revision: it is deleted, the new one descends from its parent and takes its
 * sources. Returns the revision, or the refusal.
 */
function commitDraft(state: SpeakersRequests, body: unknown): { status: number; body: unknown } {
  const request = draftCommitRequestSchema.parse(body);
  state.commits.push(request);
  const draft = state.draft;
  if (draft === undefined || draft.version !== request.draftVersion) return { status: 409, body: draftChanged(state) };
  if (request.expectedPrimaryRevisionId !== state.primary) {
    return { status: 409, body: conflict("conflict.primary_changed", { currentPrimaryRevisionId: state.primary }) };
  }
  // As the server does: a sentence naming a speaker that no longer exists (deleted in another window) is refused.
  if (draft.segments.some((segment) => typeof segment.speakerId === "string" && !state.speakers.some((speaker) => speaker.id === segment.speakerId))) {
    return { status: 400, body: errorResponseSchema.parse({ error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "" } }) };
  }
  const base = draft.baseRevisionId;
  const baseSegments = new Map(revisionSegments(state, base).map((segment) => [segment.id, segment]));
  const baseManual = state.manual.find((item) => item.id === base);
  const folded = baseManual !== undefined && base === state.primary && !state.manual.some((item) => item.parentRevisionId === base) ? baseManual : undefined;
  state.manualCommitted += 1;
  const id = manualRevisionId(state.manualCommitted);
  const accept = request.speakerReview === "accept_suggestions";
  // Paragraphs as the server keeps them: a draft's explicit marks as they are, otherwise inherited from the base.
  const explicit = hasExplicitParagraphs(draft.segments);
  const inherited = inheritedParagraphStarts(baseSegments, draft.segments);
  const baseLoose = [...baseSegments.values()][0]?.looseJoin === true;
  const baseMarked = [...baseSegments.values()][0]?.paragraphStart !== undefined;
  const loose = explicit ? baseLoose || !baseMarked : baseLoose;
  const committed: TranscriptSegmentDto[] = draft.segments.map((segment, ordinal) => {
    const first = segment.sourceSegmentIds[0];
    let speakerId = segment.speakerId === undefined ? (first === undefined ? undefined : baseSegments.get(first)?.speakerId) : (segment.speakerId ?? undefined);
    if (segment.speakerReview === "needs_review" && !accept) speakerId = undefined;
    const sources = folded === undefined ? segment.sourceSegmentIds : segment.sourceSegmentIds.flatMap((source) => baseSegments.get(source)?.sourceSegmentIds ?? []);
    const paragraphStart = explicit ? segment.paragraphStart : inherited[ordinal];
    return {
      id: segmentId(id, ordinal),
      revisionId: id,
      ordinal,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      ...(speakerId === undefined ? {} : { speakerId }),
      ...(paragraphStart === undefined ? {} : { paragraphStart }),
      ...(paragraphStart !== undefined && loose ? { looseJoin: true as const } : {}),
      sourceSegmentIds: sources,
    };
  });
  if (folded !== undefined) state.manual = state.manual.filter((item) => item !== folded);
  const revision: ManualRevision = { id, parentRevisionId: folded?.parentRevisionId ?? base, segments: committed, createdAt: now + state.manualCommitted };
  state.manual.push(revision);
  state.primary = id;
  state.draft = undefined;
  state.afterCommit?.(state);
  return { status: 201, body: transcriptRevisionDtoSchema.parse(revisionDto(state, id)) };
}

/** The lecture's chapters as the chapters endpoint returns them; none unless a spec set `chapters`. */
function speakerChapters(state: SpeakersRequests) {
  const chapters = state.chapters;
  if (chapters === undefined) return chaptersDtoSchema.parse({ revisions: [] });
  const end = speakerStartMs(state, state.sequence.length);
  const revision = {
    id: "01J0000000000000000000SPCH",
    artifactId: "01J0000000000000000000SPCA",
    origin: { kind: "platform" },
    chapters: chapters.map((chapter, index) => {
      const next = chapters[index + 1];
      return { startMs: speakerStartMs(state, chapter.start), endMs: next === undefined ? end : speakerStartMs(state, next.start), title: chapter.title };
    }),
    quality: "normal",
    qualityReasons: [],
    stale: false,
    createdAt: now,
  };
  return chaptersDtoSchema.parse({ artifactId: revision.artifactId, current: revision, revisions: [revision] });
}

function revisionDto(state: SpeakersRequests, revisionId: string) {
  const confirmedAt = state.confirmedAt.get(revisionId);
  const manual = state.manual.find((item) => item.id === revisionId);
  const base =
    manual === undefined
      ? revision(revisionId, revisionSegments(state, revisionId).length)
      : {
          id: manual.id,
          contentId: SPEAKERS_CONTENT,
          kind: "manual",
          parentRevisionId: manual.parentRevisionId,
          language: "zh-CN",
          timingFidelity: "inherited_segment",
          generation: { kind: "manual" },
          segmentCount: manual.segments.length,
          ...(manual.segments[0]?.looseJoin === true ? { looseJoin: true as const } : {}),
          createdAt: manual.createdAt,
        };
  return { ...base, ...(confirmedAt === undefined ? {} : { speakersConfirmedAt: confirmedAt }) };
}

/** The id of the `n`th speaker created in a browser context (from 1). */
export const createdSpeakerId = (n: number): string => `01J00000000000000000NSPK${String(n).padStart(2, "0")}`;

/** Whether a listed revision or the stored draft names the speaker. */
function isNamed(state: SpeakersRequests, speakerId: string): boolean {
  if (state.draft?.segments.some((segment) => segment.speakerId === speakerId) === true) return true;
  return revisionIds(state).some((revisionId) => revisionSegments(state, revisionId).some((segment) => segment.speakerId === speakerId));
}

/** Whether anything still refers to the speaker, as the server works it out: any revision (archived ones included) or the draft. */
const isReferenced = (state: SpeakersRequests, speakerId: string): boolean => state.archivedReferences.has(speakerId) || isNamed(state, speakerId);

/** A speaker as the API answers with it: whether it is used and referenced is worked out at the time of asking. */
function speakerAnswer(state: SpeakersRequests, speaker: SpeakerDto): SpeakerDto {
  return { ...speaker, used: speaker.used || isNamed(state, speaker.id), referenced: isReferenced(state, speaker.id) };
}

/** The speakers a revision's sentences name, in ordinal order. */
function namedSpeakers(state: SpeakersRequests, revisionId: string): SpeakerDto[] {
  const named = new Set(revisionSegments(state, revisionId).flatMap((segment) => (segment.speakerId === undefined ? [] : [segment.speakerId])));
  return state.speakers.filter((speaker) => named.has(speaker.id)).sort((a, b) => a.ordinal - b.ordinal);
}

/** Changes whenever a named speaker's id, ordinal, name or name confirmation does, as the server's digest does. */
function rosterDigest(state: SpeakersRequests, revisionId: string): string {
  return JSON.stringify(namedSpeakers(state, revisionId).map((speaker) => [speaker.id, speaker.ordinal, speaker.name ?? null, speaker.name !== undefined && speaker.nameConfirmed === true]));
}

/** The review panel's figures, counted from the context's sentences and speakers the way the server counts them. */
function speakerReview(state: SpeakersRequests, revisionId: string) {
  const tally = new Map<string, { sentences: number; assignedMs: number }>();
  let unassigned = 0;
  for (const segment of revisionSegments(state, revisionId)) {
    if (segment.speakerId === undefined) {
      unassigned += 1;
      continue;
    }
    const entry = tally.get(segment.speakerId) ?? { sentences: 0, assignedMs: 0 };
    entry.sentences += 1;
    entry.assignedMs += segment.endMs - segment.startMs;
    tally.set(segment.speakerId, entry);
  }
  const confirmedAt = state.confirmedAt.get(revisionId);
  return speakerReviewDtoSchema.parse({
    revisionId,
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    rosterDigest: rosterDigest(state, revisionId),
    speakers: [...tally].map(([id, entry]) => ({ id, ...entry })),
    unassigned,
    pendingNames: namedSpeakers(state, revisionId).filter((speaker) => speaker.name !== undefined && speaker.nameConfirmed !== true).length,
    ...(state.draftNeedsReview > 0 ? { draftNeedsReview: state.draftNeedsReview } : {}),
  });
}

/** `/api/**` of the speakers lecture; false for anything else. */
export async function handleSpeakers(route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).then(() => true);
  const contentMatch = /^\/api\/contents\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (contentMatch !== null && contentMatch[1] === SPEAKERS_CONTENT) {
    const resource = contentMatch[2];
    const state = speakersRequests(request.frame().page());
    if (method === "GET" && resource === undefined) return json(contentDetailDtoSchema.parse({ ...content(state.primary), media: [] }));
    if (method === "GET" && resource === "summaries") return json(summaries(SPEAKERS_REVISION, SPEAKERS_CONTENT, false));
    if (method === "GET" && resource === "chapters") return json(speakerChapters(state));
    if (method === "GET" && resource === "notes") return json({ items: [] });
    if (method === "GET" && resource === "transcript/revisions") {
      if (state.failRevisionList) return json(errorResponseSchema.parse({ error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } }), 500);
      return json(transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: state.primary, revisions: revisionIds(state).map((id) => revisionListItem(revisionDto(state, id))) }));
    }
    if (resource === "transcript/draft") {
      if (method === "GET") return state.draft === undefined ? json(errorResponseSchema.parse({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }), 404) : json(draftDto(state, state.draft));
      if (method === "PUT") {
        const body = transcriptDraftRequestSchema.parse(request.postDataJSON());
        if (body.expectedVersion !== (state.draft?.version ?? null)) return json(draftChanged(state), 409);
        if (!revisionIds(state).includes(body.baseRevisionId)) return json(errorResponseSchema.parse({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }), 404);
        state.draft = { baseRevisionId: body.baseRevisionId, version: (body.expectedVersion ?? 0) + 1, segments: body.segments, updatedAt: Date.now() };
        return json(draftDto(state, state.draft));
      }
      if (method === "DELETE") {
        const asked = url.searchParams.get("version");
        const version = asked === null ? undefined : draftVersionSchema.parse(Number(asked));
        if (state.draft === undefined || (version !== undefined && version !== state.draft.version)) return json(draftChanged(state), 409);
        state.draft = undefined;
        await route.fulfill({ status: 204, body: "" });
        return true;
      }
    }
    if (method === "POST" && resource === "transcript/draft/commit") {
      const answer = commitDraft(state, request.postDataJSON());
      return json(answer.body, answer.status);
    }
    if (method === "GET" && resource === "speakers") return json(speakerListDtoSchema.parse({ items: state.speakers.map((speaker) => speakerAnswer(state, speaker)) }));
    if (method === "POST" && resource === "speakers") {
      const body = speakerCreateRequestSchema.parse(request.postDataJSON());
      state.creations.push(body);
      const name = body.name === undefined ? undefined : normalizeSpeakerName(body.name);
      if (name === "too_long") return json(errorResponseSchema.parse({ error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "" } }), 400);
      state.speakersCreated += 1;
      const ordinal = Math.max(0, ...state.speakers.map((speaker) => speaker.ordinal)) + 1;
      const created = speakerDtoSchema.parse({
        id: createdSpeakerId(state.speakersCreated),
        ordinal,
        colorIndex: body.colorIndex ?? defaultSpeakerColorIndex(ordinal),
        used: false,
        referenced: false,
        ...(name === undefined ? {} : { name }),
        ...(name !== undefined && body.nameConfirmed === true ? { nameConfirmed: true } : {}),
      });
      state.speakers.push(created);
      return json(created, 201);
    }
    const speakerMatch = resource === undefined ? null : /^speakers\/([^/]+)(\/avatar)?$/.exec(resource);
    if (speakerMatch !== null && speakerMatch[2] !== undefined && method === "GET") {
      state.avatarHeaders.push(request.headers());
      await route.fulfill({ status: 200, contentType: "image/png", body: AVATAR_PNG });
      return true;
    }
    if (speakerMatch !== null && speakerMatch[2] === undefined && method === "DELETE") {
      const speakerId = speakerMatch[1] as string;
      state.deletions.push(speakerId);
      if (!state.speakers.some((speaker) => speaker.id === speakerId)) {
        return json(errorResponseSchema.parse({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }), 404);
      }
      if (isReferenced(state, speakerId)) return json(conflict("conflict.speaker_in_use"), 409);
      state.speakers = state.speakers.filter((speaker) => speaker.id !== speakerId);
      await route.fulfill({ status: 204, body: "" });
      return true;
    }
    if (speakerMatch !== null && speakerMatch[2] === undefined && method === "PATCH") {
      const patch = speakerPatchRequestSchema.parse(request.postDataJSON());
      const index = state.speakers.findIndex((speaker) => speaker.id === speakerMatch[1]);
      const current = state.speakers[index];
      if (current === undefined || "copyFrom" in patch) return json({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }, 404);
      const { name: _old, nameConfirmed: wasConfirmed, ...rest } = current;
      const name = patch.name === undefined ? current.name : (patch.name ?? undefined);
      // A name is confirmed only by a request that writes it and says so; a changed name without that is not.
      const confirmed = name !== undefined && (patch.name !== undefined && patch.nameConfirmed === true ? true : name === current.name && wasConfirmed === true);
      const updated = speakerDtoSchema.parse({
        ...rest,
        ...(name === undefined ? {} : { name }),
        ...(confirmed ? { nameConfirmed: true } : {}),
        ...(patch.colorIndex === undefined ? {} : { colorIndex: patch.colorIndex }),
      });
      state.speakers[index] = updated;
      return json(speakerAnswer(state, updated));
    }
    if (method === "POST" && resource === "transcript/retranscribe") {
      const reason = state.refuseNextRetranscribe;
      if (reason !== undefined) {
        delete state.refuseNextRetranscribe;
        return json(errorResponseSchema.parse({ error: { class: "invalid_request", code: "invalid_request.diarization_unavailable", retryDisposition: "never", userMessage: "", details: { reason } } }), 400);
      }
      return json(taskAcceptedDtoSchema.parse({ taskId: "01J000000000000000SPTASK01" }), 202);
    }
    if (method === "POST" && resource === "export") {
      const body = contentExportRequestSchema.parse(request.postDataJSON());
      state.exports.push(body);
      const speakers = "includeSpeakers" in body && body.includeSpeakers === true;
      const extension = body.format === "markdown" ? "md" : body.format.split("-")[0];
      const text = body.format === "vtt" ? (speakers ? speakerVtt() : VTT_HEADER) : `${body.format}\n`;
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${SPEAKERS_TITLE}.${extension}`)}` },
        body: text,
      });
      return true;
    }
    return false;
  }
  if (method === "GET" && path === "/api/speakers/suggestions") return json({ items: [] });
  const revisionMatch = /^\/api\/transcript\/revisions\/([^/]+)\/([a-z-]+)$/.exec(path);
  const revisionId = revisionMatch?.[1];
  if (revisionMatch === null || revisionId === undefined) return false;
  const state = speakersRequests(request.frame().page());
  // A manual revision a later commit folded away is gone, as on the server.
  if (revisionId !== SPEAKERS_REVISION && revisionId !== SPEAKERS_EARLIER_REVISION && !state.manual.some((item) => item.id === revisionId)) return false;
  const resource = `${method} ${revisionMatch[2]}`;
  if (resource === "GET segments") {
    return json(transcriptSegmentPageDtoSchema.parse({ revision: revisionDto(state, revisionId), items: revisionSegments(state, revisionId) }));
  }
  if (resource === "GET speaker-review") return json(speakerReview(state, revisionId));
  if (resource === "PUT speakers-confirmed") {
    const body = speakersConfirmedRequestSchema.parse(request.postDataJSON());
    state.confirmations.push(body);
    if (!body.confirmed) {
      state.confirmedAt.delete(revisionId);
      return json(speakerReview(state, revisionId));
    }
    if (body.expectedRosterDigest !== rosterDigest(state, revisionId)) {
      return json(errorResponseSchema.parse({ error: { class: "conflict", code: "conflict.speakers_changed", retryDisposition: "never", userMessage: "" } }), 409);
    }
    // Confirming vouches for the names shown, and a second confirmation keeps the first time.
    const at = Date.now();
    state.speakers = state.speakers.map((speaker) => (namedSpeakers(state, revisionId).some((named) => named.id === speaker.id) && speaker.name !== undefined ? { ...speaker, nameConfirmed: true } : speaker));
    if (!state.confirmedAt.has(revisionId)) state.confirmedAt.set(revisionId, at);
    return json(speakerReview(state, revisionId));
  }
  return false;
}
