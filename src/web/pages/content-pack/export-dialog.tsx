import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CONTENT_PACK_FILE_EXTENSION } from "../../../shared/backup-names.ts";
import type { ContentPackExportJobDto, ContentPackExportPlanDto, ExportPlanContent } from "../../../shared/dto/content-pack.ts";
import type { AppError } from "../../../shared/errors.ts";
import { useApi } from "../../api/context.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { localTimeStamp, pickPackDestination } from "../../desktop/bridge.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { formatDateTime } from "../../format.ts";
import { Button, buttonClass } from "../../ui/button.tsx";
import { Checkbox } from "../../ui/checkbox.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { Callout, InlineNote, NOTE_TEXT_CLASS } from "../../ui/notice.tsx";
import { BlockedCard, ExportCard, useSummaryLine } from "./export-card.tsx";
import {
  applyToContent,
  buildSelection,
  cardHints,
  carriedMembers,
  choiceSummary,
  choiceValid,
  defaultChoice,
  exportableContents,
  suggestedPackName,
  totalBytes,
  type ApplyTemplate,
  type ExportChoice,
} from "./export-model.ts";
import { cancelExport, downloadUrl, fetchExportPlan, packKeys, startExport, useActivePackJobs, useExportJob } from "./pack-api.ts";
import { bytesLabel, titleOf } from "./pack-labels.ts";

/** What the wizard exports: Contents in the order they were picked, and the page it was opened from. */
export interface ExportRequest {
  contentIds: readonly string[];
  /** Opened from a collection page: that collection starts ticked, the Contents' other collections do not. */
  collectionId?: string;
  /** The card that starts open: the Content the user was on. */
  focusContentId?: string;
}

const FooterTarget = createContext<HTMLElement | null>(null);

/**
 * A wide sectioned dialog whose footer the step showing inside fills, through `PackFooter`: the
 * buttons and the totals belong to the step, yet stay in view below the scrolling body.
 */
export function PackModal(props: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <Modal
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      size="wide"
      footer={<div ref={setTarget} className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-2" data-testid="pack-dialog-footer" />}
    >
      <FooterTarget.Provider value={target}>{props.children}</FooterTarget.Provider>
    </Modal>
  );
}

/**
 * The buttons of the step on show, in the footer of the `PackModal` around it, cancel first;
 * `status` (totals, what still blocks the main action) reads at the footer's left end. Every
 * step renders one, so the footer is never an empty bar.
 */
export function PackFooter(props: { children: ReactNode; status?: ReactNode }) {
  const target = useContext(FooterTarget);
  if (target === null) return null;
  return createPortal(
    <>
      {props.status === undefined ? null : <div className="min-w-0 flex-1 basis-48 text-note text-muted">{props.status}</div>}
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{props.children}</div>
    </>,
    target,
  );
}

/**
 * The export wizard. It reads the export plan of the picked Contents, lets the user decide
 * card by card, shows a confirmation with the dependency check, the size and the warning
 * that a pack is not encrypted, and then follows the job: the desktop client writes the pack
 * where the user saved it, server mode offers it as a plain download. A job already running
 * for the user (opened again after a reload) is shown instead of a new plan.
 */
export function ExportPackDialog(props: { open: boolean; onClose: () => void; request: ExportRequest | undefined; resumeJobId?: string | undefined }) {
  const { t } = useTranslation();
  return (
    <PackModal open={props.open} onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("contentPack.export.title")}>
      {props.open ? <ExportFlow request={props.request} resumeJobId={props.resumeJobId} onClose={props.onClose} /> : null}
    </PackModal>
  );
}

type Step = { step: "choose" } | { step: "confirm" } | { step: "job"; jobId: string };

/** The editor's state, kept while a failed or cancelled job is shown so 「返回修改」 finds the choices as they were. */
interface EditorMemory {
  choices?: Map<string, ExportChoice>;
  collections?: ReadonlySet<string>;
  expanded?: ReadonlySet<string>;
}

function ExportFlow(props: { request: ExportRequest | undefined; resumeJobId: string | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const active = useActivePackJobs(props.resumeJobId === undefined);
  const [step, setStep] = useState<Step>(props.resumeJobId === undefined ? { step: "choose" } : { step: "job", jobId: props.resumeJobId });
  const memory = useRef<EditorMemory>({});
  // A job still running from before takes the place of a new plan: one pack job per user.
  const running = props.resumeJobId === undefined ? active.data?.exportJobId : undefined;
  useEffect(() => {
    if (running !== undefined) setStep({ step: "job", jobId: running });
  }, [running]);
  const shown: Step = running !== undefined && step.step !== "job" ? { step: "job", jobId: running } : step;
  if (shown.step === "job") {
    return <ExportJobView jobId={shown.jobId} onBack={props.request === undefined ? undefined : () => setStep({ step: "choose" })} onClose={props.onClose} />;
  }
  if (props.request === undefined || active.isPending) return <LoadingStep onClose={props.onClose} />;
  return <ExportChoices request={props.request} memory={memory} step={shown.step} setStep={setStep} importRunning={active.data?.importJobId !== undefined} onClose={props.onClose} />;
}

/** A step still reading, with the way out the footer always offers. */
function LoadingStep(props: { onClose: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      {props.children ?? <Loading />}
      <PackFooter>
        <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
      </PackFooter>
    </>
  );
}

function ExportChoices(props: {
  request: ExportRequest;
  memory: MutableRefObject<EditorMemory>;
  step: "choose" | "confirm";
  setStep: (step: Step) => void;
  importRunning: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const { contentIds, collectionId, focusContentId } = props.request;
  const plan = useQuery({
    queryKey: packKeys.plan(contentIds, collectionId),
    queryFn: () => fetchExportPlan(client, contentIds, collectionId),
    // Each opening reads what is there now: revisions, files and tasks change between openings.
    staleTime: 0,
    gcTime: 0,
  });
  if (plan.isPending) {
    return (
      <LoadingStep onClose={props.onClose}>
        <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
          {t("contentPack.export.loading")}
        </p>
      </LoadingStep>
    );
  }
  if (plan.isError) {
    return (
      <>
        <ErrorView error={appErrorOf(plan.error)}>
          <Button size="sm" onClick={() => void plan.refetch()} data-testid="pack-export-plan-retry">
            {t("common.action.retry")}
          </Button>
        </ErrorView>
        <PackFooter>
          <Button onClick={props.onClose}>{t("contentPack.export.close")}</Button>
        </PackFooter>
      </>
    );
  }
  return (
    <PlanEditor
      plan={plan.data}
      request={props.request}
      memory={props.memory}
      focusContentId={focusContentId}
      step={props.step}
      setStep={props.setStep}
      importRunning={props.importRunning}
      onClose={props.onClose}
    />
  );
}

function PlanEditor(props: {
  plan: ContentPackExportPlanDto;
  request: ExportRequest;
  memory: MutableRefObject<EditorMemory>;
  focusContentId: string | undefined;
  step: "choose" | "confirm";
  setStep: (step: Step) => void;
  importRunning: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const desktop = useDesktop();
  const { plan } = props;
  const exportable = useMemo(() => exportableContents(plan), [plan]);
  const remembered = props.memory.current;
  const [choices, setChoices] = useState<Map<string, ExportChoice>>(
    () => new Map(exportable.map((content) => [content.contentId, remembered.choices?.get(content.contentId) ?? defaultChoice(content)])),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    if (remembered.expanded !== undefined) return remembered.expanded;
    const focus = props.focusContentId !== undefined && exportable.some((content) => content.contentId === props.focusContentId) ? props.focusContentId : exportable[0]?.contentId;
    return new Set(focus === undefined ? [] : [focus]);
  });
  const [collections, setCollections] = useState<ReadonlySet<string>>(() => {
    if (remembered.collections !== undefined) return remembered.collections;
    const from = props.request.collectionId;
    // From a collection page only that collection starts ticked; elsewhere every collection does.
    return new Set(plan.collections.filter((collection) => from === undefined || collection.collectionId === from).map((collection) => collection.collectionId));
  });
  useEffect(() => {
    props.memory.current = { choices, collections, expanded };
  }, [props.memory, choices, collections, expanded]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [startError, setStartError] = useState<AppError | undefined>(undefined);
  const choiceOf = (content: ExportPlanContent): ExportChoice => choices.get(content.contentId) ?? defaultChoice(content);
  const exportableIds = new Set(exportable.map((content) => content.contentId));
  const invalid = exportable.filter((content) => !choiceValid(content, choiceOf(content)));
  const size = totalBytes(plan, choices);
  const blocked = plan.contents.filter((content) => content.blocked !== undefined);

  const applyAll = (from: ExportPlanContent, template: ApplyTemplate): void => {
    setChoices((current) => {
      const next = new Map(current);
      for (const content of exportable) {
        if (content.contentId !== from.contentId) next.set(content.contentId, applyToContent(content, current.get(content.contentId) ?? defaultChoice(content), template));
      }
      return next;
    });
  };

  const start = useMutation({
    mutationFn: async (): Promise<string | undefined> => {
      setNotice(undefined);
      const selection = buildSelection(plan, choices, collections);
      if (desktop) {
        const collectionName = plan.collections.find((collection) => collection.collectionId === props.request.collectionId)?.name;
        const name = suggestedPackName({
          titles: exportable.map((content) => content.title),
          collectionName,
          fallback: t("contentPack.export.title"),
          stamp: localTimeStamp(new Date()).slice(0, 13),
          extension: CONTENT_PACK_FILE_EXTENSION,
        });
        let picked;
        try {
          picked = await pickPackDestination(name);
        } catch (error) {
          setNotice(t("contentPack.export.shellRefused", { reason: error instanceof Error ? error.message : String(error) }));
          return undefined;
        }
        if (picked === null) {
          setNotice(t("contentPack.export.pickCancelled"));
          return undefined;
        }
        return startExport(client, selection, picked.grant);
      }
      return startExport(client, selection, undefined);
    },
    onMutate: () => setStartError(undefined),
    onSuccess: (jobId) => {
      void queryClient.invalidateQueries({ queryKey: packKeys.active });
      if (jobId !== undefined) props.setStep({ step: "job", jobId });
    },
    onError: (error) => {
      const appError = appErrorOf(error);
      if (appError.code === "conflict.pack_job_active") void queryClient.invalidateQueries({ queryKey: packKeys.active });
      setStartError(appError);
    },
  });

  if (exportable.length === 0) {
    return (
      <div className="flex flex-col gap-3 text-sm" data-testid="pack-export">
        <p>{t("contentPack.export.nothingSelectable")}</p>
        {blocked.map((content) => (
          <BlockedCard key={content.contentId} content={content} />
        ))}
        <PackFooter>
          <Button onClick={props.onClose}>{t("contentPack.export.close")}</Button>
        </PackFooter>
      </div>
    );
  }

  if (props.step === "confirm") {
    return (
      <ExportConfirm
        plan={plan}
        choices={choices}
        collections={collections}
        size={size}
        desktop={desktop}
        busy={start.isPending}
        notice={notice}
        error={startError}
        importRunning={props.importRunning}
        onBack={() => props.setStep({ step: "choose" })}
        onStart={() => start.mutate()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pack-export">
      <p className="text-muted">{plan.contents.length === 1 ? t("contentPack.export.introSingle") : t("contentPack.export.intro", { count: plan.contents.length })}</p>
      <div className="flex flex-col gap-2">
        {plan.contents.map((content) =>
          content.blocked !== undefined ? (
            <BlockedCard key={content.contentId} content={content} />
          ) : (
            <ExportCard
              key={content.contentId}
              content={content}
              choice={choiceOf(content)}
              onChange={(choice) => setChoices((current) => new Map(current).set(content.contentId, choice))}
              expanded={expanded.has(content.contentId)}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(content.contentId)) next.delete(content.contentId);
                  else next.add(content.contentId);
                  return next;
                })
              }
              others={exportable.length - 1}
              onApplyAll={(template) => applyAll(content, template)}
            />
          ),
        )}
      </div>
      {plan.collections.length === 0 ? null : (
        <fieldset className="mt-2 min-w-0" data-testid="pack-export-collections">
          <legend className="mb-1 text-sm font-medium">{t("contentPack.export.collections.title")}</legend>
          <p className={`mb-2 ${NOTE_TEXT_CLASS}`}>{t("contentPack.export.collections.intro")}</p>
          <ul className="flex flex-col gap-1.5">
            {plan.collections.map((collection) => {
              const carried = carriedMembers(collection, exportableIds);
              return (
                <li key={collection.collectionId}>
                  <Checkbox
                      labelClassName="items-start! text-sm"
                      className="mt-0.5"
                      checked={carried > 0 && collections.has(collection.collectionId)}
                      disabled={carried === 0}
                      onChange={(event) =>
                        setCollections((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(collection.collectionId);
                          else next.delete(collection.collectionId);
                          return next;
                        })
                      }
                      data-testid="pack-collection"
                      data-collection-id={collection.collectionId}
                    >
                      <span className="break-words">{collection.name}</span>
                      <span className="ml-2 text-xs text-muted">
                        {carried === 0 ? t("contentPack.export.collections.noneCarried") : t("contentPack.export.collections.carried", { carried, total: collection.memberCount })}
                      </span>
                    </Checkbox>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <PackFooter
        status={
          <div aria-live="polite">
            <span>{t("contentPack.export.totalContents", { count: exportable.length })}</span>
            {t("contentPack.separator")}
            <span data-testid="pack-export-total">{t("contentPack.export.total", { size: bytesLabel(size) })}</span>
            {invalid.length > 0 ? <span className="ml-2 text-danger">{t("contentPack.export.fixProblems", { count: invalid.length })}</span> : null}
          </div>
        }
      >
        <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
        <Button variant="primary" disabled={invalid.length > 0} onClick={() => props.setStep({ step: "confirm" })} data-testid="pack-export-next">
          {t("contentPack.export.next")}
        </Button>
      </PackFooter>
    </div>
  );
}

/** Counts of every dependency the choices resolved or left, for the confirmation. */
function dependencyChecks(plan: ContentPackExportPlanDto, choices: ReadonlyMap<string, ExportChoice>) {
  const checks = { translationParents: 0, standalone: 0, noTranscript: 0, notesLeft: 0, figuresByTime: 0 };
  for (const content of exportableContents(plan)) {
    for (const hint of cardHints(content, choices.get(content.contentId) ?? defaultChoice(content))) {
      if (hint.kind === "translationParents") checks.translationParents += 1;
      else if (hint.kind === "standalone") checks.standalone += 1;
      else if (hint.kind === "noTranscript") checks.noTranscript += 1;
      else if (hint.kind === "notesOnUnselected") checks.notesLeft += hint.count;
      else if (hint.kind === "figuresOnUnselected") checks.figuresByTime += hint.count;
    }
  }
  return checks;
}

function ExportConfirm(props: {
  plan: ContentPackExportPlanDto;
  choices: ReadonlyMap<string, ExportChoice>;
  collections: ReadonlySet<string>;
  size: number;
  desktop: boolean;
  busy: boolean;
  notice: string | undefined;
  error: AppError | undefined;
  importRunning: boolean;
  onBack: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const summaryLine = useSummaryLine();
  const { plan } = props;
  const exportable = exportableContents(plan);
  const blocked = plan.contents.filter((content) => content.blocked !== undefined);
  const checks = dependencyChecks(plan, props.choices);
  const lines: string[] = [];
  if (checks.translationParents > 0) lines.push(t("contentPack.export.confirm.checkTranslationParents", { count: checks.translationParents }));
  if (checks.standalone > 0) lines.push(t("contentPack.export.confirm.checkStandalone", { count: checks.standalone }));
  if (checks.noTranscript > 0) lines.push(t("contentPack.export.confirm.checkNoTranscript", { count: checks.noTranscript }));
  if (checks.notesLeft > 0) lines.push(t("contentPack.export.confirm.checkNotesLeft", { count: checks.notesLeft }));
  if (checks.figuresByTime > 0) lines.push(t("contentPack.export.confirm.checkFiguresByTime", { count: checks.figuresByTime }));
  const selection = buildSelection(plan, props.choices, props.collections);
  const collectionNames = plan.collections.filter((collection) => selection.collectionIds.includes(collection.collectionId)).map((collection) => collection.name);
  const busyJob = props.error?.code === "conflict.pack_job_active" || props.importRunning;
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="pack-export-confirm">
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted">{t("contentPack.export.confirm.contents")}</h3>
        <ul className="flex flex-col gap-1">
          {exportable.map((content) => (
            <li key={content.contentId} className="min-w-0">
              <span className="block truncate font-medium" title={titleOf(content.title, t)}>
                {titleOf(content.title, t)}
              </span>
              <span className="block text-xs text-muted">{summaryLine(choiceSummary(content, props.choices.get(content.contentId) ?? defaultChoice(content)), content)}</span>
            </li>
          ))}
        </ul>
        {blocked.length === 0 ? null : (
          <p className={`mt-1.5 ${NOTE_TEXT_CLASS}`}>{t("contentPack.export.confirm.skipped", { titles: blocked.map((content) => t("contentPack.quoted", { text: titleOf(content.title, t) })).join(t("contentPack.listSeparator")) })}</p>
        )}
        <p className={`mt-1.5 ${NOTE_TEXT_CLASS}`}>
          {collectionNames.length === 0 ? t("contentPack.export.confirm.noCollections") : t("contentPack.export.confirm.collections", { names: collectionNames.map((name) => t("contentPack.quoted", { text: name })).join(t("contentPack.listSeparator")) })}
        </p>
      </section>
      <section data-testid="pack-export-checks">
        <h3 className="mb-1.5 text-xs font-medium text-muted">{t("contentPack.export.confirm.checks")}</h3>
        {lines.length === 0 ? (
          <p>{t("contentPack.export.confirm.checksOk")}</p>
        ) : (
          <ul className="list-disc pl-5">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>
      <p className="font-medium" data-testid="pack-export-size">
        {t("contentPack.export.confirm.size", { size: bytesLabel(props.size) })}
      </p>
      {/* Read before the pack is written: once it leaves, nothing in it is protected. */}
      <Callout tone="warn" testId="pack-export-notice">
        <ul className="flex flex-col gap-1">
          <li className="font-medium">{t("contentPack.export.confirm.unencrypted")}</li>
          <li className="text-note text-muted">{t("contentPack.export.confirm.noSecrets")}</li>
        </ul>
      </Callout>
      {props.notice === undefined ? null : <InlineNote role="status">{props.notice}</InlineNote>}
      {props.error === undefined ? null : busyJob ? (
        <Callout tone="warn" announce="alert">
          {t("contentPack.export.jobBusy")}
        </Callout>
      ) : (
        <ErrorView error={props.error} />
      )}
      {props.importRunning && props.error === undefined ? <InlineNote>{t("contentPack.export.jobBusy")}</InlineNote> : null}
      <PackFooter>
        <Button onClick={props.onBack} disabled={props.busy}>
          {t("contentPack.export.back")}
        </Button>
        <Button variant="primary" loading={props.busy} disabled={props.importRunning} onClick={props.onStart} data-testid="pack-export-start">
          {props.desktop ? t("contentPack.export.confirm.startDesktop") : t("contentPack.export.confirm.startServer")}
        </Button>
      </PackFooter>
    </div>
  );
}

/** A running or finished export: progress and 「取消导出」, then the file, or why it failed. */
function ExportJobView(props: { jobId: string; onBack: (() => void) | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const job = useExportJob(props.jobId);
  const cancel = useMutation({
    mutationFn: () => cancelExport(client, props.jobId),
    onSuccess: (data) => {
      queryClient.setQueryData(packKeys.exportJob(props.jobId), data);
      void queryClient.invalidateQueries({ queryKey: packKeys.active });
    },
  });
  const status = job.data?.status;
  useEffect(() => {
    if (status !== undefined && status !== "running") void queryClient.invalidateQueries({ queryKey: packKeys.active });
  }, [status, queryClient]);
  if (job.isError) {
    return (
      <>
        <ErrorView error={appErrorOf(job.error)} />
        <PackFooter>
          <Button onClick={props.onClose}>{t("contentPack.export.close")}</Button>
        </PackFooter>
      </>
    );
  }
  if (job.data === undefined) {
    return (
      <>
        <Loading />
        <PackFooter>
          <Button onClick={props.onClose}>{t("contentPack.export.close")}</Button>
        </PackFooter>
      </>
    );
  }
  return <ExportJobBody job={job.data} cancelling={cancel.isPending} onCancel={() => cancel.mutate()} onBack={props.onBack} onClose={props.onClose} />;
}

function ExportJobBody(props: { job: ContentPackExportJobDto; cancelling: boolean; onCancel: () => void; onBack: (() => void) | undefined; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const { job } = props;
  const result = job.result;
  const expired = result?.expiresAt !== undefined && result.expiresAt <= Date.now();
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pack-export-job" data-status={job.status}>
      {job.status === "running" ? (
        <div role="status" aria-live="polite">
          <p className="mb-1.5 font-medium">
            {t("contentPack.export.running")}
            {t("contentPack.separator")}
            {t(`contentPack.phase.export.${job.phase}`)}
          </p>
          <progress className="h-1.5 w-full" max={Math.max(1, job.bytesTotal)} value={Math.min(job.bytesDone, job.bytesTotal)} aria-label={t("contentPack.export.running")} />
          <p className="mt-1 text-xs text-muted">{t("contentPack.progressBytes", { done: bytesLabel(job.bytesDone), total: bytesLabel(job.bytesTotal) })}</p>
        </div>
      ) : null}
      {job.status === "succeeded" && result !== undefined ? (
        <div className="rounded-md border border-line p-3" role="status">
          <p className="font-medium text-ok">{t("contentPack.export.succeeded")}</p>
          {result.downloadPath === undefined ? (
            <p className="mt-1 break-all" data-testid="pack-export-saved">
              {t("contentPack.export.savedAs", { name: result.fileName })}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted">{t("contentPack.export.resultDetail", { count: result.contents, size: bytesLabel(result.sizeBytes) })}</p>
          {result.downloadPath === undefined ? null : expired ? (
            <p className={`mt-2 ${NOTE_TEXT_CLASS}`}>{t("contentPack.export.expired")}</p>
          ) : (
            <div className="mt-3 flex flex-col items-start gap-1.5">
              {/* A plain link: the browser saves the file itself, chunk by chunk, outside the page. */}
              <a
                href={downloadUrl(client, result.downloadPath)}
                download={result.fileName}
                className={`${buttonClass("primary")} max-w-full`}
                data-testid="pack-export-download"
              >
                <Download size={14} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{t("contentPack.export.download", { name: result.fileName })}</span>
              </a>
              {result.expiresAt === undefined ? null : <p className={NOTE_TEXT_CLASS}>{t("contentPack.export.downloadHint", { time: formatDateTime(result.expiresAt, i18n.language) })}</p>}
            </div>
          )}
        </div>
      ) : null}
      {job.status === "cancelled" ? <p role="status">{t("contentPack.export.cancelled")}</p> : null}
      {job.status === "failed" ? (
        <div className="flex flex-col gap-2">
          <p className="font-medium">{t("contentPack.export.failed")}</p>
          {job.error === undefined ? null : <ErrorView error={job.error} />}
          {job.failedContent === undefined ? null : <p className="text-note">{t("contentPack.export.failedContent", { title: titleOf(job.failedContent.title, t) })}</p>}
        </div>
      ) : null}
      <PackFooter>
        {job.status === "running" ? (
          <Button loading={props.cancelling} onClick={props.onCancel} data-testid="pack-export-cancel">
            {t("contentPack.export.cancel")}
          </Button>
        ) : null}
        {(job.status === "failed" || job.status === "cancelled") && props.onBack !== undefined ? <Button onClick={props.onBack}>{t("contentPack.export.back")}</Button> : null}
        <Button variant={job.status === "running" ? "secondary" : "primary"} onClick={props.onClose}>
          {t("contentPack.export.close")}
        </Button>
      </PackFooter>
    </div>
  );
}
