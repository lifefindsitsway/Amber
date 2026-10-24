import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import { chaptersDtoSchema } from "../../../shared/dto/chapter.ts";
import { highlightsDtoSchema } from "../../../shared/dto/highlight.ts";
import { contentDetailDtoSchema, transcriptRevisionListDtoSchema, type TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import type { TranscriptKind } from "../../../shared/enums.ts";
import { contentSummariesDtoSchema } from "../../../shared/dto/summary.ts";
import { taskListDtoSchema } from "../../../shared/dto/task.ts";
import type { TaskKind } from "../../../shared/enums.ts";
import { transcriptSegmentPageDtoSchema, type TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { translationsDtoSchema } from "../../../shared/dto/translation.ts";
import { readingParagraphs, readingSections, type ReadingChapter } from "../../../shared/reading.ts";
import type { ApiClient } from "../../api/client.ts";
import { useApi, useTaskHub } from "../../api/context.tsx";
import type { RedoStage } from "../../components/task-flow.tsx";
import { queryKeys, queryString } from "../../api/queries.ts";

/**
 * Query keys of the detail page, all under the Content they belong to, so a task event on
 * the Content refreshes every one of them (useContentTaskRefresh).
 */
export const contentKeys = {
  revisions: (contentId: string) => ["content", contentId, "revisions"] as const,
  summaries: (contentId: string) => ["content", contentId, "summaries"] as const,
  chapters: (contentId: string) => ["content", contentId, "chapters"] as const,
  highlights: (contentId: string) => ["content", contentId, "highlights"] as const,
  translations: (contentId: string) => ["content", contentId, "translations"] as const,
  latestTask: (contentId: string) => ["content", contentId, "latest-task"] as const,
  latestRedos: (contentId: string, stages: readonly RedoStage[]) => ["content", contentId, "latest-redos", ...stages] as const,
  cacheTask: (contentId: string) => ["content", contentId, "cache-task"] as const,
  segments: (revisionId: string) => ["segments", revisionId] as const,
};

export function useContentDetail(contentId: string) {
  const client = useApi();
  return useQuery({
    queryKey: queryKeys.content(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}`, contentDetailDtoSchema),
  });
}

export function useRevisions(contentId: string) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.revisions(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}/transcript/revisions`, transcriptRevisionListDtoSchema),
  });
}

export function useSummaries(contentId: string) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.summaries(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}/summaries`, contentSummariesDtoSchema),
  });
}

export function useChapters(contentId: string) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.chapters(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}/chapters`, chaptersDtoSchema),
  });
}

export function useHighlights(contentId: string) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.highlights(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}/highlights`, highlightsDtoSchema),
  });
}

export function useTranslations(contentId: string) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.translations(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}/translations`, translationsDtoSchema),
  });
}

/**
 * The most recent processing Task of the Content, the body of the empty-state stage flow;
 * cache, burn, translate and highlight Tasks never replace it.
 */
export function useLatestTask(contentId: string) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.latestTask(contentId),
    queryFn: async () =>
      (await client.get(`/api/tasks${queryString({ contentId, kind: "process_content", limit: 1 })}`, taskListDtoSchema)).items[0] ?? null,
  });
}

/** The single-stage Task kind that redoes each stage of `process_content`. */
export const REDO_TASK_KINDS = {
  asr: "retranscribe",
  proofread: "reproofread",
  chapter: "regenerate_chapters",
  summary: "regenerate_summary",
} as const satisfies Record<RedoStage, TaskKind>;

/**
 * The most recent redo Task of each of `stages` on the Content, folded into the empty-state
 * stage flow over the processing Task's own runs; values are Task ids. A summary
 * redo counts only for `summaryTemplateId`, the processing Task's template, so it is the newest
 * of one page of summary redos with that template. Under the Content's keys, so a Task created
 * or finished on the Content reads them again.
 */
export function useLatestRedos(contentId: string, stages: readonly RedoStage[], summaryTemplateId?: string) {
  const client = useApi();
  return useQuery({
    queryKey: [...contentKeys.latestRedos(contentId, stages), summaryTemplateId ?? null],
    queryFn: async () => {
      const latest = await Promise.all(
        stages.map(async (stage) => {
          if (stage === "summary") {
            if (summaryTemplateId === undefined) return [stage, undefined] as const;
            const page = await client.get(`/api/tasks${queryString({ contentId, kind: REDO_TASK_KINDS[stage], limit: API_PAGE_SIZE_MAX })}`, taskListDtoSchema);
            return [stage, page.items.find((task) => task.templateId === summaryTemplateId)?.id] as const;
          }
          return [
            stage,
            (await client.get(`/api/tasks${queryString({ contentId, kind: REDO_TASK_KINDS[stage], limit: 1 })}`, taskListDtoSchema)).items[0]?.id,
          ] as const;
        }),
      );
      const redos: Partial<Record<RedoStage, string>> = {};
      for (const [stage, taskId] of latest) {
        if (taskId !== undefined) redos[stage] = taskId;
      }
      return redos;
    },
  });
}

/** The Content's unfinished `cache_media` Task, so a reload brings its progress card back. */
export function useUnfinishedCacheTask(contentId: string, enabled: boolean) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.cacheTask(contentId),
    queryFn: async () =>
      (await client.get(`/api/tasks${queryString({ contentId, kind: "cache_media", unfinished: 1, limit: 1 })}`, taskListDtoSchema)).items[0] ??
      null,
    enabled,
  });
}

/**
 * Every segment of a revision, read page by page; revisions are immutable, so never stale.
 * `signal` reaches every page, so switching revisions abandons the old one at once.
 */
export async function fetchAllSegments(client: ApiClient, revisionId: string, signal?: AbortSignal): Promise<TranscriptSegmentDto[]> {
  const segments: TranscriptSegmentDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.get(
      `/api/transcript/revisions/${encodeURIComponent(revisionId)}/segments${queryString({ limit: API_PAGE_SIZE_MAX, cursor })}`,
      transcriptSegmentPageDtoSchema,
      signal === undefined ? {} : { signal },
    );
    segments.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return segments;
}

export function useSegments(revisionId: string | undefined) {
  const client = useApi();
  return useQuery({
    queryKey: contentKeys.segments(revisionId ?? ""),
    queryFn: ({ signal }) => fetchAllSegments(client, revisionId as string, signal),
    enabled: revisionId !== undefined,
    staleTime: Infinity,
  });
}

/** Refreshes the page's data when a Task on this Content reports progress or finishes. */
export function useContentTaskRefresh(contentId: string): void {
  const hub = useTaskHub();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      hub.onEvent((event) => {
        if ((event.type === "task.finished" || event.type === "task.updated") && event.task.contentId === contentId) {
          void queryClient.invalidateQueries({ queryKey: ["content", contentId] });
          // The chat context depends on the primary transcript and summary the pipeline publishes.
          void queryClient.invalidateQueries({ queryKey: ["chat", contentId] });
        }
      }),
    [hub, queryClient, contentId],
  );
}

export interface Paragraph {
  startMs: number;
  speakerId?: string;
  segments: TranscriptSegmentDto[];
}

/**
 * Paragraphs for reading, by the rules shared with the TXT export:
 * a revision whose sentences carry `paragraphStart` breaks at those marks and at speaker
 * changes; one without marks falls back to pauses above PARAGRAPH_GAP_MS, speaker changes
 * and the PARAGRAPH_MAX_CHARS readability cap.
 */
export function paragraphsOf(segments: readonly TranscriptSegmentDto[]): Paragraph[] {
  return readingParagraphs(segments);
}

/** A row of the reading view: a chapter heading or a paragraph. */
export type ReaderRow = { kind: "chapter"; startMs: number; title: string } | { kind: "paragraph"; paragraph: Paragraph };

/**
 * Reading rows with the current chapters as headings: a chapter start
 * is a boundary above paragraphs, so each chapter is paragraphed on its own and its heading
 * precedes its paragraphs; sentences before the first chapter get no heading. Chapters are
 * projected by time, so any revision of the Content can be read under them. Without
 * chapters the rows are exactly `paragraphsOf`.
 */
export function readerRows(segments: readonly TranscriptSegmentDto[], chapters: readonly ReadingChapter[]): ReaderRow[] {
  const rows: ReaderRow[] = [];
  for (const section of readingSections(segments, chapters)) {
    if (section.chapter !== undefined) {
      rows.push({ kind: "chapter", startMs: section.chapter.startMs, title: section.chapter.title });
    }
    for (const paragraph of readingParagraphs(section.sentences)) {
      rows.push({ kind: "paragraph", paragraph });
    }
  }
  return rows;
}

/** The sentence playing at `ms`, if any. */
export function segmentAt(segments: readonly TranscriptSegmentDto[], ms: number | undefined): TranscriptSegmentDto | undefined {
  if (ms === undefined) return undefined;
  return segments.find((segment) => segment.startMs <= ms && ms < segment.endMs);
}

/** Revisions a reader may pick for 原文细读: everything but translations. */
export function readableRevisions<T extends TranscriptRevisionDto>(revisions: readonly T[]): T[] {
  return revisions.filter((revision) => revision.kind !== "translated");
}

/** The root a revision descends from, following `parentRevisionId`; the export's original-transcript section reads this root. */
export function rootOf(revision: TranscriptRevisionDto, revisions: readonly TranscriptRevisionDto[]): TranscriptRevisionDto {
  const byId = new Map(revisions.map((item) => [item.id, item]));
  let current = revision;
  const seen = new Set<string>([current.id]);
  for (;;) {
    const parent = current.parentRevisionId === undefined ? undefined : byId.get(current.parentRevisionId);
    if (parent === undefined || seen.has(parent.id)) return current;
    seen.add(parent.id);
    current = parent;
  }
}

/**
 * Every lineage root of the Content (revisions without a parent, translations excluded):
 * several may coexist, such as an imported subtitle next to an ASR original, and then the
 * user picks one rather than the oldest being assumed.
 */
export function rootsOf<T extends TranscriptRevisionDto>(revisions: readonly T[]): T[] {
  return revisions.filter((revision) => revision.kind !== "translated" && revision.parentRevisionId === undefined);
}

/** What the version pickers need to know of a revision; list items also say whether it is archived. */
export type PickableRevision = Pick<TranscriptRevisionDto, "id" | "kind" | "parentRevisionId" | "createdAt"> & { archived?: boolean };

/**
 * The manual revision a picker shows by default: the primary when it is manual, else the
 * nearest manual ancestor of the primary, else none. Every other manual revision is an
 * earlier edit and goes behind 「历史手动修订」.
 */
export function currentManualId(revisions: readonly PickableRevision[], primaryId: string | undefined): string | undefined {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const seen = new Set<string>();
  for (let cursor = primaryId === undefined ? undefined : byId.get(primaryId); cursor !== undefined && !seen.has(cursor.id); ) {
    if (cursor.kind === "manual") return cursor.id;
    seen.add(cursor.id);
    cursor = cursor.parentRevisionId === undefined ? undefined : byId.get(cursor.parentRevisionId);
  }
  return undefined;
}

export interface RevisionGroups {
  /** Non-archived manual revisions other than the current one. */
  history: Set<string>;
  archived: Set<string>;
}

export function revisionGroups(revisions: readonly PickableRevision[], primaryId: string | undefined): RevisionGroups {
  const manual = currentManualId(revisions, primaryId);
  const history = new Set<string>();
  const archived = new Set<string>();
  for (const revision of revisions) {
    if (revision.archived === true) archived.add(revision.id);
    else if (revision.kind === "manual" && revision.id !== manual) history.add(revision.id);
  }
  return { history, archived };
}

/**
 * The revisions a version picker lists, in their given order: every non-archived revision
 * that is not manual, plus the one current manual revision; earlier manual revisions only
 * with `showHistory`, archived ones only with `showArchived`. Ids in `include` (the revision
 * being shown, a deep link) are always listed so a picker never loses its own value.
 */
export function visibleRevisions<T extends PickableRevision>(
  revisions: readonly T[],
  primaryId: string | undefined,
  options: { showHistory?: boolean; showArchived?: boolean; include?: ReadonlyArray<string | undefined> } = {},
): T[] {
  const groups = revisionGroups(revisions, primaryId);
  const include = new Set(options.include ?? []);
  return revisions.filter((revision) => {
    if (include.has(revision.id)) return true;
    if (groups.archived.has(revision.id)) return options.showArchived === true;
    if (groups.history.has(revision.id)) return options.showHistory === true;
    return true;
  });
}

/** Kinds a person made or chose, which a fresh ASR run does not replace by itself. */
const USER_CHOSEN_KINDS: ReadonlySet<TranscriptKind> = new Set(["imported", "manual", "corrected"]);

/**
 * The newest non-archived ASR original created after the primary, when the primary is an
 * imported, manual or corrected revision: a re-transcription the user may want to switch to,
 * since publishing it did not move the primary.
 */
export function newerAsrRevision<T extends PickableRevision>(revisions: readonly T[], primaryId: string | undefined): T | undefined {
  const primary = revisions.find((revision) => revision.id === primaryId);
  if (primary === undefined || !USER_CHOSEN_KINDS.has(primary.kind)) return undefined;
  return revisions
    .filter((revision) => revision.kind === "asr" && revision.parentRevisionId === undefined && revision.archived !== true && revision.createdAt > primary.createdAt)
    .reduce<T | undefined>((best, revision) => (best === undefined || revision.createdAt > best.createdAt ? revision : best), undefined);
}
