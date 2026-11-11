import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { queryKeys } from "../../api/queries.ts";
import { transcriptRevisionDtoSchema, type TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { transcriptDraftDtoSchema } from "../../../shared/dto/transcript.ts";
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
import { contentKeys, fetchAllSegments, useRevisions } from "./content-data.ts";
import { SpeakerLead } from "./speaker-column.tsx";
import { draftKey, type BaseSpeakers, type DraftSegment, type SpeakerFilter } from "./speaker-draft.ts";
import { FilterBar, SpeakerFilterMenu, SpeakerPanel } from "./speaker-toolbar.tsx";
import { SplitControl } from "./split-sentence.tsx";
import { SpeakerEditingProvider, useSpeakerEditing } from "./use-speaker-editing.tsx";
import { useSpeakers, speakerLabel } from "./speakers/speaker-data.ts";
import { draftChangedVersion, useDraftSync } from "./use-draft-sync.ts";
import { isChineseLanguage, SentenceEditor, type SentenceEditorHandle } from "./sentence-editor.tsx";

export type { DraftSegment };

/**
 * Starts a draft from a revision: each sentence keeps its timing and points at its source,
 * and states its speaker (`null` = none), so a draft never depends on the source to say who
 * speaks.
 */
export function draftFromSegments(segments: ReadonlyArray<{ id: string; startMs: number; endMs: number; text: string; speakerId?: string }>): DraftSegment[] {
  return segments.map((segment) => ({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id], speakerId: segment.speakerId ?? null }));
}

interface LoadedDraft {
  baseRevisionId: string;
  version: number | null;
  segments: DraftSegment[];
  /** For a saved draft with sentences that do not state their speaker: who their sources have. */
  baseSpeakers: BaseSpeakers | undefined;
}

/** The Content's transcript draft as the editor starts from it: the saved one, else a new one from the base. */
async function loadDraft(client: ReturnType<typeof useApi>, contentId: string, baseId: string): Promise<LoadedDraft> {
  try {
    const draft = await client.get(`/api/contents/${encodeURIComponent(contentId)}/transcript/draft`, transcriptDraftDtoSchema);
    // A draft saved before drafts stated speakers keeps its sentences as they are (the commit
    // reads the speaker of the first source); the editor needs those speakers only to show them.
    const baseSpeakers = draft.segments.some((segment) => segment.speakerId === undefined)
      ? new Map((await fetchAllSegments(client, draft.baseRevisionId)).map((segment) => [segment.id, segment.speakerId] as const))
      : undefined;
    return { baseRevisionId: draft.baseRevisionId, version: draft.version, segments: draft.segments, baseSpeakers };
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
  onClose: () => void;
  /** Opens the apply-speakers flow on mount with this revision as the source. */
  applySpeakersFrom?: string;
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
  const handleRef = useRef<SentenceEditorHandle<DraftSegment>>(null);
  /** The choice for unconfirmed sentences a commit was made with: a retry after a conflict repeats it. */
  const lastReview = useRef<SpeakerReviewResolution | undefined>(undefined);

  const { sync, state } = useDraftSync<readonly DraftSegment[]>((value, expectedVersion) =>
    client.put(draftUrl, transcriptDraftDtoSchema, { body: { baseRevisionId, expectedVersion, segments: [...value] } }),
  );

  const initial = useQuery({
    queryKey: ["draft", contentId, props.base.id],
    queryFn: () => loadDraft(client, contentId, props.base.id),
    staleTime: Infinity,
    gcTime: 0,
  });
  useEffect(() => {
    if (initial.data !== undefined && segments === undefined) {
      setSegments(initial.data.segments);
      setBaseRevisionId(initial.data.baseRevisionId);
      setBaseSpeakers(initial.data.baseSpeakers);
      sync.init(initial.data.segments, initial.data.version);
    }
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
  const [labeling, setLabeling] = useState(false);
  const showColumn = labeling || speakers.length > 0 || resolved.some((id) => id !== null);
  const pendingReviews = useMemo(() => (segments ?? NO_SEGMENTS).filter((segment) => segment.speakerReview === "needs_review"), [segments]);
  const suggested = pendingReviews.filter((segment) => typeof segment.speakerId === "string").length;

  const commit = useMutation({
    mutationFn: (input: CommitInput) =>
      sync.commit((draftVersion) =>
        client.post(`${draftUrl}/commit`, transcriptRevisionDtoSchema, {
          body: { expectedPrimaryRevisionId: input.expected ?? "", draftVersion, ...(input.review === undefined ? {} : { speakerReview: input.review }) },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.content(contentId) });
      // A commit can make speakers used or unused; other tabs read the list again too.
      publishSpeakersChanged(events, queryClient, contentId);
      props.onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.error.code === "conflict.primary_changed") {
        const current = error.error.details?.["currentPrimaryRevisionId"];
        setConflict(typeof current === "string" ? current : "");
      }
    },
  });
  const startCommit = (review: SpeakerReviewResolution | undefined): void => {
    lastReview.current = review;
    commit.mutate({ expected: expectedPrimary, ...(review === undefined ? {} : { review }) });
  };

  // Discarding is explicit and confirmed: the draft's unfinished edits are gone for good.
  const discard = useMutation({
    mutationFn: () => sync.discard((version) => client.delete(`${draftUrl}?version=${version}`, z.undefined())),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
      void queryClient.invalidateQueries({ queryKey: contentKeys.translations(contentId) });
      props.onClose();
    },
  });

  /** 「载入最新」: the draft as another window left it, or the base again when it is gone. */
  const loadLatest = async (): Promise<void> => {
    const latest = await loadDraft(client, contentId, baseRevisionId);
    setSegments(latest.segments);
    setBaseRevisionId(latest.baseRevisionId);
    setBaseSpeakers(latest.baseSpeakers);
    sync.reset(latest.segments, latest.version);
  };

  const exit = (): void => {
    void sync.close();
    props.onClose();
  };

  const renderLead = useCallback((_item: DraftSegment, index: number) => <SpeakerLead index={index} />, []);
  const rowActions = useCallback((item: DraftSegment, index: number) => <SplitControl index={index} segment={item} />, []);

  if (initial.isError) {
    return initial.error instanceof ApiError ? <ErrorView error={initial.error.error} /> : null;
  }
  if (segments === undefined) return <Loading />;

  const failure = [commit.error, discard.error].find((error) => error instanceof ApiError && draftChangedVersion(error) === undefined && error.error.code !== "conflict.primary_changed");
  const busy = commit.isPending || discard.isPending;
  const filterName = filterLabel(t, filter, speakers);
  const shown = visible === undefined ? segments.length : visible.size;

  return (
    <SpeakerEditingProvider value={speakerEditing.contextValue}>
      <div className="contents" ref={speakerEditing.wrapper} onFocus={speakerEditing.onFocus}>
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
          onExit={exit}
          onCommit={() => (pendingReviews.length > 0 ? setReviewOpen(true) : startCommit(undefined))}
          busy={busy}
          handleRef={handleRef}
          {...(showColumn ? { renderLead, rowActions } : {})}
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
              />
            </>
          }
          commitNote={
            pendingReviews.length === 0 ? null : (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => setFilter({ kind: "review" })}
                data-testid="draft-review-count"
              >
                {t("speakerEditor.commit.pending", { count: pendingReviews.length })}
              </button>
            )
          }
          notices={
            <>
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
            </>
          }
        />
      </div>
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
              exit();
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
              commit.mutate({ expected: next, ...(lastReview.current === undefined ? {} : { review: lastReview.current }) });
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
  }
}
