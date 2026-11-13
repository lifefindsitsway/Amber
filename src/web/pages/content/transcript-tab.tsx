import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronsDown, ChevronsUp, Copy, NotebookPen, Pencil, Sparkles } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { contentDtoSchema, type TranscriptRevisionDto, type TranscriptRevisionListItemDto } from "../../../shared/dto/content.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { isOnlyPunctuationChange } from "../../../shared/reading.ts";
import { speakerModeFor, speakerShares } from "../../../shared/speaker-turns.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useProviders, useSettings } from "../../api/queries.ts";
import { loadBundledFont } from "../../bundled-fonts.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { formatDuration } from "../../format.ts";
import { usePlayerCapabilities, usePlayerTime } from "../../player/player-controller.tsx";
import { searchKeys, termRanges } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { copyText } from "../../ui/clipboard.ts";
import { elementOf } from "../../ui/dom-selection.ts";
import { notesBySegment } from "../../notes/note-anchor.ts";
import { useOptionalNotesUi } from "../../notes/note-ui-context.tsx";
import { useContentNotes } from "../../notes/queries.ts";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { AsrBanner } from "./asr-banner.tsx";
import { ChapterOutline } from "./chapter-outline.tsx";
import { useContentPage } from "./content-context.tsx";
import {
  contentKeys,
  readableRevisions,
  revisionGroups,
  segmentsAt,
  useChapters,
  useRevisions,
  useSegments,
  visibleRevisions,
  type Paragraph,
} from "./content-data.ts";
import { DraftEditor } from "./draft-editor.tsx";
import { revisionLabel } from "./labels.ts";
import { READER_TEXT_ATTRIBUTE, useAppliedReaderFont } from "./reader-font.ts";
import { readerSections, readingText, readingTextWithSpeakers, viewRowKey, viewRows } from "./reader-rows.ts";
import { PARAGRAPH_GAP_EM, READER_COLUMN_CLASS, READER_INDENT_ATTRIBUTE, READER_SCROLLER_CLASS, readerBodyStyle, SentenceRuns, type SentenceViewProps } from "./reader-sentences.tsx";
import { useStickyTurn } from "./reader-sticky.ts";
import { READER_GUTTER, StickyTurnMarker, TurnParagraph, useIsNarrow, type TurnContext } from "./reader-turns.tsx";
import { ReaderTypographyPopover } from "./reader-typography-popover.tsx";
import { READER_TYPOGRAPHY_DEFAULTS, readerSideMargin, useReaderTypography, type ReaderTypography, type ReaderTypographyChange } from "./reader-typography.ts";
import { RevisionActions } from "./revision-actions-dialog.tsx";
import { revisionInfo } from "./revision-info.ts";
import { useLocatedSegment } from "./same-sentence.ts";
import type { ScrollAnchor } from "./scroll-anchor.ts";
import { isChineseLanguage } from "./sentence-editor.tsx";
import { useSentenceMenu } from "./sentence-menu.tsx";
import { SpeakersNotReadHint } from "./speaker-basis-notice.tsx";
import { filteredRowKey, filteredViewRows, rowIndexOfSegment, sentenceCounts, type FilteredRow } from "./speaker-filter.ts";
import { SpeakerFilterBar, SpeakerFilterButton, SpeakerFilterEmpty, SpeakerGap, useScrollToSegment, useSpeakerFilter } from "./speaker-filter-ui.tsx";
import { speakerLabel, useSpeakers } from "./speakers/speaker-data.ts";
import { SpeakerReviewControl } from "./speakers/review/speaker-review-panel.tsx";
import { ComparisonSummary } from "./speakers/compare/comparison-summary.tsx";
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
  // The ASR revision whose speakers the editor is to bring into the current text.
  const [applyFrom, setApplyFrom] = useState<string | undefined>(undefined);
  // The review panel's 「去编辑器查看」 opens the editor on the cross-recognition comparison.
  const [compareOnOpen, setCompareOnOpen] = useState(false);
  const applyParam = params.get("applySpeakers");
  // A link asking to apply speakers opens the editor on it, and is spent: the address does not keep asking.
  useEffect(() => {
    if (applyParam === null) return;
    setApplyFrom(applyParam);
    setEditing(true);
    const next = new URLSearchParams(params);
    next.delete("applySpeakers");
    setParams(next, { replace: true });
  }, [applyParam, params, setParams]);

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
    // Keyed by version: switching to another one closes this editor (keeping its last edits) and opens a fresh one.
    // Applying speakers always edits the current text: a newer ASR original being read is only the source of the speakers.
    const base = applyFrom === undefined ? revision : (readable.find((item) => item.id === primaryId) ?? revision);
    return (
      <DraftEditor
        key={base.id}
        base={base}
        primaryRevisionId={primaryId}
        {...(applyFrom === undefined ? {} : { applySpeakersFrom: applyFrom })}
        {...(compareOnOpen ? { openComparison: true } : {})}
        onClose={() => {
          setEditing(false);
          setApplyFrom(undefined);
          setCompareOnOpen(false);
        }}
      />
    );
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
      onEdit={() => {
        setApplyFrom(undefined);
        setEditing(true);
      }}
      onCompare={() => {
        setApplyFrom(undefined);
        setCompareOnOpen(true);
        setEditing(true);
      }}
      onApplySpeakers={(sourceRevisionId) => {
        setApplyFrom(sourceRevisionId);
        setEditing(true);
      }}
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

const COPY_ITEM_CLASS = "cursor-pointer rounded px-2 py-1.5 outline-none data-highlighted:bg-sunken";

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
  /** Opens the editor on the cross-recognition comparison of the shown revision. */
  onCompare: () => void;
  /** Opens the editor on the apply-speakers flow for the given ASR revision. */
  onApplySpeakers: (sourceRevisionId: string) => void;
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
  const notesUi = useOptionalNotesUi();
  const notes = useContentNotes(page.content.id, revision.id);
  const pinned = useDragPin();
  const [typography, setTypography, resetTypography] = useReaderTypography();
  // A font size, line height, font or layout change resizes every row: keep the first visible row where it was.
  // The anchor is taken just before the change and used by the very next commit; a change that
  // never lands (nothing differs, or the preference cannot be stored yet) must not leave it
  // behind to pull the view back later, so it is dropped once the change has had its turn.
  const anchorBeforeChange = useRef<ScrollAnchor | undefined>(undefined);
  const rememberAnchor = (): void => {
    anchorBeforeChange.current = reader.current?.anchor();
    setTimeout(() => {
      anchorBeforeChange.current = undefined;
    }, 0);
  };
  // The default font reads no font file; a bundled one is drawn only once it is registered. A
  // stored face read in the background (a restored page, a retry) resizes the rows when it is
  // drawn, just like a change made in the popover.
  const readerFont = useAppliedReaderFont(typography, client, { onBeforeApply: rememberAnchor });
  // The element the rows scroll in, as state: it only exists once the sentences have loaded.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const narrow = useIsNarrow(host);
  // The sentence the user last clicked to play: the primary highlight while it still covers the playing moment.
  const [pinnedId, setPinnedId] = useState<string | undefined>(undefined);
  const pinnedEntered = useRef(false);

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
  const noteItems = notes.data?.items;
  const placed = useMemo(() => notesBySegment(noteItems ?? [], list), [noteItems, list]);
  // Speakers are only asked for when a sentence names one, so a text without speakers costs no
  // request — unless the address filters by speaker, whose ids are checked against the list.
  const hasSpeakerSentences = useMemo(() => list.some((segment) => segment.speakerId !== undefined), [list]);
  const [urlParams] = useSearchParams();
  const speakers = useSpeakers(page.content.id, hasSpeakerSentences || urlParams.has("speaker"));
  const speakerList = speakers.data?.items;
  // Whether the revision is read by speakers is decided by its data; the user's switch only hides the turns.
  // Memoised: the player's time re-renders this view several times a second.
  const speakerMode = useMemo(() => hasSpeakerSentences && speakerList !== undefined && speakerModeFor(list, speakerList), [hasSpeakerSentences, list, speakerList]);
  const showTurns = speakerMode && typography.showSpeakers;
  const speakerById = useMemo(() => new Map((speakerList ?? []).map((speaker) => [speaker.id, speaker])), [speakerList]);
  const shares = useMemo(() => new Map(speakerShares(showTurns ? list : []).map((share) => [share.speakerId, share])), [showTurns, list]);
  const sections = useMemo(() => readerSections(list, currentChapters?.chapters ?? []), [list, currentChapters]);
  const rowOptions = useMemo(
    () => ({
      turns: showTurns,
      // A sentence with a note or a search hit needs room, which a compact turn does not give it.
      hasMarks: (segment: TranscriptSegmentDto) => (placed.get(segment.id)?.length ?? 0) > 0 || (props.search !== "" && termRanges(segment.text, props.search).length > 0),
    }),
    [showTurns, placed, props.search],
  );
  const rows = useMemo(() => viewRows(sections, rowOptions), [sections, rowOptions]);
  // 「只看」: the rows shown are the selected speakers' sentences with gap bars between them;
  // copying still takes the whole text.
  const filter = useSpeakerFilter(speakerList);
  const counts = useMemo(() => sentenceCounts(list), [list]);
  const filtered = useMemo(
    () => (filter.active ? filteredViewRows(list, currentChapters?.chapters ?? [], filter.selectedSet, rowOptions) : undefined),
    [filter.active, filter.selectedSet, list, currentChapters, rowOptions],
  );
  const shownRows: FilteredRow[] = filtered?.rows ?? rows;
  const scrollToRow = useCallback((index: number) => reader.current?.scrollToIndex(index, "start"), []);
  const returnTo = useScrollToSegment(shownRows, scrollToRow);
  // Scrolls to a sentence; one the filter hides brings the whole text back first.
  const locate = (segmentId: string): boolean => {
    const index = rowIndexOfSegment(shownRows, segmentId);
    if (index >= 0) {
      reader.current?.scrollToIndex(index);
      return true;
    }
    if (!filter.active || rowIndexOfSegment(rows, segmentId) < 0) return false;
    filter.clear();
    returnTo(segmentId);
    return true;
  };
  // The outline lists the headings the reader actually shows, so every entry has a row to scroll to.
  const outline = useMemo(() => shownRows.flatMap((row, index) => (row.kind === "chapter" ? [{ index, startMs: row.startMs, title: row.title }] : [])), [shownRows]);
  const changes = useMemo(
    () => (showChanges && parent.data !== undefined ? changedSegments(revision, list, parent.data) : new Map<string, "ai" | "user">()),
    [showChanges, parent.data, revision, list],
  );
  const unmapped = noteItems?.filter((note) => note.view === null).length ?? 0;
  const notesLink = `/notes?contentId=${encodeURIComponent(page.content.id)}`;
  const tracking = capabilities.timeTracking === "supported";
  const { primary: current, others: overlapping } = segmentsAt(list, tracking ? time : undefined, pinnedId);
  const overlapKey = overlapping.map((segment) => segment.id).join(",");
  const overlapIds = useMemo(() => new Set(overlapKey === "" ? [] : overlapKey.split(",")), [overlapKey]);
  const turnMarker = useStickyTurn(host, showTurns && !narrow, shownRows);

  // The pin ends when playback has been inside the sentence and then left it.
  useEffect(() => {
    if (pinnedId === undefined) return;
    const target = list.find((segment) => segment.id === pinnedId);
    const inside = target !== undefined && time !== undefined && target.startMs <= time && time < target.endMs;
    if (inside) pinnedEntered.current = true;
    else if (pinnedEntered.current) {
      pinnedEntered.current = false;
      setPinnedId(undefined);
    }
  }, [pinnedId, time, list]);

  const changeTypography = (change: ReaderTypographyChange): void => {
    const next = { ...typography, ...change };
    if (
      next.fontSize === typography.fontSize &&
      next.lineHeight === typography.lineHeight &&
      next.showSpeakers === typography.showSpeakers &&
      next.font === typography.font &&
      next.customFont === typography.customFont &&
      readerSideMargin(next) === readerSideMargin(typography)
    ) {
      return;
    }
    rememberAnchor();
    setTypography(change);
  };
  const resetReaderTypography = (): void => {
    const unchanged =
      typography.fontSize === READER_TYPOGRAPHY_DEFAULTS.fontSize &&
      typography.lineHeight === READER_TYPOGRAPHY_DEFAULTS.lineHeight &&
      typography.showSpeakers === READER_TYPOGRAPHY_DEFAULTS.showSpeakers &&
      typography.font === undefined &&
      typography.customFont === undefined &&
      readerSideMargin(typography) === readerSideMargin(READER_TYPOGRAPHY_DEFAULTS);
    if (!unchanged) rememberAnchor();
    resetTypography();
  };
  // Every commit consumes the anchor, but only one that really resized the rows puts it back: re-measuring
  // a windowed list for a commit that changed nothing would only make it jump.
  // The font drawn, not the one stored: a bundled face only resizes the rows once it is registered.
  const layoutKey = `${typography.fontSize} ${typography.lineHeight} ${readerSideMargin(typography)} ${showTurns} ${readerFont.key}`;
  const committedLayout = useRef(layoutKey);
  useLayoutEffect(() => {
    const anchor = anchorBeforeChange.current;
    anchorBeforeChange.current = undefined;
    const resized = committedLayout.current !== layoutKey;
    committedLayout.current = layoutKey;
    if (resized && anchor !== undefined) reader.current?.restoreAnchor(anchor);
  });

  const turnContext = useMemo<TurnContext>(
    () => ({ contentId: page.content.id, speakers: speakerById, shares, typography: { fontSize: typography.fontSize, lineHeight: typography.lineHeight }, narrow }),
    [page.content.id, speakerById, shares, typography.fontSize, typography.lineHeight, narrow],
  );
  // `名字：` (full-width colon for Chinese text) in front of a speaker's words; nothing for a speaker the list does not know.
  const speakerPrefix = (speakerId: string | undefined): string => {
    const speaker = speakerId === undefined ? undefined : speakerById.get(speakerId);
    if (speaker === undefined) return "";
    return t(isChineseLanguage(revision.language) ? "speakerReader.copy.prefixCjk" : "speakerReader.copy.prefixOther", { name: speakerLabel(t, speaker) });
  };
  const copyBody = (): void => void copyText(readingText(rows));
  const copyWithSpeakers = (): void => void copyText(readingTextWithSpeakers(sections, speakerPrefix));
  const targetIndex = located.segmentId === undefined ? undefined : rowIndexOfSegment(shownRows, located.segmentId);
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
  // Editing starts from loaded sentences of a revision that is not archived (the server refuses an archived base).
  const canEdit = segments.data !== undefined && !revision.archived;
  // An archived revision has to be restored before it can be current.
  const canSetPrimary = revision.id !== props.primaryId && revision.kind !== "translated" && !revision.archived;

  // 定位原文 from a detached note popover: scroll this reader to the sentence when it shows that revision.
  useEffect(
    () =>
      notesUi?.registerLocator((revisionId, segmentId) => revisionId === revision.id && locate(segmentId)),
    // `locate` is rebuilt every render; what it reads is listed instead.
    [notesUi, revision.id, rows, shownRows, filter.active],
  );
  const onOpenNotes = (segmentId: string, noteIds: string[]): void => {
    notesUi?.openView({ noteIds, segmentId, revisionId: revision.id });
  };

  const onSentence = (segment: TranscriptSegmentDto): void => {
    pinnedEntered.current = false;
    setPinnedId(segment.id);
    page.select({ revisionId: revision.id, segmentId: segment.id }, segment.startMs);
  };
  // A heading seeks to the first sentence under it, so the selection lands on a real sentence.
  const onSeekHeading = (index: number): void => {
    const next = shownRows[index + 1];
    const first = next?.kind === "paragraph" ? next.paragraph.segments[0] : undefined;
    if (first !== undefined) onSentence(first);
  };
  const menuTarget = useSentenceMenu<HTMLDivElement>((segmentId) => segments.data?.find((segment) => segment.id === segmentId), {
    explainSentence: false,
    // Playing from the menu is a click on the sentence: it leads the highlight while sentences overlap.
    onPlay: (segmentId) => {
      const segment = segments.data?.find((item) => item.id === segmentId);
      if (segment !== undefined) onSentence(segment);
    },
    ...(speakerMode ? { speakerPrefixOf: (segmentId: string) => speakerPrefix(segments.data?.find((segment) => segment.id === segmentId)?.speakerId) } : {}),
  });

  /** One row of the reader, before it is set in the reading column. */
  const renderRow = (row: (typeof shownRows)[number], index: number): ReactNode => {
    if (row.kind === "gap")
      return (
        <SpeakerGap
          gap={row}
          onReturn={(segmentId) => {
            filter.clear();
            returnTo(segmentId);
          }}
        />
      );
    if (row.kind === "chapter") return <ChapterHeading startMs={row.startMs} title={row.title} onSeek={() => onSeekHeading(index)} />;
    const sentences: SentenceViewProps = {
      selectedId: located.segmentId,
      currentId: current?.id,
      overlapIds,
      changes,
      search: props.search,
      notes: placed,
      onOpenNotes,
      onSentence,
    };
    const onSeekParagraph = (): void => {
      const first = row.paragraph.segments[0];
      if (first !== undefined) onSentence(first);
    };
    return row.turn === undefined ? (
      <ParagraphView {...sentences} paragraph={row.paragraph} typography={typography} onSeekParagraph={onSeekParagraph} />
    ) : (
      <TurnParagraph {...sentences} context={turnContext} paragraph={row.paragraph} turn={row.turn} onSeekParagraph={onSeekParagraph} />
    );
  };

  return (
    <div ref={menuTarget} className="flex h-full min-h-0 flex-col" data-revision-id={revision.id} data-explainable data-notes>
      <AsrBanner contentId={page.content.id} revisions={props.readable} primaryId={props.primaryId} onApplySpeakers={props.onApplySpeakers} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <select
          aria-label={t("contentView.transcript.version")}
          className="h-7 max-w-80 rounded border border-line bg-surface px-1 text-xs"
          value={revision.id}
          onChange={(event) => props.onPick(event.target.value)}
          title={revisionInfo(revision, props.readable, t)}
          data-testid="transcript-version"
        >
          {props.revisions.map((item) => (
            <option key={item.id} value={item.id} title={revisionInfo(item, props.readable, t)}>
              {revisionLabel(item, props.primaryId, t, undefined, props.readable)}
            </option>
          ))}
        </select>
        <SpeakerReviewControl
          contentId={page.content.id}
          revisionId={revision.id}
          speakerMode={speakerMode}
          speakersConfirmedAt={revision.speakersConfirmedAt}
          sentences={segments.data}
          onLocate={(segmentId) => void locate(segmentId)}
          crossCheck={<ComparisonSummary revisionId={revision.id} revisions={props.readable} onOpenEditor={canEdit ? props.onCompare : undefined} />}
        />
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
        {configured ? <SpeakersNotReadHint contentId={page.content.id} revisionId={props.primaryId} testId="proofread-speakers-not-read" /> : null}
        <ChapterOutline entries={outline} onPick={(index) => reader.current?.scrollToIndex(index, "start")} />
        <Button size="sm" variant="ghost" onClick={props.onEdit} disabled={!canEdit}>
          <Pencil size={14} />
          {t("common.action.edit")}
        </Button>
        {speakerMode ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" variant="ghost" data-testid="transcript-copy">
                <Copy size={14} />
                {t("speakerReader.copy.menu")}
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-44 rounded-md border border-line bg-surface p-1 text-sm shadow-lg">
                <DropdownMenu.Item className={COPY_ITEM_CLASS} onSelect={copyBody} data-testid="transcript-copy-body">
                  {t("speakerReader.copy.body")}
                </DropdownMenu.Item>
                <DropdownMenu.Item className={COPY_ITEM_CLASS} onSelect={copyWithSpeakers} data-testid="transcript-copy-speakers">
                  {t("speakerReader.copy.withSpeakers")}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : (
          <Button size="sm" variant="ghost" onClick={copyBody} data-testid="transcript-copy">
            <Copy size={14} />
            {t("common.action.copy")}
          </Button>
        )}
        {speakerMode ? (
          <SpeakerFilterButton contentId={page.content.id} speakers={speakerList ?? []} counts={counts} selected={filter.selected} onChange={filter.set} />
        ) : null}
        <ReaderTypographyPopover
          value={typography}
          speakerMode={speakerMode}
          fontUnavailable={readerFont.failed}
          fontLoading={readerFont.loading}
          onRetryFont={readerFont.retry}
          loadFont={(face) => loadBundledFont(client, face)}
          onChange={changeTypography}
          onReset={resetReaderTypography}
        />
        <Link
          to={notesLink}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap hover:bg-sunken"
          data-testid="transcript-notes-link"
        >
          <NotebookPen size={14} />
          {t("notes.transcript.link", { count: noteItems?.length ?? 0 })}
        </Link>
      </div>
      {filtered === undefined ? null : <SpeakerFilterBar speakers={speakerList ?? []} selected={filter.selected} turns={filtered.turns} onClear={filter.clear} />}
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
      {segments.isPending || (hasSpeakerSentences && speakers.isPending) ? (
        <Loading />
      ) : filtered !== undefined && filtered.sentences === 0 ? (
        <SpeakerFilterEmpty onClear={filter.clear} />
      ) : (
        <div
          ref={setHost}
          className="relative min-h-0 flex-1"
          onMouseDown={pinned.start}
          {...readerFont.hostProps}
          style={{
            ...readerFont.hostProps.style,
            // Read by the reading column and by the sticky marker's copy of it.
            "--reader-font-size": `${typography.fontSize}px`,
            "--reader-gutter": showTurns && !narrow ? READER_GUTTER : "0px",
            "--reader-margin": `${readerSideMargin(typography)}px`,
          } as CSSProperties}
        >
          <VirtualRows
            ref={reader}
            className={`absolute inset-0 ${READER_SCROLLER_CLASS}`}
            testId="transcript-reader"
            items={shownRows}
            keyOf={(row) => filteredRowKey(row, viewRowKey)}
            estimateSize={96}
            scrollToIndex={targetIndex}
            pinnedIndex={pinned.index}
            render={(row, index) => (
              // Every row sits in the reading column; a chapter heading indents to the text's edge.
              <div className={READER_COLUMN_CLASS} {...(row.kind === "chapter" ? { [READER_INDENT_ATTRIBUTE]: "" } : {})}>
                {renderRow(row, index)}
              </div>
            )}
          />
          {showTurns && !narrow ? <StickyTurnMarker contentId={page.content.id} speakers={speakerById} turn={turnMarker} typography={typography} /> : null}
          {shownRows.length > 0 ? (
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

/** A paragraph of the plain reading view (no speaker turns): its time, then its sentences run on. */
function ParagraphView(props: SentenceViewProps & { paragraph: Paragraph; typography: Pick<ReaderTypography, "fontSize" | "lineHeight">; onSeekParagraph: () => void }) {
  return (
    <p
      className="break-words"
      {...{ [READER_TEXT_ATTRIBUTE]: "" }}
      style={{ ...readerBodyStyle(props.typography), paddingBottom: `${PARAGRAPH_GAP_EM}em` }}
    >
      <button type="button" className="mr-2 font-mono text-xs text-accent hover:underline" data-reading-time onClick={props.onSeekParagraph}>
        {formatDuration(props.paragraph.startMs)}
      </button>
      <SentenceRuns {...props} segments={props.paragraph.segments} />
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
