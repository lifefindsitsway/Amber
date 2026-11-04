import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { queryKeys } from "../../api/queries.ts";
import { transcriptRevisionDtoSchema, type TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { transcriptDraftDtoSchema, type TranscriptDraftRequest } from "../../../shared/dto/transcript.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { formatDuration } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, fetchAllSegments } from "./content-data.ts";
import { draftChangedVersion, useDraftSync } from "./use-draft-sync.ts";
import { isChineseLanguage, SentenceEditor } from "./sentence-editor.tsx";

type DraftSegment = TranscriptDraftRequest["segments"][number];

/** Starts a draft from a revision: each sentence keeps its timing and points at its source. */
export function draftFromSegments(segments: ReadonlyArray<{ id: string; startMs: number; endMs: number; text: string }>): DraftSegment[] {
  return segments.map((segment) => ({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id] }));
}

/** The Content's transcript draft as the editor starts from it: the saved one, else a new one from the base. */
async function loadDraft(client: ReturnType<typeof useApi>, contentId: string, baseId: string): Promise<{ baseRevisionId: string; version: number | null; segments: DraftSegment[] }> {
  try {
    const draft = await client.get(`/api/contents/${encodeURIComponent(contentId)}/transcript/draft`, transcriptDraftDtoSchema);
    return { baseRevisionId: draft.baseRevisionId, version: draft.version, segments: draft.segments };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { baseRevisionId: baseId, version: null, segments: draftFromSegments(await fetchAllSegments(client, baseId)) };
    }
    throw error;
  }
}

const segmentKey = (segment: DraftSegment, index: number): string => segment.id ?? `new-${index}`;
const segmentTime = (segment: DraftSegment): string => formatDuration(segment.startMs);

/**
 * Draft → Commit editing of the transcript: edits autosave to the Content's single transcript
 * draft; 「完成」 commits it as an immutable manual revision, which becomes the primary, only if
 * the primary is still the one seen when editing started. A changed primary is shown to the
 * user, never overwritten. Deleting a sentence of only fillers removes it from the draft.
 */
export function DraftEditor(props: { base: TranscriptRevisionDto; primaryRevisionId: string | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const contentId = page.content.id;
  const draftUrl = `/api/contents/${encodeURIComponent(contentId)}/transcript/draft`;
  const [expectedPrimary, setExpectedPrimary] = useState(props.primaryRevisionId);
  const [segments, setSegments] = useState<readonly DraftSegment[] | undefined>(undefined);
  const [baseRevisionId, setBaseRevisionId] = useState(props.base.id);
  const [conflict, setConflict] = useState<string | undefined>(undefined);

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

  const commit = useMutation({
    mutationFn: (expected: string | undefined) =>
      sync.commit((draftVersion) =>
        client.post(`${draftUrl}/commit`, transcriptRevisionDtoSchema, { body: { expectedPrimaryRevisionId: expected ?? "", draftVersion } }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.content(contentId) });
      props.onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.error.code === "conflict.primary_changed") {
        const current = error.error.details?.["currentPrimaryRevisionId"];
        setConflict(typeof current === "string" ? current : "");
      }
    },
  });

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
    sync.reset(latest.segments, latest.version);
  };

  const exit = (): void => {
    void sync.close();
    props.onClose();
  };

  if (initial.isError) {
    return initial.error instanceof ApiError ? <ErrorView error={initial.error.error} /> : null;
  }
  if (segments === undefined) return <Loading />;

  const failure = [commit.error, discard.error].find((error) => error instanceof ApiError && draftChangedVersion(error) === undefined && error.error.code !== "conflict.primary_changed");

  return (
    <>
      <SentenceEditor
        testId="draft-editor"
        items={segments}
        onItemsChange={onItemsChange}
        keyOf={segmentKey}
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
        onCommit={() => commit.mutate(expectedPrimary)}
        busy={commit.isPending || discard.isPending}
        notices={
          failure instanceof ApiError ? (
            <div className="px-4 pt-2">
              <ErrorView error={failure.error} />
            </div>
          ) : null
        }
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
              commit.mutate(next);
            }}
          >
            {t("contentView.draft.conflictCommit")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
