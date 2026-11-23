import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { matchPath, useLocation, useNavigate } from "react-router";
import { TRASH_RETENTION_DAYS } from "../../../shared/defaults.ts";
import {
  collectionDeletePlanDtoSchema,
  collectionDeleteResultDtoSchema,
  type CollectionDeletePlanDto,
  type CollectionDeleteRequest,
  type CollectionDeleteResultDto,
} from "../../../shared/dto/collection.ts";
import type { AppError } from "../../../shared/errors.ts";
import { ApiError } from "../../api/client.ts";
import { useApi, useContentEvents } from "../../api/context.tsx";
import { refreshContentViews } from "../../api/content-events.ts";
import { queryKeys } from "../../api/queries.ts";
import { noteKeys } from "../../notes/note-keys.ts";
import { Button } from "../../ui/button.tsx";
import { RadioCard } from "../../ui/checkbox.tsx";
import { SkeletonRows } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { Callout, InlineNote } from "../../ui/notice.tsx";
import { useToast } from "../../ui/toast.tsx";
import { appErrorOf } from "../confirm-dialog.tsx";
import { ErrorView } from "../error-view.tsx";

/** What deleting keeps: `exclusive` moves the members found in no other collection to the trash too. */
export type CollectionDeleteChoice = CollectionDeleteRequest["contents"];

/**
 * One confirmed deletion: the request body frozen when the user confirmed and its
 * Idempotency-Key. A retry after a network failure resends both unchanged, so a deletion that
 * did go through answers with its first result instead of "not found".
 */
interface DeleteIntent {
  key: string;
  body: CollectionDeleteRequest;
}

/** The body for `choice` under `plan`: Tasks are cancelled exactly when the plan shows some that stand in the way. */
export function deleteRequestOf(plan: CollectionDeletePlanDto, choice: CollectionDeleteChoice): CollectionDeleteRequest {
  if (choice === "keep") return { contents: "keep", cancelTasks: plan.collectionTaskCount > 0 };
  return {
    contents: "exclusive",
    cancelTasks: plan.exclusiveWithTasksCount > 0 || plan.collectionTaskCount > 0,
    expectedContentIds: [...plan.exclusiveContentIds],
  };
}

/**
 * Asks before deleting a Collection, the same from its page, its list card and its sidebar
 * row. Opening it reads what the deletion would touch (`GET /api/collections/:id/delete-plan`).
 * When some members belong to this collection alone, two choices are offered, deleting them
 * along (to the trash) first; otherwise it is a plain confirmation, which still says when the
 * collection's own summary is running and will be cancelled. Members another collection's
 * running summary froze rule out deleting them along.
 *
 * Cancelling Tasks cannot be undone, and the server refuses (`collection_members_changed`)
 * when the members changed between the plan and the deletion; the dialog then says what was
 * cancelled and reads the plan again. The result toast stays until closed: nothing deleted here
 * can be brought back to the collection.
 */
export function DeleteCollectionDialog(props: {
  collection: { id: string; name: string } | undefined;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (collectionId: string) => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { collection } = props;
  const open = collection !== undefined;
  const collectionId = collection?.id ?? "";
  const path = `/api/collections/${encodeURIComponent(collectionId)}`;

  // Every opening is a new session: a fresh plan, the default choice, no leftover notice.
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const [choice, setChoice] = useState<CollectionDeleteChoice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | undefined>(undefined);
  const [cancelledBeforeChange, setCancelledBeforeChange] = useState<number | undefined>(undefined);
  const [intent, setIntent] = useState<DeleteIntent | undefined>(undefined);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSession((current) => current + 1);
      setChoice(undefined);
      setError(undefined);
      setCancelledBeforeChange(undefined);
      setIntent(undefined);
    }
  }

  const plan = useQuery({
    queryKey: ["collection-delete-plan", collectionId, session],
    queryFn: ({ signal }) => client.get(`${path}/delete-plan`, collectionDeletePlanDtoSchema, { signal }),
    enabled: open,
    // Read once per opening (and again on purpose after a refusal): the counts must not change under the user's eyes.
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const data = plan.data;
  const blocked = (data?.blocked.length ?? 0) > 0;
  const withChoices = data !== undefined && data.exclusiveContentIds.length > 0;
  // The first card is the default unless it cannot be chosen.
  const chosen: CollectionDeleteChoice = !withChoices ? "keep" : (choice ?? (blocked ? "keep" : "exclusive"));
  const effective: CollectionDeleteChoice = chosen === "exclusive" && blocked ? "keep" : chosen;
  const request = data === undefined ? undefined : deleteRequestOf(data, effective);

  const close = (): void => props.onOpenChange(false);

  const settle = async (result: CollectionDeleteResultDto): Promise<void> => {
    if (collection === undefined) return;
    for (const contentId of result.trashedIds) {
      // A trashed Content answers 404 everywhere; a refetch would only show that.
      queryClient.removeQueries({ queryKey: queryKeys.content(contentId) });
      queryClient.removeQueries({ queryKey: noteKeys.contentAll(contentId) });
      contentEvents.publish({ type: "trashed", contentId });
    }
    // Its page would only show "not found" now.
    queryClient.removeQueries({ queryKey: queryKeys.collection(collection.id) });
    await Promise.all([
      refreshContentViews(queryClient),
      ...(result.cancelledTaskCount > 0 ? [queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll })] : []),
    ]);
    const trashed = result.trashedIds.length;
    const message = [
      trashed > 0 ? t("library.deleteCollection.doneWithContents", { name: collection.name, count: trashed }) : t("library.deleteCollection.done", { name: collection.name }),
      ...(result.cancelledTaskCount > 0 ? [t("library.deleteCollection.doneCancelled", { count: result.cancelledTaskCount })] : []),
    ].join("");
    toast.show({
      tone: "success",
      message,
      persistent: true,
      ...(trashed > 0 ? { action: { label: t("library.deleteContent.openTrash"), onClick: () => void navigate("/trash") } } : {}),
    });
    const viewing = matchPath("/collections/:id", pathname)?.params.id === collection.id;
    const viewedContent = matchPath("/contents/:id/*", pathname)?.params.id;
    if (viewing) void navigate("/collections");
    else if (viewedContent !== undefined && result.trashedIds.includes(viewedContent)) void navigate("/library");
    props.onDeleted?.(collection.id);
    close();
  };

  const confirm = async (): Promise<void> => {
    if (request === undefined || collection === undefined) return;
    // The held intent is reused only for the very same body: a retry of what may have gone through.
    const current = intent !== undefined && JSON.stringify(intent.body) === JSON.stringify(request) ? intent : { key: crypto.randomUUID(), body: request };
    setIntent(current);
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.post(`${path}/delete`, collectionDeleteResultDtoSchema, { body: current.body, idempotencyKey: current.key });
      setIntent(undefined);
      await settle(result);
    } catch (caught) {
      // Only an answer that never arrived keeps the intent; any answer from the server ends it.
      if (!(caught instanceof ApiError && caught.status === 0)) setIntent(undefined);
      const appError = appErrorOf(caught);
      if (appError.code === "conflict.collection_members_changed") {
        const count = appError.details?.["cancelledTaskCount"];
        setCancelledBeforeChange(typeof count === "number" ? count : 0);
        if (count !== 0) void queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll });
        setChoice(undefined);
        void plan.refetch();
      } else {
        setCancelledBeforeChange(undefined);
        setError(appError);
        // A refusal over unfinished Tasks means the plan the user saw is out of date.
        if (appError.code === "conflict.tasks_unfinished") void plan.refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmLabel =
    data === undefined
      ? t("library.deleteCollection.confirmKeep")
      : effective === "exclusive"
        ? t(request?.cancelTasks === true ? "library.deleteCollection.confirmWithContentsCancelTasks" : "library.deleteCollection.confirmWithContents", { count: data.exclusiveContentIds.length })
        : t(request?.cancelTasks === true ? "library.deleteCollection.confirmKeepCancelTasks" : "library.deleteCollection.confirmKeep");

  let body: ReactNode;
  if (plan.isError && !plan.isFetching) {
    body = (
      <div data-testid="delete-collection-plan-error">
        <ErrorView error={appErrorOf(plan.error)}>
          <Button size="sm" onClick={() => void plan.refetch()} data-testid="delete-collection-plan-retry">
            {t("common.action.retry")}
          </Button>
        </ErrorView>
      </div>
    );
  } else if (data === undefined || plan.isFetching) {
    body = <SkeletonRows count={3} rowHeight={20} testId="delete-collection-plan-loading" />;
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {withChoices ? <Choices plan={data} chosen={effective} disabled={busy} onChoose={setChoice} /> : <p className="max-w-[70ch] text-sm">{t("library.collection.deleteDescription")}</p>}
        {data.collectionTaskCount > 0 ? (
          <Callout tone="warn" density="compact" testId="delete-collection-task-note">
            {`${t("library.deleteCollection.collectionTask")} ${t("library.deleteContent.tasksNote")}`}
          </Callout>
        ) : effective === "exclusive" && data.exclusiveWithTasksCount > 0 ? (
          <Callout tone="warn" density="compact" testId="delete-collection-task-note">
            {t("library.deleteContent.tasksNote")}
          </Callout>
        ) : null}
        <InlineNote icon={<Info size={14} aria-hidden="true" />} testId="delete-collection-irreversible">
          {effective === "exclusive" || data.trashedMemberCount > 0 ? t("library.deleteCollection.irreversibleWithTrash") : t("library.deleteCollection.irreversible")}
        </InlineNote>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      title={t("library.collection.deleteTitle", { name: collection?.name ?? "" })}
      testId="delete-collection-dialog"
      footer={
        <>
          <Button onClick={close}>{t("common.action.cancel")}</Button>
          <Button
            variant="danger-solid"
            loading={busy}
            disabled={request === undefined || plan.isFetching || plan.isError}
            onClick={() => void confirm()}
            data-testid="delete-collection-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {cancelledBeforeChange === undefined ? null : (
        <Callout tone="warn" announce="alert" className="mb-4" testId="delete-collection-members-changed">
          {cancelledBeforeChange > 0
            ? t("library.deleteCollection.membersChanged", { count: cancelledBeforeChange })
            : t("library.deleteCollection.membersChangedNoTasks")}
        </Callout>
      )}
      {body}
      {error === undefined ? null : (
        <div className="mt-3">
          <ErrorView error={error} />
        </div>
      )}
    </Modal>
  );
}

/** The two choices: delete the members found nowhere else along with it, or the collection alone. */
function Choices(props: { plan: CollectionDeletePlanDto; chosen: CollectionDeleteChoice; disabled: boolean; onChoose: (choice: CollectionDeleteChoice) => void }) {
  const { t } = useTranslation();
  const { plan } = props;
  const blocked = plan.blocked.length > 0;
  const blockedId = useId();
  const names = [...new Map(plan.blocked.flatMap((entry) => entry.collections).map((entry) => [entry.id, entry.name])).values()]
    .map((name) => (name === undefined ? t("library.deleteContent.plan.unnamedCollection") : t("library.deleteContent.plan.collectionName", { name })))
    .join(t("library.deleteContent.plan.nameSeparator"));
  const lines = [
    t("library.deleteCollection.withContentsTrash", { days: TRASH_RETENTION_DAYS }),
    ...(plan.sharedCount > 0 ? [t("library.deleteCollection.withContentsShared", { count: plan.sharedCount })] : []),
    ...(plan.exclusiveWithTasksCount > 0 ? [t("library.deleteCollection.withContentsTasks", { count: plan.exclusiveWithTasksCount })] : []),
  ];
  return (
    <div role="radiogroup" aria-label={t("library.collection.deleteCollection")} className="flex flex-col gap-2" data-testid="delete-collection-choices">
      <RadioCard
        name="delete-collection-choice"
        value="exclusive"
        checked={props.chosen === "exclusive"}
        disabled={props.disabled || blocked}
        {...(blocked ? { "aria-describedby": blockedId } : {})}
        onChange={() => props.onChoose("exclusive")}
        title={t("library.deleteCollection.withContents", { count: plan.exclusiveContentIds.length })}
        description={
          <>
            {lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </>
        }
        testId="delete-collection-choice-exclusive"
      />
      {/* Outside the dimmed card, so the reason it cannot be chosen stays fully legible. */}
      {blocked ? (
        <Callout tone="warn" density="compact" id={blockedId} testId="delete-collection-blocked">
          {t("library.deleteCollection.withContentsBlocked", { count: plan.blocked.length, names })}
        </Callout>
      ) : null}
      <RadioCard
        name="delete-collection-choice"
        value="keep"
        checked={props.chosen === "keep"}
        disabled={props.disabled}
        onChange={() => props.onChoose("keep")}
        title={t("library.deleteCollection.keepContents")}
        description={t("library.deleteCollection.keepContentsHint", { count: plan.memberCount })}
        testId="delete-collection-choice-keep"
      />
    </div>
  );
}
