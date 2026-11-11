import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { contentDetailDtoSchema, transcriptRevisionListDtoSchema } from "../../src/shared/dto/content.ts";
import { contentExportRequestSchema } from "../../src/shared/dto/export.ts";
import { chaptersDtoSchema } from "../../src/shared/dto/chapter.ts";
import { speakerDtoSchema, speakerListDtoSchema, speakerPatchRequestSchema, type SpeakerDto } from "../../src/shared/dto/speaker.ts";
import { errorResponseSchema } from "../../src/shared/errors.ts";
import type { DiarizationUnavailableReason } from "../../src/shared/speakers.ts";
import { taskAcceptedDtoSchema } from "../../src/shared/dto/task.ts";
import { transcriptSegmentPageDtoSchema, type TranscriptSegmentDto } from "../../src/shared/dto/transcript.ts";
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
const SEGMENT_MS = 10_000;
const now = 1_790_000_000_000;

/** The speakers: a named teacher and an unnamed second speaker, shown as 「发言人 2」. */
export const SPEAKERS: SpeakerDto[] = [
  { id: SPEAKER_TEACHER, ordinal: 1, name: "林老师", colorIndex: 0, avatarVersion: 1, used: true },
  { id: SPEAKER_STUDENT, ordinal: 2, colorIndex: 1, used: true },
];

/** Who says each sentence: two turns of the teacher around one of the student, and a last sentence nobody was assigned to. */
export const SPEAKER_SEQUENCE = [SPEAKER_TEACHER, SPEAKER_TEACHER, SPEAKER_STUDENT, SPEAKER_TEACHER, SPEAKER_TEACHER, undefined] as const;

export const speakerSentence = (index: number): string => `第 ${index + 1} 句发言人模拟字幕。`;

function revision() {
  return {
    id: SPEAKERS_REVISION,
    contentId: SPEAKERS_CONTENT,
    kind: "asr",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "asr", modelId: "fun-asr", diarization: { status: "applied" } },
    segmentCount: SPEAKER_SEQUENCE.length,
    createdAt: now,
  } as const;
}

function segments(): TranscriptSegmentDto[] {
  return SPEAKER_SEQUENCE.map((speakerId, index) => ({
    id: segmentId(SPEAKERS_REVISION, index),
    revisionId: SPEAKERS_REVISION,
    ordinal: index,
    startMs: index * SEGMENT_MS,
    endMs: (index + 1) * SEGMENT_MS - 500,
    text: speakerSentence(index),
    ...(speakerId === undefined ? {} : { speakerId }),
    sourceSegmentIds: [],
  }));
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
  /** Headers of every request for a speaker's photo. */
  avatarHeaders: Array<Record<string, string>>;
  /** Refuses the next re-transcribe with `invalid_request.diarization_unavailable` and this reason. */
  refuseNextRetranscribe?: DiarizationUnavailableReason;
}

const states = new WeakMap<BrowserContext, SpeakersRequests>();

/** What the pages of this browser context sent to the speakers lecture's endpoints so far. */
export function speakersRequests(page: Page): SpeakersRequests {
  const context = page.context();
  let state = states.get(context);
  if (state === undefined) {
    state = { exports: [], speakers: SPEAKERS.map((speaker) => ({ ...speaker })), avatarHeaders: [] };
    states.set(context, state);
  }
  return state;
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
    if (method === "GET" && resource === "chapters") return json(chaptersDtoSchema.parse({ revisions: [] }));
    if (method === "GET" && resource === "notes") return json({ items: [] });
    if (method === "GET" && resource === "transcript/revisions") {
      return json(transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: SPEAKERS_REVISION, revisions: [revisionListItem(revision())] }));
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
      const { name: _old, ...rest } = current;
      const name = patch.name === undefined ? current.name : (patch.name ?? undefined);
      const updated = speakerDtoSchema.parse({ ...rest, ...(name === undefined ? {} : { name }), ...(patch.colorIndex === undefined ? {} : { colorIndex: patch.colorIndex }) });
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
  if (method === "GET" && path === `/api/transcript/revisions/${SPEAKERS_REVISION}/segments`) {
    return json(transcriptSegmentPageDtoSchema.parse({ revision: revision(), items: segments() }));
  }
  return false;
}
