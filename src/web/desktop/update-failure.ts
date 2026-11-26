import { ApiError } from "../api/client.ts";

/**
 * Why an update step failed, in the few kinds the user can act on differently. The download
 * reports its kind itself (the shell's resumable download); the check and the installer only
 * report the updater's English message, so those are classified here from the wording the
 * updater and the operating system use.
 */

/** Which step failed; a retry repeats it. */
export type UpdateStep = "check" | "download" | "install";

export const UPDATE_FAILURE_KINDS = ["interrupted", "unreachable", "server", "integrity", "disk", "other"] as const;
export type UpdateFailureKind = (typeof UPDATE_FAILURE_KINDS)[number];

export interface UpdateProgressSnapshot {
  downloaded: number;
  total?: number;
}

export interface UpdateFailure {
  step: UpdateStep;
  kind: UpdateFailureKind;
  /** The HTTP status the release server answered with (`server`). */
  status?: number;
  /** How many times the download reconnected on its own before giving up. */
  attempts?: number;
  /** The raw message for the technical details, with URL credentials, queries and fragments removed. */
  detail: string;
  /** How far the download had got when it failed. */
  progress?: UpdateProgressSnapshot;
  /** The sidecar's AppError code when it refused a step. */
  code?: string;
  /** The sidecar's own explanation, shown instead of the generic one. */
  userMessage?: string;
}

/** The kinds the shell's download command rejects with. */
const SHELL_DOWNLOAD_KINDS = ["interrupted", "unreachable", "server", "integrity", "busy", "other"] as const;
type ShellDownloadKind = (typeof SHELL_DOWNLOAD_KINDS)[number];

// The reqwest wording when no connection could be made, and the updater's when the feed did
// not answer with a usable manifest (a captive portal, a proxy's error page).
const UNREACHABLE_PATTERNS = [/error sending request/iu, /could not fetch a valid release json/iu];
// Windows' ERROR_DISK_FULL (112) as io::Error renders it, and the plain English wording.
const DISK_FULL_PATTERNS = [/os error 112\b/iu, /not enough space/iu];

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/giu;

/**
 * Removes what must not be shown or copied from a URL inside a message: signed download links
 * carry their credentials in the query string, and a proxy URL may carry a user and password.
 */
export function redactDetail(text: string): string {
  return text.replace(URL_PATTERN, (url) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, "$1").replace(/[?#].*$/u, ""));
}

function messageText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** A refusal from the sidecar keeps its code and explanation. */
function sidecarFailure(step: UpdateStep, error: ApiError): UpdateFailure {
  const { code, userMessage } = error.error;
  return { step, kind: "other", detail: code, code, ...(userMessage.trim() === "" ? {} : { userMessage }) };
}

function classify(step: UpdateStep, error: unknown, patterns: readonly RegExp[], kind: UpdateFailureKind): UpdateFailure {
  if (error instanceof ApiError) return sidecarFailure(step, error);
  const detail = redactDetail(messageText(error));
  return { step, kind: patterns.some((pattern) => pattern.test(detail)) ? kind : "other", detail };
}

/** A failed check: the feed could not be reached, or something else. */
export function checkFailure(error: unknown): UpdateFailure {
  return classify("check", error, UNREACHABLE_PATTERNS, "unreachable");
}

/** A failed install: the disk is full, or something else (the sidecar's refusal keeps its code). */
export function installFailure(error: unknown): UpdateFailure {
  return classify("install", error, DISK_FULL_PATTERNS, "disk");
}

interface ShellDownloadError {
  kind: ShellDownloadKind;
  status?: number;
  attempts: number;
  detail: string;
}

function isShellDownloadError(error: unknown): error is ShellDownloadError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (SHELL_DOWNLOAD_KINDS as readonly unknown[]).includes(candidate["kind"]) && typeof candidate["detail"] === "string";
}

/**
 * A failed download, as the shell describes it, with how far it had got. `busy` (another
 * download of the same update still running) has nothing specific to tell the user.
 */
export function downloadFailure(error: unknown, progress?: UpdateProgressSnapshot): UpdateFailure {
  const snapshot = progress === undefined ? {} : { progress: progress.total === undefined ? { downloaded: progress.downloaded } : { downloaded: progress.downloaded, total: progress.total } };
  if (!isShellDownloadError(error)) {
    return { step: "download", kind: "other", detail: redactDetail(messageText(error)), ...snapshot };
  }
  return {
    step: "download",
    kind: error.kind === "busy" ? "other" : error.kind,
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(typeof error.attempts === "number" ? { attempts: error.attempts } : {}),
    detail: redactDetail(error.detail),
    ...snapshot,
  };
}
