import type { Page, Request, Route } from "@playwright/test";
import { chaptersDtoSchema } from "../../src/shared/dto/chapter.ts";
import { contentDescriptionFetchDtoSchema, contentDetailDtoSchema, transcriptRevisionListDtoSchema } from "../../src/shared/dto/content.ts";
import { taskDetailDtoSchema, taskListDtoSchema, type StageRunDto } from "../../src/shared/dto/task.ts";
import { transcriptSegmentPageDtoSchema } from "../../src/shared/dto/transcript.ts";
import type { DescriptionFetchResult } from "../../src/shared/dto/content.ts";
import type { ProcessingStatus, StageId, StageStatus } from "../../src/shared/enums.ts";
import { errorResponseSchema, type ErrorClass } from "../../src/shared/errors.ts";
import { CLIP_SERVER_PORT } from "../fixtures/e2e/global-setup.ts";
import { revisionListItem, segmentId, summaries } from "./mock-backend.ts";

/**
 * Platform lectures whose own video description the content page shows under the title, and
 * `POST /api/contents/:id/description/fetch` answering as the server does: `found` and `empty`
 * write the description (or its absence) and the time it was settled, `unknown` writes nothing,
 * `superseded` answers with the Content as another request left it, and an error answers the
 * usual `{ error }`. Each lecture is set up per browser context before its page loads; every
 * body is parsed with the shared schemas.
 */

const now = 1_790_000_000_000;
const SENTENCE_MS = 4_000;
/** The clip the Playwright global setup serves with range support, as `GET /api/media` does. */
const CLIP_URL = `http://127.0.0.1:${CLIP_SERVER_PORT}/local-player.webm`;

/** The id of the `n`th description lecture (from 1). */
export const descriptionContentId = (n: number): string => `01J0000000000000000000DS${String(n).padStart(2, "0")}`;
/** Its one revision; the 22 characters segment ids start with differ from every other revision's. */
export const descriptionRevisionId = (n: number): string => `01J00000000000000000DR${String(n).padStart(2, "0")}RV`;
const taskId = (n: number): string => `01J000000000000000DSTASK${String(n).padStart(2, "0")}`;
const assetId = (n: number): string => `01J0000000000000000000DA${String(n).padStart(2, "0")}`;
export const descriptionSentence = (index: number): string => `第 ${index + 1} 句简介课程字幕。`;

/** One answer of the fetch endpoint, used up by one request. */
export type FetchAnswer =
  | { result: "found"; description: string; truncated?: true }
  | { result: Extract<DescriptionFetchResult, "empty" | "unknown"> }
  /** Another request settled the description first: the answer carries what it left. */
  | { result: "superseded"; description: string }
  | { error: { status: number; class: ErrorClass; code: string; userMessage: string } };

/** The latest `process_content` Task of a lecture, as far as the title row asks about it. */
export interface MockTask {
  status: ProcessingStatus;
  stages: ReadonlyArray<[StageId, StageStatus]>;
}

export interface DescriptionLecture {
  title: string;
  platform: "bilibili" | "youtube";
  description?: string;
  truncated?: true;
  checkedAt?: number;
  /** Sentences of its transcript. */
  sentences: number;
  task?: MockTask;
  /** A cached copy of the video the local player can play. */
  cached?: true;
  /** Answers for the next fetches, in order; an empty queue answers `unknown`. */
  answers: FetchAnswer[];
  /** While set, a fetch waits for it before answering. */
  hold?: Promise<void>;
}

export interface DescriptionState {
  lectures: Map<number, DescriptionLecture>;
  /** Every fetch request, by lecture number, in order. */
  fetches: number[];
}

const states = new WeakMap<object, DescriptionState>();

/** The description lectures of this page's browser context; set them up before the page loads. */
export function descriptionState(page: Page): DescriptionState {
  const context = page.context();
  let state = states.get(context);
  if (state === undefined) {
    state = { lectures: new Map(), fetches: [] };
    states.set(context, state);
  }
  return state;
}

function detail(n: number, lecture: DescriptionLecture) {
  const bilibili = lecture.platform === "bilibili";
  const id = `BV1desc${String(n).padStart(5, "0")}`;
  return contentDetailDtoSchema.parse({
    id: descriptionContentId(n),
    source: bilibili
      ? { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${id}`, platformContentId: id, platformPartId: "1" }
      : { kind: "youtube", sourceUrl: `https://www.youtube.com/watch?v=desc${n}`, platformContentId: `desc${n}` },
    title: lecture.title,
    durationMs: lecture.sentences * SENTENCE_MS,
    rawLanguage: "zh-CN",
    primaryTranscriptRevisionId: descriptionRevisionId(n),
    processingStatus: lecture.task === undefined || lecture.task.status === "succeeded" ? "succeeded" : lecture.task.status,
    collections: [],
    createdAt: now,
    updatedAt: now,
    media: lecture.cached
      ? [
          {
            id: assetId(n),
            kind: "platform_cache",
            displayName: "cache.webm",
            mimeType: "video/webm",
            sizeBytes: 1,
            durationMs: 130_000,
            quality: "360",
            availability: "available",
            retentionPolicy: "evictable",
            localPath: "cache.webm",
            createdAt: now,
          },
        ]
      : [],
    ...(lecture.description === undefined ? {} : { description: lecture.description }),
    ...(lecture.truncated === undefined ? {} : { descriptionTruncated: true }),
    ...(lecture.checkedAt === undefined ? {} : { descriptionCheckedAt: lecture.checkedAt }),
  });
}

function revision(n: number, lecture: DescriptionLecture) {
  return {
    id: descriptionRevisionId(n),
    contentId: descriptionContentId(n),
    kind: "platform",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "platform" },
    segmentCount: lecture.sentences,
    createdAt: now,
  } as const;
}

function stageRuns(n: number, task: MockTask): StageRunDto[] {
  return task.stages.map(([stage, status], index) => ({
    id: `01J00000000000000DSSTAGE${String(n).padStart(1, "0")}${index}`.slice(0, 26),
    taskId: taskId(n),
    stage,
    attempt: 1,
    status,
    progress: status === "succeeded" || status === "skipped" ? 1 : 0,
    dependencies: index === 0 ? [] : [task.stages[index - 1]?.[0] as StageId],
  }));
}

function taskDetail(n: number, lecture: DescriptionLecture, task: MockTask) {
  return taskDetailDtoSchema.parse({
    id: taskId(n),
    contentId: descriptionContentId(n),
    kind: "process_content",
    statusProjection: task.status,
    targetTitle: lecture.title,
    createdAt: now,
    stageRuns: stageRuns(n, task),
    workUnits: [],
    eventSeq: 0,
  });
}

/** Applies one fetch to the lecture the way the server writes it, and says what to answer. */
function fetchOnce(n: number, lecture: DescriptionLecture): { status: number; body: unknown } {
  const answer = lecture.answers.shift() ?? { result: "unknown" };
  if ("error" in answer) {
    const { status, ...error } = answer.error;
    return { status, body: errorResponseSchema.parse({ error: { ...error, retryDisposition: "safe" } }) };
  }
  if (answer.result === "found" || answer.result === "superseded") {
    lecture.description = answer.description;
    if ("truncated" in answer && answer.truncated !== undefined) lecture.truncated = true;
    else delete lecture.truncated;
    lecture.checkedAt = Date.now();
  } else if (answer.result === "empty") {
    delete lecture.description;
    delete lecture.truncated;
    lecture.checkedAt = Date.now();
  }
  return { status: 200, body: contentDescriptionFetchDtoSchema.parse({ result: answer.result, content: detail(n, lecture) }) };
}

/** `/api/**` of the description lectures; false for anything else. */
export async function handleDescription(route: Route, request: Request, url: URL): Promise<boolean> {
  const state = descriptionState(request.frame().page());
  if (state.lectures.size === 0) return false;
  const method = request.method();
  const path = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).then(() => true);
  const lectureOf = (find: (n: number) => boolean): [number, DescriptionLecture] | undefined => [...state.lectures].find(([n]) => find(n));

  const contentMatch = /^\/api\/contents\/([^/]+)(?:\/(.+))?$/.exec(path);
  const byContent = contentMatch === null ? undefined : lectureOf((n) => descriptionContentId(n) === contentMatch[1]);
  if (contentMatch !== null && byContent !== undefined) {
    const [n, lecture] = byContent;
    const resource = contentMatch[2];
    if (method === "GET" && resource === undefined) return json(detail(n, lecture));
    if (method === "POST" && resource === "description/fetch") {
      state.fetches.push(n);
      if (lecture.hold !== undefined) await lecture.hold;
      const answer = fetchOnce(n, lecture);
      return json(answer.body, answer.status);
    }
    if (method === "GET" && resource === "summaries") return json(summaries(descriptionRevisionId(n), descriptionContentId(n), false));
    if (method === "GET" && resource === "chapters") return json(chaptersDtoSchema.parse({ revisions: [] }));
    if (method === "GET" && resource === "notes") return json({ items: [] });
    if (method === "GET" && resource === "transcript/revisions") {
      return json(transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: descriptionRevisionId(n), revisions: [revisionListItem(revision(n, lecture))] }));
    }
    return false;
  }
  const segmentsMatch = /^\/api\/transcript\/revisions\/([^/]+)\/segments$/.exec(path);
  const byRevision = segmentsMatch === null ? undefined : lectureOf((n) => descriptionRevisionId(n) === segmentsMatch[1]);
  if (method === "GET" && byRevision !== undefined) {
    const [n, lecture] = byRevision;
    const id = descriptionRevisionId(n);
    const items = Array.from({ length: lecture.sentences }, (_, index) => ({
      id: segmentId(id, index),
      revisionId: id,
      ordinal: index,
      startMs: index * SENTENCE_MS,
      endMs: (index + 1) * SENTENCE_MS - 200,
      text: descriptionSentence(index),
      sourceSegmentIds: [],
    }));
    return json(transcriptSegmentPageDtoSchema.parse({ revision: revision(n, lecture), items }));
  }
  if (method === "GET" && path === "/api/tasks") {
    const byTasks = lectureOf((n) => descriptionContentId(n) === url.searchParams.get("contentId"));
    if (byTasks === undefined) return false;
    const [n, lecture] = byTasks;
    const task = url.searchParams.get("kind") === "process_content" ? lecture.task : undefined;
    const items = task === undefined ? [] : [(({ stageRuns: _runs, workUnits: _units, eventSeq: _seq, ...rest }) => rest)(taskDetail(n, lecture, task))];
    return json(taskListDtoSchema.parse({ items, eventSeq: 0 }));
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  const byTask = taskMatch === null ? undefined : lectureOf((n) => taskId(n) === taskMatch[1]);
  if (method === "GET" && byTask !== undefined && byTask[1].task !== undefined) return json(taskDetail(byTask[0], byTask[1], byTask[1].task));
  const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(path);
  if (method === "GET" && mediaMatch !== null && lectureOf((n) => assetId(n) === mediaMatch[1]) !== undefined) {
    await route.continue({ url: CLIP_URL });
    return true;
  }
  return false;
}
