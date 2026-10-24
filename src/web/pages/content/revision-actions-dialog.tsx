import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  transcriptRevisionListItemDtoSchema,
  type RevisionBlockersDto,
  type TranscriptRevisionListItemDto,
} from "../../../shared/dto/content.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { searchKeys } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { revisionLabel } from "./labels.ts";

/** Kinds kept as evidence: they can be archived but never permanently deleted. */
const PROTECTED_KINDS: ReadonlySet<string> = new Set(["platform", "asr"]);

export const BLOCKER_CATEGORIES = ["children", "draft", "notes", "highlights", "chatMessages", "artifacts", "activeTasks"] as const satisfies ReadonlyArray<keyof RevisionBlockersDto>;

/**
 * A preview of what blocks deleting `ids`, from the list items' own blockers: children inside
 * the set do not count, other references are summed. The server judges the set as a whole and
 * its refusal, when it comes, replaces this preview.
 */
export function setBlockers(ids: readonly string[], revisions: readonly TranscriptRevisionListItemDto[]): RevisionBlockersDto {
  const inSet = new Set(ids);
  const blockers: RevisionBlockersDto = { children: 0, draft: 0, notes: 0, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0 };
  for (const item of revisions) {
    if (inSet.has(item.id)) {
      for (const category of BLOCKER_CATEGORIES) {
        if (category !== "children") blockers[category] += item.blockers[category];
      }
    } else if (item.parentRevisionId !== undefined && inSet.has(item.parentRevisionId)) {
      blockers.children += 1;
    }
  }
  return blockers;
}

/** Blockers as the server reported them in a `conflict.revision_referenced` refusal. */
function refusedBlockers(error: unknown): RevisionBlockersDto | undefined {
  if (!(error instanceof ApiError) || error.error.code !== "conflict.revision_referenced") return undefined;
  const details = error.error.details ?? {};
  const counts = Object.fromEntries(BLOCKER_CATEGORIES.map((category) => [category, typeof details[category] === "number" ? (details[category] as number) : 0]));
  return counts as RevisionBlockersDto;
}

/** After any change to a revision every view of the Content reads its revisions, outputs and primary again. */
function useRefreshContent(contentId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.content(contentId) });
    await queryClient.invalidateQueries({ queryKey: ["draft", contentId] });
  };
}

/**
 * The 「…」 menu of the picked revision: archive or restore it, or open the permanent delete
 * dialog. The primary offers neither (the hint says to switch first); platform and ASR
 * originals only archive.
 */
export function RevisionActions(props: {
  contentId: string;
  revision: TranscriptRevisionListItemDto;
  revisions: readonly TranscriptRevisionListItemDto[];
  primaryId: string | undefined;
  /** Called once the revision is gone, so the page can show another one. */
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const refresh = useRefreshContent(props.contentId);
  const [deleting, setDeleting] = useState(false);
  const { revision } = props;
  const isPrimary = revision.id === props.primaryId;
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      client.put(`/api/transcript/revisions/${encodeURIComponent(revision.id)}/archived`, transcriptRevisionListItemDtoSchema, { body: { archived } }),
    onSuccess: refresh,
  });
  const item = "cursor-pointer rounded px-2 py-1.5 outline-none data-highlighted:bg-sunken data-disabled:cursor-default data-disabled:opacity-50";
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="ghost" aria-label={t("contentView.revisions.actions")} title={t("contentView.revisions.actions")} data-testid="revision-actions">
            <MoreHorizontal size={14} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" className="z-50 min-w-40 rounded-md border border-line bg-surface p-1 text-sm shadow-lg">
            <DropdownMenu.Item
              className={item}
              disabled={isPrimary || archive.isPending}
              onSelect={() => archive.mutate(!revision.archived)}
              data-testid="revision-archive"
            >
              {revision.archived ? t("contentView.revisions.unarchive") : t("contentView.revisions.archive")}
            </DropdownMenu.Item>
            {PROTECTED_KINDS.has(revision.kind) ? null : (
              <DropdownMenu.Item className={item} disabled={isPrimary} onSelect={() => setDeleting(true)} data-testid="revision-delete">
                {t("contentView.revisions.delete")}
              </DropdownMenu.Item>
            )}
            {isPrimary || PROTECTED_KINDS.has(revision.kind) ? (
              <DropdownMenu.Label className="max-w-56 px-2 pt-1.5 pb-1 text-xs text-muted" data-testid="revision-actions-hint">
                {isPrimary ? t("contentView.revisions.primaryHint") : t("contentView.revisions.protectedHint")}
              </DropdownMenu.Label>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {archive.error instanceof ApiError ? (
        <div className="basis-full">
          <ErrorView error={archive.error.error} />
        </div>
      ) : null}
      {deleting ? (
        <RevisionDeleteDialog
          contentId={props.contentId}
          revision={revision}
          revisions={props.revisions}
          primaryId={props.primaryId}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            props.onDeleted();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Permanent deletion: lists every revision the delete would remove (with descendants only
 * when asked) and each category of reference that blocks it. A blocked delete offers
 * 「改为归档」, and a blocking draft 「放弃草稿」 behind a second confirmation.
 */
export function RevisionDeleteDialog(props: {
  contentId: string;
  revision: TranscriptRevisionListItemDto;
  revisions: readonly TranscriptRevisionListItemDto[];
  primaryId: string | undefined;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const refresh = useRefreshContent(props.contentId);
  const queryClient = useQueryClient();
  const [withDescendants, setWithDescendants] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { revision } = props;
  const ids = [revision.id, ...(withDescendants ? revision.descendantIds : [])];
  const members = ids.flatMap((id) => props.revisions.filter((item) => item.id === id));

  const remove = useMutation({
    mutationFn: () =>
      client.delete(`/api/transcript/revisions/${encodeURIComponent(revision.id)}?withDescendants=${withDescendants ? "true" : "false"}`, z.undefined()),
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: searchKeys.all });
      props.onDeleted();
    },
  });
  const archive = useMutation({
    mutationFn: () =>
      client.put(`/api/transcript/revisions/${encodeURIComponent(revision.id)}/archived`, transcriptRevisionListItemDtoSchema, { body: { archived: true } }),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  const discard = useMutation({
    mutationFn: () => client.delete(`/api/contents/${encodeURIComponent(props.contentId)}/transcript/draft`, z.undefined()),
    onSuccess: async () => {
      setConfirmDiscard(false);
      remove.reset();
      await refresh();
    },
  });

  const blockers = refusedBlockers(remove.error) ?? setBlockers(ids, props.revisions);
  const blocked = BLOCKER_CATEGORIES.some((category) => blockers[category] > 0);
  const isPrimary = ids.includes(props.primaryId ?? "");
  const busy = remove.isPending || archive.isPending || discard.isPending;
  const otherError = remove.error instanceof ApiError && refusedBlockers(remove.error) === undefined ? remove.error : undefined;
  const failure = otherError ?? (archive.error instanceof ApiError ? archive.error : discard.error instanceof ApiError ? discard.error : undefined);

  return (
    <Modal open onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("contentView.revisions.deleteTitle")}>
      <div className="flex flex-col gap-3 text-sm" data-testid="revision-delete-dialog">
        <p className="text-xs text-muted">{t("contentView.revisions.deleteSet")}</p>
        <ul className="flex flex-col gap-1" data-testid="revision-delete-set">
          {members.map((member) => (
            <li key={member.id} className="rounded bg-sunken px-2 py-1 text-xs" data-revision-id={member.id}>
              {revisionLabel(member, props.primaryId, t, i18n, props.revisions)}
            </li>
          ))}
        </ul>
        {revision.descendantIds.length > 0 ? (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={withDescendants}
              onChange={(event) => {
                setWithDescendants(event.target.checked);
                remove.reset();
              }}
              data-testid="revision-delete-descendants"
            />
            {t("contentView.revisions.withDescendants", { count: revision.descendantIds.length })}
          </label>
        ) : null}
        {isPrimary ? <p className="text-xs text-muted">{t("contentView.revisions.primaryHint")}</p> : null}
        {blocked ? (
          <div className="flex flex-col gap-1" data-testid="revision-blockers">
            <p className="text-xs text-muted">{t("contentView.revisions.blockersTitle")}</p>
            <ul className="flex flex-col gap-0.5 text-xs">
              {BLOCKER_CATEGORIES.filter((category) => blockers[category] > 0).map((category) => (
                <li key={category} data-testid={`revision-blocker-${category}`}>
                  {t(`contentView.revisions.blocker.${category}`, { count: blockers[category] })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {confirmDiscard ? <p className="text-xs text-danger" data-testid="revision-discard-draft-hint">{t("contentView.revisions.discardDraftHint")}</p> : null}
        {failure === undefined ? null : <ErrorView error={failure.error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
          {blockers.draft > 0 ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => (confirmDiscard ? discard.mutate() : setConfirmDiscard(true))}
              data-testid="revision-discard-draft"
            >
              {confirmDiscard ? t("contentView.revisions.discardDraftConfirm") : t("contentView.revisions.discardDraft")}
            </Button>
          ) : null}
          {blocked && !revision.archived && !isPrimary ? (
            <Button disabled={busy || blockers.draft > 0} onClick={() => archive.mutate()} data-testid="revision-archive-instead">
              {t("contentView.revisions.archiveInstead")}
            </Button>
          ) : null}
          <Button variant="danger" disabled={busy || blocked || isPrimary} onClick={() => remove.mutate()} data-testid="revision-delete-confirm">
            {t("contentView.revisions.deleteConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
