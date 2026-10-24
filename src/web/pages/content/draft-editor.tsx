import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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

type DraftSegment = TranscriptDraftRequest["segments"][number];

const AUTOSAVE_DELAY_MS = 800;

/** Starts a draft from a revision: each sentence keeps its timing and points at its source. */
export function draftFromSegments(segments: ReadonlyArray<{ id: string; startMs: number; endMs: number; text: string }>): DraftSegment[] {
  return segments.map((segment) => ({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id] }));
}

/**
 * Draft → Commit editing: edits autosave to the Content's single draft; 「完成」 commits it
 * as an immutable manual revision, which becomes the primary, only if the primary is still
 * the one seen when editing started. A changed primary is shown to the user, never overwritten.
 */
export function DraftEditor(props: { base: TranscriptRevisionDto; primaryRevisionId: string | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const contentId = page.content.id;
  const [expectedPrimary, setExpectedPrimary] = useState(props.primaryRevisionId);
  const [segments, setSegments] = useState<DraftSegment[] | undefined>(undefined);
  const [baseRevisionId, setBaseRevisionId] = useState(props.base.id);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = useRef(false);

  const initial = useQuery({
    queryKey: ["draft", contentId, props.base.id],
    queryFn: async () => {
      try {
        return await client.get(`/api/contents/${encodeURIComponent(contentId)}/transcript/draft`, transcriptDraftDtoSchema);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return { baseRevisionId: props.base.id, segments: draftFromSegments(await fetchAllSegments(client, props.base.id)) };
        }
        throw error;
      }
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  useEffect(() => {
    if (initial.data !== undefined && segments === undefined) {
      setSegments(initial.data.segments);
      setBaseRevisionId(initial.data.baseRevisionId);
    }
  }, [initial.data, segments]);

  const save = useMutation({
    mutationFn: (draft: TranscriptDraftRequest) =>
      client.put(`/api/contents/${encodeURIComponent(contentId)}/transcript/draft`, transcriptDraftDtoSchema, { body: draft }),
  });
  const { mutateAsync: saveDraft } = save;

  useEffect(() => {
    if (segments === undefined || !dirty.current) return;
    const timer = setTimeout(() => {
      // A commit or discard in the meantime has taken over the edits.
      if (!dirty.current) return;
      dirty.current = false;
      void saveDraft({ baseRevisionId, segments }).catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [segments, baseRevisionId, saveDraft]);

  const commit = useMutation({
    mutationFn: async (expected: string | undefined) => {
      if (segments !== undefined) {
        dirty.current = false;
        await saveDraft({ baseRevisionId, segments });
      }
      return client.post(`/api/contents/${encodeURIComponent(contentId)}/transcript/draft/commit`, transcriptRevisionDtoSchema, {
        body: { expectedPrimaryRevisionId: expected ?? "" },
      });
    },
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
    mutationFn: async () => {
      dirty.current = false;
      try {
        await client.delete(`/api/contents/${encodeURIComponent(contentId)}/transcript/draft`, z.undefined());
      } catch (error) {
        // Nothing was saved yet, so there is nothing to discard.
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
      props.onClose();
    },
  });

  if (initial.isError) {
    return initial.error instanceof ApiError ? <ErrorView error={initial.error.error} /> : null;
  }
  if (segments === undefined) return <Loading />;

  const edit = (index: number, text: string): void => {
    dirty.current = true;
    setSegments(segments.map((segment, at) => (at === index ? { ...segment, text } : segment)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="draft-editor">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <span className="text-xs text-muted">{save.isPending ? t("contentView.draft.saving") : t("contentView.draft.autosave")}</span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="danger"
            disabled={discard.isPending || commit.isPending}
            onClick={() => (confirmDiscard ? discard.mutate() : setConfirmDiscard(true))}
            title={t("contentView.revisions.discardDraftHint")}
            data-testid="draft-discard"
          >
            {confirmDiscard ? t("contentView.revisions.discardDraftConfirm") : t("contentView.revisions.discardDraft")}
          </Button>
          <Button size="sm" onClick={props.onClose}>
            {t("contentView.draft.exit")}
          </Button>
          <Button size="sm" variant="primary" disabled={commit.isPending} onClick={() => commit.mutate(expectedPrimary)} data-testid="draft-commit">
            {t("common.action.done")}
          </Button>
        </div>
      </div>
      {discard.error instanceof ApiError ? (
        <div className="px-4 pt-2">
          <ErrorView error={discard.error.error} />
        </div>
      ) : null}
      {commit.error instanceof ApiError && conflict === undefined ? (
        <div className="px-4 pt-2">
          <ErrorView error={commit.error.error} />
        </div>
      ) : null}
      <ol className="min-h-0 flex-1 overflow-auto px-4 py-2">
        {segments.map((segment, index) => (
          <li key={segment.id ?? index} className="flex items-start gap-2 py-1" data-segment-id={segment.id}>
            <span className="w-14 shrink-0 pt-1.5 font-mono text-xs text-muted">{formatDuration(segment.startMs)}</span>
            <textarea
              aria-label={formatDuration(segment.startMs)}
              className="min-h-8 flex-1 resize-y rounded border border-line bg-surface px-2 py-1 text-sm"
              rows={1}
              value={segment.text}
              onChange={(event) => edit(index, event.target.value)}
            />
          </li>
        ))}
      </ol>
      <Modal open={conflict !== undefined} onOpenChange={(open) => (open ? undefined : setConflict(undefined))} title={t("contentView.draft.conflictTitle")}>
        <p className="text-sm" data-testid="draft-conflict">
          {t("contentView.draft.conflictMessage")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            onClick={() => {
              setConflict(undefined);
              void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
              props.onClose();
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
    </div>
  );
}
