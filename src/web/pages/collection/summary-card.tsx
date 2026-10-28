import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CollectionSummaryDto } from "../../../shared/dto/collection.ts";
import type { TaskDto } from "../../../shared/dto/task.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { FailedTaskNotice } from "../../components/failed-task-notice.tsx";
import { RichText } from "../../components/rich-text.tsx";
import { TaskFlow } from "../../components/task-flow.tsx";
import { Button } from "../../ui/button.tsx";
import { useStoredValue } from "../../use-stored-value.ts";

/** Per collection, whether the user opened the summary card; it starts closed so the lectures stay in view. */
export function summaryExpandedKey(collectionId: string): string {
  return `amber.collection.summaryExpanded.${collectionId}`;
}

/** Per collection, the failed summary Task whose flow the user closed. */
export function summaryFailureDismissedKey(collectionId: string): string {
  return `amber.collection.summaryFailureDismissed.${collectionId}`;
}

/**
 * The collection's rollup summary: generated only on explicit request,
 * partials expandable once the final is published, stale reasons shown on top. Once there is
 * one (shown or withheld), it can be summarised again or deleted as a whole behind a
 * confirmation; both wait while a summary Task is unfinished. The card folds away its body
 * (closed by default, remembered per collection) but never the actions, notices or a summary
 * Task's flow. The summary carries no citations, so its text has nothing to jump to.
 */
export function SummaryCard(props: {
  collectionId: string;
  summary: CollectionSummaryDto;
  /** The collection's most recent summary Task, offered for a re-run when it failed. */
  latestTask?: TaskDto | null | undefined;
  onGenerate: () => void;
  generating?: boolean;
  /** Deletes every revision of the summary; settles once the card's data is read again. */
  onDelete: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [showPartials, setShowPartials] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expandedValue, setExpandedValue] = useStoredValue(summaryExpandedKey(props.collectionId));
  const bodyId = useId();
  const { summary } = props;
  const current = summary.current;
  const exists = current !== undefined || summary.hiddenReason !== undefined;
  const busy = summary.activeTaskId !== undefined;
  const expanded = expandedValue === "1";
  // A withheld summary has no body to fold, so it gets no toggle.
  const foldable = current !== undefined && summary.hiddenReason === undefined;
  const bodyShown = expanded && foldable;
  const toggle = (): void => setExpandedValue(expanded ? undefined : "1");
  return (
    <section className="rounded-lg border border-line p-4" aria-label={t("library.summary.title")} data-testid="collection-summary">
      <div className="mb-2 flex items-center justify-between gap-3">
        {foldable ? (
          <h2 className="text-sm font-semibold">
            <button
              type="button"
              className="-mx-1 flex items-center gap-1 rounded px-1 hover:bg-sunken"
              aria-expanded={expanded}
              aria-controls={bodyShown ? bodyId : undefined}
              title={t(expanded ? "library.summary.collapse" : "library.summary.expand")}
              onClick={toggle}
              data-testid="collection-summary-toggle"
            >
              {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              {t("library.summary.title")}
            </button>
          </h2>
        ) : (
          <h2 className="text-sm font-semibold">{t("library.summary.title")}</h2>
        )}
        {exists ? (
          <div className="flex items-center gap-2" data-testid="collection-summary-actions">
            <Button size="sm" disabled={busy || props.generating === true} onClick={props.onGenerate}>
              {t("library.summary.regenerate")}
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              {t("library.summary.delete")}
            </Button>
          </div>
        ) : null}
      </div>
      {summary.activeTaskId === undefined ? null : (
        <div className="mb-3">
          <TaskFlow taskId={summary.activeTaskId} />
        </div>
      )}
      {summary.activeTaskId === undefined ? (
        <FailedTaskNotice
          className="mb-3"
          task={props.latestTask}
          storageKey={summaryFailureDismissedKey(props.collectionId)}
          message={t("library.summary.failed")}
          testId="collection-summary-failed"
        />
      ) : null}
      {summary.hiddenReason !== undefined ? (
        // The body is withheld while a summarised member is in the trash; saying "not
        // generated yet" here would invite summarising again for no reason.
        <p className="rounded bg-sunken px-3 py-2 text-sm text-muted" role="status" data-testid="collection-summary-hidden">
          {t(`library.summary.hidden.${summary.hiddenReason}`)}
        </p>
      ) : summary.stale && summary.staleReason !== undefined ? (
        <p className="mb-3 rounded bg-accent-soft px-3 py-2 text-xs text-accent" role="status">
          {t(`library.summary.stale.${summary.staleReason}`)}
        </p>
      ) : null}
      {summary.hiddenReason !== undefined ? null : current === undefined ? (
        summary.activeTaskId === undefined ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm">{t("library.summary.notGenerated")}</p>
            <p className="text-xs text-muted">{t("library.summary.notGeneratedHint")}</p>
            <Button variant="primary" disabled={props.generating === true} onClick={props.onGenerate}>
              {t("library.summary.generate")}
            </Button>
          </div>
        ) : null
      ) : bodyShown ? (
        <div id={bodyId} data-testid="collection-summary-body">
          {current.quality === "degraded" ? <p className="mb-2 text-xs text-muted">{t("library.summary.degraded")}</p> : null}
          <RichText source={current.body} />
          {current.partials.length === 0 ? null : (
            <div className="mt-4 border-t border-line pt-3">
              <button type="button" className="flex items-center gap-1 text-xs text-muted hover:underline" aria-expanded={showPartials} onClick={() => setShowPartials(!showPartials)}>
                {showPartials ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t("library.summary.partials", { count: current.partials.length })}
              </button>
              {showPartials ? (
                <ol className="mt-2 flex flex-col gap-3">
                  {[...current.partials]
                    .sort((a, b) => a.index - b.index)
                    .map((partial) => (
                      <li key={partial.id} className="rounded bg-panel p-3">
                        <p className="mb-1 text-xs font-medium text-muted">{t("library.summary.partial", { n: partial.index + 1 })}</p>
                        <RichText source={partial.body} />
                      </li>
                    ))}
                </ol>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("library.summary.deleteTitle")}
        description={t("library.summary.deleteDescription")}
        confirmLabel={t("library.summary.delete")}
        danger
        onConfirm={props.onDelete}
      />
    </section>
  );
}
