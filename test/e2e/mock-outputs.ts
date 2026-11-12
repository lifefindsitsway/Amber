import type { Page, Request, Route } from "@playwright/test";
import { chaptersDtoSchema } from "../../src/shared/dto/chapter.ts";
import { chatDtoSchema } from "../../src/shared/dto/chat.ts";
import { collectionDetailDtoSchema, collectionSummaryDtoSchema } from "../../src/shared/dto/collection.ts";
import { contentDetailDtoSchema, contentDtoSchema, contentListDtoSchema, transcriptRevisionListDtoSchema, type TranscriptRevisionDto } from "../../src/shared/dto/content.ts";
import { contentExportRequestSchema } from "../../src/shared/dto/export.ts";
import { highlightsDtoSchema } from "../../src/shared/dto/highlight.ts";
import { speakerListDtoSchema, type SpeakerDto } from "../../src/shared/dto/speaker.ts";
import type { SpeakerContextDto } from "../../src/shared/dto/speaker-context.ts";
import { contentSummariesDtoSchema } from "../../src/shared/dto/summary.ts";
import { taskAcceptedDtoSchema } from "../../src/shared/dto/task.ts";
import { speakerReviewDtoSchema, transcriptSegmentPageDtoSchema, type TranscriptSegmentDto } from "../../src/shared/dto/transcript.ts";
import { translationRequestSchema, translationsDtoSchema } from "../../src/shared/dto/translation.ts";
import { BILI_REVISION, BILIBILI_CONTENT, PROFILE, revisionListItem, segmentId } from "./mock-backend.ts";

/**
 * The fake AI highlights, translations and file exports of the browser smoke, for the
 * processed bilibili lecture: recompute and translate "finish" at once, so the page shows
 * their results after its own refetch; exports answer with a named file whose first line
 * the specs check. Request bodies are parsed with the shared schemas.
 */

export const BILIBILI_TITLE = "第二讲：B 站模拟课程";
/** Scores of the generated highlights over sentences 1, 8 and 12. */
export const HIGHLIGHT_SCORES = [95, 85, 60] as const;
const HIGHLIGHT_INDEXES = [0, 7, 11] as const;
const SEGMENT_MS = 10_000;
const now = 1_790_000_000_000;

interface OutputState {
  highlights: Set<string>;
  languages: string[];
}

const states = new WeakMap<Page, OutputState>();

function stateOf(page: Page): OutputState {
  let state = states.get(page);
  if (state === undefined) {
    state = { highlights: new Set(), languages: [] };
    states.set(page, state);
  }
  return state;
}

const translatedId = (language: string): string => `01J00000000000000000TR${language.toUpperCase().padEnd(4, "X").slice(0, 4)}`;

function biliRevision(): TranscriptRevisionDto {
  return {
    id: BILI_REVISION,
    contentId: BILIBILI_CONTENT,
    kind: "platform",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "platform" },
    segmentCount: 12,
    createdAt: now,
  };
}

function translated(language: string): TranscriptRevisionDto {
  return { ...biliRevision(), id: translatedId(language), kind: "translated", language, parentRevisionId: BILI_REVISION, generation: { kind: "llm" }, createdAt: now + 1 };
}

const sentence = (index: number): string => `第 ${index + 1} 句模拟字幕。`;

function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** `/api/contents/:id/{highlights,translations,export}` and the bilibili revisions once translated; false for anything else. */
export async function handleOutputs(route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const state = stateOf(request.frame().page());
  const match = /^\/api\/contents\/([^/]+)\/(highlights(?:\/recompute)?|translations|export|transcript\/revisions)$/.exec(path);
  const translatedMatch = /^\/api\/transcript\/revisions\/([^/]+)\/segments$/.exec(path);

  if (translatedMatch !== null) {
    const language = state.languages.find((tag) => translatedId(tag) === translatedMatch[1]);
    if (language === undefined) return false;
    const revision = translated(language);
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: `${revision.id.slice(0, 22)}${String(index).padStart(4, "0")}`,
      revisionId: revision.id,
      ordinal: index,
      startMs: index * SEGMENT_MS,
      endMs: (index + 1) * SEGMENT_MS - 500,
      text: `[${language}] ${sentence(index)}`,
      sourceSegmentIds: [segmentId(BILI_REVISION, index)],
    }));
    await fulfillJson(route, transcriptSegmentPageDtoSchema.parse({ revision, items }));
    return true;
  }
  if (match === null) return false;
  const contentId = match[1] as string;
  const resource = match[2] as string;

  if (resource === "transcript/revisions") {
    if (contentId !== BILIBILI_CONTENT || state.languages.length === 0) return false;
    await fulfillJson(
      route,
      transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: BILI_REVISION, revisions: [biliRevision(), ...state.languages.map(translated)].map(revisionListItem) }),
    );
    return true;
  }
  if (resource === "highlights/recompute" && method === "POST") {
    state.highlights.add(contentId);
    await fulfillJson(route, taskAcceptedDtoSchema.parse({ taskId: "01J000000000000000HLTASK01" }), 202);
    return true;
  }
  if (resource === "highlights" && method === "GET") {
    const generated = contentId === BILIBILI_CONTENT && state.highlights.has(contentId);
    const body = generated
      ? {
          artifactId: "01J0000000000000000000HLA1",
          current: {
            id: "01J0000000000000000000HLR1",
            artifactId: "01J0000000000000000000HLA1",
            transcriptRevisionId: BILI_REVISION,
            items: HIGHLIGHT_INDEXES.map((index, position) => ({
              segmentId: segmentId(BILI_REVISION, index),
              score: HIGHLIGHT_SCORES[position],
              text: `第 ${index + 1} 句是关键`,
              segmentText: sentence(index),
              startMs: index * SEGMENT_MS,
              endMs: (index + 1) * SEGMENT_MS - 500,
            })),
            quality: "normal",
            qualityReasons: [],
            stale: false,
            createdAt: now,
          },
        }
      : {};
    await fulfillJson(route, highlightsDtoSchema.parse(body));
    return true;
  }
  if (resource === "translations" && method === "POST") {
    const body = translationRequestSchema.parse(request.postDataJSON());
    for (const language of body.targetLanguages) {
      if (!state.languages.includes(language)) state.languages.push(language);
    }
    await fulfillJson(route, taskAcceptedDtoSchema.parse({ taskId: "01J000000000000000TRTASK01" }), 202);
    return true;
  }
  if (resource === "translations" && method === "GET") {
    const languages = contentId === BILIBILI_CONTENT ? state.languages : [];
    await fulfillJson(
      route,
      translationsDtoSchema.parse({
        translations: languages.map((language) => ({
          artifactId: `01J00000000000000000TA${language.toUpperCase().padEnd(4, "X").slice(0, 4)}`,
          targetLanguage: language,
          current: translated(language),
          revisions: [translated(language)],
          stale: false,
        })),
        activeTasks: [],
      }),
    );
    return true;
  }
  if (resource === "export" && method === "POST") {
    const body = contentExportRequestSchema.parse(request.postDataJSON());
    const extension = body.format === "markdown" ? "md" : body.format.startsWith("srt") ? "srt" : body.format.startsWith("ass") ? "ass" : body.format;
    const text =
      body.format === "markdown"
        ? `# ${BILIBILI_TITLE}\n\n## 原文细读\n${sentence(0)}\n`
        : body.format.startsWith("srt")
          ? `1\n00:00:00,000 --> 00:00:09,500\n${sentence(0)}\n`
          : `${body.format}\n`;
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${BILIBILI_TITLE}.${extension}`)}` },
      body: text,
    });
    return true;
  }
  return false;
}

/*
 * Two lectures whose AI results were generated with speakers, for the speaker-notice and
 * speaker-search specs. The first one's summary, chapters and highlights report whatever
 * speaker basis a spec sets; the second one only shares a speaker's name with the first, so
 * a name search finds two people. Installed per page on top of the shared fake; anything not
 * about these lectures falls through to it.
 */
export const BASIS_CONTENT = "01J0000000000000000000SB01";
export const BASIS_REVISION = "01J0000000000000000000SBR1";
export const BASIS_TITLE = "第五讲：发言人依据模拟课程";
export const NAMESAKE_CONTENT = "01J0000000000000000000SB02";
export const NAMESAKE_REVISION = "01J0000000000000000000SBR2";
export const NAMESAKE_TITLE = "第六讲：同名发言人模拟课程";
export const BASIS_COLLECTION = "01J0000000000000000000SBC1";
export const BASIS_COLLECTION_NAME = "发言人依据合集";
export const PROFESSOR = "01J0000000000000000000SBK1";
export const GUEST = "01J0000000000000000000SBK2";
export const NAMESAKE_PROFESSOR = "01J0000000000000000000SBK3";
export const NAMESAKE_GUEST = "01J0000000000000000000SBK4";
/** The name both lectures give their first speaker; it appears in no sentence, title or summary. */
export const PROFESSOR_NAME = "王教授";
/** The sentence the summary and the chat answer cite: the unnamed guest's first one. */
export const BASIS_CITED_INDEX = 2;
const BASIS_SEGMENT_MS = 10_000;

interface Lecture {
  contentId: string;
  revisionId: string;
  title: string;
  speakers: SpeakerDto[];
  /** Who says each sentence. */
  sequence: readonly string[];
  sentence: (index: number) => string;
}

export const BASIS_LECTURE: Lecture = {
  contentId: BASIS_CONTENT,
  revisionId: BASIS_REVISION,
  title: BASIS_TITLE,
  speakers: [
    { id: PROFESSOR, ordinal: 1, name: PROFESSOR_NAME, colorIndex: 0, used: true, nameConfirmed: true },
    { id: GUEST, ordinal: 2, colorIndex: 1, used: true },
  ],
  sequence: [PROFESSOR, PROFESSOR, GUEST, PROFESSOR, GUEST, PROFESSOR],
  sentence: (index) => `第 ${index + 1} 句依据模拟字幕。`,
};

export const NAMESAKE_LECTURE: Lecture = {
  contentId: NAMESAKE_CONTENT,
  revisionId: NAMESAKE_REVISION,
  title: NAMESAKE_TITLE,
  speakers: [
    { id: NAMESAKE_PROFESSOR, ordinal: 1, name: PROFESSOR_NAME, colorIndex: 2, used: true },
    { id: NAMESAKE_GUEST, ordinal: 2, colorIndex: 3, used: true },
  ],
  sequence: [NAMESAKE_GUEST, NAMESAKE_PROFESSOR, NAMESAKE_PROFESSOR],
  sentence: (index) => `第 ${index + 1} 句依据同名字幕。`,
};

const LECTURES = [BASIS_LECTURE, NAMESAKE_LECTURE];

/** What the two lectures look like for one page; specs change it before navigating. */
export interface SpeakerBasisState {
  /** The speaker context of the first lecture's summary, chapters and highlights; undefined = generated without speakers. */
  basis: SpeakerContextDto | undefined;
  /** Whether the first lecture's primary has its speakers reviewed; the second one's never has. */
  confirmed: boolean;
  /** The first lecture's player: bilibili can only be moved, YouTube plays a range. */
  source: "bilibili" | "youtube";
  /** A stored chat answer on the first lecture, generated with these speakers. */
  chatAnswer: SpeakerContextDto | undefined;
  /** Members of the collection whose summaries' speaker basis changed; undefined = none. */
  collectionChanged: number | undefined;
}

const basisStates = new WeakMap<Page, SpeakerBasisState>();

/** The two lectures' state on this page, or undefined when the page did not install them. */
export function speakerBasisState(page: Page): SpeakerBasisState | undefined {
  return basisStates.get(page);
}

const lectureSegments = (lecture: Lecture): TranscriptSegmentDto[] =>
  lecture.sequence.map((speakerId, index) => ({
    id: segmentId(lecture.revisionId, index),
    revisionId: lecture.revisionId,
    ordinal: index,
    startMs: index * BASIS_SEGMENT_MS,
    endMs: (index + 1) * BASIS_SEGMENT_MS - 500,
    text: lecture.sentence(index),
    speakerId,
    sourceSegmentIds: [],
  }));

/** Whether the lecture's primary has its speakers reviewed. */
export function lectureConfirmed(lecture: Lecture, state: SpeakerBasisState): boolean {
  return lecture === BASIS_LECTURE && state.confirmed;
}

function lectureRevision(lecture: Lecture, state: SpeakerBasisState): TranscriptRevisionDto {
  return {
    id: lecture.revisionId,
    contentId: lecture.contentId,
    kind: "asr",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "asr", modelId: "fun-asr", diarization: { status: "applied" } },
    segmentCount: lecture.sequence.length,
    ...(lectureConfirmed(lecture, state) ? { speakersConfirmedAt: now } : {}),
    createdAt: now,
  };
}

function lectureContent(lecture: Lecture, state: SpeakerBasisState) {
  const youtube = lecture === BASIS_LECTURE && state.source === "youtube";
  return contentDtoSchema.parse({
    id: lecture.contentId,
    source: youtube
      ? { kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=mockBasis01", platformContentId: "mockBasis01" }
      : { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/BV1mockbasis${lecture.contentId.slice(-1)}`, platformContentId: `BV1mockbasis${lecture.contentId.slice(-1)}`, platformPartId: "1" },
    title: lecture.title,
    durationMs: lecture.sequence.length * BASIS_SEGMENT_MS,
    rawLanguage: "zh-CN",
    primaryTranscriptRevisionId: lecture.revisionId,
    processingStatus: "succeeded",
    collections: lecture === BASIS_LECTURE ? [{ id: BASIS_COLLECTION, name: BASIS_COLLECTION_NAME, itemId: "01J00000000000000000ITMSB1" }] : [],
    createdAt: now,
    updatedAt: now,
  });
}

/** The summary text of each lecture; it quotes no speaker name, so a name search finds no summary. */
export const lectureSummaryText = (lecture: Lecture): string => (lecture === BASIS_LECTURE ? "嘉宾认为依据需要复核" : "两位发言人讨论依据");

function lectureSummaries(lecture: Lecture, state: SpeakerBasisState) {
  const cited = segmentId(lecture.revisionId, BASIS_CITED_INDEX);
  const basis = lecture === BASIS_LECTURE ? state.basis : undefined;
  return contentSummariesDtoSchema.parse({
    templates: [
      {
        template: { id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false },
        artifactId: `01J00000000000000000ARTSB${lecture.contentId.slice(-1)}`,
        stale: false,
        current: {
          id: `01J00000000000000000SUMSB${lecture.contentId.slice(-1)}`,
          artifactId: `01J00000000000000000ARTSB${lecture.contentId.slice(-1)}`,
          body: `## 摘要\n${lectureSummaryText(lecture)} [[seg:${cited}]]。`,
          citations: [{ transcriptRevisionId: lecture.revisionId, segmentId: cited }],
          transcriptRevisionId: lecture.revisionId,
          quality: "normal",
          qualityReasons: [],
          stale: false,
          ...(basis === undefined ? {} : { speakerContext: basis }),
          createdAt: now,
        },
      },
    ],
  });
}

function lectureChapters(lecture: Lecture, state: SpeakerBasisState) {
  const basis = lecture === BASIS_LECTURE ? state.basis : undefined;
  const current = {
    id: `01J00000000000000000CHRSB${lecture.contentId.slice(-1)}`,
    artifactId: `01J00000000000000000CHASB${lecture.contentId.slice(-1)}`,
    origin: { kind: "ai", transcriptRevisionId: lecture.revisionId },
    chapters: [
      { startMs: 0, endMs: 3 * BASIS_SEGMENT_MS, title: "开场", startSegmentId: segmentId(lecture.revisionId, 0) },
      { startMs: 3 * BASIS_SEGMENT_MS, endMs: lecture.sequence.length * BASIS_SEGMENT_MS, title: "讨论", startSegmentId: segmentId(lecture.revisionId, 3) },
    ],
    quality: "normal",
    qualityReasons: [],
    stale: false,
    ...(basis === undefined ? {} : { speakerContext: basis }),
    createdAt: now,
  };
  return chaptersDtoSchema.parse({ artifactId: current.artifactId, current, revisions: [current] });
}

/** The highlighted sentences of the first lecture: the professor's first and the guest's first. */
export const BASIS_HIGHLIGHT_INDEXES = [0, BASIS_CITED_INDEX] as const;

function lectureHighlights(lecture: Lecture, state: SpeakerBasisState) {
  const basis = lecture === BASIS_LECTURE ? state.basis : undefined;
  return highlightsDtoSchema.parse({
    artifactId: `01J00000000000000000HLASB${lecture.contentId.slice(-1)}`,
    current: {
      id: `01J00000000000000000HLRSB${lecture.contentId.slice(-1)}`,
      artifactId: `01J00000000000000000HLASB${lecture.contentId.slice(-1)}`,
      transcriptRevisionId: lecture.revisionId,
      items: BASIS_HIGHLIGHT_INDEXES.map((index) => ({
        segmentId: segmentId(lecture.revisionId, index),
        score: 90,
        text: `第 ${index + 1} 句是重点`,
        segmentText: lecture.sentence(index),
        speakerId: lecture.sequence[index],
        startMs: index * BASIS_SEGMENT_MS,
        endMs: (index + 1) * BASIS_SEGMENT_MS - 500,
      })),
      quality: "normal",
      qualityReasons: [],
      stale: false,
      ...(basis === undefined ? {} : { speakerContext: basis }),
      createdAt: now,
    },
  });
}

function lectureReview(lecture: Lecture, state: SpeakerBasisState) {
  const counts = new Map<string, number>();
  for (const speakerId of lecture.sequence) counts.set(speakerId, (counts.get(speakerId) ?? 0) + 1);
  return speakerReviewDtoSchema.parse({
    revisionId: lecture.revisionId,
    ...(lectureConfirmed(lecture, state) ? { confirmedAt: now } : {}),
    rosterDigest: `digest-${lecture.contentId.slice(-1)}`,
    speakers: [...counts].map(([id, sentences]) => ({ id, sentences, assignedMs: sentences * (BASIS_SEGMENT_MS - 500) })),
    unassigned: 0,
    pendingNames: 0,
  });
}

const BASIS_THREAD = "01J00000000000000000THRSB1";
/** The stored chat answer's text; it cites the guest's sentence. */
export const BASIS_CHAT_ANSWER = "嘉宾在这里提出了疑问";

function lectureChat(state: SpeakerBasisState) {
  const cited = segmentId(BASIS_REVISION, BASIS_CITED_INDEX);
  const thread = { id: BASIS_THREAD, createdAt: now, title: "嘉宾说了什么？", lastMessageAt: now + 2 };
  const modelRef = { providerProfileId: PROFILE, modelId: "mock-model", providerNameSnapshot: "模拟模型", modelDisplaySnapshot: "mock-model", protocolSnapshot: "openai_compatible" };
  return chatDtoSchema.parse({
    thread,
    messages: [
      { id: "01J00000000000000000MSGSB1", role: "user", text: "嘉宾说了什么？", status: "complete", citations: [], createdAt: now + 1 },
      {
        id: "01J00000000000000000MSGSB2",
        role: "assistant",
        text: `${BASIS_CHAT_ANSWER} [[seg:${cited}]]。`,
        status: "complete",
        contextTranscriptRevisionId: BASIS_REVISION,
        citations: [{ transcriptRevisionId: BASIS_REVISION, segmentId: cited }],
        modelRef,
        ...(state.chatAnswer === undefined ? {} : { speakerContext: state.chatAnswer }),
        createdAt: now + 2,
        finishedAt: now + 2,
      },
    ],
    context: { mode: "full", estimatedTokens: 1234 },
  });
}

function lectureCollection(state: SpeakerBasisState) {
  const detail = collectionDetailDtoSchema.parse({
    id: BASIS_COLLECTION,
    name: BASIS_COLLECTION_NAME,
    itemCount: 1,
    createdAt: now,
    updatedAt: now,
    items: [
      {
        id: "01J00000000000000000ITMSB1",
        contentId: BASIS_CONTENT,
        position: 0,
        addedAt: now,
        title: BASIS_TITLE,
        processingStatus: "succeeded",
        source: { kind: "bilibili" },
        updatedAt: now,
      },
    ],
  });
  const summary = collectionSummaryDtoSchema.parse({ stale: false, ...(state.collectionChanged === undefined ? {} : { speakerContextChangedMembers: state.collectionChanged }) });
  return { detail, summary };
}

/**
 * Serves the two lectures (and the collection holding the first) on `page`, on top of the
 * shared fake. Returns the state the routes read, for the spec to change between visits.
 */
export async function installSpeakerBasis(page: Page, initial: Partial<SpeakerBasisState> = {}): Promise<SpeakerBasisState> {
  const state: SpeakerBasisState = { basis: undefined, confirmed: true, source: "bilibili", chatAnswer: undefined, collectionChanged: undefined, ...initial };
  basisStates.set(page, state);
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET") return route.fallback();
    // The library reads its search hits back by id.
    const ids = path === "/api/contents" ? url.searchParams.get("ids") : null;
    if (ids !== null) {
      const wanted = ids.split(",");
      const own = LECTURES.filter((lecture) => wanted.includes(lecture.contentId));
      if (own.length > 0) return reply(contentListDtoSchema.parse({ items: own.map((lecture) => lectureContent(lecture, state)), total: own.length }));
      return route.fallback();
    }
    if (path === `/api/collections/${BASIS_COLLECTION}`) return reply(lectureCollection(state).detail);
    if (path === `/api/collections/${BASIS_COLLECTION}/summary`) return reply(lectureCollection(state).summary);
    const revisionMatch = /^\/api\/transcript\/revisions\/([^/]+)\/(segments|speaker-review)$/.exec(path);
    if (revisionMatch !== null) {
      const lecture = LECTURES.find((item) => item.revisionId === revisionMatch[1]);
      if (lecture === undefined) return route.fallback();
      return reply(
        revisionMatch[2] === "segments"
          ? transcriptSegmentPageDtoSchema.parse({ revision: lectureRevision(lecture, state), items: lectureSegments(lecture) })
          : lectureReview(lecture, state),
      );
    }
    const contentMatch = /^\/api\/contents\/([^/]+)(?:\/(.+))?$/.exec(path);
    const lecture = contentMatch === null ? undefined : LECTURES.find((item) => item.contentId === contentMatch[1]);
    if (lecture === undefined || contentMatch === null) return route.fallback();
    switch (contentMatch[2]) {
      case undefined:
        return reply(contentDetailDtoSchema.parse({ ...lectureContent(lecture, state), media: [] }));
      case "summaries":
        return reply(lectureSummaries(lecture, state));
      case "chapters":
        return reply(lectureChapters(lecture, state));
      case "highlights":
        return reply(lectureHighlights(lecture, state));
      case "speakers":
        return reply(speakerListDtoSchema.parse({ items: lecture.speakers }));
      case "transcript/revisions":
        return reply(transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: lecture.revisionId, revisions: [revisionListItem(lectureRevision(lecture, state))] }));
      case "chat":
        return lecture === BASIS_LECTURE && state.chatAnswer !== undefined ? reply(lectureChat(state)) : route.fallback();
      case "chat/threads":
        return lecture === BASIS_LECTURE && state.chatAnswer !== undefined ? reply({ threads: [lectureChat(state).thread] }) : route.fallback();
      default:
        return route.fallback();
    }
  });
  return state;
}
