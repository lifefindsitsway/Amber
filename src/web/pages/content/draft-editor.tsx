import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { GitCompare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { queryKeys } from "../../api/queries.ts";
import { transcriptRevisionDtoSchema, type TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { transcriptDraftDtoSchema, type TranscriptSegmentDto } from "../../../shared/dto/transcript.ts";
import { hasExplicitParagraphs, inheritedParagraphStarts } from "../../../shared/paragraph-marks.ts";
import type { ReadingChapter } from "../../../shared/reading.ts";
import type { SpeakerReviewResolution } from "../../../shared/speakers.ts";
import { ApiError } from "../../api/client.ts";
import { publishSpeakersChanged } from "../../api/content-events.ts";
import { useApi, useContentEvents } from "../../api/context.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { formatDuration } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ApplySpeakersDialog } from "./apply-speakers.tsx";
import { CommitReviewDialog } from "./commit-review-dialog.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, fetchAllSegments, useChapters, useRevisions } from "./content-data.ts";
import { ParagraphControl, ParagraphEditingProvider, useParagraphEditing } from "./paragraph-controls.tsx";
import { SpeakerLead } from "./speaker-column.tsx";
import { draftKey, type BaseSpeakers, type DraftSegment, type SpeakerFilter } from "./speaker-draft.ts";
import { FilterBar, SpeakerFilterMenu, SpeakerPanel, type SpeakerUndoGuard } from "./speaker-toolbar.tsx";
import { MissingSpeakerNotice } from "./speakers/missing-speaker-notice.tsx";
import { SplitControl } from "./split-sentence.tsx";
import { SpeakerEditingProvider, useSpeakerEditing } from "./use-speaker-editing.tsx";
import { useSpeakers, speakerLabel } from "./speakers/speaker-data.ts";
import { draftChangedVersion, useDraftSync } from "./use-draft-sync.ts";
import { isChineseLanguage, SentenceEditor, type SentenceEditorHandle } from "./sentence-editor.tsx";
import { KeepSpeakersConfirmed, keepSpeakersConfirmedField, useKeepSpeakersConfirmed } from "./speakers/review/keep-speakers-confirmed.tsx";
import { ComparisonView, type ComparisonFilter } from "./speakers/compare/comparison-view.tsx";
import { locateDraftTarget, type EditorCloseResult, type EditTarget, type InitialScroll, type InitialScrollOutcome } from "./edit-position.ts";
import { usePlayRange } from "../../player/player-controller.tsx";

export type { DraftSegment };

/**
 * What a speaker entry of the reading view asks the editor to open once the list is in place:
 * the speaker panel, or the speaker menu of one sentence (the one the entry was asked on).
 */
export type SpeakerIntent = { kind: "panel" } | { kind: "menu"; segmentId: string };

/**
 * Starts a draft from a revision: each sentence keeps its timing and points at its source,
 * and states its speaker (`null` = none), so a draft never depends on the source to say who
 * speaks. A revision with paragraph marks gives the draft explicit paragraphs from the start;
 * one without leaves the draft without, inheriting whatever its base has.
 */
export function draftFromSegments(
  segments: ReadonlyArray<{ id: string; startMs: number; endMs: number; text: string; speakerId?: string; paragraphStart?: boolean }>,
): DraftSegment[] {
  return segments.map((segment) => ({
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    sourceSegmentIds: [segment.id],
    speakerId: segment.speakerId ?? null,
    ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
  }));
}

/**
 * A saved draft without paragraph marks over a base that has them, given the marks a commit
 * would inherit, so the editor shows and edits the paragraphs the draft really has. Only in
 * memory: the server keeps the draft as it is until the user's next edit is saved. A draft with
 * marks, or over a base without them, is returned as it is.
 */
export function withInheritedParagraphs(draft: readonly DraftSegment[], base: readonly TranscriptSegmentDto[]): readonly DraftSegment[] {
  if (hasExplicitParagraphs(draft)) return draft;
  const marks = inheritedParagraphStarts(new Map(base.map((segment) => [segment.id, segment] as const)), draft);
  if (marks[0] === undefined) return draft;
  return draft.map((segment, index) => ({ ...segment, paragraphStart: marks[index] === true }));
}

interface LoadedDraft {
  baseRevisionId: string;
  version: number | null;
  segments: DraftSegment[];
  /** For a saved draft with sentences that do not state their speaker: who their sources have. */
  baseSpeakers: BaseSpeakers | undefined;
}

/** The Content's transcript draft as the editor starts from it: the saved one, else a new one from the base. */
async function loadDraft(client: ReturnType<typeof useApi>, queryClient: QueryClient, contentId: string, baseId: string): Promise<LoadedDraft> {
  try {
    const draft = await client.get(`/api/contents/${encodeURIComponent(contentId)}/transcript/draft`, transcriptDraftDtoSchema);
    // The draft's own base says what its sentences inherit. A revision never changes, so the
    // reading view's copy of it serves when it has one.
    const unstated = draft.segments.some((segment) => segment.speakerId === undefined);
    const base =
      unstated || !hasExplicitParagraphs(draft.segments)
        ? await queryClient.fetchQuery({ queryKey: contentKeys.segments(draft.baseRevisionId), queryFn: () => fetchAllSegments(client, draft.baseRevisionId), staleTime: Infinity })
        : undefined;
    // A draft saved before drafts stated speakers keeps its sentences as they are (the commit
    // reads the speaker of the first source); the editor needs those speakers only to show them.
    const baseSpeakers = unstated && base !== undefined ? new Map(base.map((segment) => [segment.id, segment.speakerId] as const)) : undefined;
    const segments = base === undefined ? draft.segments : [...withInheritedParagraphs(draft.segments, base)];
    return { baseRevisionId: draft.baseRevisionId, version: draft.version, segments, baseSpeakers };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { baseRevisionId: baseId, version: null, segments: draftFromSegments(await fetchAllSegments(client, baseId)), baseSpeakers: undefined };
    }
    throw error;
  }
}

const NO_SEGMENTS: readonly DraftSegment[] = [];
const segmentTime = (segment: DraftSegment): string => formatDuration(segment.startMs);

/** What 「完成」 sends beyond the expected primary: the choice for sentences still to confirm, when there were any. */
interface CommitInput {
  expected: string | undefined;
  review?: SpeakerReviewResolution;
  /** Ticked 「保持发言人已核对」: the new revision keeps the base's review. */
  speakersConfirmed?: true;
}

/**
 * Draft → Commit editing of the transcript: edits autosave to the Content's single transcript
 * draft; 「完成」 commits it as an immutable manual revision, which becomes the primary, only if
 * the primary is still the one seen when editing started. A changed primary is shown to the
 * user, never overwritten. Deleting a sentence of only fillers removes it from the draft.
 */
export function DraftEditor(props: {
  base: TranscriptRevisionDto;
  primaryRevisionId: string | undefined;
  /** Called once when the editor closes, with how it ended. */
  onClose: (result: EditorCloseResult) => void;
  /** The sentence (of the revision read when 「编辑」 was clicked) to open the editor on. */
  initialTarget?: EditTarget;
  /** Opens the apply-speakers flow on mount with this revision as the source. */
  applySpeakersFrom?: string;
  /** Opens the cross-recognition comparison on mount. */
  openComparison?: boolean;
  /** Told once how the list's opening went (see `SentenceEditorProps.onInitialScrollDone`). */
  onInitialScrollDone?: (outcome: InitialScrollOutcome | "none") => void;
  /**
   * Opens the speaker panel or a sentence's speaker menu once the list's opening scroll is done,
   * unless the user took over meanwhile (`cancelled`): the editor never pulls focus from them.
   */
  speakerIntent?: SpeakerIntent;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const events = useContentEvents();
  const page = useContentPage();
  const contentId = page.content.id;
  const draftUrl = `/api/contents/${encodeURIComponent(contentId)}/transcript/draft`;
  const [expectedPrimary, setExpectedPrimary] = useState(props.primaryRevisionId);
  const [segments, setSegments] = useState<readonly DraftSegment[] | undefined>(undefined);
  const [baseRevisionId, setBaseRevisionId] = useState(props.base.id);
  const [baseSpeakers, setBaseSpeakers] = useState<BaseSpeakers | undefined>(undefined);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  const [applyOpen, setApplyOpen] = useState(props.applySpeakersFrom !== undefined);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [comparing, setComparing] = useState(props.openComparison === true);
  const handleRef = useRef<SentenceEditorHandle<DraftSegment>>(null);
  /** The choice for unconfirmed sentences a commit was made with: a retry after a conflict repeats it. */
  const lastReview = useRef<SpeakerReviewResolution | undefined>(undefined);
  // The close is reported once: a late success of a request made before closing must not close it again.
  const closed = useRef(false);
  const { onClose } = props;
  const close = useCallback(
    (result: EditorCloseResult) => {
      if (closed.current) return;
      closed.current = true;
      onClose(result);
    },
    [onClose],
  );
  // Where the list opens: decided once, from the draft as loaded, never again while editing.
  const [initialScroll, setInitialScroll] = useState<InitialScroll | undefined>(undefined);

  const { sync, state } = useDraftSync<readonly DraftSegment[]>((value, expectedVersion) =>
    client.put(draftUrl, transcriptDraftDtoSchema, { body: { baseRevisionId, expectedVersion, segments: [...value] } }),
  );

  const initial = useQuery({
    queryKey: ["draft", contentId, props.base.id],
    queryFn: () => loadDraft(client, queryClient, contentId, props.base.id),
    staleTime: Infinity,
    gcTime: 0,
  });
  useEffect(() => {
    if (initial.data !== undefined && segments === undefined) {
      setSegments(initial.data.segments);
      setBaseRevisionId(initial.data.baseRevisionId);
      setBaseSpeakers(initial.data.baseSpeakers);
      sync.init(initial.data.segments, initial.data.version);
      const target = props.initialTarget;
      const index = target === undefined ? undefined : locateDraftTarget(initial.data.segments, target);
      if (target !== undefined && index !== undefined) setInitialScroll({ index, offset: target.offset, focus: target.strong });
    }
    // The target is read with the first loaded draft only, so it is not a dependency.
  }, [initial.data, segments, sync]);

  const onItemsChange = useCallback(
    (next: readonly DraftSegment[]) => {
      setSegments(next);
      sync.edit(next);
    },
    [sync],
  );

  const speakerList = useSpeakers(contentId);
  const speakers = useMemo(() => speakerList.data?.items ?? [], [speakerList.data]);
  const revisions = useRevisions(contentId);
  const speakerEditing = useSpeakerEditing({ contentId, segments: segments ?? NO_SEGMENTS, baseSpeakers, speakers, handleRef });
  const { resolved, visible, filter, setFilter } = speakerEditing;
  // A Content nobody was ever assigned in has no speaker column until the user starts: a
  // column of 「未分配」 on every sentence would be noise to someone only correcting text.
  // A speaker entry starts labelling right away: the column is there for the menu it opens.
  const [labeling, setLabeling] = useState(props.speakerIntent !== undefined);
  // Bumped to open the speaker panel from outside it.
  const [panelSignal, setPanelSignal] = useState(0);
  const showColumn = labeling || speakers.length > 0 || resolved.some((id) => id !== null);
  // The current chapters, projected by time as the reading view does: a chapter start always
  // opens a paragraph.
  const chapterQuery = useChapters(contentId);
  const chapters = useMemo<readonly ReadingChapter[]>(() => chapterQuery.data?.current?.chapters ?? [], [chapterQuery.data]);
  const pendingReviews = useMemo(() => (segments ?? NO_SEGMENTS).filter((segment) => segment.speakerReview === "needs_review"), [segments]);
  const suggested = pendingReviews.filter((segment) => typeof segment.speakerId === "string").length;
  const keepReview = useKeepSpeakersConfirmed({ contentId, baseRevisionId, segments });
  const range = usePlayRange();
  // The comparison reads the sentences as the editor resolves them now, keyed like its rows.
  const compared = useMemo(
    () => (segments ?? NO_SEGMENTS).map((segment, index) => ({ id: draftKey(segment, index), startMs: segment.startMs, endMs: segment.endMs, speakerId: resolved[index] ?? null })),
    [segments, resolved],
  );
  // A category picked in the comparison filters the rows; going back to 「全部」 there only
  // lifts that filter, never one the user picked in the editor's own menu. The comparison
  // reports its category again whenever the sentences change: that refreshes a category
  // filter still shown, but must not take over from a filter picked in the menu since.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const reportedCategory = useRef<ComparisonFilter["kind"] | undefined>(undefined);
  const onComparisonFilter = useCallback(
    (picked: ComparisonFilter | null) => {
      const repeated = picked !== null && picked.kind === reportedCategory.current;
      reportedCategory.current = picked?.kind;
      if (picked !== null) {
        if (!repeated || filterRef.current.kind === "keys") setFilter({ kind: "keys", keys: picked.ids, category: picked.kind });
      } else if (filterRef.current.kind === "keys") setFilter({ kind: "all" });
    },
    [setFilter],
  );
  const locateRow = useCallback(
    (key: string) => {
      const index = (segments ?? NO_SEGMENTS).findIndex((segment, at) => draftKey(segment, at) === key);
      if (index >= 0) handleRef.current?.focusSentence(index);
    },
    [segments],
  );
  const closeComparison = (): void => {
    setComparing(false);
    if (filter.kind === "keys") setFilter({ kind: "all" });
  };

  const commit = useMutation({
    mutationFn: (input: CommitInput) => {
      const committedBase = baseRevisionId;
      return sync.commit(async (draftVersion, committed) => {
        const revision = await client.post(`${draftUrl}/commit`, transcriptRevisionDtoSchema, {
          body: {
            expectedPrimaryRevisionId: input.expected ?? "",
            draftVersion,
            ...(input.review === undefined ? {} : { speakerReview: input.review }),
            ...(input.speakersConfirmed === true ? { speakersConfirmed: true } : {}),
          },
        });
        return { revision, committed, baseRevisionId: committedBase };
      });
    },
    onSuccess: ({ revision, committed, baseRevisionId: committedBase }) => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.content(contentId) });
      // A commit can make speakers used or unused; other tabs read the list again too.
      publishSpeakersChanged(events, queryClient, contentId);
      close({ kind: "committed", revisionId: revision.id, segmentCount: revision.segmentCount, baseRevisionId: committedBase, committed });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.error.code === "conflict.primary_changed") {
        const current = error.error.details?.["currentPrimaryRevisionId"];
        setConflict(typeof current === "string" ? current : "");
      }
      // A sentence naming a speaker deleted in another window is refused; the list read again
      // shows which sentences those are, with the offer to unassign them.
      if (error instanceof ApiError && error.error.class === "invalid_request") void speakerList.refetch();
    },
  });
  const startCommit = (review: SpeakerReviewResolution | undefined): void => {
    lastReview.current = review;
    commit.mutate({ expected: expectedPrimary, ...(review === undefined ? {} : { review }), ...keepSpeakersConfirmedField(keepReview) });
  };

  // Discarding is explicit and confirmed: the draft's unfinished edits are gone for good.
  const discard = useMutation({
    mutationFn: () => sync.discard((version) => client.delete(`${draftUrl}?version=${version}`, z.undefined())),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
      void queryClient.invalidateQueries({ queryKey: contentKeys.translations(contentId) });
      close({ kind: "discarded" });
    },
  });

  // The speaker entries' request, acted on once the list is in place: the panel, or the menu of
  // the sentence the editor opened on. A user who scrolled, typed or clicked meanwhile keeps what
  // they are doing.
  const intent = useRef(props.speakerIntent);
  const reportOpening = props.onInitialScrollDone;
  const { openMenuAt } = speakerEditing;
  const onInitialScrollDone = useCallback(
    (outcome: InitialScrollOutcome | "none") => {
      reportOpening?.(outcome);
      const asked = intent.current;
      intent.current = undefined;
      if (asked === undefined || outcome === "cancelled") return;
      if (asked.kind === "panel") setPanelSignal((signal) => signal + 1);
      else if (initialScroll !== undefined && outcome !== "none") openMenuAt(initialScroll.index);
    },
    [reportOpening, openMenuAt, initialScroll],
  );
  // Deleting a speaker the undo history still names would let an undo bring back sentences
  // pointing at nobody: those steps go with it, and the confirmation says so.
  const undoGuard = useMemo<SpeakerUndoGuard>(() => {
    const names = (speakerId: string) => (items: readonly DraftSegment[]) => items.some((segment) => segment.speakerId === speakerId);
    return {
      mentions: (speakerId) => handleRef.current?.hasUndo(names(speakerId)) === true,
      drop: (speakerId) => handleRef.current?.dropUndo(names(speakerId)),
    };
  }, []);
  // Chapters decide where paragraphs start from the first row shown, so the list waits for them
  // once; a later refetch must not take the editor (and its undo history) down again.
  const chaptersAwaited = useRef(false);
  if (!chapterQuery.isPending) chaptersAwaited.current = true;

  const paragraphs = useParagraphEditing({
    segments: segments ?? NO_SEGMENTS,
    resolved,
    chapters,
    visible,
    // The moments the editor takes no batch edit: a commit or discard under way, a conflict.
    locked: commit.isPending || discard.isPending || (state.phase !== "editing" && state.phase !== "saving"),
    speakerPickers: showColumn,
    handleRef,
  });

  /** 「载入最新」: the draft as another window left it, or the base again when it is gone. */
  const loadLatest = async (): Promise<void> => {
    const latest = await loadDraft(client, queryClient, contentId, baseRevisionId);
    setSegments(latest.segments);
    setBaseRevisionId(latest.baseRevisionId);
    setBaseSpeakers(latest.baseSpeakers);
    sync.reset(latest.segments, latest.version);
  };

  const exit = (result: EditorCloseResult = { kind: "exited" }): void => {
    void sync.close();
    close(result);
  };

  const renderLead = useCallback((_item: DraftSegment, index: number) => <SpeakerLead index={index} />, []);
  // Paragraphs and splitting do not need speakers: the actions are there whether or not the
  // speaker column is.
  const rowActions = useCallback(
    (item: DraftSegment, index: number) => (
      <>
        <ParagraphControl index={index} />
        <SplitControl index={index} segment={item} />
      </>
    ),
    [],
  );

  if (initial.isError) {
    return initial.error instanceof ApiError ? <ErrorView error={initial.error.error} /> : null;
  }
  // The chapters decide where paragraphs start from the first row shown; the reading view has
  // usually fetched them already.
  if (segments === undefined || !chaptersAwaited.current) return <Loading />;

  const failure = [commit.error, discard.error].find((error) => error instanceof ApiError && draftChangedVersion(error) === undefined && error.error.code !== "conflict.primary_changed");
  const busy = commit.isPending || discard.isPending;
  const filterName = filterLabel(t, filter, speakers);
  const shown = visible === undefined ? segments.length : visible.size;

  return (
    <SpeakerEditingProvider value={speakerEditing.contextValue}>
      <ParagraphEditingProvider value={paragraphs.contextValue}>
        <div className="contents" ref={speakerEditing.wrapper} onFocus={speakerEditing.onFocus} onKeyDown={paragraphs.onKeyDown}>
          <SentenceEditor
            testId="draft-editor"
            items={segments}
            onItemsChange={onItemsChange}
            keyOf={draftKey}
            renderHeader={segmentTime}
            textLabel={segmentTime}
            layout="compact"
            fillers={isChineseLanguage(props.base.language)}
            deleteWholeSentences
            sync={state}
            onRetry={() => sync.retry()}
            onLoadLatest={() => void loadLatest()}
            onKeepMine={() => sync.overwrite()}
            onDiscard={() => discard.mutate()}
            onExit={() => exit()}
            onCommit={() => (pendingReviews.length > 0 ? setReviewOpen(true) : startCommit(undefined))}
            busy={busy}
            handleRef={handleRef}
            {...(initialScroll === undefined ? {} : { initialScroll })}
            rowActions={rowActions}
            paragraphStarts={paragraphs.starts}
            onInitialScrollDone={onInitialScrollDone}
            {...(showColumn ? { renderLead } : {})}
            {...(visible === undefined ? {} : { visible })}
            toolbarExtra={
              <>
                {speakers.length > 0 || filter.kind !== "all" ? (
                  <SpeakerFilterMenu
                    segments={segments}
                    resolved={resolved}
                    changedKeys={speakerEditing.changedKeys}
                    speakers={speakers}
                    filter={filter}
                    filterName={filterName}
                    shown={shown}
                    onFilter={setFilter}
                    hasChanged={speakerEditing.changedKeys.size > 0}
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={comparing}
                  onClick={() => (comparing ? closeComparison() : setComparing(true))}
                  data-testid="comparison-toggle"
                >
                  <GitCompare size={14} aria-hidden="true" />
                  {t(comparing ? "speakerCompare.panel.close" : "speakerCompare.panel.open")}
                </Button>
                <SpeakerPanel
                  contentId={contentId}
                  segments={segments}
                  resolved={resolved}
                  current={speakerEditing.drafted}
                  others={speakerEditing.rest}
                  disabled={busy || state.phase !== "editing" && state.phase !== "saving"}
                  columnShown={showColumn}
                  onStartLabeling={() => setLabeling(true)}
                  onMerge={speakerEditing.merge}
                  onApply={() => setApplyOpen(true)}
                  undoGuard={undoGuard}
                  openSignal={panelSignal}
                />
              </>
            }
            commitNote={
              <>
                <KeepSpeakersConfirmed state={keepReview} disabled={busy} />
                {pendingReviews.length === 0 ? null : (
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
                    onClick={() => setFilter({ kind: "review" })}
                    data-testid="draft-review-count"
                  >
                    {t("speakerEditor.commit.pending", { count: pendingReviews.length })}
                  </button>
                )}
              </>
            }
            notices={
              <>
                {comparing ? (
                  <div className="max-h-[45vh] overflow-y-auto border-b border-line px-4 py-3" data-testid="comparison-panel">
                    <ComparisonView
                      contentId={contentId}
                      {...(page.content.durationMs === undefined ? {} : { durationMs: page.content.durationMs })}
                      sentences={compared}
                      baseRevisionId={baseRevisionId}
                      revisions={revisions.data?.revisions ?? []}
                      speakers={speakers}
                      {...(range.mode === "unsupported" ? {} : { playRange: range.playRange })}
                      rangePlayable={range.mode === "play"}
                      onLocate={locateRow}
                      onFilterChange={onComparisonFilter}
                      activeCategory={filter.kind === "keys" ? filter.category : null}
                    />
                  </div>
                ) : null}
                {speakerEditing.summary === undefined ? null : (
                  <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5 text-xs" role="status" data-testid="apply-result">
                    <span className="font-medium tabular-nums">
                      {t("speakerEditor.apply.summary", speakerEditing.summary)}
                    </span>
                    <button type="button" className="ml-auto rounded px-1.5 py-0.5 hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent" onClick={speakerEditing.dismissSummary}>
                      {t("speakerEditor.apply.dismiss")}
                    </button>
                  </div>
                )}
                <MissingSpeakerNotice count={speakerEditing.missingCount} onUnassign={() => void speakerEditing.unassignMissing()} disabled={busy} />
                <FilterBar filter={filter} label={filterName} shown={shown} total={segments.length} onClear={() => setFilter({ kind: "all" })} />
                {speakerEditing.selectedCount === 0 ? null : (
                  <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken/50 px-4 py-1.5 text-xs" role="status" data-testid="speaker-selection-bar">
                    <span className="tabular-nums">{t("speakerEditor.selection.count", { count: speakerEditing.selectedCount })}</span>
                    <span className="text-muted">{t("speakerEditor.selection.hint")}</span>
                    <button type="button" className="ml-auto rounded px-1.5 py-0.5 text-accent hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent" onClick={speakerEditing.clearSelection} data-testid="speaker-selection-clear">
                      {t("speakerEditor.selection.clear")}
                    </button>
                  </div>
                )}
                {speakerEditing.createError instanceof ApiError ? (
                  <div className="px-4 pt-2">
                    <ErrorView error={speakerEditing.createError.error} />
                  </div>
                ) : null}
                {failure instanceof ApiError ? (
                  <div className="px-4 pt-2">
                    <ErrorView error={failure.error} />
                  </div>
                ) : null}
                <p className="sr-only" role="status" data-testid="paragraph-status">
                  {paragraphs.status}
                </p>
              </>
            }
          />
        </div>
      </ParagraphEditingProvider>
      <ApplySpeakersDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        contentId={contentId}
        revisions={revisions.data?.revisions ?? []}
        baseRevisionId={baseRevisionId}
        preselect={props.applySpeakersFrom}
        draft={segments}
        resolved={resolved}
        speakers={speakers}
        onApply={speakerEditing.applyAligned}
      />
      <CommitReviewDialog
        open={reviewOpen}
        remaining={pendingReviews.length}
        suggested={suggested}
        busy={busy}
        onContinue={() => {
          setReviewOpen(false);
          setFilter({ kind: "review" });
        }}
        onCommit={(resolution) => {
          setReviewOpen(false);
          startCommit(resolution);
        }}
      />
      <Modal open={conflict !== undefined} onOpenChange={(open) => (open ? undefined : setConflict(undefined))} title={t("contentView.draft.conflictTitle")}>
        <p className="text-sm" data-testid="draft-conflict">
          {t("contentView.draft.conflictMessage")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            onClick={() => {
              setConflict(undefined);
              void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
              exit({ kind: "reload" });
            }}
          >
            {t("contentView.draft.conflictReload")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const next = conflict === "" ? undefined : conflict;
              setConflict(undefined);
              setExpectedPrimary(next);
              commit.mutate({ expected: next, ...(lastReview.current === undefined ? {} : { review: lastReview.current }), ...keepSpeakersConfirmedField(keepReview) });
            }}
          >
            {t("contentView.draft.conflictCommit")}
          </Button>
        </div>
      </Modal>
    </SpeakerEditingProvider>
  );
}

/** What a filter is called in the bar under the toolbar. */
function filterLabel(t: TFunction, filter: SpeakerFilter, speakers: ReadonlyArray<{ id: string; name?: string; ordinal: number }>): string {
  switch (filter.kind) {
    case "all":
      return t("speakerEditor.filter.all");
    case "speaker": {
      const speaker = speakers.find((item) => item.id === filter.speakerId);
      return speaker === undefined ? t("speakerEditor.filter.speakerUnknown") : speakerLabel(t, speaker);
    }
    case "review":
      return t("speakerEditor.filter.review");
    case "unassigned":
      return t("speakerEditor.filter.unassigned");
    case "changed":
      return t("speakerEditor.filter.changed");
    case "keys":
      return t(`speakerCompare.kind.${filter.category}`);
  }
}
