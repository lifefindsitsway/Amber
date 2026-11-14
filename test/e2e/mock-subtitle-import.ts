import { createHash } from "node:crypto";
import type { Page, Request, Route } from "@playwright/test";
import { contentDetailDtoSchema, subtitleImportRequestSchema, subtitleImportResponseSchema, transcriptRevisionListDtoSchema, type TranscriptRevisionDto } from "../../src/shared/dto/content.ts";
import { chaptersDtoSchema } from "../../src/shared/dto/chapter.ts";
import { contentExportRequestSchema } from "../../src/shared/dto/export.ts";
import { importResponseSchema } from "../../src/shared/dto/import.ts";
import { speakerListDtoSchema, type SpeakerDto } from "../../src/shared/dto/speaker.ts";
import { subtitleInspectRequestSchema, subtitleInspectResponseSchema, type SubtitleInspectResponse } from "../../src/shared/dto/subtitle-import.ts";
import { translationsDtoSchema } from "../../src/shared/dto/translation.ts";
import { transcriptSegmentPageDtoSchema, type TranscriptSegmentDto } from "../../src/shared/dto/transcript.ts";
import { SPEAKERS_PER_CONTENT_MAX } from "../../src/shared/defaults.ts";
import { appError } from "../../src/server/domain/errors.ts";
import { errorResponseSchema, type ErrorClass, type RefinedErrorCode } from "../../src/shared/errors.ts";
import { revisionListItem, summaries } from "./mock-backend.ts";

/**
 * A processed lecture to import subtitle files into, for the subtitle import specs. The fake
 * answers previews from what a spec scripts per file name (the digest is the real SHA-256 of
 * the text sent, so a changed file is caught like the server catches it), stores imports as
 * new revisions, speakers and translations, and keeps every request body. It is installed per
 * page on top of the shared fake; anything not about this lecture or these endpoints falls
 * through to it.
 */

export const IMPORT_CONTENT = "01J0000000000000000000SI01";
export const IMPORT_REVISION = "01J0000000000000000000SIR1";
export const IMPORT_TITLE = "第七讲：字幕导入模拟课程";
/** As many sentences as the shared lecture, so the shared summary's citations resolve. */
const SEGMENT_COUNT = 12;
/** A large imported file is served as its first sentences; nothing here reads further. */
const SERVED_SEGMENTS_MAX = 24;
const SEGMENT_MS = 10_000;
const now = 1_790_000_000_000;

/** What a preview of one file answers: the response without its digest, or a failure. */
export type PreviewScript =
  | { preview: Omit<SubtitleInspectResponse, "digest" | "target">; target?: Partial<NonNullable<SubtitleInspectResponse["target"]>> }
  | { error: MockFailure };

export interface MockFailure {
  status: number;
  errorClass: ErrorClass;
  code: string;
}

/** One part of a multipart upload, in the order it was sent. */
export interface UploadPart {
  name: string;
  filename?: string;
  value?: string;
}

export interface SubtitleImportState {
  /** Preview answers by file name; a file without one is read as a plain SRT of one cue per sentence. */
  previews: Map<string, PreviewScript>;
  /** Bodies of `POST /api/subtitles/inspect`. */
  inspects: unknown[];
  /** Bodies of `POST /api/contents/:id/subtitle-import`, refused ones included. */
  imports: unknown[];
  /** Failures the next imports run into, one per request. */
  importFailures: MockFailure[];
  /** Timeline warnings every successful import reports. */
  importWarnings: string[];
  /** Parts of each `POST /api/contents/upload`, in order. */
  uploads: UploadPart[][];
  /** Bodies of the lecture's export requests. */
  exports: unknown[];
  /** The lecture's speakers. */
  speakers: SpeakerDto[];
  /** Overrides the speaker room previews report; absent = what is left of the per-Content maximum. */
  speakerRoom?: number;
  /** Every revision of the lecture, the platform original first. */
  revisions: TranscriptRevisionDto[];
  primaryRevisionId: string;
  /** Language → the current translation revision. */
  currentTranslations: Record<string, string>;
}

/** SHA-256 hex of a text as the server digests it: decoded, without a BOM. */
export function digestOf(text: string): string {
  return createHash("sha256").update(text.replace(/^\uFEFF/u, ""), "utf8").digest("hex");
}

function platformRevision(): TranscriptRevisionDto {
  return {
    id: IMPORT_REVISION,
    contentId: IMPORT_CONTENT,
    kind: "platform",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "platform" },
    segmentCount: SEGMENT_COUNT,
    createdAt: now,
  };
}

/** A machine translation of the platform original, current for `language`. */
export function machineTranslation(language: string): TranscriptRevisionDto {
  return {
    ...platformRevision(),
    id: `01J00000000000000000SIT${language.toUpperCase().padEnd(3, "X").slice(0, 3)}`,
    kind: "translated",
    language,
    parentRevisionId: IMPORT_REVISION,
    generation: { kind: "llm" },
    createdAt: now + 1,
  };
}

const segmentIdOf = (revisionId: string, index: number): string => `${revisionId.slice(0, 22)}${String(index).padStart(4, "0")}`;

function segmentsOf(state: SubtitleImportState, revision: TranscriptRevisionDto): TranscriptSegmentDto[] {
  const speakerIds = state.speakers.map((speaker) => speaker.id);
  return Array.from({ length: Math.min(revision.segmentCount, SERVED_SEGMENTS_MAX) }, (_, index) => {
    const imported = revision.generation["kind"] === "imported";
    // Imported sentences go to the speakers in turn, so the reader shows them.
    const speakerId = imported && revision.kind !== "translated" && speakerIds.length > 0 ? speakerIds[index % speakerIds.length] : undefined;
    const prefix = revision.kind === "translated" ? `[${revision.language}] ` : imported ? "导入的" : "";
    return {
      id: segmentIdOf(revision.id, index),
      revisionId: revision.id,
      ordinal: index,
      startMs: index * SEGMENT_MS,
      endMs: (index + 1) * SEGMENT_MS - 500,
      text: `${prefix}第 ${index + 1} 句字幕导入模拟。`,
      ...(speakerId === undefined ? {} : { speakerId }),
      sourceSegmentIds: revision.parentRevisionId === undefined ? [] : [segmentIdOf(revision.parentRevisionId, index)],
    };
  });
}

function content(state: SubtitleImportState) {
  return {
    id: IMPORT_CONTENT,
    source: { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1mock00007", platformContentId: "BV1mock00007", platformPartId: "1" },
    title: IMPORT_TITLE,
    durationMs: SEGMENT_COUNT * SEGMENT_MS,
    rawLanguage: "zh-CN",
    primaryTranscriptRevisionId: state.primaryRevisionId,
    processingStatus: "succeeded",
    collections: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** The plain SRT of one cue per sentence a file without a scripted preview reads as. */
const PLAIN_PREVIEW: Omit<SubtitleInspectResponse, "digest" | "target"> = {
  format: "srt",
  cueCount: SEGMENT_COUNT,
  droppedCues: { count: 0, samples: [] },
  rangeMs: { start: 0, end: SEGMENT_COUNT * SEGMENT_MS - 500 },
  speakers: { source: "none", candidates: [], sequence: [] },
  limits: [],
};

/** The error body the server sends, its user message worded from the same i18n resources. */
function errorBody(failure: MockFailure): unknown {
  const code = failure.code === failure.errorClass ? {} : { code: failure.code as RefinedErrorCode };
  return errorResponseSchema.parse({ error: appError(failure.errorClass, { ...code, params: { detail: "text" } }) });
}

/** The part names (and file names) of a multipart body, in the order they were sent, with the text values. */
function multipartParts(request: Request): UploadPart[] {
  const raw = request.postDataBuffer()?.toString("latin1") ?? "";
  const boundary = /boundary=([^;]+)/u.exec(request.headers()["content-type"] ?? "")?.[1];
  if (boundary === undefined) return [];
  return raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .flatMap((chunk) => {
      const [head = "", ...rest] = chunk.split("\r\n\r\n");
      const name = /name="([^"]*)"/u.exec(head)?.[1];
      if (name === undefined) return [];
      const filename = /filename="([^"]*)"/u.exec(head)?.[1];
      const body = rest.join("\r\n\r\n").replace(/\r\n$/u, "");
      return [filename === undefined ? { name, value: Buffer.from(body, "latin1").toString("utf8") } : { name, filename }];
    });
}

/**
 * Serves the lecture, previews and imports for `page`. Install after `installMockBackend`, so
 * this route sees requests first.
 */
export async function installSubtitleImport(
  page: Page,
  initial: Partial<SubtitleImportState> & {
    /** Languages that already have a current machine translation of the platform original. */
    machineTranslations?: string[];
  } = {},
): Promise<SubtitleImportState> {
  const { machineTranslations = [], ...rest } = initial;
  const translations = machineTranslations.map(machineTranslation);
  const state: SubtitleImportState = {
    previews: new Map(),
    inspects: [],
    imports: [],
    importFailures: [],
    importWarnings: [],
    uploads: [],
    exports: [],
    speakers: [],
    revisions: [platformRevision(), ...translations],
    primaryRevisionId: IMPORT_REVISION,
    currentTranslations: Object.fromEntries(translations.map((translation) => [translation.language, translation.id])),
    ...rest,
  };
  let next = 0;
  const newId = (tag: string): string => `01J000000000000000${tag}${String(++next).padStart(8 - tag.length, "0")}`;

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (method === "POST" && path === "/api/subtitles/inspect") {
      const body = subtitleInspectRequestSchema.parse(request.postDataJSON());
      state.inspects.push(body);
      const script = state.previews.get(body.filename ?? "") ?? { preview: PLAIN_PREVIEW };
      if ("error" in script) return json(errorBody(script.error), script.error.status);
      const target =
        body.contentId === IMPORT_CONTENT
          ? {
              target: {
                primaryRevisionId: state.primaryRevisionId,
                speakers: state.speakers.map(({ nameConfirmed: _confirmed, ...speaker }) => speaker),
                speakerRoom: state.speakerRoom ?? SPEAKERS_PER_CONTENT_MAX - state.speakers.length,
                currentTranslations: { ...state.currentTranslations },
                durationMs: SEGMENT_COUNT * SEGMENT_MS,
                coverageWarning: false,
                ...script.target,
              },
            }
          : {};
      return json(subtitleInspectResponseSchema.parse({ ...script.preview, digest: digestOf(body.text), ...target }));
    }

    if (method === "POST" && path === "/api/contents/upload") {
      state.uploads.push(multipartParts(request));
      return json(importResponseSchema.parse({ importBatchId: "01J0000000000000000BATCHSI", taskIds: [], contentIds: [] }), 202);
    }

    const contentMatch = /^\/api\/contents\/([^/]+)(?:\/(.+))?$/u.exec(path);
    if (contentMatch !== null && contentMatch[1] === IMPORT_CONTENT) {
      const resource = contentMatch[2];
      if (method === "GET" && resource === undefined) return json(contentDetailDtoSchema.parse({ ...content(state), media: [] }));
      if (method === "GET" && resource === "summaries") return json(summaries(IMPORT_REVISION, IMPORT_CONTENT, true));
      if (method === "GET" && resource === "chapters") return json(chaptersDtoSchema.parse({ revisions: [] }));
      if (method === "GET" && resource === "notes") return json({ items: [] });
      if (method === "GET" && resource === "speakers") return json(speakerListDtoSchema.parse({ items: state.speakers }));
      if (method === "GET" && resource === "transcript/revisions") {
        return json(transcriptRevisionListDtoSchema.parse({ primaryTranscriptRevisionId: state.primaryRevisionId, revisions: state.revisions.map(revisionListItem) }));
      }
      if (method === "GET" && resource === "translations") {
        const languages = [...new Set(state.revisions.filter((revision) => revision.kind === "translated").map((revision) => revision.language))];
        return json(
          translationsDtoSchema.parse({
            translations: languages.map((language) => {
              const revisions = state.revisions.filter((revision) => revision.kind === "translated" && revision.language === language);
              const current = revisions.find((revision) => revision.id === state.currentTranslations[language]);
              return { artifactId: `01J00000000000000000SIA${language.toUpperCase().padEnd(3, "X").slice(0, 3)}`, targetLanguage: language, ...(current === undefined ? {} : { current }), revisions, stale: false };
            }),
            activeTasks: [],
          }),
        );
      }
      if (method === "POST" && resource === "export") {
        const body = contentExportRequestSchema.parse(request.postDataJSON());
        state.exports.push(body);
        const extension = body.format === "markdown" ? "md" : body.format === "ambersub" ? "ambersub" : body.format.split("-")[0];
        return route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${IMPORT_TITLE}.${extension}`)}` },
          body: `${body.format}\n`,
        });
      }
      if (method === "POST" && resource === "subtitle-import") {
        const raw: unknown = request.postDataJSON();
        state.imports.push(raw);
        const body = subtitleImportRequestSchema.parse(raw);
        const failure = state.importFailures.shift();
        if (failure !== undefined) return json(errorBody(failure), failure.status);
        if (body.options !== undefined && body.options.expectedDigest !== digestOf(body.text)) {
          return json(errorBody({ status: 409, errorClass: "conflict", code: "conflict.subtitle_changed" }), 409);
        }
        const createdAt = Date.now();
        if (body.format === "txt" || body.format === "md" || /\.(txt|md)$/u.test(body.filename ?? "")) {
          return json(subtitleImportResponseSchema.parse({ referenceTextId: newId("REF"), warnings: [] }), 201);
        }
        const script = state.previews.get(body.filename ?? "");
        const preview = script !== undefined && "preview" in script ? script.preview : PLAIN_PREVIEW;
        const original: TranscriptRevisionDto = {
          id: newId("IMP"),
          contentId: IMPORT_CONTENT,
          kind: "imported",
          language: preview.package?.language ?? body.language ?? "zh-CN",
          timingFidelity: "segment_only",
          generation: { kind: "imported" },
          segmentCount: preview.cueCount,
          createdAt,
        };
        const options = body.options;
        const reused = new Set((options?.identities ?? []).flatMap((identity) => (identity.speakerId === undefined ? [] : [identity.key])));
        const named =
          options === undefined
            ? []
            : preview.speakers.source === "prefix"
              ? preview.speakers.candidates.filter((candidate) => options.speakers?.prefixNames?.includes(candidate.key) === true)
              : preview.speakers.candidates;
        const created = named.filter((candidate) => !reused.has(candidate.key));
        for (const candidate of created) {
          const ordinal = Math.max(0, ...state.speakers.map((speaker) => speaker.ordinal)) + 1;
          const name = /^发言人 \d+$/u.test(candidate.label) ? undefined : candidate.label;
          state.speakers.push({ id: newId("SPK"), ordinal, ...(name === undefined ? {} : { name }), colorIndex: (ordinal - 1) % 8, used: true });
        }
        const languages =
          options === undefined
            ? []
            : options.translationLanguage === null
              ? []
              : typeof options.translationLanguage === "string"
                ? [options.translationLanguage]
                : (preview.package?.translationLanguages ?? preview.bilingual?.languages ?? []);
        const translations = languages.map((language) => ({
          ...original,
          id: newId("TRN"),
          kind: "translated" as const,
          language,
          parentRevisionId: original.id,
        }));
        state.revisions.push(original, ...translations);
        if (options?.setCurrent !== false) {
          state.primaryRevisionId = original.id;
          for (const translation of translations) state.currentTranslations[translation.language] = translation.id;
        }
        return json(
          subtitleImportResponseSchema.parse({
            transcriptRevisionId: original.id,
            ...(translations.length === 0 ? {} : { translationRevisionIds: Object.fromEntries(translations.map((translation) => [translation.language, translation.id])) }),
            ...(created.length === 0 ? {} : { speakersCreated: created.length }),
            warnings: state.importWarnings,
          }),
          201,
        );
      }
      return route.fallback();
    }

    const revisionMatch = /^\/api\/transcript\/revisions\/([^/]+)\/segments$/u.exec(path);
    const revision = revisionMatch === null ? undefined : state.revisions.find((item) => item.id === revisionMatch[1]);
    if (method === "GET" && revision !== undefined) {
      return json(transcriptSegmentPageDtoSchema.parse({ revision, items: segmentsOf(state, revision) }));
    }
    return route.fallback();
  });
  return state;
}
