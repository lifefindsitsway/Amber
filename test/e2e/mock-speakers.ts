import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { contentDetailDtoSchema, transcriptRevisionListDtoSchema } from "../../src/shared/dto/content.ts";
import { contentExportRequestSchema } from "../../src/shared/dto/export.ts";
import { chaptersDtoSchema } from "../../src/shared/dto/chapter.ts";
import { speakerDtoSchema, speakerListDtoSchema, speakerPatchRequestSchema, type SpeakerDto } from "../../src/shared/dto/speaker.ts";
import { errorResponseSchema } from "../../src/shared/errors.ts";
import type { DiarizationUnavailableReason } from "../../src/shared/speakers.ts";
import { taskAcceptedDtoSchema } from "../../src/shared/dto/task.ts";
import { speakerReviewDtoSchema, speakersConfirmedRequestSchema, transcriptSegmentPageDtoSchema, type TranscriptSegmentDto } from "../../src/shared/dto/transcript.ts";
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
  { id: SPEAKER_TEACHER, ordinal: 1, name: "林老师", colorIndex: 0, avatarVersion: 1, used: true },
  { id: SPEAKER_STUDENT, ordinal: 2, colorIndex: 1, used: true },
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

function content() {
  return {
    id: SPEAKERS_CONTENT,
    source: { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1mock00004", platformContentId: "BV1mock00004", platformPartId: "1" },
    title: SPEAKERS_TITLE,
    durationMs: SPEAKER_SEQUENCE.length * SEGMENT_MS,
    rawLanguage: "zh-CN",
    primaryTranscriptRevisionId: SPEAKERS_REVISION,
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
}

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
    };
    states.set(context, state);
  }
  return state;
}

/** The sentences a revision of the lecture has in this browser context. */
function revisionSegments(state: SpeakersRequests, revisionId: string): TranscriptSegmentDto[] {
  return revisionId === SPEAKERS_EARLIER_REVISION ? segments(EARLIER_SEQUENCE, {}, revisionId) : segments(state.sequence, state.texts, SPEAKERS_REVISION, state.offsetMs ?? 0, state.paragraphStarts);
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
  return { ...revision(revisionId, revisionSegments(state, revisionId).length), ...(confirmedAt === undefined ? {} : { speakersConfirmedAt: confirmedAt }) };
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
    if (method === "GET" && resource === undefined) return json(contentDetailDtoSchema.parse({ ...content(), media: [] }));
    if (method === "GET" && resource === "summaries") return json(summaries(SPEAKERS_REVISION, SPEAKERS_CONTENT, false));
    if (method === "GET" && resource === "chapters") return json(speakerChapters(speakersRequests(request.frame().page())));
    if (method === "GET" && resource === "notes") return json({ items: [] });
    if (method === "GET" && resource === "transcript/revisions") {
      const state = speakersRequests(request.frame().page());
      const ids = state.earlierRevision ? [SPEAKERS_EARLIER_REVISION, SPEAKERS_REVISION] : [SPEAKERS_REVISION];
      return json(transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: SPEAKERS_REVISION, revisions: ids.map((id) => revisionListItem(revisionDto(state, id))) }));
    }
    const state = speakersRequests(request.frame().page());
    if (method === "GET" && resource === "speakers") return json(speakerListDtoSchema.parse({ items: state.speakers }));
    const speakerMatch = resource === undefined ? null : /^speakers\/([^/]+)(\/avatar)?$/.exec(resource);
    if (speakerMatch !== null && speakerMatch[2] !== undefined && method === "GET") {
      state.avatarHeaders.push(request.headers());
      await route.fulfill({ status: 200, contentType: "image/png", body: AVATAR_PNG });
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
      return json(updated);
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
  if (revisionMatch === null || (revisionId !== SPEAKERS_REVISION && revisionId !== SPEAKERS_EARLIER_REVISION)) return false;
  const state = speakersRequests(request.frame().page());
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
