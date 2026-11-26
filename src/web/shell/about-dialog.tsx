import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PUBLIC_REPOSITORY_URL, RELEASES_PAGE_URL } from "../../shared/app-identity.ts";
import { ApiError } from "../api/client.ts";
import { useVersion } from "../api/queries.ts";
import { ErrorView } from "../components/error-view.tsx";
import { UpdateProgressLine } from "../desktop/desktop-integration.tsx";
import { UpdateFailureNotice } from "../desktop/update-failure-notice.tsx";
import { AUTO_CHECK_KEY, autoCheckEnabled, useBackupBusy, useUpdater, type UpdateState } from "../desktop/updater.ts";
import { useDesktop } from "../desktop/use-desktop.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Loading } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { NOTE_TEXT_CLASS, TEXT_ACTION_CLASS } from "../ui/notice.tsx";

const LICENSE = "AGPL-3.0";

/**
 * "About Amber" from the account menu: version, run mode, license and the
 * source repository; in the desktop client also the update area.
 */
export function AboutDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const version = useVersion();
  const desktop = useDesktop();
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("shell.about.title")}>
      {version.data === undefined ? (
        version.isPending ? (
          <Loading />
        ) : version.error instanceof ApiError ? (
          <ErrorView error={version.error.error} />
        ) : null
      ) : (
        <>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">{t("shell.about.version")}</dt>
            <dd className="font-mono" data-testid="about-version">
              {version.data.version}
            </dd>
            <dt className="text-muted">{t("shell.about.mode")}</dt>
            <dd>{t(`shell.about.modeValue.${version.data.mode}`)}</dd>
            <dt className="text-muted">{t("shell.about.license")}</dt>
            <dd>{LICENSE}</dd>
            <dt className="text-muted">{t("shell.about.source")}</dt>
            <dd>
              <a href={PUBLIC_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className={TEXT_ACTION_CLASS} data-testid="about-source">
                {t("shell.about.sourceLink")}
              </a>
            </dd>
          </dl>
          {desktop ? <UpdateArea /> : null}
        </>
      )}
    </Modal>
  );
}

function useStatusLine(update: UpdateState): string | undefined {
  const { t } = useTranslation();
  switch (update.status) {
    case "checking":
      return t("shell.about.update.checking");
    case "up_to_date":
      return t("shell.about.update.upToDate");
    case "available":
    case "downloading":
      return t("shell.about.update.available", { version: update.version ?? "" });
    case "ready_to_install":
    case "installing":
      return t("shell.about.update.readyToInstall", { version: update.version ?? "" });
    default:
      return undefined;
  }
}

/** Manual check, the automatic-check switch, progress and the fallback download page. Results show here, never as the card. */
function UpdateArea() {
  const { t } = useTranslation();
  const update = useUpdater();
  const backupBusy = useBackupBusy();
  const { controller } = update;
  const [autoCheck, setAutoCheck] = useState(autoCheckEnabled);
  const busy = update.status === "checking" || update.status === "downloading" || update.status === "installing";
  const toggle = (on: boolean): void => {
    setAutoCheck(on);
    try {
      localStorage.setItem(AUTO_CHECK_KEY, on ? "1" : "0");
    } catch {
      // Not remembered; the next start checks as before.
    }
  };
  const line = useStatusLine(update);
  const failure = update.status === "failed" ? update.error : undefined;
  return (
    <section className="mt-6 border-t border-line pt-6" data-testid="about-update">
      <h3 className="mb-3 text-sm font-semibold">{t("shell.about.update.title")}</h3>
      {line === undefined && failure === undefined ? null : (
        // One element across states, so the line reads as one status that changes.
        <div className="mb-3" data-testid="about-update-status">
          {/* A failed check, download or install is something to deal with, explained as in the update card. */}
          {failure === undefined ? <p className="text-sm">{line}</p> : <UpdateFailureNotice error={failure} version={update.version} />}
        </div>
      )}
      <UpdateProgressLine />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || update.status === "ready_to_install"} onClick={() => void controller.check({ manual: true })} data-testid="about-update-check">
          {t("shell.about.update.check")}
        </Button>
        {update.status === "available" ? (
          <Button size="sm" variant="primary" disabled={backupBusy} onClick={() => void controller.download()} data-testid="about-update-download">
            {t("shell.desktop.updateDownload")}
          </Button>
        ) : null}
        {update.status === "ready_to_install" ? (
          <Button size="sm" variant="primary" disabled={backupBusy} onClick={() => void controller.install()} data-testid="about-update-install">
            {t("shell.desktop.updateInstall")}
          </Button>
        ) : null}
        {update.status === "failed" && update.error?.step !== "check" ? (
          <Button size="sm" onClick={() => void controller.retry()} data-testid="about-update-retry">
            {t("shell.desktop.updateRetry")}
          </Button>
        ) : null}
      </div>
      <div className="mb-3">
        <Checkbox checked={autoCheck} onChange={(event) => toggle(event.target.checked)} data-testid="about-update-auto">
          {t("shell.about.update.autoCheck")}
        </Checkbox>
      </div>
      <p className={NOTE_TEXT_CLASS}>
        <a href={RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer" className={TEXT_ACTION_CLASS} data-testid="about-update-manual">
          {t("shell.about.update.manualDownload")}
        </a>
        {" · "}
        {t("shell.about.update.manualDownloadHint")}
      </p>
    </section>
  );
}
