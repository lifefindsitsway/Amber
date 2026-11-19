import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Copy, NotebookPen, Pencil, Sparkles } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { contentDtoSchema, type TranscriptRevisionDto, type TranscriptRevisionListDto, type TranscriptRevisionListItemDto } from "../../../shared/dto/content.ts";
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
import { searchKeys } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { copyText } from "../../ui/clipboard.ts";
import { notesBySegment } from "../../notes/note-anchor.ts";
import { useOptionalNotesUi } from "../../notes/note-ui-context.tsx";
import { useContentNotes } from "../../notes/queries.ts";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { AsrBanner } from "./asr-banner.tsx";
import { ChapterOutline } from "./chapter-outline.tsx";
import { useContentPage } from "./content-context.tsx";
import {
  contentKeys,
  fetchAllSegments,
  pickShownRevision,
  readableRevisions,
  revisionGroups,
  segmentsAt,
  useChapters,
  useRevisions,
  useSegments,
  visibleRevisions,
  type Paragraph,
} from "./content-data.ts";
import { DraftEditor, type SpeakerIntent } from "./draft-editor.tsx";
import { FigureInsertMenu } from "./figure-insert-menu.tsx";
import { useReaderFigureRows, useTextRowsHandle } from "./figure-reader.tsx";
import { FigureRowProvider, FigureRowView } from "./figure-row.tsx";
import { RETURN_RESTORE_ATTRIBUTE, type EditorCloseResult, type EditTarget, type ReturnPosition, type ReturnRestoreOutcome, type SentenceRef } from "./edit-position.ts";
import { revisionLabel } from "./labels.ts";
import { READER_TEXT_ATTRIBUTE, useAppliedReaderFont } from "./reader-font.ts";
import { captureEditEntry, mapAfterCommit, nearestByTime, nearestShownSentence } from "./reader-return.ts";
import { readerSections, readingText, readingTextWithSpeakers, viewRowKey, viewRows } from "./reader-rows.ts";
import { ChapterHeading } from "./reader-chapter.tsx";
import { ReaderJumpButtons } from "./reader-jump.tsx";
import { useReaderLocate } from "./reader-locate.ts";
import { useReaderSelection } from "./reader-selection-controller.ts";
import { selectionRows } from "./reader-selection.ts";
import { PARAGRAPH_GAP_EM, READER_COLUMN_CLASS, READER_INDENT_ATTRIBUTE, READER_SCROLLER_CLASS, ReaderTime, readerBodyStyle, SentenceRuns, type SentenceViewProps } from "./reader-sentences.tsx";
import { stickyMetrics, useStickyTurn } from "./reader-sticky.ts";
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
import { SpeakerFilterBar, SpeakerFilterButton, SpeakerFilterEmpty, SpeakerGap, useScrollToSegment, useSkippedText, useSpeakerFilter } from "./speaker-filter-ui.tsx";
import { speakerLabel, useSpeakers } from "./speakers/speaker-data.ts";
import { SpeakerReviewControl } from "./speakers/review/speaker-review-panel.tsx";
import { LabelSpeakersButton } from "./speakers/label-speakers-button.tsx";
import { ComparisonSummary } from "./speakers/compare/comparison-summary.tsx";
import { TranscriptEmptyState } from "./transcript-empty-state.tsx";
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

/**
 * An editing session opened with 「编辑」: the sentence the editor opens on, the reader's screen
 * to come back to, and the selected sentence's times (to follow it into a committed revision).
 */
export interface EditSession {
  target: EditTarget | undefined;
  back: ReturnPosition;
  selected: SentenceRef | undefined;
}

/**
 * What the reader does once when it mounts again after the editor closed. Every kind carries
 * the page's navigation count at the time editing started: a later navigation cancels it.
 */
export type ReaderReturn =
  /** The same revision: the screen comes back to the pixel, or by its top sentence when that row is gone. */
  | { kind: "anchor"; back: ReturnPosition }
  /** A known sentence of the shown revision, put at `offset` below the reader's top. */
  | { kind: "segment"; navigation: number; segmentId: string; offset: number; approximate: boolean }
  /** Another revision than the one left: the sentence nearest in time to `ref`. */
  | { kind: "time"; navigation: number; ref: SentenceRef; offset: number }
  /** Nothing to come back to. */
  | { kind: "none"; navigation: number };

const returnNavigation = (plan: ReaderReturn): number => (plan.kind === "anchor" ? plan.back.navigation : plan.navigation);

/** The editor closed and the reader waits for what to show: a commit, or a reload after the primary changed. */
interface Transition {
  result: Extract<EditorCloseResult, { kind: "committed" | "reload" }>;
  session: EditSession | undefined;
  /** The page's navigation count when the editor closed. */
  navigation: number;
  error?: unknown;
  /**
   * Everything is read and the address has been asked to change: the reader comes back once
   * the address names `revision` (the router applies address changes as a transition, after
   * the selection), so it never renders the new selection over the old revision.
   */
  settled?: { revision: string | null; plan: ReaderReturn | undefined; noCentring: { navigation: number; revisionId: string } | undefined };
}

/** 原文细读 tab: version picker, paragraph reading, change marks, Draft → Commit. */
export function TranscriptTab() {
  const { t } = useTranslation();
  const page = useContentPage();
  const client = useApi();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const revisions = useRevisions(page.content.id);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // The ASR revision whose speakers the editor is to bring into the current text.
  const [applyFrom, setApplyFrom] = useState<string | undefined>(undefined);
  // The review panel's 「去编辑器查看」 opens the editor on the cross-recognition comparison.
  const [compareOnOpen, setCompareOnOpen] = useState(false);
  // What a speaker entry of the reader asks the editor to open once it is in place.
  const [speakerIntent, setSpeakerIntent] = useState<SpeakerIntent | undefined>(undefined);
  // The 「编辑」 session, taken on the click and spent when the editor closes.
  const session = useRef<EditSession | undefined>(undefined);
  const [transition, setTransition] = useState<Transition | undefined>(undefined);
  const [returnPlan, setReturnPlan] = useState<ReaderReturn | undefined>(undefined);
  // Back from the editor, the reader does not centre the selected sentence until the user
  // navigates again: it shows the screen the user had instead.
  const [noCentring, setNoCentring] = useState<{ navigation: number; revisionId: string } | undefined>(undefined);
  // The page as it is now, for the steps that finish after a request.
  const pageNow = useRef(page);
  pageNow.current = page;
  const applyParam = params.get("applySpeakers");
  // A link asking to apply speakers opens the editor on it, and is spent: the address does not keep asking.
  useEffect(() => {
    if (applyParam === null) return;
    session.current = undefined;
    setApplyFrom(applyParam);
    setEditing(true);
    const next = new URLSearchParams(params);
    next.delete("applySpeakers");
    setParams(next, { replace: true });
  }, [applyParam, params, setParams]);

  /**
   * After a commit or a reload, reads the revision list (and a committed revision's sentences)
   * before the reader comes back, then moves the address, the selection and the reader's return
   * in one step: the reader never renders the new text with the old selection, nor the old text.
   */
  const finish = async (pending: Transition): Promise<void> => {
    setTransition({ ...pending, error: undefined });
    try {
      const listed = await revisions.refetch();
      if (listed.error !== null) throw listed.error;
      const list: TranscriptRevisionListDto | undefined = listed.data;
      if (list === undefined) throw new Error("revision list unavailable");
      const now = pageNow.current;
      // A navigation during editing is the user's: their selection stays and nothing is restored.
      const undisturbed = now.navigation === (pending.session?.back.navigation ?? pending.navigation);
      const known = (revisionId: string): boolean => list.revisions.some((item) => item.id === revisionId);
      const keptSelection = now.selection !== undefined && known(now.selection.revisionId) ? now.selection : undefined;
      const back = pending.session?.back;
      if (pending.result.kind === "committed") {
        const result = pending.result;
        if (!known(result.revisionId)) throw new Error("committed revision not listed");
        const next = await queryClient.fetchQuery({
          queryKey: contentKeys.segments(result.revisionId),
          queryFn: ({ signal }) => fetchAllSegments(client, result.revisionId, signal),
          staleTime: Infinity,
        });
        let selection = keptSelection;
        const selected = pending.session?.selected;
        if (undisturbed && now.selection !== undefined && now.selection.revisionId === result.baseRevisionId) {
          const ref = selected !== undefined && selected.segmentId === now.selection.segmentId ? selected : sentenceRefOf(queryClient, now.selection);
          const mapped = ref === undefined ? undefined : mapAfterCommit({ committed: result.committed, next, ref });
          selection = mapped === undefined ? undefined : { revisionId: result.revisionId, segmentId: mapped.segmentId };
        }
        let plan: ReaderReturn | undefined;
        if (back !== undefined) {
          const top = back.top;
          const mapped = top === undefined ? undefined : mapAfterCommit({ committed: result.committed, next, ref: top });
          plan =
            top === undefined || mapped === undefined
              ? { kind: "none", navigation: back.navigation }
              : { kind: "segment", navigation: back.navigation, segmentId: mapped.segmentId, offset: top.offset, approximate: mapped.approximate };
        }
        // Shown as the current text when it is the primary; named in the address when another window's commit won.
        const revision = list.primaryTranscriptRevisionId === result.revisionId ? null : result.revisionId;
        now.switchRevision({ revision, selection });
        setTransition({ ...pending, settled: { revision, plan, noCentring: back === undefined ? undefined : { navigation: back.navigation, revisionId: result.revisionId } } });
      } else {
        const revision = new URLSearchParams(window.location.search).get("revision");
        const shown = shownRevisionId(list, revision);
        if (now.selection !== keptSelection) now.switchRevision({ revision, selection: undefined });
        let plan: ReaderReturn | undefined;
        if (back !== undefined) {
          plan =
            shown === back.revisionId
              ? { kind: "anchor", back }
              : back.top === undefined
                ? { kind: "none", navigation: back.navigation }
                : { kind: "time", navigation: back.navigation, ref: back.top, offset: back.top.offset };
        }
        setTransition({ ...pending, settled: { revision, plan, noCentring: back === undefined || shown === undefined ? undefined : { navigation: back.navigation, revisionId: shown } } });
      }
    } catch (error) {
      setTransition({ ...pending, error });
    }
  };

  // The address now names what the transition settled on: the reader may come back.
  const settled = transition?.settled;
  const addressed = settled !== undefined && params.get("revision") === settled.revision;
  useEffect(() => {
    if (settled === undefined || !addressed) return;
    setReturnPlan(settled.plan);
    setNoCentring(settled.noCentring);
    setTransition(undefined);
  }, [settled, addressed]);

  const onEditorClose = (result: EditorCloseResult): void => {
    const spent = session.current;
    session.current = undefined;
    setEditing(false);
    setApplyFrom(undefined);
    setCompareOnOpen(false);
    setSpeakerIntent(undefined);
    if (result.kind === "committed" || result.kind === "reload") {
      void finish({ result, session: spent, navigation: page.navigation });
      return;
    }
    setReturnPlan(spent === undefined ? undefined : { kind: "anchor", back: spent.back });
    setNoCentring(spent === undefined ? undefined : { navigation: spent.back.navigation, revisionId: spent.back.revisionId });
  };

  if (transition !== undefined) {
    // Never the old text meanwhile: it would be read as the result of the commit. Checked before
    // the list's own state: the list read failing here leaves the query in error, and only this
    // view offers the retry that finishes the return.
    return transition.error === undefined ? (
      <Loading />
    ) : (
      <div className="flex flex-col items-center gap-3 p-6" role="alert" data-testid="transcript-return-failed">
        {transition.error instanceof ApiError ? <ErrorView error={transition.error.error} /> : <p className="text-sm">{t("common.state.loadFailed")}</p>}
        <Button size="sm" onClick={() => void finish(transition)} data-testid="transcript-return-retry">
          {t("common.action.retry")}
        </Button>
      </div>
    );
  }
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
  const revision = pickShownRevision(readable, primaryId, requested);
  if (revision === undefined) {
    return <TranscriptEmptyState />;
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
    const target = applyFrom === undefined && !compareOnOpen ? session.current?.target : undefined;
    return (
      <DraftEditor
        key={base.id}
        base={base}
        primaryRevisionId={primaryId}
        {...(applyFrom === undefined ? {} : { applySpeakersFrom: applyFrom })}
        {...(compareOnOpen ? { openComparison: true } : {})}
        {...(target === undefined ? {} : { initialTarget: target })}
        {...(speakerIntent === undefined || applyFrom !== undefined || compareOnOpen ? {} : { speakerIntent })}
        onClose={onEditorClose}
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
  const centring = noCentring === undefined || noCentring.revisionId !== revision.id || noCentring.navigation !== page.navigation;
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
      centring={centring}
      {...(returnPlan === undefined ? {} : { returnPlan })}
      onReturnTaken={() => setReturnPlan(undefined)}
      onEdit={(entry, intent) => {
        session.current = entry;
        setApplyFrom(undefined);
        setCompareOnOpen(false);
        setSpeakerIntent(intent);
        setEditing(true);
      }}
      onCompare={() => {
        session.current = undefined;
        setApplyFrom(undefined);
        setCompareOnOpen(true);
        setEditing(true);
      }}
      onApplySpeakers={(sourceRevisionId) => {
        session.current = undefined;
        setApplyFrom(sourceRevisionId);
        setEditing(true);
      }}
    />
  );
}

function shownRevisionId(list: TranscriptRevisionListDto, requested: string | null): string | undefined {
  return pickShownRevision(readableRevisions(list.revisions), list.primaryTranscriptRevisionId, requested)?.id;
}

/** A selected sentence's times, from the sentences already read. */
function sentenceRefOf(queryClient: ReturnType<typeof useQueryClient>, selection: { revisionId: string; segmentId: string }): SentenceRef | undefined {
  const sentence = queryClient.getQueryData<TranscriptSegmentDto[]>(contentKeys.segments(selection.revisionId))?.find((item) => item.id === selection.segmentId);
  return sentence === undefined ? undefined : { segmentId: sentence.id, startMs: sentence.startMs, endMs: sentence.endMs };
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
  /** 「编辑」, with where the editor is to open and where to come back to. */
  /** Opens the editor; `intent` when a speaker entry asked for it (what to open once it is in place). */
  onEdit: (entry: EditSession, intent?: SpeakerIntent) => void;
  /** Whether the selected sentence is centred when it changes; off right after coming back from the editor. */
  centring: boolean;
  /** Where to put the screen once the rows are ready, after the editor closed; taken once. */
  returnPlan?: ReaderReturn;
  /** The return plan has been taken: it must not be run again by a later mount. */
  onReturnTaken: () => void;
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
  // The list's own handle counts figure rows too; the reader's controls count text rows only and go through `reader`.
  const rawReader = useRef<VirtualRowsHandle>(null);
  const displayIndex = useRef<number[]>([]);
  const reader = useTextRowsHandle(rawReader, displayIndex);
  const notesUi = useOptionalNotesUi();
  const notes = useContentNotes(page.content.id, revision.id);
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
  const rowOptions = useMemo(() => ({ turns: showTurns }), [showTurns]);
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
  // The rows as text, for a selection: what it takes is written from these, not read off the
  // page, where a long text only has the rows near the viewport.
  const skippedText = useSkippedText();
  const selectionModels = useMemo(
    () =>
      selectionRows(shownRows, (row) => filteredRowKey(row, viewRowKey), {
        speaker: (turn) => {
          const speaker = turn.speakerId === undefined ? undefined : speakerById.get(turn.speakerId);
          return speaker === undefined ? { name: t("speakerIdentity.unassigned"), named: false } : { name: speakerLabel(t, speaker), named: true };
        },
        time: formatDuration,
        gap: (row) => t("speakerContext.filter.gap", { duration: skippedText(row.skippedMs) }),
      }),
    // `skippedText` is rebuilt every render and only depends on the language, like `t`.
    [shownRows, speakerById, t],
  );
  // Another revision, filter or speaker display is another view of the text: a selection does not carry over.
  const selection = useReaderSelection({
    revisionId: revision.id,
    viewKey: `${revision.id} ${filter.selected.join(",")} ${showTurns}`,
    rows: selectionModels,
    skipped: t("chat.selection.skipped"),
  });
  const scrollToRow = useCallback((index: number) => reader.current?.scrollToIndex(index, "start"), []);
  const returnTo = useScrollToSegment(shownRows, scrollToRow);
  // Scrolls to a sentence; one the filter hides brings the whole text back first.
  const locate = (segmentId: string): boolean => {
    locator.cancel();
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
  const turnMarker = useStickyTurn(host, showTurns && !narrow, shownRows, stickyMetrics(typography));
  const textRowKey = useCallback((row: FilteredRow) => filteredRowKey(row, viewRowKey), []);
  const readerScroller = useCallback(() => host?.querySelector<HTMLElement>('[data-testid="transcript-reader"]') ?? null, [host]);
  // Figures join the rows on screen only: selections, copying and notes keep reading `shownRows`.
  const figureRows = useReaderFigureRows({
    contentId: page.content.id,
    revisionId: revision.id,
    rows,
    shownRows,
    textKey: textRowKey,
    ready: segments.data !== undefined,
    filter: { active: filter.active, clear: filter.clear },
    raw: rawReader,
    displayIndex,
    host,
    scroller: readerScroller,
    segments: list,
    followingId: current?.id,
    tracking,
    time,
    speakers: speakerById,
    gutter: showTurns && !narrow,
    typography: { fontSize: typography.fontSize, lineHeight: typography.lineHeight, sideMargin: readerSideMargin(typography) },
  });

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
  // The return after editing (see below): its outcome, the plan still to run, and the one running.
  const [returnOutcome, setReturnOutcome] = useState<ReturnRestoreOutcome | undefined>(undefined);
  const pendingReturn = useRef(props.returnPlan);
  const returning = useRef<{ navigation: number; again: () => void } | undefined>(undefined);
  const { onReturnTaken } = props;
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
    if (!resized) return;
    // While the screen is still being brought back after editing, aim for that position again:
    // an anchor taken mid-way would settle on a spot the user never had.
    if (returning.current !== undefined) returning.current.again();
    else if (anchor !== undefined) reader.current?.restoreAnchor(anchor);
  });

  // Coming back from the editor: once, as soon as the rows are on screen. A filter that hides
  // every sentence leaves no rows; the return then waits until the filter is cleared.
  useLayoutEffect(() => {
    const plan = pendingReturn.current;
    // The list itself, not the text-row handle in front of it (which always exists): the return waits until the list is mounted.
    if (plan === undefined || rawReader.current === null || segments.data === undefined || shownRows.length === 0) return;
    pendingReturn.current = undefined;
    onReturnTaken();
    const navigation = returnNavigation(plan);
    const end = (outcome: ReturnRestoreOutcome): void => {
      returning.current = undefined;
      setReturnOutcome(outcome);
    };
    if (page.navigation !== navigation) {
      end("cancelled");
      return;
    }
    const sentences = segments.data;
    /** Puts a sentence of the shown revision at `offset`; one the filter hides gives way to the nearest shown one. */
    const toSentence = (segmentId: string, offset: number, approximate: boolean): void => {
      let id: string | undefined = segmentId;
      let near = approximate;
      if (rowIndexOfSegment(shownRows, segmentId) < 0) {
        const sentence = sentences.find((item) => item.id === segmentId);
        id = sentence === undefined ? undefined : nearestShownSentence(shownRows, sentence);
        near = true;
      }
      const index = id === undefined ? -1 : rowIndexOfSegment(shownRows, id);
      const row = shownRows[index];
      if (id === undefined || row === undefined) {
        end("unavailable");
        return;
      }
      const target = { rowKey: filteredRowKey(row, viewRowKey), segmentId: id, offset };
      const run = (): void =>
        reader.current?.restoreSegment(target, (result) => {
          if (result === "cancelled") end("cancelled");
          else if (result === "missing") end("unavailable");
          else end(near ? "approximate" : "exact");
        });
      returning.current = { navigation, again: run };
      run();
    };
    switch (plan.kind) {
      case "none":
        end("unavailable");
        return;
      case "segment":
        toSentence(plan.segmentId, plan.offset, plan.approximate);
        return;
      case "time": {
        const id = nearestByTime(sentences, plan.ref);
        if (id === undefined) end("unavailable");
        else toSentence(id, plan.offset, true);
        return;
      }
      case "anchor": {
        const { anchor, top } = plan.back;
        const byTop = (): void => {
          if (top === undefined) end("unavailable");
          else toSentence(top.segmentId, top.offset, false);
        };
        // The anchor may be a figure row: the list's rows, figures included, are what it is looked up in.
        if (anchor === undefined || !figureRows.rows.some((row) => figureRows.keyOf(row) === anchor.key)) {
          byTop();
          return;
        }
        const run = (): void =>
          reader.current?.restoreAnchor(anchor, (result) => {
            if (result === "cancelled") end("cancelled");
            else if (result === "missing") byTop();
            else end("exact");
          });
        returning.current = { navigation, again: run };
        run();
      }
    }
  });
  // A navigation while the screen is being brought back ends that: the user went somewhere.
  useEffect(() => {
    if (returning.current !== undefined && returning.current.navigation !== page.navigation) reader.current?.cancelRestore();
  }, [page.navigation]);
  // 「定位到播放位置」. It is a navigation of its own: the return after editing, still to run or
  // still correcting the position, is dropped first, so it cannot pull the view back later.
  const locator = useReaderLocate({
    reader,
    area: host,
    scroller: () => host?.querySelector<HTMLElement>('[data-testid="transcript-reader"]') ?? null,
    revisionId: revision.id,
    segments: list,
    tracking,
    time,
    pinnedId,
    rows: shownRows,
    rowKey: (row) => filteredRowKey(row, viewRowKey),
    filter: { active: filter.active, key: filter.selected.join(","), clear: filter.clear },
    navigation: page.navigation,
    onNavigate: () => {
      if (pendingReturn.current !== undefined) {
        pendingReturn.current = undefined;
        onReturnTaken();
        setReturnOutcome("cancelled");
      }
      if (returning.current !== undefined) {
        returning.current = undefined;
        reader.current?.cancelRestore();
        setReturnOutcome("cancelled");
      }
    },
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
  const selectionPins = selection.pinnedKeys;
  const figurePins = figureRows.pinnedKeys;
  const pinnedKeys = useMemo(() => (figurePins.length === 0 ? selectionPins : [...selectionPins, ...figurePins]), [selectionPins, figurePins]);
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
  /**
   * 「编辑」: notes the sentence to open the editor on and the screen to come back to. The speaker
   * entries go the same way and say what to open in the editor; 「更改发言人…」 names the sentence
   * it was asked on, which then is the target ahead of the playing one.
   */
  const startEdit = (intent?: SpeakerIntent): void => {
    const asked = intent?.kind === "menu" ? intent.segmentId : undefined;
    const scroller = host?.querySelector<HTMLElement>('[data-testid="transcript-reader"]') ?? null;
    const back: ReturnPosition = { revisionId: revision.id, anchor: undefined, top: undefined, navigation: page.navigation };
    const entry =
      scroller === null
        ? { target: undefined, back }
        : captureEditEntry(scroller, {
            revisionId: revision.id,
            navigation: page.navigation,
            segments: list,
            playback: asked === undefined && tracking && time !== undefined ? { known: true, currentId: current?.id } : { known: false },
            clickedId: asked ?? located.segmentId,
          });
    const picked = page.selection?.revisionId === revision.id ? list.find((segment) => segment.id === page.selection?.segmentId) : undefined;
    props.onEdit({ ...entry, selected: picked === undefined ? undefined : { segmentId: picked.id, startMs: picked.startMs, endMs: picked.endMs } }, intent);
  };
  const onOpenNotes = (segmentId: string, noteIds: string[]): void => {
    notesUi?.openView({ noteIds, segmentId, revisionId: revision.id });
  };

  const onSentence = (segment: TranscriptSegmentDto): void => {
    pinnedEntered.current = false;
    setPinnedId(segment.id);
    page.select({ revisionId: revision.id, segmentId: segment.id }, segment.startMs);
  };
  // A heading plays from the first sentence shown under it, before the next heading, so the selection
  // lands on a real sentence. With none shown (a filter hid them all) it has nothing to play.
  const headingSeek = (index: number): { ms: number; onSeek: () => void } | undefined => {
    for (const row of shownRows.slice(index + 1)) {
      if (row.kind === "chapter") return undefined;
      const first = row.kind === "paragraph" ? row.paragraph.segments[0] : undefined;
      if (first !== undefined) return { ms: first.startMs, onSeek: () => onSentence(first) };
    }
    return undefined;
  };
  const menuTarget = useSentenceMenu<HTMLDivElement>((segmentId) => segments.data?.find((segment) => segment.id === segmentId), {
    explainSentence: false,
    // Playing from the menu is a click on the sentence: it leads the highlight while sentences overlap.
    onPlay: (segmentId) => {
      const segment = segments.data?.find((item) => item.id === segmentId);
      if (segment !== undefined) onSentence(segment);
    },
    ...(speakerMode ? { speakerPrefixOf: (segmentId: string) => speakerPrefix(segments.data?.find((segment) => segment.id === segmentId)?.speakerId) } : {}),
    ...(canEdit && speakerMode ? { onChangeSpeaker: (segmentId: string) => startEdit({ kind: "menu", segmentId }) } : {}),
  });

  /** One row of the reader, before it is set in the reading column. */
  const renderRow = (row: (typeof figureRows.rows)[number], index: number): ReactNode => {
    if (row.kind === "figure") return <FigureRowView row={row} typography={typography} />;
    if (row.kind === "gap")
      return (
        <SpeakerGap
          gap={row}
          onReturn={(segmentId) => {
            locator.cancel();
            filter.clear();
            returnTo(segmentId);
          }}
        />
      );
    if (row.kind === "chapter") {
      // Headings play from the text rows under them, which figures do not count among.
      const seek = headingSeek(shownRows.indexOf(row));
      return <ChapterHeading title={row.title} first={index === 0} {...(seek === undefined ? {} : { seek })} />;
    }
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
    <div
      ref={menuTarget}
      className="flex h-full min-h-0 flex-col"
      data-revision-id={revision.id}
      data-explainable
      data-notes
      {...(returnOutcome === undefined ? {} : { [RETURN_RESTORE_ATTRIBUTE]: returnOutcome })}
    >
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
          {...(canEdit ? { onManageSpeakers: () => startEdit({ kind: "panel" }) } : {})}
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
        <FigureInsertMenu />
        <ChapterOutline
          entries={outline}
          onPick={(index) => {
            locator.cancel();
            reader.current?.scrollToIndex(index, "start");
          }}
        />
        <Button size="sm" variant="ghost" onClick={() => startEdit()} disabled={!canEdit} data-testid="transcript-edit">
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
        ) : canEdit ? (
          // Without speakers to read by, the same place offers to start labelling them.
          <LabelSpeakersButton onClick={() => startEdit({ kind: "panel" })} />
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
      {figureRows.missing ? (
        <p className="px-4 pt-2 text-xs text-muted" role="status" data-testid="figure-locate-missing">
          {t("figures.locate.missing")}
        </p>
      ) : null}
      {figureRows.loadFailed ? (
        <p className="px-4 pt-2 text-xs text-muted" data-testid="figures-load-failed">
          {t("figures.loadFailed")}
          {" · "}
          <button type="button" className="text-accent hover:underline" onClick={figureRows.retry}>
            {t("common.action.retry")}
          </button>
        </p>
      ) : null}
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
          onMouseDown={selection.onMouseDown}
          {...readerFont.hostProps}
          style={{
            ...readerFont.hostProps.style,
            // Read by the reading column and by the sticky marker's copy of it.
            "--reader-font-size": `${typography.fontSize}px`,
            "--reader-gutter": showTurns && !narrow ? READER_GUTTER : "0px",
            "--reader-margin": `${readerSideMargin(typography)}px`,
          } as CSSProperties}
        >
          <FigureRowProvider value={figureRows.controller}>
            <VirtualRows
              ref={rawReader}
              className={`absolute inset-0 ${READER_SCROLLER_CLASS}`}
              testId="transcript-reader"
              items={figureRows.rows}
              keyOf={figureRows.keyOf}
              estimateSize={figureRows.estimate}
              rowAttributes={figureRows.rowAttributes}
              scrollToIndex={props.centring && targetIndex !== undefined ? displayIndex.current[targetIndex] : undefined}
              // Centred when the selected sentence (or its row among the text rows) changes, not when figures move it down.
              scrollToToken={props.centring && targetIndex !== undefined ? `${located.segmentId ?? ""} ${targetIndex}` : undefined}
              windowCount={shownRows.length}
              pinnedKeys={pinnedKeys}
              scrollerRef={selection.scrollerRef}
              render={(row, index) => (
                // Every row sits in the reading column; a chapter heading, and a figure outside a turn, indent to the text's edge.
                <div className={READER_COLUMN_CLASS} {...(row.kind === "chapter" || (row.kind === "figure" && row.turn === undefined) ? { [READER_INDENT_ATTRIBUTE]: "" } : {})}>
                  {renderRow(row, index)}
                </div>
              )}
            />
          </FigureRowProvider>
          {figureRows.overlay}
          {showTurns && !narrow ? <StickyTurnMarker contentId={page.content.id} speakers={speakerById} turn={turnMarker} typography={typography} /> : null}
          {shownRows.length > 0 ? (
            <ReaderJumpButtons
              onTop={() => {
                locator.cancel();
                reader.current?.scrollToTop();
              }}
              onBottom={() => {
                locator.cancel();
                reader.current?.scrollToBottom();
              }}
              locate={locator.button}
            />
          ) : null}
        </div>
      )}
    </div>
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
      <ReaderTime startMs={props.paragraph.startMs} onSeek={props.onSeekParagraph} />
      <SentenceRuns {...props} segments={props.paragraph.segments} />
    </p>
  );
}
