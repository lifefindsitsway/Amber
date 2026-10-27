import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronsDown, ChevronsUp, Copy, NotebookPen, Pencil, Sparkles } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { contentDtoSchema, type TranscriptRevisionDto, type TranscriptRevisionListItemDto } from "../../../shared/dto/content.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { isMarked, isOnlyPunctuationChange, joinReading, readingSeparator } from "../../../shared/reading.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useProviders, useSettings } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { formatDuration } from "../../format.ts";
import { usePlayerCapabilities, usePlayerTime } from "../../player/player-controller.tsx";
import { searchKeys, termRanges } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { copyText } from "../../ui/clipboard.ts";
import { elementOf } from "../../ui/dom-selection.ts";
import { DecoratedText } from "../../notes/decorated-text.tsx";
import { notesBySegment, type SentenceNote } from "../../notes/note-anchor.ts";
import { useOptionalNotesUi } from "../../notes/note-ui-context.tsx";
import { useContentNotes } from "../../notes/queries.ts";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { AsrBanner } from "./asr-banner.tsx";
import { ChapterOutline } from "./chapter-outline.tsx";
import { useContentPage } from "./content-context.tsx";
import {
  contentKeys,
  readableRevisions,
  readerRows,
  revisionGroups,
  segmentAt,
  useChapters,
  useRevisions,
  useSegments,
  visibleRevisions,
  type Paragraph,
  type ReaderRow,
} from "./content-data.ts";
import { DraftEditor } from "./draft-editor.tsx";
import { revisionBasis, revisionLabel } from "./labels.ts";
import { RevisionActions } from "./revision-actions-dialog.tsx";
import { useLocatedSegment } from "./same-sentence.ts";
import { useSentenceMenu } from "./sentence-menu.tsx";
import { VirtualRows, type VirtualRowsHandle } from "./virtual-rows.tsx";

/**
 * Which sentences a revision changed relative to its parent, and who changed them. A
 * proofreading pass that only restored punctuation did not change what was said, so a
 * `corrected` sentence counts as an AI change only when something other than punctuation
 * differs; a `manual` revision is compared strictly.
 */
export function changedSegments(
  revision: TranscriptRevisionDto,
  segments: readonly TranscriptSegmentDto[],
  parentSegments: readonly TranscriptSegmentDto[],
): Map<string, "ai" | "user"> {
  const changes = new Map<string, "ai" | "user">();
  if (revision.kind !== "corrected" && revision.kind !== "manual") return changes;
  const who = revision.kind === "corrected" ? "ai" : "user";
  const parentText = new Map(parentSegments.map((segment) => [segment.id, segment.text]));
  for (const segment of segments) {
    const before = segment.sourceSegmentIds.map((id) => parentText.get(id) ?? "").join("");
    if (segment.sourceSegmentIds.length === 0) {
      changes.set(segment.id, who);
    } else if (before !== segment.text && !(who === "ai" && isOnlyPunctuationChange(before, segment.text))) {
      changes.set(segment.id, who);
    }
  }
  return changes;
}

/** 原文细读 tab: version picker, paragraph reading, change marks, Draft → Commit. */
export function TranscriptTab() {
  const { t } = useTranslation();
  const page = useContentPage();
  const [params, setParams] = useSearchParams();
  const revisions = useRevisions(page.content.id);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  if (revisions.isPending) return <Loading />;
  if (revisions.isError) {
    return revisions.error instanceof ApiError ? <ErrorView error={revisions.error.error} /> : <EmptyState title={t("common.state.loadFailed")} />;
  }
  const all = revisions.data.revisions;
  const readable = readableRevisions(all);
  const primaryId = revisions.data.primaryTranscriptRevisionId;
  const requested = params.get("revision");
  // A link to a revision that no longer exists says so instead of silently showing another one.
  const missing = requested !== null && !all.some((item) => item.id === requested);
  const groups = revisionGroups(readable, primaryId);
  const revision =
    readable.find((item) => item.id === requested) ??
    readable.find((item) => item.id === primaryId) ??
    visibleRevisions(readable, primaryId).at(-1) ??
    readable.at(-1);
  if (revision === undefined) {
    return <EmptyState title={t("contentView.transcript.empty")} hint={t("contentView.transcript.emptyHint")} />;
  }
  const pick = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set("revision", id);
    setParams(next, { replace: true });
  };
  const unpick = (): void => {
    const next = new URLSearchParams(params);
    next.delete("revision");
    setParams(next, { replace: true });
  };
  if (editing) {
    return <DraftEditor base={revision} primaryRevisionId={primaryId} onClose={() => setEditing(false)} />;
  }
  // A shown revision that sits behind a toggle (a deep link, say) opens that toggle.
  const historyOpen = showHistory || groups.history.has(revision.id);
  const archivedOpen = showArchived || groups.archived.has(revision.id);
  const toggles: RevisionToggles = {
    historyCount: groups.history.size,
    historyOpen,
    setHistoryOpen: (open) => {
      setShowHistory(open);
      if (!open && groups.history.has(revision.id)) unpick();
    },
    archivedCount: groups.archived.size,
    archivedOpen,
    setArchivedOpen: (open) => {
      setShowArchived(open);
      if (!open && groups.archived.has(revision.id)) unpick();
    },
  };
  return (
    <TranscriptReader
      revision={revision}
      revisions={visibleRevisions(readable, primaryId, { showHistory: historyOpen, showArchived: archivedOpen, include: [revision.id] })}
      readable={readable}
      primaryId={primaryId}
      search={params.get("search") ?? ""}
      missing={missing}
      toggles={toggles}
      onPick={pick}
      onDeleted={unpick}
      onEdit={() => setEditing(true)}
    />
  );
}

/** The state of the 「历史手动修订」 and 「显示已归档」 toggles beside a version picker. */
export interface RevisionToggles {
  historyCount: number;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  archivedCount: number;
  archivedOpen: boolean;
  setArchivedOpen: (open: boolean) => void;
}

/** The two toggles; each appears only when it has something to reveal. */
export function RevisionToggleBar(props: { toggles: RevisionToggles }) {
  const { t } = useTranslation();
  const { toggles } = props;
  return (
    <>
      {toggles.historyCount > 0 ? (
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={toggles.historyOpen}
            onChange={(event) => toggles.setHistoryOpen(event.target.checked)}
            data-testid="revision-history-toggle"
          />
          {t("contentView.revisions.historyToggle", { count: toggles.historyCount })}
        </label>
      ) : null}
      {toggles.archivedCount > 0 ? (
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={toggles.archivedOpen}
            onChange={(event) => toggles.setArchivedOpen(event.target.checked)}
            data-testid="revision-archived-toggle"
          />
          {t("contentView.revisions.archivedToggle", { count: toggles.archivedCount })}
        </label>
      ) : null}
    </>
  );
}

function TranscriptReader(props: {
  revision: TranscriptRevisionListItemDto;
  /** The revisions the picker lists. */
  revisions: TranscriptRevisionListItemDto[];
  /** Every revision a reader may open, listed or not: labels and 「基于」 resolve against these. */
  readable: TranscriptRevisionListItemDto[];
  primaryId: string | undefined;
  missing: boolean;
  toggles: RevisionToggles;
  onDeleted: () => void;
  /** The query a search hit opened the page with; its terms are marked in the text. */
  search: string;
  onPick: (id: string) => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const providers = useProviders();
  const settings = useSettings();
  const capabilities = usePlayerCapabilities();
  const time = usePlayerTime();
  const { revision } = props;
  const segments = useSegments(revision.id);
  const chapters = useChapters(page.content.id);
  const [showChanges, setShowChanges] = useState(false);
  const parent = useSegments(showChanges ? revision.parentRevisionId : undefined);
  const located = useLocatedSegment(revision.id);
  const reader = useRef<VirtualRowsHandle>(null);
  const menuTarget = useSentenceMenu<HTMLDivElement>((segmentId) => segments.data?.find((segment) => segment.id === segmentId), { explainSentence: false });
  const notesUi = useOptionalNotesUi();
  const notes = useContentNotes(page.content.id, revision.id);
  const pinned = useDragPin();

  const proofread = useMutation({
    mutationFn: () =>
      client.post(`/api/contents/${encodeURIComponent(page.content.id)}/transcript/proofread`, taskAcceptedDtoSchema, {
        body: settings.data?.defaultModelRef === undefined ? {} : { modelRef: settings.data.defaultModelRef },
        idempotent: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.latestTask(page.content.id) });
    },
  });

  const list = segments.data ?? [];
  const currentChapters = chapters.data?.current;
  const rows = useMemo(() => readerRows(list, currentChapters?.chapters ?? []), [list, currentChapters]);
  // The outline lists the headings the reader actually shows, so every entry has a row to scroll to.
  const outline = useMemo(() => rows.flatMap((row, index) => (row.kind === "chapter" ? [{ index, startMs: row.startMs, title: row.title }] : [])), [rows]);
  const changes = useMemo(
    () => (showChanges && parent.data !== undefined ? changedSegments(revision, list, parent.data) : new Map<string, "ai" | "user">()),
    [showChanges, parent.data, revision, list],
  );
  const noteItems = notes.data?.items;
  const placed = useMemo(() => notesBySegment(noteItems ?? [], list), [noteItems, list]);
  const unmapped = noteItems?.filter((note) => note.view === null).length ?? 0;
  const notesLink = `/notes?contentId=${encodeURIComponent(page.content.id)}`;
  const current = capabilities.timeTracking === "supported" ? segmentAt(list, time) : undefined;
  const targetIndex =
    located.segmentId === undefined ? undefined : rows.findIndex((row) => row.kind === "paragraph" && row.paragraph.segments.some((s) => s.id === located.segmentId));
  const configured = (providers.data?.items.length ?? 0) > 0;
  const proofreadLabel = revision.kind === "corrected" ? t("contentView.transcript.reproofread") : t("contentView.transcript.proofread");
  // Only a reproofread whose parent is the current version becomes current by itself; any other version needs the user.
  const setPrimary = useMutation({
    mutationFn: () =>
      client.put(`/api/contents/${encodeURIComponent(page.content.id)}/primary-transcript`, contentDtoSchema, { body: { revisionId: revision.id } }),
    onSuccess: async () => {
      // Every output of this Content judges its freshness against the current version, and search indexes it.
      await queryClient.invalidateQueries({ queryKey: queryKeys.content(page.content.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      await queryClient.invalidateQueries({ queryKey: searchKeys.all });
    },
  });
  // An archived revision has to be restored before it can be current.
  const canSetPrimary = revision.id !== props.primaryId && revision.kind !== "translated" && !revision.archived;

  // 定位原文 from a detached note popover: scroll this reader to the sentence when it shows that revision.
  useEffect(
    () =>
      notesUi?.registerLocator((revisionId, segmentId) => {
        if (revisionId !== revision.id) return false;
        const index = rows.findIndex((row) => row.kind === "paragraph" && row.paragraph.segments.some((s) => s.id === segmentId));
        if (index < 0) return false;
        reader.current?.scrollToIndex(index);
        return true;
      }),
    [notesUi, revision.id, rows],
  );
  const onOpenNotes = (segmentId: string, noteIds: string[]): void => {
    notesUi?.openView({ noteIds, segmentId, revisionId: revision.id });
  };

  const onSentence = (segment: TranscriptSegmentDto): void => {
    page.select({ revisionId: revision.id, segmentId: segment.id }, segment.startMs);
  };
  // A heading seeks to the first sentence under it, so the selection lands on a real sentence.
  const onSeekHeading = (index: number): void => {
    const next = rows[index + 1];
    const first = next?.kind === "paragraph" ? next.paragraph.segments[0] : undefined;
    if (first !== undefined) onSentence(first);
  };

  return (
    <div ref={menuTarget} className="flex h-full min-h-0 flex-col" data-revision-id={revision.id} data-explainable data-notes>
      <AsrBanner contentId={page.content.id} revisions={props.readable} primaryId={props.primaryId} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <select
          aria-label={t("contentView.transcript.version")}
          className="h-7 max-w-80 rounded border border-line bg-surface px-1 text-xs"
          value={revision.id}
          onChange={(event) => props.onPick(event.target.value)}
          title={revisionBasis(revision, props.readable, t)}
          data-testid="transcript-version"
        >
          {props.revisions.map((item) => (
            <option key={item.id} value={item.id} title={revisionBasis(item, props.readable, t)}>
              {revisionLabel(item, props.primaryId, t, undefined, props.readable)}
            </option>
          ))}
        </select>
        <RevisionActions contentId={page.content.id} revision={revision} revisions={props.readable} primaryId={props.primaryId} onDeleted={props.onDeleted} />
        <RevisionToggleBar toggles={props.toggles} />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={showChanges} disabled={revision.parentRevisionId === undefined} onChange={(event) => setShowChanges(event.target.checked)} />
          {t("contentView.transcript.showChanges")}
        </label>
        {canSetPrimary ? (
          <Button size="sm" variant="ghost" disabled={setPrimary.isPending} onClick={() => setPrimary.mutate()} data-testid="transcript-set-primary">
            <CheckCircle2 size={14} />
            {t("contentView.transcript.setPrimary")}
          </Button>
        ) : null}
        {configured ? (
          <Button size="sm" disabled={proofread.isPending} onClick={() => proofread.mutate()} data-testid="proofread">
            <Sparkles size={14} />
            {proofreadLabel}
          </Button>
        ) : (
          <Button size="sm" disabled title={t("contentView.summary.needsModel")}>
            {proofreadLabel}
          </Button>
        )}
        <ChapterOutline entries={outline} onPick={(index) => reader.current?.scrollToIndex(index, "start")} />
        <Button size="sm" variant="ghost" onClick={props.onEdit} disabled={segments.data === undefined || revision.archived}>
          <Pencil size={14} />
          {t("common.action.edit")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyText(readingText(rows))}>
          <Copy size={14} />
          {t("common.action.copy")}
        </Button>
        <Link
          to={notesLink}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap hover:bg-sunken"
          data-testid="transcript-notes-link"
        >
          <NotebookPen size={14} />
          {t("notes.transcript.link", { count: noteItems?.length ?? 0 })}
        </Link>
      </div>
      {notes.isError ? (
        <p className="px-4 pt-2 text-xs text-muted" data-testid="transcript-notes-failed">
          {t("notes.transcript.loadFailed")}
          {" · "}
          <button type="button" className="text-accent hover:underline" onClick={() => void notes.refetch()}>
            {t("common.action.retry")}
          </button>
        </p>
      ) : null}
      {unmapped > 0 ? (
        <p className="px-4 pt-2 text-xs text-muted" data-testid="transcript-notes-unmapped">
          {t("notes.transcript.unmapped", { count: unmapped })}
          {" · "}
          <Link to={notesLink} className="text-accent hover:underline">
            {t("notes.transcript.viewUnmapped")}
          </Link>
        </p>
      ) : null}
      {showChanges ? (
        <div className="flex gap-3 px-4 pt-2 text-xs text-muted">
          <span className="rounded bg-sky-500/15 px-1">{t("contentView.transcript.changeAi")}</span>
          <span className="rounded bg-emerald-500/15 px-1">{t("contentView.transcript.changeUser")}</span>
        </div>
      ) : null}
      {props.missing ? <p className="px-4 pt-2 text-xs text-muted" data-testid="revision-missing">{t("contentView.revisions.missing")}</p> : null}
      {located.unmatched ? <p className="px-4 pt-2 text-xs text-muted" data-testid="locate-unmatched">{t("contentView.locate.unmatched")}</p> : null}
      {currentChapters?.stale === true ? (
        <p className="px-4 pt-2 text-xs text-muted" data-testid="transcript-chapters-stale">
          {t("contentView.chapters.stale")}
        </p>
      ) : null}
      {proofread.error instanceof ApiError ? <div className="px-4 pt-2"><ErrorView error={proofread.error.error} /></div> : null}
      {setPrimary.error instanceof ApiError ? <div className="px-4 pt-2"><ErrorView error={setPrimary.error.error} /></div> : null}
      {segments.isPending ? (
        <Loading />
      ) : (
        <div className="relative min-h-0 flex-1" onMouseDown={pinned.start}>
          <VirtualRows
            ref={reader}
            className="absolute inset-0 px-4 py-2"
            testId="transcript-reader"
            items={rows}
            keyOf={rowKey}
            estimateSize={96}
            scrollToIndex={targetIndex}
            pinnedIndex={pinned.index}
            render={(row, index) =>
              row.kind === "chapter" ? (
                <ChapterHeading startMs={row.startMs} title={row.title} onSeek={() => onSeekHeading(index)} />
              ) : (
                <ParagraphView
                  paragraph={row.paragraph}
                  selectedId={located.segmentId}
                  currentId={current?.id}
                  changes={changes}
                  search={props.search}
                  notes={placed}
                  onOpenNotes={onOpenNotes}
                  onSeekParagraph={() => {
                    const first = row.paragraph.segments[0];
                    if (first !== undefined) onSentence(first);
                  }}
                  onSentence={onSentence}
                />
              )
            }
          />
          {rows.length > 0 ? (
            <div className="absolute right-6 bottom-4 flex flex-col gap-2">
              <ReaderJump label={t("contentView.transcript.toTop")} onClick={() => reader.current?.scrollToTop()} testId="reader-to-top">
                <ChevronsUp size={16} />
              </ReaderJump>
              <ReaderJump label={t("contentView.transcript.toBottom")} onClick={() => reader.current?.scrollToBottom()} testId="reader-to-bottom">
                <ChevronsDown size={16} />
              </ReaderJump>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A round button floating over the reader's corner; translucent so it hides little text. */
function ReaderJump(props: { label: string; onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface/90 text-muted shadow hover:bg-sunken hover:text-ink"
      onClick={props.onClick}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

/** Chapters without a sentence are dropped before this, so a start time names one heading. */
function rowKey(row: ReaderRow): string {
  return row.kind === "chapter" ? `chapter:${row.startMs}` : (row.paragraph.segments[0]?.id ?? String(row.paragraph.startMs));
}

/** What the copy button takes: the view as read, headings on their own line, blocks a blank line apart. */
function readingText(rows: readonly ReaderRow[]): string {
  return rows
    .map((row) => (row.kind === "chapter" ? row.title : joinReading(row.paragraph.segments.map((s) => s.text), row.paragraph.segments.some(isMarked))))
    .join("\n\n");
}

/** A chapter start inside the reading view: a boundary above paragraphs, named and seekable. */
function ChapterHeading(props: { startMs: number; title: string; onSeek: () => void }) {
  return (
    <h3 className="flex items-baseline gap-2 pt-4 pb-1 text-sm font-semibold" data-testid="transcript-chapter">
      <button type="button" className="font-mono text-xs font-normal text-accent hover:underline" data-reading-time onClick={props.onSeek}>
        {formatDuration(props.startMs)}
      </button>
      <span>{props.title}</span>
    </h3>
  );
}

function ParagraphView(props: {
  paragraph: Paragraph;
  selectedId: string | undefined;
  currentId: string | undefined;
  changes: Map<string, "ai" | "user">;
  search: string;
  notes: ReadonlyMap<string, SentenceNote[]>;
  onOpenNotes: (segmentId: string, noteIds: string[]) => void;
  onSeekParagraph: () => void;
  onSentence: (segment: TranscriptSegmentDto) => void;
}) {
  return (
    <p className="py-2 text-sm leading-7">
      <button type="button" className="mr-2 font-mono text-xs text-accent hover:underline" data-reading-time onClick={props.onSeekParagraph}>
        {formatDuration(props.paragraph.startMs)}
      </button>
      {props.paragraph.segments.map((segment, index) => {
        const change = props.changes.get(segment.id);
        const marks = [
          segment.id === props.selectedId ? "bg-accent-soft ring-1 ring-accent/50" : "",
          segment.id === props.currentId ? "underline decoration-accent decoration-2" : "",
          change === "ai" ? "bg-sky-500/15" : change === "user" ? "bg-emerald-500/15" : "",
        ].join(" ");
        // The separator is a bare text node so it is neither clickable nor marked as changed.
        const previous = index === 0 ? undefined : props.paragraph.segments[index - 1];
        return (
          <Fragment key={segment.id}>
            {previous === undefined ? null : readingSeparator(previous.text, segment.text, isMarked(previous))}
            <span
              data-segment-id={segment.id}
              {...(segment.id === props.currentId ? { "data-testid": "current-sentence" } : {})}
              {...(segment.id === props.selectedId ? { "aria-current": "true" as const } : {})}
              className={`cursor-pointer rounded hover:bg-sunken ${marks}`}
              onClick={() => {
                // The click that ends a drag selection is not a request to play from here.
                if (window.getSelection()?.isCollapsed === false) return;
                props.onSentence(segment);
              }}
            >
              <DecoratedText
                text={segment.text}
                notes={props.notes.get(segment.id) ?? []}
                search={props.search === "" ? [] : termRanges(segment.text, props.search)}
                onOpenNotes={(noteIds) => props.onOpenNotes(segment.id, noteIds)}
              />
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

/**
 * Keeps the row a drag selection started in mounted while the drag goes on: the
 * windowed reader auto-scrolls under a long drag and would otherwise unmount the row holding
 * the selection's anchor. The pin follows the selection's anchor node and is released on
 * mouseup, after the selection toolbar has taken its snapshot.
 */
function useDragPin(): { index: number | undefined; start: (event: MouseEvent<HTMLElement>) => void } {
  const [index, setIndex] = useState<number | undefined>(undefined);
  const release = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => release.current?.(), []);
  const start = (event: MouseEvent<HTMLElement>): void => {
    if (event.button !== 0 || !(event.target instanceof Node)) return;
    if (elementOf(event.target)?.closest("[data-row-index]") == null) return;
    release.current?.();
    const follow = (): void => {
      const anchor = window.getSelection()?.anchorNode;
      const row = anchor == null ? null : elementOf(anchor)?.closest<HTMLElement>("[data-row-index]");
      const value = row?.dataset["rowIndex"];
      if (value !== undefined) setIndex(Number(value));
    };
    const stop = (): void => {
      document.removeEventListener("selectionchange", follow);
      document.removeEventListener("mouseup", stop);
      release.current = undefined;
      setIndex(undefined);
    };
    document.addEventListener("selectionchange", follow);
    document.addEventListener("mouseup", stop);
    release.current = stop;
  };
  return { index, start };
}
