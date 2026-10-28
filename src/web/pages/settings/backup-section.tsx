import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { filterUiPreferences, type DroppedPreference, type LibraryCategory, BACKUP_FILE_EXTENSION } from "../../../shared/backup.ts";
import { BACKUP_PROGRESS_POLL_MS } from "../../../shared/defaults.ts";
import type { BackupExportJobDto, RestoreApplyReport, RestoreInspectReport, RestoreProgress, UnreadableOriginalReason } from "../../../shared/dto/backup.ts";
import type { AppError } from "../../../shared/errors.ts";
import { formatBytes } from "../../../shared/units.ts";
import {
  backupKeys,
  cancelBackupExport,
  estimateBackup,
  fetchBackupExport,
  fetchRestoreReadiness,
  localUiPreferences,
  startBackupExport,
} from "../../api/backup.ts";
import { resolveEndpoint } from "../../api/client.ts";
import { useApi, useTaskHub } from "../../api/context.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import {
  EVENT_RESTORE_PROGRESS,
  EVENT_SIDECAR_FAILED,
  EVENT_SIDECAR_RESTARTED,
  inspectBackup,
  onShellEvent,
  pickBackupDestination,
  localTimeStamp,
  pickRestoreOriginalsDir,
  restoreBackup,
  type PickedFile,
} from "../../desktop/bridge.ts";
import { useBackupBusy, useUpdateController, useUpdater } from "../../desktop/updater.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { formatDateTime } from "../../format.ts";
import { resetSubtitlePrefsMemory } from "../../player/subtitle-prefs.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { SettingsBlock } from "./settings-ui.tsx";

/**
 * `/settings/backup`, desktop client only: export a backup of this
 * device, or restore one onto a fresh installation. Export, restore and an update install
 * exclude each other; the update controller carries the shared busy flag.
 */
export function BackupSection() {
  const { t } = useTranslation();
  const desktop = useDesktop();
  if (!desktop) {
    return <p className="text-sm text-muted">{t("backup.desktopOnly")}</p>;
  }
  return (
    <div>
      <ExportCard />
      <RestoreCard />
    </div>
  );
}

/** Whether an update download or install keeps backups out. */
function useUpdateBusy(): boolean {
  const update = useUpdater();
  return update.status === "downloading" || update.status === "installing";
}

function suggestedFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `Amber-${stamp}.${BACKUP_FILE_EXTENSION}`;
}

function ExportCard() {
  const { t } = useTranslation();
  const client = useApi();
  const controller = useUpdateController();
  const updateBusy = useUpdateBusy();
  const restoring = useBackupBusy("restore");
  const [includeOriginals, setIncludeOriginals] = useState(true);
  const [includeCache, setIncludeCache] = useState(false);
  const [excludeUnreadable, setExcludeUnreadable] = useState(false);
  // Originals a failed export found changed since import: still readable, so the estimate
  // cannot list them, yet only excluding them lets the next export succeed.
  const [changed, setChanged] = useState<ReadonlyArray<{ assetId: string; displayName: string }>>([]);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [accepted, setAccepted] = useState<DroppedPreference[]>([]);
  const [startError, setStartError] = useState<AppError | undefined>(undefined);
  const request = { includeOriginals, includeCache };
  const estimate = useQuery({ queryKey: backupKeys.estimate(request), queryFn: () => estimateBackup(client, request), enabled: jobId === undefined });
  const job = useQuery({
    queryKey: backupKeys.job(jobId ?? ""),
    queryFn: () => fetchBackupExport(client, jobId ?? ""),
    enabled: jobId !== undefined,
    refetchInterval: (query) => (query.state.data === undefined || query.state.data.status === "running" ? BACKUP_PROGRESS_POLL_MS : false),
  });
  const running = jobId !== undefined && (job.data === undefined || job.data.status === "running");
  useEffect(() => {
    controller.setBackupBusy("export", running);
    return () => controller.setBackupBusy("export", false);
  }, [controller, running]);
  const failedAsset = job.data?.status === "failed" && job.data.error?.class === "media_changed" ? job.data.failedAsset : undefined;
  const failedId = failedAsset?.assetId;
  const failedName = failedAsset?.displayName;
  useEffect(() => {
    if (failedId === undefined || failedName === undefined) return;
    setChanged((current) => (current.some((item) => item.assetId === failedId) ? current : [...current, { assetId: failedId, displayName: failedName }]));
    setExcludeUnreadable(false);
  }, [failedId, failedName]);
  const listed = estimate.data?.originals.unreadable ?? [];
  const unreadable: ReadonlyArray<{ assetId: string; displayName: string; reason: UnreadableOriginalReason | "changed" }> = includeOriginals
    ? [...listed, ...changed.filter((item) => !listed.some((entry) => entry.assetId === item.assetId)).map((item) => ({ ...item, reason: "changed" as const }))]
    : [];
  const blockedByUnreadable = unreadable.length > 0 && !excludeUnreadable;
  const start = useMutation({
    mutationFn: async () => {
      const picked = await pickBackupDestination(suggestedFileName(new Date()));
      if (picked === null) return;
      const answer = await startBackupExport(client, {
        grant: picked.grant,
        includeOriginals,
        includeCache,
        excludeOriginals: excludeUnreadable ? unreadable.map((item) => item.assetId) : [],
        uiPreferences: localUiPreferences(),
      });
      setAccepted(answer.preferencesDropped);
      setJobId(answer.jobId);
    },
    onMutate: () => setStartError(undefined),
    onError: (error) => setStartError(appErrorOf(error)),
  });
  const cancel = useMutation({ mutationFn: (id: string) => cancelBackupExport(client, id), onSuccess: () => void job.refetch() });
  const disabled = updateBusy || restoring || running || start.isPending || estimate.data === undefined || blockedByUnreadable;
  const total = estimate.data === undefined ? 0 : estimate.data.database.bytes + (includeOriginals ? estimate.data.originals.bytes : 0) + (includeCache ? estimate.data.cache.bytes : 0);
  return (
    <SettingsBlock title={t("backup.export.title")} intro={t("backup.export.intro")}>
      <div className="mb-3 flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeOriginals} disabled={running} onChange={(event) => setIncludeOriginals(event.target.checked)} data-testid="backup-include-originals" />
          {t("backup.export.includeOriginals")}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeCache} disabled={running} onChange={(event) => setIncludeCache(event.target.checked)} data-testid="backup-include-cache" />
          {t("backup.export.includeCache")}
        </label>
      </div>
      <div className="mb-3 text-sm" data-testid="backup-estimate">
        <p className="mb-1 text-xs font-medium text-muted">{t("backup.export.estimate")}</p>
        {estimate.data === undefined ? (
          estimate.error === null ? (
            <p className="text-muted">{t("backup.export.estimating")}</p>
          ) : (
            <ErrorView error={appErrorOf(estimate.error)} />
          )
        ) : (
          <ul className="text-muted">
            <li>{t("backup.export.estimateDatabase", { size: formatBytes(estimate.data.database.bytes) })}</li>
            {includeOriginals ? <li>{t("backup.export.estimateOriginals", { count: estimate.data.originals.count, size: formatBytes(estimate.data.originals.bytes) })}</li> : null}
            {includeCache ? <li>{t("backup.export.estimateCache", { count: estimate.data.cache.count, size: formatBytes(estimate.data.cache.bytes) })}</li> : null}
            <li className="text-text">{t("backup.export.estimateTotal", { size: formatBytes(total) })}</li>
          </ul>
        )}
      </div>
      {unreadable.length === 0 ? null : (
        <div className="mb-3 rounded-md border border-line p-3 text-sm" data-testid="backup-unreadable">
          <p className="mb-1">{t("backup.export.unreadableTitle", { count: unreadable.length })}</p>
          <ul className="mb-2 list-disc pl-5 text-muted">
            {unreadable.map((item) => (
              <li key={item.assetId}>
                {item.displayName} · {t(`backup.export.unreadableReason.${item.reason}`)}
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={excludeUnreadable} onChange={(event) => setExcludeUnreadable(event.target.checked)} data-testid="backup-exclude-unreadable" />
            {t("backup.export.excludeUnreadable")}
          </label>
          {blockedByUnreadable ? <p className="mt-1 text-xs text-danger">{t("backup.export.unreadableBlocking")}</p> : null}
        </div>
      )}
      <ul className="mb-3 list-disc pl-5 text-xs text-muted" data-testid="backup-notice">
        <li className="text-danger">{t("backup.export.unencrypted")}</li>
        <li>{t("backup.export.noSecrets")}</li>
        <li>{t("backup.export.timePoint")}</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={disabled} onClick={() => start.mutate()} data-testid="backup-export-start">
          {t("backup.export.start")}
        </Button>
        {updateBusy ? <span className="text-xs text-muted">{t("backup.export.blockedByUpdate")}</span> : null}
        {restoring ? <span className="text-xs text-muted">{t("backup.export.blockedByRestore")}</span> : null}
      </div>
      {startError === undefined ? null : (
        <div className="mt-3">
          <ErrorView error={startError} />
        </div>
      )}
      {job.data === undefined ? null : (
        <ExportJobView job={job.data} dropped={accepted} onCancel={() => cancel.mutate(job.data.jobId)} cancelling={cancel.isPending} />
      )}
    </SettingsBlock>
  );
}

function DroppedList(props: { dropped: readonly DroppedPreference[] }) {
  const { t } = useTranslation();
  if (props.dropped.length === 0) return null;
  return (
    <div className="mt-2 text-xs text-muted" data-testid="backup-dropped">
      <p>{t("backup.export.droppedTitle", { count: props.dropped.length })}</p>
      <ul className="list-disc pl-5">
        {props.dropped.map((item) => (
          <li key={item.key}>
            <span className="font-mono">{item.key}</span> · {t(`backup.export.droppedReason.${item.reason}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExportJobView(props: { job: BackupExportJobDto; dropped: readonly DroppedPreference[]; onCancel: () => void; cancelling: boolean }) {
  const { t } = useTranslation();
  const { job } = props;
  return (
    <div className="mt-3 rounded-md border border-line p-3 text-sm" data-testid="backup-export-job" data-status={job.status}>
      {job.status === "running" ? (
        <>
          <p className="mb-1">
            {t("backup.export.running")} · {t(`backup.export.phase.${job.phase}`)}
          </p>
          <progress className="h-1.5 w-full" max={Math.max(1, job.bytesTotal)} value={Math.min(job.bytesDone, job.bytesTotal)} />
          <p className="mt-1 text-xs text-muted">
            {t("backup.export.progress", { done: formatBytes(job.bytesDone), total: formatBytes(job.bytesTotal), filesDone: job.filesDone, filesTotal: job.filesTotal })}
          </p>
          <Button size="sm" className="mt-2" disabled={props.cancelling} onClick={props.onCancel} data-testid="backup-export-cancel">
            {t("backup.export.cancel")}
          </Button>
        </>
      ) : null}
      {job.status === "succeeded" && job.result !== undefined ? (
        <>
          <p>{t("backup.export.succeeded", { size: formatBytes(job.result.sizeBytes), originals: job.result.originals, cache: job.result.cache })}</p>
          <DroppedList dropped={job.result.preferencesDropped} />
        </>
      ) : null}
      {job.status === "cancelled" ? <p>{t("backup.export.cancelled")}</p> : null}
      {job.status === "failed" ? (
        <>
          <p className="mb-2">{t("backup.export.failed")}</p>
          {job.error === undefined ? null : <ErrorView error={job.error} />}
          {job.failedAsset === undefined ? null : <p className="mt-2 text-xs">{t("backup.export.failedAsset", { name: job.failedAsset.displayName })}</p>}
        </>
      ) : null}
      {job.status === "running" ? <DroppedList dropped={props.dropped} /> : null}
    </div>
  );
}

const CATEGORY_GROUPS: ReadonlyArray<readonly ["library" | "models" | "accounts" | "usage" | "other", readonly LibraryCategory[]]> = [
  ["library", ["content", "collection", "import_batch", "task", "media_asset", "transcript_revision", "transcript_draft", "note", "chat_thread"]],
  ["models", ["provider_profile", "asr_provider_profile", "other_model_profile", "terminology_set", "summary_template", "prompt_override_version"]],
  ["accounts", ["platform_account", "secret"]],
  ["usage", ["token_usage", "asr_usage"]],
  ["other", ["network_allowlist", "pending_file_delete", "cache_root"]],
];

type RestoreStage =
  | { step: "idle" }
  | { step: "inspected"; archive: PickedFile; report: RestoreInspectReport; originals?: PickedFile }
  | { step: "running"; progress?: RestoreProgress }
  | { step: "done"; report: RestoreApplyReport; preferences?: { applied: number; failed: number; dropped: number } }
  | { step: "refused"; reason: string };

/** Writes the restored UI preferences after re-checking them against the whitelist; a failed write is only counted. */
function applyPreferences(candidates: Readonly<Record<string, string>>, droppedByRestore: number): { applied: number; failed: number; dropped: number } {
  const { accepted, dropped } = filterUiPreferences(candidates);
  let applied = 0;
  let failed = 0;
  for (const [key, value] of Object.entries(accepted)) {
    try {
      localStorage.setItem(key, value);
      applied += 1;
    } catch {
      failed += 1;
    }
  }
  // Mounted subtitle views re-read their preferences.
  resetSubtitlePrefsMemory();
  return { applied, failed, dropped: dropped.length + droppedByRestore };
}

function RestoreCard() {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const hub = useTaskHub();
  const controller = useUpdateController();
  const updateBusy = useUpdateBusy();
  const readiness = useQuery({ queryKey: backupKeys.readiness, queryFn: () => fetchRestoreReadiness(client) });
  const [stage, setStage] = useState<RestoreStage>({ step: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [pickError, setPickError] = useState<string | undefined>(undefined);
  const running = stage.step === "running";
  useEffect(() => {
    controller.setBackupBusy("restore", running);
    return () => controller.setBackupBusy("restore", false);
  }, [controller, running]);
  const exportBusy = useBackupBusy("export");

  const pick = async (): Promise<void> => {
    setPickError(undefined);
    try {
      const inspected = await inspectBackup();
      if (inspected !== null) setStage({ step: "inspected", archive: inspected.archive, report: inspected.report });
    } catch (error) {
      setPickError(error instanceof Error ? error.message : String(error));
    }
  };
  const pickOriginals = async (): Promise<void> => {
    if (stage.step !== "inspected") return;
    setPickError(undefined);
    try {
      const picked = await pickRestoreOriginalsDir(localTimeStamp(new Date()));
      if (picked !== null) setStage({ ...stage, originals: picked });
    } catch (error) {
      setPickError(error instanceof Error ? error.message : String(error));
    }
  };

  const restoringRef = useRef(false);
  const run = async (): Promise<void> => {
    if (stage.step !== "inspected" || restoringRef.current) return;
    restoringRef.current = true;
    const { archive, originals } = stage;
    setConfirming(false);
    setStage({ step: "running" });
    // Subscribed before the command starts: the shell may announce the restart before it answers.
    let backendBack: () => void = () => undefined;
    const backend = new Promise<void>((resolve) => {
      backendBack = resolve;
    });
    const unsubscribers = await Promise.all([
      onShellEvent<RestoreProgress>(EVENT_RESTORE_PROGRESS, (progress) => setStage({ step: "running", progress })),
      onShellEvent(EVENT_SIDECAR_RESTARTED, () => backendBack()),
      onShellEvent(EVENT_SIDECAR_FAILED, () => backendBack()),
    ]);
    try {
      const report = await restoreBackup(archive.grant, originals?.grant ?? null);
      // The shell restarts the sidecar before answering; follow it whether or not its event arrived.
      await Promise.race([
        backend,
        resolveEndpoint().then((endpoint) => {
          client.setEndpoint(endpoint);
          hub.reconnect();
        }),
      ]);
      const preferences = report.ok ? applyPreferences(report.preferences.candidates, report.preferences.dropped.length) : undefined;
      setStage(preferences === undefined ? { step: "done", report } : { step: "done", report, preferences });
      await queryClient.invalidateQueries();
    } catch (error) {
      setStage({ step: "refused", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
      restoringRef.current = false;
    }
  };

  const header = stage.step === "inspected" && stage.report.ok ? stage.report.header : undefined;
  const needsOriginalsDir = header !== undefined && header.originals.length > 0;
  const ready = header !== undefined && (!needsOriginalsDir || (stage.step === "inspected" && stage.originals !== undefined));
  const fresh = readiness.data?.fresh === true;
  const blocked = updateBusy || exportBusy || running;
  return (
    <SettingsBlock title={t("backup.restore.title")} intro={t("backup.restore.intro")}>
      {readiness.data === undefined ? (
        readiness.error === null ? (
          <Loading />
        ) : (
          <ErrorView error={appErrorOf(readiness.error)} />
        )
      ) : fresh ? null : (
        <div className="mb-3 rounded-md border border-line p-3 text-sm" data-testid="restore-not-fresh">
          <p>{t("backup.restore.notFresh")}</p>
          <p className="mb-2">{t("backup.restore.notFreshHowTo")}</p>
          <details className="mb-2 text-xs" data-testid="restore-clear-help">
            <summary className="cursor-pointer text-muted">{t("backup.restore.clearHelpTitle")}</summary>
            <p className="mt-1 text-danger">{t("backup.restore.clearHelpBody")}</p>
          </details>
          <p className="mb-1 text-xs font-medium text-muted">{t("backup.restore.nonEmptyTitle")}</p>
          <ul className="list-disc pl-5 text-xs text-muted">
            {CATEGORY_GROUPS.map(([group, categories]) => {
              const present = categories.filter((category) => readiness.data.nonEmpty.includes(category));
              return present.length === 0 ? null : (
                <li key={group}>
                  {t("backup.restore.groupLine", {
                    group: t(`backup.restore.group.${group}`),
                    items: present.map((category) => t(`backup.restore.category.${category}`)).join(t("backup.restore.itemSeparator")),
                  })}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!fresh || blocked} onClick={() => void pick()} data-testid="restore-pick">
          {t("backup.restore.pick")}
        </Button>
        {updateBusy ? <span className="text-xs text-muted">{t("backup.export.blockedByUpdate")}</span> : null}
      </div>
      {pickError === undefined ? null : (
        <p className="mt-2 text-sm text-danger" role="alert">
          {t("backup.restore.shellRefused", { reason: pickError })}
        </p>
      )}
      {stage.step === "inspected" && !stage.report.ok ? (
        <div className="mt-3">
          <ErrorView error={stage.report.error} />
        </div>
      ) : null}
      {header === undefined ? null : (
        <div className="mt-3 rounded-md border border-line p-3 text-sm" data-testid="restore-summary">
          <p className="mb-1 font-medium">
            {t("backup.restore.summaryTitle")} <span className="ml-1 rounded bg-sunken px-1.5 py-0.5 text-xs text-muted">{t("backup.restore.unverified")}</span>
          </p>
          <ul className="text-muted">
            <li>{t("backup.restore.summaryVersion", { version: header.amberVersion })}</li>
            <li>{t("backup.restore.summaryTime", { time: formatDateTime(header.createdAt, i18n.language) })}</li>
            <li>{t("backup.restore.summaryCounts", { contents: header.counts.contents, collections: header.counts.collections, notes: header.counts.notes })}</li>
            <li>{header.originals.length > 0 ? t("backup.restore.summaryOriginals", { count: header.originals.length }) : t("backup.restore.summaryNoOriginals")}</li>
            <li>{header.cache.length > 0 ? t("backup.restore.summaryCache", { count: header.cache.length }) : t("backup.restore.summaryNoCache")}</li>
          </ul>
          {needsOriginalsDir ? (
            <div className="mt-3">
              <Button size="sm" disabled={blocked} onClick={() => void pickOriginals()} data-testid="restore-pick-originals">
                {t("backup.restore.pickOriginalsDir")}
              </Button>
              <p className="mt-1 text-xs text-muted">{t("backup.restore.originalsDirHint")}</p>
              {stage.step === "inspected" && stage.originals !== undefined ? (
                <p className="mt-1 text-xs" data-testid="restore-originals-dir">
                  {t("backup.restore.originalsDirChosen", { path: stage.originals.path })}
                </p>
              ) : null}
            </div>
          ) : null}
          <Button variant="primary" className="mt-3" disabled={!ready || blocked} onClick={() => setConfirming(true)} data-testid="restore-start">
            {t("backup.restore.start")}
          </Button>
        </div>
      )}
      <Modal open={confirming} onOpenChange={setConfirming} title={t("backup.restore.confirmTitle")}>
        <div className="mb-4 text-sm" data-testid="restore-confirm">
          {(readiness.data?.willReplace.length ?? 0) === 0 ? (
            <p className="mb-2">{t("backup.restore.confirmReplaceNone")}</p>
          ) : (
            <>
              <p className="mb-1">{t("backup.restore.confirmReplace")}</p>
              <ul className="mb-2 list-disc pl-5">
                {(readiness.data?.willReplace ?? []).map((setting) => (
                  <li key={setting}>{t(`backup.restore.replace.${setting}`)}</li>
                ))}
              </ul>
            </>
          )}
          <ul className="list-disc pl-5 text-muted">
            <li>{t("backup.restore.confirmKeys")}</li>
            <li>{t("backup.restore.confirmPlatforms")}</li>
            <li>{t("backup.restore.confirmBackend")}</li>
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirming(false)}>{t("common.action.cancel")}</Button>
          <Button variant="primary" onClick={() => void run()} data-testid="restore-confirm-start">
            {t("backup.restore.confirm")}
          </Button>
        </div>
      </Modal>
      {stage.step === "running" ? <RestoreOverlay progress={stage.progress} /> : null}
      {stage.step === "done" ? <RestoreResult report={stage.report} preferences={stage.preferences} /> : null}
      {stage.step === "refused" ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {t("backup.restore.shellRefused", { reason: stage.reason })}
        </p>
      ) : null}
    </SettingsBlock>
  );
}

function RestoreOverlay(props: { progress: RestoreProgress | undefined }) {
  const { t } = useTranslation();
  const { progress } = props;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" role="alertdialog" aria-busy="true" data-testid="restore-overlay">
      <div className="w-80 rounded-lg border border-line bg-surface p-4 text-sm shadow-xl">
        <p className="mb-2 font-medium">{t("backup.restore.running")}</p>
        {progress === undefined ? (
          <p className="text-xs text-muted">{t("backup.restore.waitingBackend")}</p>
        ) : (
          <>
            <progress className="h-1.5 w-full" max={Math.max(1, progress.total)} value={Math.min(progress.done, progress.total)} />
            <p className="mt-1 text-xs text-muted">{t("backup.restore.progress", { phase: t(`backup.restore.phase.${progress.phase}`), done: progress.done, total: progress.total })}</p>
          </>
        )}
      </div>
    </div>
  );
}

function RestoreResult(props: { report: RestoreApplyReport; preferences: { applied: number; failed: number; dropped: number } | undefined }) {
  const { t } = useTranslation();
  const { report } = props;
  if (!report.ok) {
    return (
      <div className="mt-3 text-sm" data-testid="restore-result" data-ok="false">
        <p className="mb-2">{t("backup.restore.failed")}</p>
        <ErrorView error={report.error} />
      </div>
    );
  }
  const { restored } = report;
  return (
    <div className="mt-3 rounded-md border border-line p-3 text-sm" data-testid="restore-result" data-ok="true">
      <p className="mb-1 font-medium">{t("backup.restore.succeeded")}</p>
      <p>{t("backup.restore.summary", { contents: restored.contents, collections: restored.collections, notes: restored.notes, originals: restored.originals, cache: restored.cache })}</p>
      {restored.missingOriginals === 0 ? null : <p className="text-muted">{t("backup.restore.missingOriginals", { count: restored.missingOriginals })}</p>}
      {restored.profilesNeedingCredentials === 0 ? null : <p className="text-muted">{t("backup.restore.profilesNeedingCredentials", { count: restored.profilesNeedingCredentials })}</p>}
      {report.originalsDir === null ? null : <p className="text-muted">{t("backup.restore.originalsDir", { path: report.originalsDir })}</p>}
      {props.preferences === undefined ? null : (
        <p className="text-muted" data-testid="restore-preferences">
          {t("backup.restore.preferences", props.preferences)}
        </p>
      )}
    </div>
  );
}
