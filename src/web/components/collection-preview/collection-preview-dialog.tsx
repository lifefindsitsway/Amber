import { ListVideo } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { COLLECTION_PREVIEW_FILTER_MIN, COLLECTION_PREVIEW_ITEMS_MAX, IMPORT_BATCH_MAX } from "../../../shared/defaults.ts";
import type { AppError } from "../../../shared/errors.ts";
import { recognizeLink } from "../../links.ts";
import { Button } from "../../ui/button.tsx";
import { Checkbox } from "../../ui/checkbox.tsx";
import { EmptyState, Skeleton, Spinner } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { Callout, InlineNote, TextAction } from "../../ui/notice.tsx";
import { TextInput } from "../../ui/text-field.tsx";
import { ErrorView } from "../error-view.tsx";
import { EntryCover, EntryDuration, EntryState, EntryTitle, PartsNote } from "./entry-parts.tsx";
import { OrderList, OrderToolbar } from "./order-list.tsx";
import { chosenDuration, hoursAndMinutes, notInCollection, rangeBetween, selectable, type CollectionChoice, type PreviewEntry, type PreviewSession } from "./state.ts";
import type { CollectionPreview } from "./use-collection-preview.ts";

type Pane = "select" | "order";

const SKELETON_ROWS = 6;

/**
 * The wide dialog for choosing what to import from platform collections, and in which order.
 * Several collection links are gone through one by one (「下一个」); only the last step submits,
 * with every link's choice. 「取消」 closes and keeps the choice; the page that opened it (and
 * holds `preview`) submits in `onConfirm` and reports back through `submitting` and `error`.
 */
export function CollectionPreviewDialog(props: {
  preview: CollectionPreview;
  onConfirm: (choices: CollectionChoice[]) => void;
  submitting: boolean;
  /** Why the last submit failed, shown in the dialog. */
  error: AppError | undefined;
  /** Other links of the same import, which count against the batch limit. */
  reserved?: number;
}) {
  const { t } = useTranslation();
  const { preview } = props;
  const [pane, setPane] = useState<Pane>("select");
  const url = preview.urls[preview.step];
  const session = url === undefined ? undefined : preview.sessions[url];
  const last = preview.step >= preview.urls.length - 1;
  const reserved = props.reserved ?? 0;
  // The whole import counts: the other links plus every collection's chosen entries.
  const total = preview.totalChosen + reserved;
  const over = total > IMPORT_BATCH_MAX;
  const ready = preview.urls.every((link) => preview.sessions[link]?.phase === "ready");
  const title = session?.title !== undefined && session.title !== "" ? session.title : t("shell.collectionPreview.title");

  // Each collection opens on its entries.
  useEffect(() => setPane("select"), [url]);

  const footer = (
    <>
      <div className="mr-auto min-w-0 basis-full sm:basis-auto" data-testid="preview-footer-note">
        {over ? (
          <InlineNote className="text-warn" role="status">
            {t("shell.collectionPreview.overLimit", {
              max: IMPORT_BATCH_MAX,
              count: total,
              excess: total - IMPORT_BATCH_MAX,
            })}
          </InlineNote>
        ) : (
          <InlineNote>{reserved > 0 ? t("shell.collectionPreview.footerReserved", { count: reserved }) : t("shell.collectionPreview.footerNote")}</InlineNote>
        )}
      </div>
      <Button onClick={preview.close} data-testid="preview-cancel">
        {t("common.action.cancel")}
      </Button>
      {preview.step > 0 ? (
        <Button onClick={() => preview.setStep(preview.step - 1)} data-testid="preview-previous">
          {t("shell.collectionPreview.previous")}
        </Button>
      ) : null}
      {last ? (
        <Button
          variant="primary"
          loading={props.submitting}
          disabled={!ready || over || total === 0}
          onClick={() => props.onConfirm(preview.choices())}
          data-testid="preview-submit"
        >
          {t("shell.collectionPreview.submit", { count: total })}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => preview.setStep(preview.step + 1)} data-testid="preview-next">
          {t("shell.collectionPreview.next")}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open={preview.isOpen}
      onOpenChange={(open) => {
        if (!open) preview.close();
      }}
      title={title}
      size="xl"
      footer={footer}
      testId="collection-preview"
    >
      {session === undefined ? null : <SessionView key={session.url} preview={preview} session={session} pane={pane} onPane={setPane} over={over} error={props.error} />}
    </Modal>
  );
}

/**
 * One collection: a header that stays in view (platform and counts, the submit error, the two
 * panes and, for the entries, their toolbar) over the rows, which scroll.
 */
function SessionView(props: { preview: CollectionPreview; session: PreviewSession; pane: Pane; onPane: (pane: Pane) => void; over: boolean; error: AppError | undefined }) {
  const { t } = useTranslation();
  const { preview, session } = props;
  const [query, setQuery] = useState("");
  const view = selectView(session, query);
  const ready = session.phase === "ready";
  return (
    <Tabs.Root value={props.pane} onValueChange={(value) => props.onPane(value as Pane)} className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-3 bg-surface pb-2">
        <Summary session={session} step={preview.step} steps={preview.urls.length} over={props.over} />
        {props.error === undefined ? null : <ErrorView error={props.error} />}
        <Tabs.List aria-label={t("shell.collectionPreview.tabs")} className="inline-flex w-fit gap-0.5 rounded-md bg-sunken p-0.5">
          <PaneTab value="select" label={t("shell.collectionPreview.tabSelect")} />
          <PaneTab
            value="order"
            label={t("shell.collectionPreview.tabOrderCount", {
              count: session.selected.size,
            })}
          />
        </Tabs.List>
        {props.pane === "select" && ready && session.entries.length > 0 ? <SelectToolbar preview={preview} session={session} view={view} query={query} onQuery={setQuery} /> : null}
        {props.pane === "order" && ready && session.selected.size > 0 ? <OrderToolbar session={session} onReset={() => preview.resetOrder(session.url)} /> : null}
      </div>
      <Tabs.Content value="select" className="outline-none">
        <SelectPane preview={preview} session={session} view={view} query={query} />
      </Tabs.Content>
      <Tabs.Content value="order" className="outline-none">
        {ready ? (
          <OrderList session={session} onArrange={(order) => preview.arrange(session.url, order)} onMoveToFront={(id) => preview.moveToFront(session.url, id)} />
        ) : (
          // Reading, or failed: the same skeleton or error with its retry as on the entries.
          <SelectPane preview={preview} session={session} view={view} query={query} />
        )}
      </Tabs.Content>
    </Tabs.Root>
  );
}

function PaneTab(props: { value: Pane; label: string }) {
  return (
    <Tabs.Trigger
      value={props.value}
      className="h-7 rounded px-3 text-sm whitespace-nowrap text-muted outline-none transition duration-150 motion-reduce:transition-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-[state=active]:bg-surface data-[state=active]:font-medium data-[state=active]:text-ink data-[state=active]:shadow-sm"
      data-testid={`preview-tab-${props.value}`}
    >
      {props.label}
    </Tabs.Trigger>
  );
}

/** Platform, counts and the length of what is chosen; the step of several collections at the end. */
function Summary(props: { session: PreviewSession; step: number; steps: number; over: boolean }) {
  const { t } = useTranslation();
  const { session } = props;
  const platform = recognizeLink(session.canonicalUrl ?? session.url)?.platform ?? recognizeLink(session.url)?.platform;
  const durationText = useDurationText();
  const duration = chosenDuration(session);
  const length = duration === undefined ? undefined : durationText(duration.totalMs);
  const parts: string[] = [];
  if (session.phase === "ready") {
    parts.push(
      session.truncated
        ? session.totalCount === undefined
          ? t("shell.collectionPreview.totalOver", {
              count: COLLECTION_PREVIEW_ITEMS_MAX,
            })
          : t("shell.collectionPreview.total", { count: session.totalCount })
        : t("shell.collectionPreview.total", { count: session.itemCount }),
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1" data-testid="preview-summary">
      <p className="flex flex-wrap items-center gap-x-1.5 text-note text-muted">
        <ListVideo size={14} aria-hidden="true" className="shrink-0" />
        {platform === undefined ? null : <span>{t(`shell.collectionPreview.platform.${platform}`)}</span>}
        {session.phase === "loading" ? (
          <span>{t("shell.collectionPreview.loading")}</span>
        ) : (
          <>
            {parts.map((part) => (
              <span key={part}>
                <span aria-hidden="true">· </span>
                {part}
              </span>
            ))}
            <span className={props.over ? "font-medium text-warn" : ""} data-testid="preview-chosen-count">
              <span aria-hidden="true">· </span>
              {t("shell.collectionPreview.chosen", {
                count: session.selected.size,
              })}
            </span>
            {length === undefined || duration === undefined ? null : (
              <span data-testid="preview-duration">
                <span aria-hidden="true">· </span>
                {duration.complete
                  ? t("shell.collectionPreview.duration", { duration: length })
                  : t("shell.collectionPreview.durationKnown", {
                      duration: length,
                    })}
              </span>
            )}
          </>
        )}
      </p>
      {props.steps > 1 ? (
        <span className="text-xs text-muted tabular-nums" data-testid="preview-step">
          {t("shell.collectionPreview.step", {
            index: props.step + 1,
            count: props.steps,
          })}
        </span>
      ) : null}
    </div>
  );
}

/** "约 X 小时 Y 分" wording of a length, to the minute. */
function useDurationText(): (ms: number) => string {
  const { t } = useTranslation();
  return (ms) => {
    const { hours, minutes } = hoursAndMinutes(ms);
    if (hours > 0) return t("shell.collectionPreview.hoursMinutes", { hours, minutes });
    if (minutes > 0) return t("shell.collectionPreview.minutes", { minutes });
    return t("shell.collectionPreview.underMinute");
  };
}

/** Placeholder rows of the real rows' size while the first page loads. */
function LoadingRows() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="flex flex-col" data-testid="preview-loading">
      <span className="sr-only">{t("shell.collectionPreview.loading")}</span>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex min-h-15 items-center gap-3 px-2 py-2">
          <Skeleton width={16} height={16} />
          <Skeleton width={24} height={12} />
          <Skeleton width={64} height={36} />
          <Skeleton height={14} className="flex-1" />
          <Skeleton width={40} height={12} />
        </div>
      ))}
    </div>
  );
}

/** The rows on screen: every entry read so far, narrowed by the title filter. */
interface SelectView {
  shown: PreviewEntry[];
  choosable: PreviewEntry[];
  filtering: boolean;
}

function selectView(session: PreviewSession, query: string): SelectView {
  const needle = query.trim().toLowerCase();
  const shown = needle === "" ? session.entries : session.entries.filter((entry) => (entry.title ?? "").toLowerCase().includes(needle));
  return {
    shown,
    choosable: shown.filter(selectable),
    filtering: needle !== "",
  };
}

/**
 * Acts on the rows on screen, as it says: the select-all box (mixed while some are chosen),
 * 「只选还不在此合集里的」, 「加载全部」 (stoppable), and the title filter once there are many rows.
 */
function SelectToolbar(props: { preview: CollectionPreview; session: PreviewSession; view: SelectView; query: string; onQuery: (query: string) => void }) {
  const { t } = useTranslation();
  const scopeId = useId();
  const { preview, session, view } = props;
  const ids = (entries: readonly PreviewEntry[]) => entries.map((entry) => entry.platformContentId);
  const chosenShown = view.choosable.filter((entry) => session.selected.has(entry.platformContentId)).length;
  const allState = chosenShown === 0 ? "none" : chosenShown === view.choosable.length ? "all" : "some";
  const canPage = session.nextOffset !== undefined;
  const onlyOutside = view.choosable.filter(notInCollection);
  const insideChosen = view.choosable.filter((entry) => !notInCollection(entry) && session.selected.has(entry.platformContentId)).length;
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-2 pb-2" data-testid="preview-toolbar">
      <Checkbox
        checked={allState === "all"}
        indeterminate={allState === "some"}
        disabled={view.choosable.length === 0}
        onChange={() => preview.choose(session.url, ids(view.choosable), allState !== "all")}
        aria-describedby={scopeId}
        data-testid="preview-select-all"
      >
        {t("shell.collectionPreview.selectAll")}
      </Checkbox>
      <span id={scopeId} className="text-note text-muted" data-testid="preview-shown-scope">
        {t("shell.collectionPreview.shownScope", { count: view.shown.length })}
      </span>
      <TextAction
        className="text-note disabled:cursor-default disabled:text-muted disabled:no-underline"
        // Disabled when the shown rows are already chosen exactly so: a click that changes nothing reads as broken.
        disabled={onlyOutside.every((entry) => session.selected.has(entry.platformContentId)) && insideChosen === 0}
        onClick={() => {
          preview.choose(session.url, ids(view.choosable.filter((entry) => !notInCollection(entry))), false);
          preview.choose(session.url, ids(onlyOutside), true);
        }}
        data-testid="preview-only-not-in-collection"
      >
        {t("shell.collectionPreview.onlyNotInCollection")}
      </TextAction>
      {session.loadingAll ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner size={12} />
          <TextAction className="text-note" onClick={() => preview.stopLoading(session.url)} data-testid="preview-stop-loading">
            {t("shell.collectionPreview.stopLoading")}
          </TextAction>
        </span>
      ) : canPage ? (
        <TextAction className="text-note" onClick={() => preview.loadAll(session.url)} data-testid="preview-load-all">
          {t("shell.collectionPreview.loadAll")}
        </TextAction>
      ) : null}
      {session.entries.length > COLLECTION_PREVIEW_FILTER_MIN ? (
        <TextInput
          size="sm"
          type="search"
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder={t("shell.collectionPreview.filter")}
          aria-label={t("shell.collectionPreview.filter")}
          className="ml-auto w-48"
          data-testid="preview-filter"
        />
      ) : null}
    </div>
  );
}

/**
 * The entries of one collection in the platform's order. A click anywhere on a row (or its check
 * box) chooses it; with Shift, the range from the last clicked row takes the clicked row's new
 * state. More pages load as the end scrolls into view (not while filtering), or on request.
 */
function SelectPane(props: { preview: CollectionPreview; session: PreviewSession; view: SelectView; query: string }) {
  const { t } = useTranslation();
  const { preview, session, view } = props;
  const anchor = useRef<string | undefined>(undefined);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const canPage = session.phase === "ready" && session.nextOffset !== undefined;
  const autoPage = canPage && !view.filtering && !session.paging && session.pageError === undefined;
  const { loadMore } = preview;

  // The end of the list in view reads the next page; observed again after every page, since a
  // short page can leave the end in view without crossing the edge again.
  useEffect(() => {
    const target = sentinel.current;
    if (!autoPage || target === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) void loadMore(session.url);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [autoPage, loadMore, session.url, session.entries.length]);

  if (session.phase === "loading" || session.phase === "idle") return <LoadingRows />;
  if (session.phase === "failed") {
    return (
      <div className="py-2" data-testid="preview-failed">
        {session.error === undefined ? null : (
          <ErrorView error={session.error}>
            <Button size="sm" onClick={() => preview.retry(session.url)} data-testid="preview-retry">
              {t("shell.collectionPreview.retry")}
            </Button>
          </ErrorView>
        )}
      </div>
    );
  }

  const shownIds = view.shown.map((entry) => entry.platformContentId);
  const choose = (entry: PreviewEntry, event: MouseEvent): void => {
    if (!selectable(entry)) return;
    const id = entry.platformContentId;
    const on = !session.selected.has(id);
    const range = event.shiftKey && anchor.current !== undefined ? rangeBetween(shownIds, anchor.current, id) : undefined;
    preview.choose(session.url, range ?? [id], on);
    anchor.current = id;
  };

  return (
    <div className="flex flex-col pt-1">
      {session.truncated ? (
        <InlineNote className="mb-2 px-2" testId="preview-truncated">
          {session.totalCount === undefined
            ? t("shell.collectionPreview.truncatedUnknown", {
                max: COLLECTION_PREVIEW_ITEMS_MAX,
              })
            : t("shell.collectionPreview.truncated", {
                total: session.totalCount,
                max: COLLECTION_PREVIEW_ITEMS_MAX,
              })}
        </InlineNote>
      ) : null}
      {session.selected.size === 0 && session.entries.length > 0 ? (
        <Callout tone="info" density="compact" className="mb-2" testId="preview-none-chosen">
          {t("shell.collectionPreview.noneChosen")}
        </Callout>
      ) : null}
      {session.entries.length === 0 ? (
        <EmptyState title={t("shell.collectionPreview.empty")} />
      ) : view.shown.length === 0 ? (
        <EmptyState
          title={t("shell.collectionPreview.filterEmpty", {
            query: props.query.trim(),
          })}
        />
      ) : (
        <ul className="@container flex flex-col" data-testid="preview-entries">
          {view.shown.map((entry) => (
            <EntryRow key={entry.platformContentId} entry={entry} chosen={session.selected.has(entry.platformContentId)} onChoose={choose} />
          ))}
        </ul>
      )}
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      {session.pageError === undefined ? null : (
        <ErrorView error={session.pageError}>
          <Button size="sm" onClick={() => void preview.loadMore(session.url)} data-testid="preview-page-retry">
            {t("shell.collectionPreview.retry")}
          </Button>
        </ErrorView>
      )}
      {canPage ? (
        <InlineNote
          className="justify-center py-3"
          testId="preview-more"
          action={
            session.paging ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size={12} />
                {t("shell.collectionPreview.loadingMore")}
              </span>
            ) : (
              <TextAction onClick={() => void preview.loadMore(session.url)} data-testid="preview-load-more">
                {t("shell.collectionPreview.loadMore")}
              </TextAction>
            )
          }
        >
          {t("shell.collectionPreview.shownOf", {
            shown: session.entries.length,
            count: session.itemCount,
          })}
        </InlineNote>
      ) : null}
    </div>
  );
}

function EntryRow(props: { entry: PreviewEntry; chosen: boolean; onChoose: (entry: PreviewEntry, event: MouseEvent) => void }) {
  const { t } = useTranslation();
  const rowId = useId();
  const { entry } = props;
  const enabled = selectable(entry);
  const position = (entry.index ?? 0) + 1;
  return (
    <li
      className={`flex min-h-15 items-center gap-3 rounded-md px-2 py-2 select-none ${enabled ? "cursor-pointer hover:bg-panel" : "cursor-default"}`}
      onMouseDown={(event) => {
        // Shift picks a range; it should not also select the rows' text.
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a") !== null) return;
        props.onChoose(entry, event);
      }}
      data-testid="preview-entry"
      data-entry-id={entry.platformContentId}
      data-chosen={props.chosen ? "true" : "false"}
    >
      <Checkbox
        checked={props.chosen}
        disabled={!enabled}
        // The row's click handler decides; the box only shows it.
        onChange={() => undefined}
        aria-labelledby={`${rowId}-position ${rowId}-title`}
        aria-describedby={`${rowId}-state`}
        data-testid="preview-entry-box"
      />
      <span id={`${rowId}-position`} className="w-8 shrink-0 text-right text-xs text-muted tabular-nums">
        <span className="sr-only">{t("shell.collectionPreview.entry", { index: position })}</span>
        <span aria-hidden="true">{position}</span>
      </span>
      <EntryCover entry={entry} />
      <span className={`flex min-w-0 flex-1 flex-col gap-1 @2xl:flex-row @2xl:items-center @2xl:gap-3 ${enabled ? "" : "opacity-70"}`}>
        <span className="flex min-w-0 flex-1 flex-col">
          <EntryTitle entry={entry} id={`${rowId}-title`} className="text-sm" />
          <PartsNote entry={entry} />
        </span>
        <span className="shrink-0 @2xl:w-44">
          <EntryState entry={entry} describeId={`${rowId}-state`} />
        </span>
      </span>
      <EntryDuration entry={entry} />
    </li>
  );
}
