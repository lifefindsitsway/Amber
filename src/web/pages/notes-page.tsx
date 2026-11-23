import { ChevronDown, ChevronRight, NotebookPen } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import type { NoteDto, NoteGroupDto } from "../../shared/dto/note.ts";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { formatDateTime } from "../format.ts";
import { NoteCard } from "../notes/note-card.tsx";
import { useContentNotes, useNoteGroups } from "../notes/queries.ts";
import { Button } from "../ui/button.tsx";
import { FOCUS_RING } from "../ui/button.tsx";
import { EmptyState, PageHeader, SkeletonRows } from "../ui/feedback.tsx";
import { TEXT_ACTION_CLASS } from "../ui/notice.tsx";
import { Pagination, useListPosition, usePagination } from "../ui/pagination.tsx";
import { Tooltip } from "../ui/tooltip.tsx";
import { useContentDetail } from "./content/content-data.ts";

/** Notes grouped by Content (`/notes`); `?contentId=` narrows it to one Content. */
export function NotesPage() {
  const [params, setParams] = useSearchParams();
  const contentId = params.get("contentId") ?? undefined;
  return (
    <div className="flex h-full flex-col" data-testid="notes-page">
      {contentId === undefined || contentId === "" ? <AllNotes /> : <ContentNotes contentId={contentId} onViewAll={() => setParams({})} />}
    </div>
  );
}

const NO_GROUPS: readonly NoteGroupDto[] = [];

function AllNotes() {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const groups = useNoteGroups(useListPosition("notes"));
  const pager = usePagination({
    scope: "notes",
    total: groups.data?.total,
    totalStale: groups.isPlaceholderData,
    onPageShown: () => {
      if (scroller.current !== null) scroller.current.scrollTop = 0;
    },
  });
  // Explicit toggles by Content, kept while the page is open, across page changes; a group
  // nobody toggled is open when it is first on its page.
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // The previous page's groups are never shown while the next page loads.
  const items = groups.isPlaceholderData ? NO_GROUPS : (groups.data?.items ?? NO_GROUPS);
  const total = groups.data?.total;
  const isOpen = (contentId: string, index: number): boolean => expanded.get(contentId) ?? index === 0;
  const setOpen = (contentIds: readonly string[], open: boolean): void =>
    setExpanded((previous) => new Map([...previous, ...contentIds.map((contentId) => [contentId, open] as const)]));
  const allOpen = items.length > 0 && items.every((item, index) => isOpen(item.contentId, index));
  // Acts on this page's groups only; groups on other pages keep their own state.
  const toggleAll = (): void => setOpen(items.map((item) => item.contentId), !allOpen);

  return (
    <>
      <PageHeader
        title={t("notes.page.title")}
        actions={
          items.length === 0 ? null : (
            <Button onClick={toggleAll} data-testid="notes-expand-all">
              {allOpen ? t("notes.page.collapseAll") : t("notes.page.expandAll")}
            </Button>
          )
        }
      />
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-6">
        {groups.isError ? (
          <ErrorView error={appErrorOf(groups.error)} />
        ) : total === undefined || groups.isPlaceholderData || (items.length === 0 && total > 0) ? (
          // An empty page of a non-empty list is past the end (groups went meanwhile): the
          // pager moves to the last page once it knows the total.
          <GroupSkeleton count={5} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<NotebookPen size={28} />}
            title={t("notes.page.empty")}
            hint={t("notes.page.emptyHint")}
            action={
              <Link to="/library" className={`text-sm ${TEXT_ACTION_CLASS}`}>
                {t("notes.page.emptyAction")}
              </Link>
            }
          />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted" data-testid="notes-summary">
              {t("notes.page.summary", { count: total })}
            </p>
            <ul className="flex flex-col gap-3">
              {items.map((item, index) => {
                const open = isOpen(item.contentId, index);
                return (
                  <NoteGroup
                    key={item.contentId}
                    contentId={item.contentId}
                    title={item.title}
                    count={item.count}
                    latestAt={item.latestAt}
                    open={open}
                    onToggle={() => setOpen([item.contentId], !open)}
                  />
                );
              })}
            </ul>
          </>
        )}
      </div>
      <Pagination pager={pager} className="border-t border-line px-6 py-3" />
    </>
  );
}

/**
 * One Content's notes. Its detail is fetched on its own, so the title shows (and a missing
 * Content reports as such) even when the Content has no notes and thus no group.
 */
function ContentNotes(props: { contentId: string; onViewAll: () => void }) {
  const { t } = useTranslation();
  const detail = useContentDetail(props.contentId);
  const notes = useContentNotes(props.contentId);
  const [open, setOpen] = useState(true);
  const items = notes.data?.items ?? [];
  return (
    <>
      <PageHeader title={t("notes.page.title")} actions={<Button onClick={props.onViewAll} data-testid="notes-view-all">{t("notes.page.viewAll")}</Button>} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {detail.isError ? (
          <ErrorView error={appErrorOf(detail.error)} />
        ) : detail.isPending || notes.isPending ? (
          <GroupSkeleton count={1} />
        ) : notes.isError ? (
          <ErrorView error={appErrorOf(notes.error)} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<NotebookPen size={28} />}
            title={t("notes.page.contentEmpty")}
            action={
              <Link to={`/contents/${encodeURIComponent(props.contentId)}`} className={`text-sm ${TEXT_ACTION_CLASS}`}>
                {detail.data.title ?? t("library.untitled")}
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            <NoteGroup
              contentId={props.contentId}
              title={detail.data.title ?? t("library.untitled")}
              count={items.length}
              latestAt={latestCreatedAt(items)}
              open={open}
              onToggle={() => setOpen(!open)}
            />
          </ul>
        )}
      </div>
    </>
  );
}

/** Placeholders the height of a collapsed group, so the groups replace them in place. */
function GroupSkeleton(props: { count: number }) {
  return <SkeletonRows count={props.count} rowHeight={54} gap={12} testId="notes-loading" />;
}

/** A group's "latest" is when its newest note was created, as the server orders groups. */
function latestCreatedAt(items: readonly NoteDto[]): number {
  return items.reduce((latest, note) => Math.max(latest, note.createdAt), 0);
}

function NoteGroup(props: { contentId: string; title: string; count: number; latestAt: number; open: boolean; onToggle: () => void }) {
  const { t, i18n } = useTranslation();
  const toggleLabel = props.open ? t("notes.page.collapse") : t("notes.page.expand");
  return (
    <li className="rounded-lg border border-line" data-testid="notes-group" data-content-id={props.contentId}>
      <div className="flex items-center gap-3 p-3">
        <Tooltip content={toggleLabel}>
          <button
            type="button"
            className={`rounded p-1 text-muted hover:bg-sunken hover:text-ink ${FOCUS_RING}`}
            aria-expanded={props.open}
            aria-label={toggleLabel}
            onClick={props.onToggle}
            data-testid="notes-group-toggle"
          >
            {props.open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          </button>
        </Tooltip>
        <Link to={`/contents/${encodeURIComponent(props.contentId)}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
          {props.title}
        </Link>
        <span className="shrink-0 text-xs text-muted">
          {t("notes.page.count", { count: props.count })}
          {" · "}
          {t("notes.page.latest", { time: formatDateTime(props.latestAt, i18n.language) })}
        </span>
      </div>
      {props.open ? <GroupNotes contentId={props.contentId} /> : null}
    </li>
  );
}

/** Fetched only while the group is open; no revision, so each note shows as anchored. */
function GroupNotes(props: { contentId: string }) {
  const notes = useContentNotes(props.contentId);
  return (
    <div className="border-t border-line p-3">
      {notes.isPending ? (
        <SkeletonRows count={2} rowHeight={40} gap={8} />
      ) : notes.isError ? (
        <ErrorView error={appErrorOf(notes.error)} />
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.data.items.map((note) => (
            <li key={note.id}>
              <NoteCard note={note} variant="page" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
