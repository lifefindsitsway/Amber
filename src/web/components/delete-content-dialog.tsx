import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { z } from "zod";
import { TRASH_RETENTION_DAYS } from "../../shared/defaults.ts";
import {
  contentTrashPlanDtoSchema,
  contentTrashResultDtoSchema,
  type ContentTrashPlanItemDto,
  type ContentTrashPlanState,
  type ContentTrashResultDto,
} from "../../shared/dto/trash.ts";
import type { AppError } from "../../shared/errors.ts";
import { useApi, useContentEvents } from "../api/context.tsx";
import { refreshContentViews } from "../api/content-events.ts";
import { queryKeys } from "../api/queries.ts";
import { noteKeys } from "../notes/note-keys.ts";
import { Button } from "../ui/button.tsx";
import { SkeletonRows } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { Callout, TextAction } from "../ui/notice.tsx";
import { useToast } from "../ui/toast.tsx";
import { appErrorOf } from "./confirm-dialog.tsx";
import { ErrorView } from "./error-view.tsx";

/** A Content the dialog is asked to delete; the title stands in until the pre-check names it. */
export interface DeleteTarget {
  id: string;
  title?: string;
}

/** What a finished deletion leaves: the ids that are gone from the library now (moved, or already in the trash or missing). */
export interface DeleteOutcome {
  removedIds: string[];
}

/** Display order of the pre-check rows. */
const PLAN_ROWS: readonly ContentTrashPlanState[] = ["ready", "tasks", "blocked", "trashed", "missing"];

/**
 * Confirms moving one Content to the trash, from the library row, its right-click menu, the
 * content page or the sidebar. Same pre-check, wording and result handling as the batch delete;
 * see `DeleteContentsDialog`.
 */
export function DeleteContentDialog(props: {
  content: { id: string; title?: string } | undefined;
  onOpenChange: (open: boolean) => void;
  /** Runs once the deletion succeeded, before the caches are cleared and the lists refresh. */
  onDeleted?: () => void;
}) {
  const { content, onDeleted } = props;
  const targets = useMemo(() => (content === undefined ? undefined : [content]), [content]);
  return <DeleteDialog targets={targets} single onOpenChange={props.onOpenChange} {...(onDeleted === undefined ? {} : { onDeleted })} />;
}

/**
 * Moves the picked Contents to the trash. Opening it asks the server where each one stands
 * (`POST /api/contents/trash-plan`): deletable now, unfinished Tasks to cancel first, frozen by
 * a running collection summary, already in the trash, gone. The confirm button names the action
 * and the count. Each Content is moved on its own: when all of them went, the dialog closes
 * and a toast says so; when some failed it stays open with a report of which and why.
 * `onSettled` gets the ids no longer in the library, so a selection keeps only the failures.
 */
export function DeleteContentsDialog(props: {
  contentIds: readonly string[] | undefined;
  onOpenChange: (open: boolean) => void;
  onSettled?: (outcome: DeleteOutcome) => void;
}) {
  const { contentIds, onSettled } = props;
  const targets = useMemo(() => contentIds?.map((id) => ({ id })), [contentIds]);
  return <DeleteDialog targets={targets} single={false} onOpenChange={props.onOpenChange} {...(onSettled === undefined ? {} : { onSettled })} />;
}

interface Tally {
  byState: Record<ContentTrashPlanState, ContentTrashPlanItemDto[]>;
  /** Contents the confirm acts on: deletable now, or after cancelling their Tasks. */
  actionable: string[];
  /** Contents nothing needs doing to: already in the trash, or not there at all. */
  settled: string[];
}

function tallyOf(items: readonly ContentTrashPlanItemDto[]): Tally {
  const byState: Tally["byState"] = { ready: [], tasks: [], blocked: [], trashed: [], missing: [] };
  for (const item of items) byState[item.state].push(item);
  return {
    byState,
    actionable: [...byState.ready, ...byState.tasks].map((item) => item.contentId),
    settled: [...byState.trashed, ...byState.missing].map((item) => item.contentId),
  };
}

function DeleteDialog(props: {
  targets: readonly DeleteTarget[] | undefined;
  single: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
  onSettled?: (outcome: DeleteOutcome) => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  const toast = useToast();
  const navigate = useNavigate();
  const { targets, single } = props;
  const open = targets !== undefined;
  const ids = useMemo(() => targets?.map((target) => target.id) ?? [], [targets]);

  // Every opening is a new session: a fresh pre-check, no leftover error or report.
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | undefined>(undefined);
  const [report, setReport] = useState<ContentTrashResultDto | undefined>(undefined);
  const [showBlocked, setShowBlocked] = useState(false);
  // The server refused because a Task started after the pre-check: nothing was deleted.
  const [planChanged, setPlanChanged] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSession((current) => current + 1);
      setError(undefined);
      setReport(undefined);
      setShowBlocked(false);
      setPlanChanged(false);
    }
  }

  const plan = useQuery({
    queryKey: ["content-trash-plan", session, ids],
    queryFn: ({ signal }) => client.post("/api/contents/trash-plan", contentTrashPlanDtoSchema, { body: { contentIds: ids }, signal }),
    enabled: open && ids.length > 0,
    // Read once per opening: a later read could change the counts under the user's eyes.
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const tally = plan.data === undefined ? undefined : tallyOf(plan.data.items);
  const withTasks = (tally?.byState.tasks.length ?? 0) > 0;
  const count = tally?.actionable.length ?? 0;

  const titleOf = (contentId: string): string =>
    plan.data?.items.find((item) => item.contentId === contentId)?.title ?? targets?.find((target) => target.id === contentId)?.title ?? t("library.untitled");

  const close = (): void => props.onOpenChange(false);

  const settle = async (result: ContentTrashResultDto, planned: Tally): Promise<void> => {
    const moved = [...result.trashedIds, ...result.alreadyTrashedIds];
    if (moved.length > 0) props.onDeleted?.();
    for (const contentId of moved) {
      // A trashed Content answers 404 everywhere; a refetch would only show that.
      queryClient.removeQueries({ queryKey: queryKeys.content(contentId) });
      // Its notes are hidden with it; the groups list loses its row. The dismissed cache
      // card is kept: a restore brings the Content back exactly as it was.
      queryClient.removeQueries({ queryKey: noteKeys.contentAll(contentId) });
    }
    for (const contentId of result.trashedIds) contentEvents.publish({ type: "trashed", contentId });
    await Promise.all([
      refreshContentViews(queryClient),
      // Cancelled tasks leave the task panel; its own events may come later than this.
      ...(result.cancelledTaskCount > 0 ? [queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll })] : []),
    ]);
    props.onSettled?.({ removedIds: [...moved, ...planned.settled] });
    if (result.failed.length === 0) {
      toast.show({
        tone: "success",
        message: t("library.deleteContent.done", { count: moved.length }),
        action: { label: t("library.deleteContent.openTrash"), onClick: () => void navigate("/trash") },
      });
      close();
    } else {
      setReport(result);
    }
  };

  const confirm = async (): Promise<void> => {
    if (tally === undefined || tally.actionable.length === 0) return;
    setBusy(true);
    setError(undefined);
    setPlanChanged(false);
    try {
      const only = tally.actionable[0] as string;
      // One Content without Tasks keeps its own endpoint; cancelling first goes through the batch one.
      const result =
        single && !withTasks
          ? await client.delete(`/api/contents/${encodeURIComponent(only)}`, z.undefined()).then(() => ({ trashedIds: [only], alreadyTrashedIds: [], failed: [], cancelledTaskCount: 0 }))
          : await client.post("/api/contents/trash", contentTrashResultDtoSchema, { body: { contentIds: tally.actionable, cancelTasks: withTasks } });
      await settle(result, tally);
    } catch (caught) {
      const appError = appErrorOf(caught);
      if (appError.code === "conflict.tasks_unfinished") {
        // A Task started after the pre-check, so the plan on screen is out of date: the dialog
        // stays, says nothing was deleted and reads the plan again, whose answer turns the
        // confirm into cancelling the Tasks first.
        setPlanChanged(true);
        void plan.refetch();
      } else {
        setError(appError);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmLabel = single
    ? t(withTasks ? "library.deleteContent.confirmCancelTasks" : "library.deleteContent.confirm")
    : t(withTasks ? "library.deleteContent.confirmManyCancelTasks" : "library.deleteContent.confirmMany", { count });

  const namesOf = (items: readonly ContentTrashPlanItemDto[]): string => {
    const seen = new Map<string, string | undefined>();
    for (const item of items) for (const collection of item.blockingCollections ?? []) seen.set(collection.id, collection.name);
    return [...seen.values()]
      .map((name) => (name === undefined ? t("library.deleteContent.plan.unnamedCollection") : t("library.deleteContent.plan.collectionName", { name })))
      .join(t("library.deleteContent.plan.nameSeparator"));
  };

  let body: ReactNode;
  if (report !== undefined) {
    body = <ResultReport result={report} titleOf={titleOf} />;
  } else if (plan.isError && !plan.isFetching) {
    body = (
      <div data-testid="delete-plan-error">
        <ErrorView error={appErrorOf(plan.error)}>
          <Button size="sm" onClick={() => void plan.refetch()} data-testid="delete-plan-retry">
            {t("common.action.retry")}
          </Button>
        </ErrorView>
      </div>
    );
  } else if (tally === undefined || plan.isFetching) {
    body = <SkeletonRows count={single ? 1 : 3} rowHeight={20} testId="delete-plan-loading" />;
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {single ? (
          <SingleState tally={tally} names={namesOf(tally.byState.blocked)} />
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm" aria-label={t("library.deleteContent.plan.label")} data-testid="delete-plan">
            {PLAN_ROWS.map((state) => {
              const items = tally.byState[state];
              if (items.length === 0) return null;
              const label =
                state === "blocked"
                  ? t("library.deleteContent.plan.blocked", { count: items.length, names: namesOf(items) })
                  : t(`library.deleteContent.plan.${state}`, { count: items.length });
              return (
                <li key={state} data-testid={`delete-plan-${state}`}>
                  <span>{label}</span>
                  {state === "blocked" ? (
                    <>
                      {" "}
                      <TextAction className="inline-flex items-center gap-0.5 text-note" aria-expanded={showBlocked} onClick={() => setShowBlocked((shown) => !shown)} data-testid="delete-plan-blocked-toggle">
                        {showBlocked ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        {t(showBlocked ? "library.deleteContent.plan.hideBlocked" : "library.deleteContent.plan.showBlocked")}
                      </TextAction>
                      {showBlocked ? (
                        <ul className="mt-1 ml-4 flex list-disc flex-col gap-0.5 pl-4 text-note text-muted" data-testid="delete-plan-blocked-items">
                          {items.map((item) => (
                            <li key={item.contentId}>{titleOf(item.contentId)}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {withTasks ? (
          <Callout tone="warn" density="compact" testId="delete-tasks-note">
            {t("library.deleteContent.tasksNote")}
          </Callout>
        ) : null}
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      title={single ? t("library.deleteContent.title") : t("library.deleteContent.titleMany", { count: ids.length })}
      description={t("library.deleteContent.description", { days: TRASH_RETENTION_DAYS })}
      testId="delete-content-dialog"
      footer={
        report !== undefined ? (
          <Button onClick={close} data-testid="delete-close">
            {t("common.action.close")}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{t("common.action.cancel")}</Button>
            <Button variant="danger-solid" loading={busy} disabled={tally === undefined || plan.isFetching || count === 0} onClick={() => void confirm()} data-testid="delete-confirm">
              {confirmLabel}
            </Button>
          </>
        )
      }
    >
      {/* The one Content is named from the start; the pre-check only adds what stands in its way. */}
      {single && report === undefined ? (
        <p className="mb-2 text-sm font-medium break-words" data-testid="delete-single-title">
          {t("library.deleteContent.single.title", { title: titleOf(ids[0] ?? "") })}
        </p>
      ) : null}
      {planChanged && report === undefined ? (
        <Callout tone="warn" density="compact" announce="alert" className="mb-3" testId="delete-plan-changed">
          {t("library.deleteContent.planChanged")}
        </Callout>
      ) : null}
      {body}
      {error === undefined ? null : (
        <div className="mt-3">
          <ErrorView error={error} />
        </div>
      )}
    </Modal>
  );
}

/** The single dialog: unless the Content can simply go, what stands in its way. */
function SingleState(props: { tally: Tally; names: string }) {
  const { t } = useTranslation();
  const { byState } = props.tally;
  const tasks = byState.tasks[0]?.unfinishedTaskCount ?? 0;
  const note =
    byState.tasks.length > 0
      ? t("library.deleteContent.single.tasks", { count: tasks })
      : byState.blocked.length > 0
        ? t("library.deleteContent.single.blocked", { names: props.names })
        : byState.trashed.length > 0
          ? t("library.deleteContent.single.trashed")
          : byState.missing.length > 0
            ? t("library.deleteContent.single.missing")
            : undefined;
  return note === undefined ? null : (
    <p className="text-note text-muted" data-testid="delete-single-state">
      {note}
    </p>
  );
}

/** Which Contents could not be moved and why, after a partly failed deletion. */
function ResultReport(props: { result: ContentTrashResultDto; titleOf: (contentId: string) => string }) {
  const { t } = useTranslation();
  const { result } = props;
  const trashed = result.trashedIds.length + result.alreadyTrashedIds.length;
  return (
    <div className="flex flex-col gap-2 text-sm" role="status" data-testid="delete-report">
      <p>
        {t("library.deleteContent.report.summary", { trashed, failed: result.failed.length })}
        {result.cancelledTaskCount > 0 ? ` ${t("library.deleteContent.report.cancelled", { count: result.cancelledTaskCount })}` : ""}
      </p>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label={t("library.deleteContent.report.label")}>
        {result.failed.map((failure) => (
          <li key={failure.contentId} className="flex items-start gap-2 px-3 py-2" data-testid="delete-report-item" data-content-id={failure.contentId}>
            <CircleAlert size={14} className="mt-[3px] shrink-0 text-danger" aria-hidden="true" />
            <div className="min-w-0">
              <p className="break-words">{props.titleOf(failure.contentId)}</p>
              <p className="text-note text-muted">{t(`library.deleteContent.reason.${failure.reason}`)}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
