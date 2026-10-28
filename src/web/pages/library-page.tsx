import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, NotebookPen, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { CONTENT_LIST_IDS_MAX } from "../../shared/defaults.ts";
import { contentListDtoSchema, type ContentDto } from "../../shared/dto/content.ts";
import { CONTENT_SOURCE_KINDS, PROCESSING_STATUSES } from "../../shared/enums.ts";
import { useApi, useTaskHub } from "../api/context.tsx";
import { queryKeys, queryString, useCollections, usePatchContent } from "../api/queries.ts";
import { formatDateTime, formatDuration } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { useContextMenuTarget } from "../ui/context-menu.tsx";
import { EmptyState, Loading, PageHeader } from "../ui/feedback.tsx";
import { Pagination, useListPosition, usePagination } from "../ui/pagination.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { actionTarget, useContentActions } from "../components/use-content-actions.tsx";
import { HitSnippet } from "../search/hit-snippet.tsx";
import { hitsByContent, normalizeQuery, useSearch, type ContentSideHit } from "../search/search.ts";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import { collectionChoiceOf, filtersFromSearch, UNCOLLECTED_CHOICE, withCollectionChoice, withFilter } from "./library/filters.ts";

const SELECT_CLASS = "h-8 rounded-md border border-line bg-surface px-2 text-sm";
/** `w-px` with no wrapping shrinks a column to its content. */
export const NARROW = "w-px whitespace-nowrap py-2 font-medium";
export const COLUMN = "px-2 py-2 font-medium";
/**
 * Columns by the width of the list area (a container query, in rem so it follows the font
 * size and the sidebar): from 64rem every column shows; below that source, duration and
 * update time fold into a line under the title; below 48rem cover and collections go too.
 * The collection page's member table folds at the same widths.
 */
export const WIDE_ONLY = "hidden @5xl:table-cell";
export const COMPACT_UP = "hidden @3xl:table-cell";
/** The outermost columns keep the rows off the page edges, more so on wide lists. */
const EDGE_START = "pl-6 @5xl:pl-10";
const EDGE_END = "pr-6 @5xl:pr-10";

/**
 * All contents: filters and the page live in the URL so the new page can link to
 * one import batch. The search box goes through the search service with `scope=library`: while
 * a query is in effect the table lists only the Contents it hit, best first, each with one
 * excerpt, unpaged.
 */
export function LibraryPage() {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const hub = useTaskHub();
  const queryClient = useQueryClient();
  const collections = useCollections();
  const patch = usePatchContent();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const [query, setQuery] = useState("");
  // The row buttons and the rows' right-click menu open the same dialogs.
  const actions = useContentActions();
  const navigate = useNavigate();
  const scroller = useRef<HTMLDivElement>(null);
  const found = useSearch(query, "library");
  const searching = found.active;

  // The key starts with `contents`, so a task event re-reads only the page on screen. The
  // previous page's answer stays as placeholder only to keep the pager's total; its rows are
  // not shown.
  const position = useListPosition("library");
  const list = useQuery({
    queryKey: [...queryKeys.contentsAll, "library", filters, position.page, position.pageSize],
    queryFn: ({ signal }) => client.get(`/api/contents${queryString({ ...filters, limit: position.pageSize, page: position.page })}`, contentListDtoSchema, { signal }),
    placeholderData: keepPreviousData,
    enabled: !searching,
  });
  const pager = usePagination({
    scope: "library",
    total: list.data?.total,
    totalStale: list.isPlaceholderData,
    onPageShown: () => {
      if (scroller.current !== null) scroller.current.scrollTop = 0;
    },
  });

  // Status columns follow the pipeline without polling. Only task events re-read the list:
  // the columns it shows (status, title, cover, duration, update time) are written by the task
  // projection refresh or a stage's publish transaction, and each such write comes with
  // `task.updated` / `task.finished`. That relies on the stage graph being a chain: one stage
  // runs at a time, so its success always moves the projection. Stage and unit events alone
  // change none of these columns.
  useEffect(
    () =>
      hub.onEvent((event) => {
        if (event.type === "task.updated" || event.type === "task.finished") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
        }
      }),
    [hub, queryClient],
  );

  // Hits name Contents by id; their rows are read by those ids through the filtered listing, so
  // the filters keep applying while searching. Hits of an earlier text (still debouncing, or
  // standing in while the new query runs) are neither read nor shown.
  const hitsCurrent = found.query === normalizeQuery(query) && !found.isPlaceholderData;
  const hits = found.data === undefined ? [] : hitsByContent(found.data).slice(0, CONTENT_LIST_IDS_MAX);
  const ids = hits.map((hit) => hit.contentId);
  const hitFilters = { ...filters, ids: ids.join(","), page: 1, limit: ids.length };
  const known = useQuery({
    queryKey: [...queryKeys.contentsAll, "library", "hits", hitFilters],
    queryFn: ({ signal }) => client.get(`/api/contents${queryString(hitFilters)}`, contentListDtoSchema, { signal }),
    enabled: searching && hitsCurrent && ids.length > 0,
  });

  const rows: Array<{ item: ContentDto; hit?: ContentSideHit }> = searching
    ? hitRows(hits, known.data?.items ?? [])
    : (list.data?.items ?? []).map((item) => ({ item }));
  const pending = searching
    ? (found.data === undefined && !found.isError) || !hitsCurrent || (ids.length > 0 && known.isPending)
    : list.isPending || list.isPlaceholderData || pastEnd(list.data);
  const failure = searching ? (found.data === undefined && found.isError ? found.error : known.isError ? known.error : null) : list.isError ? list.error : null;
  const setFilter = (key: Parameters<typeof withFilter>[1], value: string): void => setSearch(withFilter(search, key, value));
  const filtered = Object.keys(filters).length > 0 || searching;
  const targetOf = (item: ContentDto) => actionTarget({ id: item.id, title: item.title, pinnedAt: item.pinnedAt, sourceUrl: item.source.sourceUrl });
  // One target for the whole table: a right click finds its row, search-result rows included.
  const rowsMenuRef = useContextMenuTarget<HTMLTableSectionElement>((hit) => {
    const row = hit.target.closest<HTMLElement>("[data-content-id]");
    const item = rows.find((candidate) => candidate.item.id === row?.dataset["contentId"])?.item;
    return item === undefined ? undefined : actions.menu(targetOf(item), hit);
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("library.title")} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3">
        <input
          className="h-8 w-56 rounded-md border border-line bg-surface px-2 text-sm"
          type="search"
          placeholder={t("search.libraryPlaceholder")}
          aria-label={t("search.libraryPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="library-search"
        />
        <select className={SELECT_CLASS} aria-label={t("library.filter.status")} value={filters.status ?? ""} onChange={(event) => setFilter("status", event.target.value)}>
          <option value="">{`${t("library.filter.status")} · ${t("library.filter.any")}`}</option>
          {PROCESSING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`common.status.${status}`)}
            </option>
          ))}
        </select>
        <select className={SELECT_CLASS} aria-label={t("library.filter.source")} value={filters.source ?? ""} onChange={(event) => setFilter("source", event.target.value)}>
          <option value="">{`${t("library.filter.source")} · ${t("library.filter.any")}`}</option>
          {CONTENT_SOURCE_KINDS.map((source) => (
            <option key={source} value={source}>
              {t(`common.source.${source}`)}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          aria-label={t("library.filter.collection")}
          value={collectionChoiceOf(filters)}
          onChange={(event) => setSearch(withCollectionChoice(search, event.target.value))}
        >
          <option value="">{`${t("library.filter.collection")} · ${t("library.filter.any")}`}</option>
          <option value={UNCOLLECTED_CHOICE}>{`${t("library.filter.collection")} · ${t("library.filter.uncollected")}`}</option>
          {(collections.data?.items ?? []).map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
        {filters.importBatchId === undefined ? null : (
          <span className="inline-flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1 text-xs text-accent">
            {t("library.filter.importBatch")}
            <button type="button" className="underline" onClick={() => setFilter("importBatchId", "")}>
              {t("library.filter.clearImportBatch")}
            </button>
          </span>
        )}
      </div>
      <div ref={scroller} className="@container min-h-0 flex-1 overflow-auto">
        {pending ? (
          <Loading />
        ) : failure !== null ? (
          <div className="p-6">
            <ErrorView error={appErrorOf(failure)} />
          </div>
        ) : rows.length === 0 ? (
          searching ? (
            <EmptyState title={t("search.empty")} hint={t("search.emptyHint")} />
          ) : filtered ? (
            <EmptyState title={t("library.empty.filtered")} />
          ) : (
            <EmptyState title={t("library.empty.title")} hint={t("library.empty.hint")}>
              <Link to="/new" className="text-sm text-accent underline">
                {t("library.empty.action")}
              </Link>
            </EmptyState>
          )
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
              <tr>
                {/* Percentages share the width out in proportion; a column's content width is its floor. */}
                <th className={`${COMPACT_UP} ${NARROW} ${EDGE_START} pr-4`}>{t("library.column.cover")}</th>
                <th className="w-full py-2 pr-4 pl-6 font-medium @3xl:w-[45%] @3xl:px-2 @5xl:w-[30%]">{t("library.column.title")}</th>
                <th className={`${WIDE_ONLY} ${COLUMN} w-[9%]`}>{t("library.column.source")}</th>
                <th className={`${WIDE_ONLY} ${COLUMN} w-[7%]`}>{t("library.column.duration")}</th>
                <th className={`${COLUMN} w-px whitespace-nowrap @3xl:w-[13%] @5xl:w-[9%]`}>{t("library.column.status")}</th>
                <th className={`${COMPACT_UP} ${COLUMN} min-w-40 @3xl:w-[30%] @5xl:w-[18%]`}>{t("library.column.collections")}</th>
                <th className={`${WIDE_ONLY} ${COLUMN} w-[13%] whitespace-nowrap`}>{t("library.column.updatedAt")}</th>
                <th className={`${NARROW} pl-4 ${EDGE_END} text-center`}>{t("library.column.actions")}</th>
              </tr>
            </thead>
            <tbody ref={rowsMenuRef}>
              {rows.map(({ item, hit }) => {
                const duration = item.durationMs === undefined ? undefined : formatDuration(item.durationMs);
                const updatedAt = formatDateTime(item.updatedAt, i18n.language);
                const pinned = item.pinnedAt !== undefined;
                return (
                  <tr key={item.id} className="border-b border-line hover:bg-panel" data-testid="library-row" data-content-id={item.id}>
                    <td className={`${COMPACT_UP} ${EDGE_START} py-2 pr-4`}>
                      <Cover url={item.coverUrl} />
                    </td>
                    <td className="py-2 pr-4 pl-6 @3xl:px-2">
                      <div className="flex items-start gap-1">
                        {item.pinnedAt === undefined ? null : (
                          <Pin size={14} className="mt-0.5 shrink-0 text-accent" aria-label={t("library.pinned")} data-testid="library-pinned" />
                        )}
                        <Link to={`/contents/${item.id}`} className="line-clamp-2 font-medium hover:underline">
                          {item.title ?? t("library.untitled")}
                        </Link>
                      </div>
                      {/* The folded columns, shown only while their own cells are hidden. */}
                      <p className="mt-0.5 text-xs text-muted @5xl:hidden" data-testid="library-row-meta">
                        {t(`common.source.${item.source.kind}`)}
                        {duration === undefined ? null : ` · ${duration}`}
                        {` · ${updatedAt}`}
                      </p>
                      {hit === undefined ? null : <HitSnippet entry={hit} query={found.query} />}
                    </td>
                    <td className={`${WIDE_ONLY} px-2 py-2 whitespace-nowrap text-muted`}>{t(`common.source.${item.source.kind}`)}</td>
                    <td className={`${WIDE_ONLY} px-2 py-2 font-mono text-xs whitespace-nowrap text-muted`}>{duration ?? ""}</td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <StatusBadge status={item.processingStatus} />
                    </td>
                    <td className={`${COMPACT_UP} px-2 py-2`}>
                      <div className="flex flex-wrap gap-1">
                        {item.collections.map((collection) => (
                          <Link key={collection.id} to={`/collections/${collection.id}`} className="rounded bg-sunken px-1.5 py-0.5 text-xs hover:underline">
                            {collection.name}
                          </Link>
                        ))}
                      </div>
                    </td>
                    <td className={`${WIDE_ONLY} px-2 py-2 text-xs whitespace-nowrap text-muted`}>{updatedAt}</td>
                    <td className={`py-2 pl-4 ${EDGE_END} text-center whitespace-nowrap`}>
                      <Button size="sm" variant="ghost" onClick={() => actions.rename(item.id)}>
                        <Pencil size={14} aria-hidden="true" />
                        {t("library.rename.action")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={patch.isPending && patch.variables?.contentId === item.id}
                        onClick={() => patch.mutate({ contentId: item.id, patch: { pinned: !pinned } })}
                      >
                        {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
                        {/* Both labels share one grid cell, so the button is as wide as the wider one and the action buttons line up across rows; the label stays next to its icon. */}
                        <span className="grid text-left">
                          <span className={`${pinned ? "invisible " : ""}[grid-area:1/1]`} aria-hidden={pinned ? "true" : undefined}>
                            {t("library.pin.action")}
                          </span>
                          <span className={`${pinned ? "" : "invisible "}[grid-area:1/1]`} aria-hidden={pinned ? undefined : "true"}>
                            {t("library.unpin.action")}
                          </span>
                        </span>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => actions.manageCollections(item.id)}>
                        <FolderPlus size={14} aria-hidden="true" />
                        {t("library.membership.action")}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => actions.remove(targetOf(item))}>
                        <Trash2 size={14} aria-hidden="true" />
                        {t("library.deleteContent.action")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void navigate(`/notes?contentId=${encodeURIComponent(item.id)}`)}>
                        <NotebookPen size={14} aria-hidden="true" />
                        {t("library.notes.action")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {searching ? null : <Pagination pager={pager} className="border-t border-line px-6 py-3" />}
      {actions.dialogs}
    </div>
  );
}

/** The hit Contents in relevance order, kept only when the filtered listing has them. */
/** An empty page of a non-empty list lies past the end; the pager is about to move to the last page. */
function pastEnd(answer: { items: readonly unknown[]; total: number } | undefined): boolean {
  return answer !== undefined && answer.items.length === 0 && answer.total > 0;
}

function hitRows(hits: ReturnType<typeof hitsByContent>, known: readonly ContentDto[]): Array<{ item: ContentDto; hit: ContentSideHit }> {
  const byId = new Map(known.map((item) => [item.id, item]));
  return hits.flatMap(({ contentId, first }) => {
    const item = byId.get(contentId);
    return item === undefined ? [] : [{ item, hit: first }];
  });
}

/**
 * Platform covers are loaded without a Referer: some CDNs refuse foreign referrers. The CSP
 * admits images over https only, so a cover stored with plain http is asked for over https;
 * one that still fails shows the empty placeholder instead of a broken image.
 */
export function Cover({ url, className = "h-12 w-20" }: { url?: string | undefined; className?: string }) {
  const [failed, setFailed] = useState<string>();
  const src = url?.replace(/^http:\/\//, "https://");
  if (src === undefined || src === failed) {
    return <div data-testid="cover-placeholder" className={`${className} rounded bg-sunken`} />;
  }
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(src)}
      // The base style's max-width: 100% lets a shrink-to-fit table column squeeze the image.
      className={`${className} max-w-none rounded object-cover`}
    />
  );
}

const STATUS_TONE: Record<string, string> = {
  queued: "bg-sunken text-muted",
  running: "bg-accent-soft text-accent",
  waiting: "bg-accent-soft text-accent",
  succeeded: "bg-ok/10 text-ok",
  failed: "bg-danger/10 text-danger",
  cancelled: "bg-sunken text-muted",
};

export function StatusBadge({ status }: { status: ContentDto["processingStatus"] }) {
  const { t } = useTranslation();
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_TONE[status] ?? ""}`}>{t(`common.status.${status}`)}</span>;
}
