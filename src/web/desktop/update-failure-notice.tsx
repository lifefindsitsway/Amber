import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { RELEASES_PAGE_URL } from "../../shared/app-identity.ts";
import { formatBytes } from "../../shared/units.ts";
import { FOCUS_RING } from "../ui/button.tsx";
import { Callout, TEXT_ACTION_CLASS } from "../ui/notice.tsx";
import type { UpdateFailure, UpdateProgressSnapshot } from "./update-failure.ts";

/**
 * How far a download got, for the progress line and the failure text: the percentage with
 * both sizes once the total is known, the bytes alone before.
 */
export function downloadProgressLabel(t: TFunction, progress: UpdateProgressSnapshot): string {
  const { downloaded, total } = progress;
  if (total === undefined || total === 0) return formatBytes(downloaded);
  return t("shell.desktop.updateProgressOf", {
    percent: Math.min(100, Math.round((downloaded / total) * 100)),
    downloaded: formatBytes(Math.min(downloaded, total)),
    total: formatBytes(total),
  });
}

/** The release page of `version`, or the list of releases when the version is not known. */
export function releasePageUrl(version: string | undefined): string {
  return version === undefined || version === "" ? RELEASES_PAGE_URL : `${RELEASES_PAGE_URL}/tag/v${version}`;
}

function failureText(t: TFunction, error: UpdateFailure): { title: string; body: string } {
  switch (error.kind) {
    case "interrupted": {
      const progress = downloadProgressLabel(t, error.progress ?? { downloaded: 0 });
      return {
        title: t("shell.desktop.updateFailure.interrupted.title"),
        body:
          error.attempts === undefined || error.attempts === 0
            ? t("shell.desktop.updateFailure.interrupted.bodyNoAttempts", { progress })
            : t("shell.desktop.updateFailure.interrupted.body", { attempts: error.attempts, progress }),
      };
    }
    case "server":
      return {
        title: t("shell.desktop.updateFailure.server.title"),
        body: error.status === undefined ? t("shell.desktop.updateFailure.server.bodyNoStatus") : t("shell.desktop.updateFailure.server.body", { status: error.status }),
      };
    case "unreachable":
    case "integrity":
    case "disk":
      return { title: t(`shell.desktop.updateFailure.${error.kind}.title`), body: t(`shell.desktop.updateFailure.${error.kind}.body`) };
    case "other":
      return {
        title: t(`shell.desktop.updateFailure.other.title.${error.step}`),
        body: error.userMessage ?? t("shell.desktop.updateFailure.other.body"),
      };
  }
}

/**
 * A failed check, download or install, the same in the update card and the about dialog: what
 * happened and what to do in plain words, the release page as the way around, and the raw
 * message folded away for whoever needs to report it.
 */
export function UpdateFailureNotice(props: { error: UpdateFailure; version: string | undefined }) {
  const { t } = useTranslation();
  const { error } = props;
  const { title, body } = failureText(t, error);
  return (
    <Callout tone="error" density="compact" announce="alert" title={title} testId="update-failure" data-kind={error.kind}>
      <p>{body}</p>
      <p className="mt-1.5">
        <a href={releasePageUrl(props.version)} target="_blank" rel="noopener noreferrer" className={TEXT_ACTION_CLASS} data-testid="update-browser-download">
          {t("shell.desktop.updateFailure.browserDownload")}
        </a>
      </p>
      <details className="mt-1.5 text-muted" data-testid="update-failure-details">
        <summary className={`w-fit cursor-pointer rounded-sm select-none hover:text-ink ${FOCUS_RING}`}>{t("shell.desktop.updateFailure.details")}</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          <li>{t("shell.desktop.updateFailure.step", { step: t(`shell.desktop.updateFailure.steps.${error.step}`) })}</li>
          {error.attempts === undefined || error.attempts === 0 ? null : <li>{t("shell.desktop.updateFailure.attempts", { attempts: error.attempts })}</li>}
          {error.detail === "" ? null : (
            <li className="font-mono text-xs leading-relaxed break-words select-text [overflow-wrap:anywhere]" data-testid="update-failure-detail">
              {error.detail}
            </li>
          )}
        </ul>
      </details>
    </Callout>
  );
}
