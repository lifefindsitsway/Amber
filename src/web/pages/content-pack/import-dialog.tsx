import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { CONTENT_PACK_FILE_EXTENSION } from "../../../shared/backup-names.ts";
import type { ContentPackImportJobDto, PackCollectionResult } from "../../../shared/dto/content-pack.ts";
import type { TFunction } from "i18next";
import type { AppError } from "../../../shared/errors.ts";
import { useApi } from "../../api/context.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { pickPackSource } from "../../desktop/bridge.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { Button } from "../../ui/button.tsx";
import { FilePicker } from "../../ui/file-picker.tsx";
import { Loading, Spinner } from "../../ui/feedback.tsx";
import { Callout, InlineNote, NOTE_TEXT_CLASS, TEXT_ACTION_CLASS } from "../../ui/notice.tsx";
import { PackFooter, PackModal } from "./export-dialog.tsx";
import { ImportPreview } from "./import-preview.tsx";
import { resultSummary } from "./import-model.ts";
import {
  cancelImport,
  decidedCollectionAction,
  discardImport,
  packKeys,
  retryCollections,
  startImportFromFile,
  uploadPack,
  useActivePackJobs,
  useImportJob,
  useRefreshAfterImport,
  type UploadHandle,
} from "./pack-api.ts";
import { bytesLabel, titleOf } from "./pack-labels.ts";

/**
 * The import dialog: pick a pack (the desktop client's open dialog, or a browser upload
 * streamed from disk), wait for the preview, decide, follow the import, read the result.
 * Closing it while the preview waits drops the staged pack (one pack job per user, and a
 * forgotten preview would hold that slot); closing it during an upload stops the upload;
 * otherwise the job goes on and the pages that offer packs show it again.
 */
export function ImportPackDialog(props: { open: boolean; onClose: () => void; resumeJobId?: string | undefined }) {
  const { t } = useTranslation();
  const beforeClose = useRef<(() => void) | undefined>(undefined);
  return (
    <PackModal
      open={props.open}
      onOpenChange={(open) => {
        if (open) return;
        beforeClose.current?.();
        props.onClose();
      }}
      title={t("contentPack.import.title")}
    >
      {props.open ? (
        <ImportFlow
          resumeJobId={props.resumeJobId}
          beforeClose={beforeClose}
          onClose={() => {
            beforeClose.current?.();
            props.onClose();
          }}
        />
      ) : null}
    </PackModal>
  );
}

type Local = { step: "pick" } | { step: "uploading"; name: string; loaded: number; total: number } | { step: "job"; jobId: string };

function ImportFlow(props: { resumeJobId: string | undefined; beforeClose: MutableRefObject<(() => void) | undefined>; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const desktop = useDesktop();
  const [local, setLocal] = useState<Local>(props.resumeJobId === undefined ? { step: "pick" } : { step: "job", jobId: props.resumeJobId });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<AppError | undefined>(undefined);
  const upload = useRef<UploadHandle | undefined>(undefined);
  // A pack job of the user's that is already running: an import is shown instead of a new one, an export keeps this one from starting.
  const active = useActivePackJobs(props.resumeJobId === undefined);
  const runningImport = active.data?.importJobId;
  const runningExport = active.data?.exportJobId;
  useEffect(() => {
    if (runningImport !== undefined) setLocal((current) => (current.step === "pick" ? { step: "job", jobId: runningImport } : current));
  }, [runningImport]);
  const jobId = local.step === "job" ? local.jobId : undefined;
  const job = useImportJob(jobId);
  const refresh = useRefreshAfterImport();

  // What closing the dialog means depends on where the import stands.
  const status = job.data?.status;
  useEffect(() => {
    props.beforeClose.current = () => {
      upload.current?.abort();
      if (jobId !== undefined && status === "awaiting_decisions") {
        void discardImport(client, jobId).finally(() => void queryClient.invalidateQueries({ queryKey: packKeys.active }));
      }
    };
    return () => {
      props.beforeClose.current = undefined;
    };
  }, [props.beforeClose, client, queryClient, jobId, status]);

  useEffect(() => {
    if (status === "finished" || status === "failed" || status === "cancelled") {
      void queryClient.invalidateQueries({ queryKey: packKeys.active });
      if (status === "finished") refresh();
    }
  }, [status, queryClient, refresh]);

  const began = (id: string): void => {
    void queryClient.invalidateQueries({ queryKey: packKeys.active });
    setLocal({ step: "job", jobId: id });
  };
  const failedToStart = (caught: unknown): void => {
    setLocal({ step: "pick" });
    setError(appErrorOf(caught));
  };

  const pickDesktop = useMutation({
    mutationFn: async () => {
      setNotice(undefined);
      setError(undefined);
      let picked;
      try {
        picked = await pickPackSource();
      } catch (caught) {
        setNotice(t("contentPack.import.shellRefused", { reason: caught instanceof Error ? caught.message : String(caught) }));
        return;
      }
      if (picked === null) return;
      began(await startImportFromFile(client, picked.grant));
    },
    onError: failedToStart,
  });

  const startUpload = (file: File | undefined): void => {
    if (file === undefined) return;
    setNotice(undefined);
    setError(undefined);
    setLocal({ step: "uploading", name: file.name, loaded: 0, total: file.size });
    const handle = uploadPack(client, file, (loaded, total) => setLocal((current) => (current.step === "uploading" ? { ...current, loaded, total } : current)));
    upload.current = handle;
    handle.done.then(
      (id) => {
        upload.current = undefined;
        began(id);
      },
      (caught: unknown) => {
        upload.current = undefined;
        if (caught instanceof DOMException && caught.name === "AbortError") {
          setLocal({ step: "pick" });
          setNotice(t("contentPack.import.uploadCancelled"));
          return;
        }
        failedToStart(caught);
      },
    );
  };

  const again = (): void => {
    setLocal({ step: "pick" });
    setError(undefined);
    setNotice(undefined);
  };

  if (local.step === "pick") {
    return (
      <div className="flex flex-col gap-4 text-sm" data-testid="pack-import-pick">
        <p className="text-muted">{t("contentPack.import.intro")}</p>
        {runningExport !== undefined ? (
          <Callout tone="warn" announce="status">
            {t("contentPack.import.jobBusy")}
          </Callout>
        ) : desktop ? (
          <div>
            <Button variant="primary" loading={pickDesktop.isPending} onClick={() => pickDesktop.mutate()} data-testid="pack-import-pick-desktop">
              {t("contentPack.import.pick")}
            </Button>
          </div>
        ) : (
          <FilePicker accept={`.${CONTENT_PACK_FILE_EXTENSION},application/octet-stream`} fileName={undefined} onFile={startUpload} label={t("contentPack.import.fileLabel")} testId="pack-import-file" />
        )}
        {notice === undefined ? null : <InlineNote role="status">{notice}</InlineNote>}
        {error === undefined ? null : error.code === "conflict.pack_job_active" ? (
          <Callout tone="warn" announce="alert">
            {t("contentPack.import.jobBusy")}
          </Callout>
        ) : (
          <ErrorView error={error} />
        )}
        <PackFooter>
          <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
        </PackFooter>
      </div>
    );
  }

  if (local.step === "uploading") {
    return (
      <div className="flex flex-col gap-3 text-sm" data-testid="pack-import-uploading">
        <div role="status" aria-live="polite">
          <p className="mb-1.5 font-medium break-all">{t("contentPack.import.uploading", { name: local.name })}</p>
          <progress className="h-1.5 w-full" max={Math.max(1, local.total)} value={Math.min(local.loaded, local.total)} aria-label={t("contentPack.phase.import.upload")} />
          <p className="mt-1 text-xs text-muted">{t("contentPack.progressBytes", { done: bytesLabel(local.loaded), total: bytesLabel(local.total) })}</p>
        </div>
        <PackFooter>
          <Button onClick={() => upload.current?.abort()} data-testid="pack-import-cancel-upload">
            {t("contentPack.import.cancelUpload")}
          </Button>
        </PackFooter>
      </div>
    );
  }

  if (job.isError) {
    return (
      <>
        <ErrorView error={appErrorOf(job.error)} />
        <PackFooter>
          <Button onClick={again}>{t("contentPack.import.pickAgain")}</Button>
        </PackFooter>
      </>
    );
  }
  if (job.data === undefined) return <LoadingStep onClose={props.onClose} />;
  return (
    <JobView
      job={job.data}
      onAgain={again}
      onClose={props.onClose}
      onDiscarded={() => {
        // Already dropped: closing must not drop it a second time.
        props.beforeClose.current = undefined;
        props.onClose();
      }}
    />
  );
}

/** A step still reading, with the way out the footer always offers. */
function LoadingStep(props: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Loading />
      <PackFooter>
        <Button onClick={props.onClose}>{t("contentPack.import.close")}</Button>
      </PackFooter>
    </>
  );
}

function JobView(props: { job: ContentPackImportJobDto; onAgain: () => void; onClose: () => void; onDiscarded: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const { job } = props;
  const set = (data: ContentPackImportJobDto): void => {
    queryClient.setQueryData(packKeys.importJob(job.jobId), data);
  };
  const cancel = useMutation({ mutationFn: () => cancelImport(client, job.jobId), onSuccess: set });
  const discard = useMutation({
    mutationFn: () => discardImport(client, job.jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: packKeys.active });
      props.onDiscarded();
    },
  });
  switch (job.status) {
    case "receiving":
    case "previewing":
    case "importing":
      return <Progress job={job} cancelling={cancel.isPending} onCancel={() => cancel.mutate()} error={cancel.error} />;
    case "awaiting_decisions":
      return job.preview === undefined ? <LoadingStep onClose={props.onClose} /> : <ImportPreview job={job} preview={job.preview} onDiscard={() => discard.mutate()} discarding={discard.isPending} onCommitted={set} />;
    case "finished":
      return job.result === undefined ? <LoadingStep onClose={props.onClose} /> : <ImportResult job={job} onClose={props.onClose} />;
    case "failed":
      return (
        <div className="flex flex-col gap-3 text-sm" data-testid="pack-import-failed">
          <p className="font-medium">{t("contentPack.import.failed")}</p>
          {job.error === undefined ? null : <ErrorView error={job.error} />}
          {job.result === undefined ? null : <ImportResult job={job} onClose={props.onClose} embedded />}
          <PackFooter>
            <Button onClick={props.onAgain}>{t("contentPack.import.pickAgain")}</Button>
            <Button variant="primary" onClick={props.onClose}>
              {t("contentPack.import.close")}
            </Button>
          </PackFooter>
        </div>
      );
    case "cancelled": {
      // The server ends a preview nobody decided on by its expiry without an error.
      const expired = job.expiresAt !== undefined && job.expiresAt <= Date.now() && job.result === undefined;
      return (
        <div className="flex flex-col gap-3 text-sm" data-testid="pack-import-cancelled" data-expired={expired ? "true" : undefined}>
          <p role="status">{expired ? t("contentPack.import.expired") : t("contentPack.import.cancelled")}</p>
          {job.result === undefined ? null : <ImportResult job={job} onClose={props.onClose} embedded />}
          <PackFooter>
            <Button onClick={props.onAgain}>{t("contentPack.import.pickAgain")}</Button>
            <Button variant="primary" onClick={props.onClose}>
              {t("contentPack.import.close")}
            </Button>
          </PackFooter>
        </div>
      );
    }
  }
}

function Progress(props: { job: ContentPackImportJobDto; cancelling: boolean; onCancel: () => void; error: unknown }) {
  const { t } = useTranslation();
  const { job } = props;
  const label = job.status === "previewing" ? t("contentPack.import.previewing") : `${t("contentPack.import.importing")}${t("contentPack.separator")}${t(`contentPack.phase.import.${job.phase}`)}`;
  const measured = job.bytesTotal > 0 && job.status !== "previewing";
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pack-import-progress" data-status={job.status} data-phase={job.phase}>
      <div role="status" aria-live="polite">
        <p className="mb-1.5 flex items-center gap-2 font-medium">
          {measured ? null : <Spinner />}
          {job.status === "receiving" ? t("contentPack.import.uploading", { name: job.fileName ?? "" }) : label}
        </p>
        {measured ? (
          <>
            <progress className="h-1.5 w-full" max={Math.max(1, job.bytesTotal)} value={Math.min(job.bytesDone, job.bytesTotal)} aria-label={label} />
            <p className="mt-1 text-xs text-muted">{t("contentPack.progressBytes", { done: bytesLabel(job.bytesDone), total: bytesLabel(job.bytesTotal) })}</p>
          </>
        ) : null}
      </div>
      {props.error === null ? null : <ErrorView error={appErrorOf(props.error)} />}
      <PackFooter>
        <Button loading={props.cancelling} onClick={props.onCancel} data-testid="pack-import-cancel">
          {t("contentPack.import.cancelImport")}
        </Button>
      </PackFooter>
    </div>
  );
}

/** Every carried Content's outcome with a link to it, then the collections on their own; failures never read as success. */
function ImportResult(props: { job: ContentPackImportJobDto; onClose: () => void; embedded?: boolean }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const refresh = useRefreshAfterImport();
  const result = props.job.result;
  const retry = useMutation({
    mutationFn: () => retryCollections(client, props.job.jobId),
    onSuccess: (data) => {
      queryClient.setQueryData(packKeys.importJob(props.job.jobId), data);
      refresh();
    },
  });
  if (result === undefined) return null;
  const summary = resultSummary(result);
  const join = (items: Array<[string, number]>, group: "addedItems" | "updatedItems" | "conflictItems"): string =>
    items
      .filter(([, count]) => count > 0)
      .map(([key, count]) => t(`contentPack.import.result.${group}.${key}` as never, { count }))
      .join(t("contentPack.listSeparator"));
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="pack-import-result" data-all-ok={summary.allOk ? "true" : "false"}>
      {props.embedded === true ? null : (
        <div role="status">
          <p className={`font-medium ${summary.allOk ? "text-ok" : "text-danger"}`} data-testid="pack-import-result-title">
            {summary.allOk ? t("contentPack.import.result.allOk") : t("contentPack.import.result.partial")}
          </p>
          <p className={NOTE_TEXT_CLASS}>{t("contentPack.import.result.summary", { imported: summary.imported, merged: summary.merged, skipped: summary.skipped, failed: summary.failed })}</p>
        </div>
      )}
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {result.contents.map((item) => {
          const added = join(Object.entries(item.added), "addedItems");
          const updated = join(Object.entries(item.updated), "updatedItems");
          const conflicts = join(Object.entries(item.conflicts), "conflictItems");
          return (
            <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5" data-testid="pack-import-result-row" data-status={item.status}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={titleOf(item.title, t)}>
                  {titleOf(item.title, t)}
                </p>
                <p className={`text-xs ${item.status === "failed" ? "text-danger" : "text-muted"}`}>
                  {t(`contentPack.import.result.status.${item.status}`)}
                  {added === "" ? null : `${t("contentPack.separator")}${t("contentPack.import.result.added", { items: added })}`}
                </p>
                {updated === "" ? null : <p className="text-xs text-muted">{t("contentPack.import.result.updated", { items: updated })}</p>}
                {conflicts === "" ? null : <p className="text-xs text-muted">{t("contentPack.import.result.conflicts", { items: conflicts })}</p>}
                {item.placedByTime === 0 ? null : <p className="text-xs text-muted">{t("contentPack.import.result.placedByTime", { count: item.placedByTime })}</p>}
                {item.error === undefined ? null : (
                  <div className="mt-1.5">
                    <ErrorView error={item.error} />
                  </div>
                )}
              </div>
              {item.contentId === undefined || item.status === "failed" || item.status === "skipped" ? null : (
                <Link to={`/contents/${encodeURIComponent(item.contentId)}`} className={`shrink-0 text-sm ${TEXT_ACTION_CLASS}`} onClick={props.onClose}>
                  {t("contentPack.import.result.open")}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {result.collections.length === 0 ? null : (
        <section data-testid="pack-import-result-collections">
          <h3 className="mb-1.5 text-xs font-medium text-muted">{t("contentPack.import.result.collections")}</h3>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {result.collections.map((item) => (
              <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5" data-testid="pack-import-result-collection" data-status={item.status}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{item.name}</p>
                  <p className={`text-xs ${item.status === "failed" ? "text-danger" : "text-muted"}`}>
                    {collectionStatusText(item, decidedCollectionAction(props.job.jobId, item.key), t)}
                  </p>
                  {item.error === undefined ? null : (
                    <div className="mt-1.5">
                      <ErrorView error={item.error} />
                    </div>
                  )}
                </div>
                {item.collectionId === undefined || item.status === "failed" || item.status === "skipped" ? null : (
                  <Link to={`/collections/${encodeURIComponent(item.collectionId)}`} className={`shrink-0 text-sm ${TEXT_ACTION_CLASS}`} onClick={props.onClose}>
                    {t("contentPack.import.result.open")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {summary.collectionsFailed > 0 && props.job.status === "finished" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()} data-testid="pack-import-retry-collections">
                {t("contentPack.import.result.retryCollections")}
              </Button>
              {retry.error === null ? null : <ErrorView error={appErrorOf(retry.error)} />}
            </div>
          ) : null}
        </section>
      )}
      {summary.failed > 0 ? <InlineNote>{t("contentPack.import.result.reimportHint")}</InlineNote> : null}
      {props.embedded === true ? null : (
        <PackFooter>
          <Button variant="primary" onClick={props.onClose} data-testid="pack-import-close">
            {t("contentPack.import.close")}
          </Button>
        </PackFooter>
      )}
    </div>
  );
}

/**
 * A collection's outcome in words. A collection the user chose to create or join comes back
 * `skipped` when none of its Contents went in (no empty collection is made); a join that
 * found every member already there adds nothing.
 */
export function collectionStatusText(item: PackCollectionResult, decided: "skip" | "create" | "join" | undefined, t: TFunction): string {
  if (item.status === "joined") return item.added === 0 ? t("contentPack.import.result.collectionStatus.joinedNone") : t("contentPack.import.result.collectionStatus.joined", { count: item.added });
  if (item.status === "skipped" && decided !== undefined && decided !== "skip") return t("contentPack.import.result.collectionStatus.nothingToAdd");
  return t(`contentPack.import.result.collectionStatus.${item.status}`);
}
