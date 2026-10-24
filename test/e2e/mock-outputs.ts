import type { Page, Request, Route } from "@playwright/test";
import { transcriptRevisionListDtoSchema, type TranscriptRevisionDto } from "../../src/shared/dto/content.ts";
import { contentExportRequestSchema } from "../../src/shared/dto/export.ts";
import { highlightsDtoSchema } from "../../src/shared/dto/highlight.ts";
import { taskAcceptedDtoSchema } from "../../src/shared/dto/task.ts";
import { transcriptSegmentPageDtoSchema } from "../../src/shared/dto/transcript.ts";
import { translationRequestSchema, translationsDtoSchema } from "../../src/shared/dto/translation.ts";
import { BILI_REVISION, BILIBILI_CONTENT, revisionListItem, segmentId } from "./mock-backend.ts";

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
