import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Download, FolderPlus, Library, Pin, PinOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { CONTENT_LIST_IDS_MAX, CONTENT_TRASH_BATCH_MAX, IMPORT_BATCH_MAX } from "../../shared/defaults.ts";
import { contentListDtoSchema, type ContentDto } from "../../shared/dto/content.ts";
import { CONTENT_PROCESSING_STATUSES, CONTENT_SOURCE_KINDS } from "../../shared/enums.ts";
import { useApi, useTaskHub } from "../api/context.tsx";
import { queryKeys, queryString, useCollections, usePatchContent } from "../api/queries.ts";
import { formatDateTime, formatDuration } from "../format.ts";
import { Button, FOCUS_RING } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { useContextMenuTarget } from "../ui/context-menu.tsx";
import { EmptyState, PageHeader, SkeletonRows } from "../ui/feedback.tsx";
import { NativeSelect } from "../ui/native-select.tsx";
import { InlineNote, TEXT_ACTION_CLASS, TextAction } from "../ui/notice.tsx";
import { Pagination, useListPosition, usePagination } from "../ui/pagination.tsx";
import { TextInput } from "../ui/text-field.tsx";
import { Tooltip } from "../ui/tooltip.tsx";
import { ContentRowMenu } from "../components/content-row-menu.tsx";
import { DeleteContentsDialog } from "../components/delete-content-dialog.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { ROW_INTERACTIVE, SelectionBar, useSelectionEscape } from "../components/selection-bar.tsx";
import { actionTarget, useContentActions } from "../components/use-content-actions.tsx";
import { HitSnippet } from "../search/hit-snippet.tsx";
import { SpeakerHitsGroup } from "../search/hit-speaker.tsx";
import { hitsByContent, normalizeQuery, useSearch, type ContentSideHit } from "../search/search.ts";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import { collectionChoiceOf, filtersFromSearch, UNCOLLECTED_CHOICE, withCollectionChoice, withFilter } from "./library/filters.ts";
import { exportBlock, pageSelection, removeSelected, toggleSelected, togglePage } from "./library/selection.ts";
import { PackActiveNotice, useExportPackWizard } from "./content-pack/pack-entry.tsx";
import { COLUMN, COMPACT_UP, Cover, NARROW, StatusBadge, WIDE_ONLY } from "./library/columns.tsx";

/** The outermost columns keep the rows off the page edges, more so on wide lists. */
const EDGE_START = "pl-6 @5xl:pl-10";
const EDGE_END = "pr-6 @5xl:pr-10";
/** A quiet icon-only row action: muted until pointed at, the size of the 「⋯」 trigger beside it. */
const ROW_ICON = `flex size-7 items-center justify-center rounded text-muted hover:bg-line hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;
/**
 * Pin and add-to-collection appear while the row is hovered or holds keyboard focus. They are
 * always rendered and only hidden (visibility, not removal), so their place is kept and the title
 * never moves; a hidden button cannot take focus, and focus reaching the row reveals them before
 * Tab gets to them. Touch screens cannot hover: there they are left out and 「⋯」 has everything.
 */
const REVEALED_ON_ROW = "invisible opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 [@media(hover:none)]:hidden";

/**
 * All contents: filters and the page live in the URL so the new page can link to
 * one import batch. The search box goes through the search service with `scope=library`: while
 * a query is in effect the table lists only the Contents it hit, best first, each with one
 * excerpt, unpaged. 「选择」 turns on a checkbox column; picked rows, across pages and
 * filters, are deleted or go into one content pack through the bar at the page foot.
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
  // The rows' 「⋯」 menus, their icon buttons and their right-click menu open the same dialogs.
  const actions = useContentActions();
  const scroller = useRef<HTMLDivElement>(null);
  const found = useSearch(query, "library");
  const searching = found.active;
  // `undefined` outside the selection mode; the ids in the order they were picked.
  const [selected, setSelected] = useState<string[] | undefined>(undefined);
  const selecting = selected !== undefined;
  const wizard = useExportPackWizard();
  // The picked ids the delete dialog works on, fixed when it opened.
  const [deleting, setDeleting] = useState<readonly string[] | undefined>(undefined);

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
  // Speakers found by name are their own group above the table; the filters do not apply to them.
  const speakerHits = searching && hitsCurrent ? (found.data?.speakers ?? []) : [];
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
  const targetOf = (item: ContentDto) => actionTarget({ id: item.id, title: item.title, pinnedAt: item.pinnedAt, sourceUrl: item.source.sourceUrl, sourceKind: item.source.kind });
  // One target for the whole table: a right click finds its row, search-result rows included.
  const rowsMenuRef = useContextMenuTarget<HTMLTableSectionElement>((hit) => {
    const row = hit.target.closest<HTMLElement>("[data-content-id]");
    const item = rows.find((candidate) => candidate.item.id === row?.dataset["contentId"])?.item;
    return item === undefined ? undefined : actions.menu(targetOf(item), hit);
  });
  const shownIds = pending || failure !== null ? [] : rows.map(({ item }) => item.id);
  const pagePicked = selected === undefined ? "none" : pageSelection(selected, shownIds);
  const block = exportBlock(selected?.length ?? 0, IMPORT_BATCH_MAX);
  const deleteBlock = exportBlock(selected?.length ?? 0, CONTENT_TRASH_BATCH_MAX);
  const barShown = selected !== undefined && selected.length > 0;
  const exitSelection = useCallback(() => setSelected(undefined), []);
  useSelectionEscape(selecting, exitSelection);
  // Edge padding moves to the checkbox column while it is shown.
  const coverEdge = selecting ? "pl-2" : EDGE_START;
  const titleEdge = selecting ? "pl-2 @3xl:px-2" : "pl-6 @3xl:px-2";

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("library.title")} />
      <PackActiveNotice className="mx-6 mt-3" />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3">
        <TextInput
          size="md"
          className="w-56"
          type="search"
          placeholder={t("library.searchPlaceholder")}
          aria-label={t("library.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="library-search"
        />
        <NativeSelect size="md" aria-label={t("library.filter.status")} value={filters.status ?? ""} onChange={(event) => setFilter("status", event.target.value)}>
          <option value="">{`${t("library.filter.status")} · ${t("library.filter.any")}`}</option>
          {CONTENT_PROCESSING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`common.status.${status}`)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect size="md" aria-label={t("library.filter.source")} value={filters.source ?? ""} onChange={(event) => setFilter("source", event.target.value)}>
          <option value="">{`${t("library.filter.source")} · ${t("library.filter.any")}`}</option>
          {CONTENT_SOURCE_KINDS.map((source) => (
            <option key={source} value={source}>
              {t(`common.source.${source}`)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          size="md"
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
        </NativeSelect>
        {filters.importBatchId === undefined ? null : (
          <span className="inline-flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1 text-xs text-accent">
            {t("library.filter.importBatch")}
            <TextAction className="underline" onClick={() => setFilter("importBatchId", "")}>
              {t("library.filter.clearImportBatch")}
            </TextAction>
          </span>
        )}
        <Button
          size="md"
          className="ml-auto"
          aria-pressed={selecting}
          onClick={() => setSelected(selecting ? undefined : [])}
          data-testid="library-select-mode"
        >
          <CheckSquare size={14} aria-hidden="true" />
          {selecting ? t("contentPack.select.exit") : t("contentPack.select.enter")}
        </Button>
      </div>
      <div ref={scroller} className="@container min-h-0 flex-1 overflow-auto">
        {pending ? (
          <SkeletonRows count={6} rowHeight={40} gap={12} className="p-6" testId="library-loading" />
        ) : failure !== null ? (
          <div className="p-6">
            <ErrorView error={appErrorOf(failure)} />
          </div>
        ) : rows.length === 0 ? (
          searching ? (
            speakerHits.length > 0 ? (
              <SpeakerHitsGroup hits={speakerHits} className="px-6 py-3" />
            ) : (
              <EmptyState title={t("search.empty")} hint={t("search.emptyHint")} />
            )
          ) : filtered ? (
            <EmptyState title={t("library.empty.filtered")} />
          ) : (
            <EmptyState
              icon={<Library size={28} />}
              title={t("library.empty.title")}
              hint={t("library.empty.hint")}
              action={
                <Link to="/new" className={`text-sm ${TEXT_ACTION_CLASS}`}>
                  {t("library.empty.action")}
                </Link>
              }
            />
          )
        ) : (
          <>
            <SpeakerHitsGroup hits={speakerHits} className="border-b border-line px-6 py-3" />
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
                <tr>
                  {selecting ? (
                    <th className={`${NARROW} ${EDGE_START} pr-2`}>
                      <Checkbox
                        className="align-middle"
                        aria-label={t("contentPack.select.pageLabel")}
                        checked={pagePicked === "all"}
                        indeterminate={pagePicked === "some"}
                        onChange={() => setSelected((current) => togglePage(current ?? [], shownIds))}
                        data-testid="library-select-page"
                      />
                    </th>
                  ) : null}
                  {/* Percentages share the width out in proportion; a column's content width is its floor. */}
                  <th className={`${COMPACT_UP} ${NARROW} ${coverEdge} pr-4`}>{t("library.column.cover")}</th>
                  <th className={`w-full py-2 pr-4 ${titleEdge} font-medium @3xl:w-[45%] @5xl:w-[30%]`}>{t("library.column.title")}</th>
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
                  const picked = selected?.includes(item.id) === true;
                  const title = item.title ?? t("library.untitled");
                  return (
                    <tr
                      key={item.id}
                      className={`group border-b border-line ${picked ? "bg-accent-soft" : "hover:bg-panel focus-within:bg-panel"}`}
                      data-testid="library-row"
                      data-content-id={item.id}
                      {...(selecting ? { "aria-selected": picked } : {})}
                      onClick={(event) => {
                        // In the selection mode a click on the row's plain area picks it; links, buttons and fields keep their own action.
                        if (!selecting || (event.target as Element).closest(ROW_INTERACTIVE) !== null) return;
                        setSelected((current) => toggleSelected(current ?? [], item.id, !picked));
                      }}
                    >
                      {selecting ? (
                        <td className={`${EDGE_START} py-2 pr-2`}>
                          <Checkbox
                            className="align-middle"
                            aria-label={t("contentPack.select.rowLabel", { title })}
                            checked={picked}
                            onChange={(event) => setSelected((current) => toggleSelected(current ?? [], item.id, event.target.checked))}
                            data-testid="library-select-row"
                          />
                        </td>
                      ) : null}
                      <td className={`${COMPACT_UP} ${coverEdge} py-2 pr-4`}>
                        <Cover url={item.coverUrl} contentId={item.id} version={item.coverImageVersion} />
                      </td>
                      <td className={`py-2 pr-4 ${titleEdge}`}>
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
                        <div className="flex items-center justify-end gap-0.5">
                          <Tooltip content={pinned ? t("library.unpin.action") : t("library.pin.action")}>
                            <button
                              type="button"
                              className={`${ROW_ICON} ${REVEALED_ON_ROW}`}
                              aria-label={pinned ? t("library.unpin.action") : t("library.pin.action")}
                              disabled={patch.isPending && patch.variables?.contentId === item.id}
                              onClick={() => patch.mutate({ contentId: item.id, patch: { pinned: !pinned } })}
                              data-testid="library-row-pin"
                            >
                              {pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
                            </button>
                          </Tooltip>
                          <Tooltip content={t("library.rowActions.addToCollection")}>
                            <button
                              type="button"
                              className={`${ROW_ICON} ${REVEALED_ON_ROW}`}
                              aria-label={t("library.rowActions.addToCollection")}
                              onClick={() => actions.manageCollections(item.id)}
                              data-testid="library-row-collections"
                            >
                              <FolderPlus size={15} aria-hidden="true" />
                            </button>
                          </Tooltip>
                          <ContentRowMenu actions={actions} content={targetOf(item)} label={title} surface="row" alwaysShown />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
      {selected === undefined || !barShown ? null : (
        <SelectionBar
          count={selected.length}
          onClear={exitSelection}
          testIdPrefix="library"
          notes={
            <>
              {deleteBlock === "tooMany" ? (
                <InlineNote id="library-delete-limit" testId="library-delete-limit" className="text-warn!">
                  {t("library.selection.deleteTooMany", { max: CONTENT_TRASH_BATCH_MAX })}
                </InlineNote>
              ) : null}
              {block === "tooMany" ? (
                <InlineNote id="library-selection-limit" testId="library-selection-limit" className="text-warn!">
                  {t("contentPack.select.tooMany", { max: IMPORT_BATCH_MAX })}
                </InlineNote>
              ) : null}
            </>
          }
        >
          <Button
            size="md"
            disabled={deleteBlock !== undefined}
            aria-describedby={deleteBlock === "tooMany" ? "library-delete-limit" : undefined}
            onClick={() => setDeleting([...selected])}
            data-testid="library-delete-selected"
          >
            <Trash2 size={14} aria-hidden="true" />
            {t("library.selection.delete")}
          </Button>
          <Button
            size="md"
            disabled={block !== undefined}
            aria-describedby={block === "tooMany" ? "library-selection-limit" : undefined}
            onClick={() => wizard.open({ contentIds: selected })}
            data-testid="library-export-selected"
          >
            <Download size={14} aria-hidden="true" />
            {t("contentPack.select.exportSelected")}
          </Button>
        </SelectionBar>
      )}
      {searching ? null : <Pagination pager={pager} className="border-t border-line px-6 py-3" />}
      {actions.dialogs}
      <DeleteContentsDialog
        contentIds={deleting}
        onOpenChange={(open) => (open ? undefined : setDeleting(undefined))}
        // Gone from the library: out of the selection; what failed stays picked.
        onSettled={({ removedIds }) => setSelected((current) => (current === undefined ? current : removeSelected(current, removedIds)))}
      />
      {wizard.dialog}
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
