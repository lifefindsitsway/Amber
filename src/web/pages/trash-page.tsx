import { CheckSquare, CircleAlert, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CONTENT_TRASH_BATCH_MAX, TRASH_RETENTION_DAYS } from "../../shared/defaults.ts";
import type { TrashItemDto, TrashRestoreResultDto } from "../../shared/dto/trash.ts";
import { formatBytes } from "../../shared/units.ts";
import { appErrorOf, ConfirmDialog } from "../components/confirm-dialog.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { formatDateTime, formatDuration } from "../format.ts";
import { useEmptyTrash, usePurgeTrashItem, useRestoreTrashItem, useRestoreTrashItems, useTrashList } from "../trash/queries.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { EmptyState, PageHeader, SkeletonRows } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { Callout, InlineNote } from "../ui/notice.tsx";
import { Pagination, useListPosition, usePagination } from "../ui/pagination.tsx";
import { useToast } from "../ui/toast.tsx";
import { SelectionBar, ROW_INTERACTIVE, useSelectionEscape } from "../components/selection-bar.tsx";
import { Cover } from "./library/columns.tsx";
import { exportBlock, pageSelection, removeSelected, toggleSelected, togglePage } from "./library/selection.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_ITEMS: readonly TrashItemDto[] = [];

/**
 * What a row says about its purge: `expired` once the retention has run out, `lessThanDay`
 * in the last day, else the days left rounded up (a Content trashed just now has the full
 * `TRASH_RETENTION_DAYS`).
 */
export function trashCountdown(item: Pick<TrashItemDto, "purgeAt" | "expired">, now: number): "expired" | "lessThanDay" | number {
  const left = item.purgeAt - now;
  if (item.expired || left <= 0) return "expired";
  return left <= DAY_MS ? "lessThanDay" : Math.ceil(left / DAY_MS);
}

/**
 * Milliseconds until any row's countdown text changes, or `undefined` when every entry has
 * expired already: above one day the text drops each time a whole number of days is left,
 * in the last day it changes on expiry.
 */
export function nextCountdownChange(items: ReadonlyArray<Pick<TrashItemDto, "purgeAt" | "expired">>, now: number): number | undefined {
  let next: number | undefined;
  for (const item of items) {
    const left = item.purgeAt - now;
    if (item.expired || left <= 0) continue;
    const delay = left > DAY_MS ? ((left - 1) % DAY_MS) + 1 : left;
    next = next === undefined ? delay : Math.min(next, delay);
  }
  return next;
}

/** The current time, re-read when the nearest countdown changes; one timer for the whole page. */
function useCountdownClock(items: readonly TrashItemDto[]): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Measured from the time the rows show, so a late render cannot skip a change.
    const delay = nextCountdownChange(items, now);
    if (delay === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, now + delay - Date.now()));
    return () => clearTimeout(timer);
  }, [items, now]);
  return now;
}

/**
 * The trash: Contents the user deleted, kept for `TRASH_RETENTION_DAYS` and
 * then purged by the server. Entries cannot be opened, only restored (until they expire) or
 * purged at once. 「选择」 picks entries across pages (only their ids are kept) to restore them
 * together: the server judges each one, the restored ones (and the ones that no longer exist)
 * leave the selection and the ones that could not come back are listed with the reason.
 */
export function TrashPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useTrashList(useListPosition("trash"));
  const pager = usePagination({
    scope: "trash",
    total: list.data?.total,
    totalStale: list.isPlaceholderData,
    onPageShown: () => {
      if (scroller.current !== null) scroller.current.scrollTop = 0;
    },
  });
  const restore = useRestoreTrashItem();
  const restoreMany = useRestoreTrashItems();
  const purge = usePurgeTrashItem();
  const emptyTrash = useEmptyTrash();
  const [purging, setPurging] = useState<TrashItemDto | undefined>(undefined);
  const [emptying, setEmptying] = useState(false);
  // How many entries emptying the trash could not purge.
  const [unpurged, setUnpurged] = useState<number | undefined>(undefined);
  // `undefined` outside the selection mode; picked ids in the order they were picked.
  const [selected, setSelected] = useState<string[] | undefined>(undefined);
  const selecting = selected !== undefined;
  const exitSelection = useCallback(() => setSelected(undefined), []);
  useSelectionEscape(selecting, exitSelection);
  const [report, setReport] = useState<TrashRestoreResultDto | undefined>(undefined);
  // The previous page's rows are never shown while the next page loads.
  const items = list.isPlaceholderData ? NO_ITEMS : (list.data?.items ?? NO_ITEMS);
  // Titles of every entry seen, for the restore report of picks made on other pages.
  const titles = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    for (const item of items) titles.current.set(item.id, item.title);
  }, [items]);
  // Across all pages: what emptying the trash purges.
  const total = list.data?.total ?? 0;
  const now = useCountdownClock(items);
  const titleOf = (item: TrashItemDto): string => item.title ?? t("trash.untitled");
  const unselect = (contentIds: readonly string[]): void => setSelected((current) => (current === undefined ? current : removeSelected(current, contentIds)));
  const loading = list.isPending || list.isPlaceholderData || (items.length === 0 && total > 0);
  const shownIds = list.isError || loading ? [] : items.map((item) => item.id);
  const restoreBlock = exportBlock(selected?.length ?? 0, CONTENT_TRASH_BATCH_MAX);

  const restoreSelected = (contentIds: string[]): void => {
    setUnpurged(undefined);
    restoreMany.mutate(contentIds, {
      onSuccess: (result) => {
        const back = [...result.restoredIds, ...result.alreadyActiveIds];
        // An entry that no longer exists cannot be acted on again, so it leaves the selection
        // too; expired and internal failures stay picked for another try or a purge.
        const gone = result.failed.filter((failure) => failure.reason === "missing").map((failure) => failure.contentId);
        unselect([...back, ...gone]);
        if (result.failed.length === 0) {
          toast.show({ tone: "success", message: t("trash.selection.restored", { count: back.length }) });
        } else {
          setReport(result);
        }
      },
    });
  };

  return (
    <div className="flex h-full flex-col" data-testid="trash-page">
      <PageHeader
        title={t("trash.title")}
        actions={
          <Button variant="danger" data-testid="trash-empty-all" disabled={total === 0} onClick={() => setEmptying(true)}>
            <Trash2 size={14} aria-hidden="true" />
            {t("trash.emptyAll")}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-3">
        <InlineNote className="min-w-0 flex-1">{t("trash.hint", { days: TRASH_RETENTION_DAYS })}</InlineNote>
        <Button
          size="md"
          variant={selecting ? "primary" : "secondary"}
          aria-pressed={selecting}
          disabled={!selecting && total === 0}
          onClick={() => setSelected(selecting ? undefined : [])}
          data-testid="trash-select-mode"
        >
          <CheckSquare size={14} aria-hidden="true" />
          {selecting ? t("contentPack.select.exit") : t("contentPack.select.enter")}
        </Button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        {unpurged === undefined ? null : (
          <Callout tone="warn" announce="status" className="mx-6 mt-3" testId="trash-notice">
            {t("trash.emptyAllPartial", { count: unpurged })}
          </Callout>
        )}
        {restoreMany.error === null ? null : (
          <div className="mx-6 mt-3" data-testid="trash-restore-error">
            <ErrorView error={appErrorOf(restoreMany.error)} />
          </div>
        )}
        {list.isError ? (
          <div className="p-6">
            <ErrorView error={appErrorOf(list.error)} />
          </div>
        ) : loading ? (
          // An empty page of a non-empty trash is past the end (entries went meanwhile): the
          // pager moves to the last page once it knows the total.
          <SkeletonRows count={5} rowHeight={48} gap={16} className="p-6" testId="trash-loading" />
        ) : items.length === 0 ? (
          <div data-testid="trash-empty">
            <EmptyState icon={<Trash2 size={28} />} title={t("trash.empty")} />
          </div>
        ) : (
          <>
            {selected !== undefined ? (
              <div className="border-b border-line px-6 py-2">
                <Checkbox
                  aria-label={t("contentPack.select.pageLabel")}
                  checked={pageSelection(selected, shownIds) === "all"}
                  indeterminate={pageSelection(selected, shownIds) === "some"}
                  onChange={() => setSelected((current) => togglePage(current ?? [], shownIds))}
                  data-testid="trash-select-page"
                />
              </div>
            ) : null}
            <ul className={selecting ? "" : "mt-3 border-t border-line"}>
              {items.map((item) => (
                <TrashRow
                  key={item.id}
                  item={item}
                  now={now}
                  restoring={restore.isPending && restore.variables === item.id}
                  restoreError={restore.isError && restore.variables === item.id ? restore.error : undefined}
                  onRestore={() => {
                    setUnpurged(undefined);
                    restore.mutate(item.id, {
                      onSuccess: () => {
                        unselect([item.id]);
                        toast.show({ tone: "success", message: t("trash.restored", { title: titleOf(item) }) });
                      },
                    });
                  }}
                  onPurge={() => setPurging(item)}
                  {...(selected === undefined
                    ? {}
                    : { picked: selected.includes(item.id), onPick: (on: boolean) => setSelected((current) => toggleSelected(current ?? [], item.id, on)) })}
                />
              ))}
            </ul>
          </>
        )}
      </div>
      {selected === undefined || selected.length === 0 ? null : (
        <SelectionBar
          count={selected.length}
          onClear={exitSelection}
          testIdPrefix="trash"
          notes={
            restoreBlock === "tooMany" ? (
              <InlineNote id="trash-restore-limit" testId="trash-restore-limit" className="text-warn!">
                {t("trash.selection.restoreTooMany", { max: CONTENT_TRASH_BATCH_MAX })}
              </InlineNote>
            ) : undefined
          }
        >
          <Button
            size="md"
            variant="primary"
            loading={restoreMany.isPending}
            disabled={restoreBlock !== undefined}
            aria-describedby={restoreBlock === "tooMany" ? "trash-restore-limit" : undefined}
            onClick={() => restoreSelected([...selected])}
            data-testid="trash-restore-selected"
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t("trash.selection.restore")}
          </Button>
        </SelectionBar>
      )}
      <Pagination pager={pager} className="border-t border-line px-6 py-3" />
      <RestoreReport report={report} titleOf={(contentId) => titles.current.get(contentId) ?? t("trash.untitled")} onClose={() => setReport(undefined)} />
      <ConfirmDialog
        open={purging !== undefined}
        onOpenChange={(open) => (open ? undefined : setPurging(undefined))}
        title={t("trash.purgeTitle")}
        description={t("trash.purgeDescription", { title: purging === undefined ? "" : titleOf(purging) })}
        confirmLabel={t("trash.purge")}
        danger
        onConfirm={async () => {
          if (purging === undefined) return;
          setUnpurged(undefined);
          await purge(purging.id);
          unselect([purging.id]);
        }}
      />
      <ConfirmDialog
        open={emptying}
        onOpenChange={setEmptying}
        title={t("trash.emptyAllTitle")}
        description={t("trash.emptyAllDescription", { count: total })}
        confirmLabel={t("trash.emptyAll")}
        danger
        onConfirm={async () => {
          setUnpurged(undefined);
          const result = await emptyTrash();
          unselect(result.purgedIds);
          if (result.failed.length > 0) setUnpurged(result.failed.length);
        }}
      />
    </div>
  );
}

/** Which picked entries could not be restored and why, after a partly failed restore. */
function RestoreReport(props: { report: TrashRestoreResultDto | undefined; titleOf: (contentId: string) => string; onClose: () => void }) {
  const { t } = useTranslation();
  const { report } = props;
  return (
    <Modal
      open={report !== undefined}
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      title={t("trash.selection.reportTitle")}
      testId="trash-restore-report"
      footer={
        <Button onClick={props.onClose} data-testid="trash-restore-report-close">
          {t("common.action.close")}
        </Button>
      }
    >
      {report === undefined ? null : (
        <div className="flex flex-col gap-2 text-sm" role="status">
          <p>{t("trash.selection.reportSummary", { restored: report.restoredIds.length + report.alreadyActiveIds.length, failed: report.failed.length })}</p>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label={t("trash.selection.reportLabel")}>
            {report.failed.map((failure) => (
              <li key={failure.contentId} className="flex items-start gap-2 px-3 py-2" data-testid="trash-restore-report-item" data-content-id={failure.contentId}>
                <CircleAlert size={14} className="mt-[3px] shrink-0 text-danger" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="break-words">{props.titleOf(failure.contentId)}</p>
                  <p className="text-note text-muted">{t(`trash.selection.reason.${failure.reason}`)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function TrashRow(props: {
  item: TrashItemDto;
  now: number;
  restoring: boolean;
  restoreError: unknown;
  onRestore: () => void;
  onPurge: () => void;
  /** Present in the selection mode. */
  picked?: boolean;
  onPick?: (on: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { item } = props;
  const countdown = trashCountdown(item, props.now);
  const expired = countdown === "expired";
  const meta = [
    t(`common.source.${item.source.kind}`),
    ...(item.durationMs === undefined ? [] : [formatDuration(item.durationMs)]),
    t("trash.deletedAt", { date: formatDateTime(item.trashedAt, i18n.language) }),
    t("trash.media", { size: formatBytes(item.mediaBytes) }),
  ].join(" · ");
  const { onPick } = props;
  const picked = props.picked === true;
  const title = item.title ?? t("trash.untitled");
  return (
    <li
      data-testid="trash-row"
      data-content-id={item.id}
      className={`border-b border-line px-6 py-3 ${picked ? "bg-accent-soft" : ""}`}
      {...(onPick === undefined ? {} : { "aria-selected": picked })}
      onClick={(event) => {
        // In the selection mode a click on the row's plain area picks it; its buttons keep their own action.
        if (onPick === undefined || (event.target as Element).closest(ROW_INTERACTIVE) !== null) return;
        onPick(!picked);
      }}
    >
      <div className="flex items-center gap-4">
        {onPick === undefined ? null : (
          <Checkbox aria-label={t("contentPack.select.rowLabel", { title })} checked={picked} onChange={(event) => onPick(event.target.checked)} data-testid="trash-select-row" />
        )}
        <Cover url={item.coverUrl} />
        {/* Not a link: a Content in the trash cannot be opened. */}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-xs text-muted">{meta}</p>
        </div>
        <span data-testid="trash-status" className={`shrink-0 text-xs whitespace-nowrap ${expired ? "text-danger" : "text-muted"}`}>
          {expired ? t("trash.expired") : countdown === "lessThanDay" ? t("trash.lessThanDay") : t("trash.daysLeft", { days: countdown })}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" data-testid="trash-restore" disabled={expired || props.restoring} onClick={props.onRestore}>
            <RotateCcw size={14} aria-hidden="true" />
            {t("trash.restore")}
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" data-testid="trash-purge" onClick={props.onPurge}>
            <Trash2 size={14} aria-hidden="true" />
            {t("trash.purge")}
          </Button>
        </div>
      </div>
      {props.restoreError === undefined ? null : (
        <div className="mt-2">
          <ErrorView error={appErrorOf(props.restoreError)} />
        </div>
      )}
    </li>
  );
}
