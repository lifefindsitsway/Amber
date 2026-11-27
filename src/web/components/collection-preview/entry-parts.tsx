import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatDuration } from "../../format.ts";
import { Cover } from "../../pages/library/columns.tsx";
import { TEXT_ACTION_CLASS } from "../../ui/notice.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import type { PreviewEntry } from "./state.ts";

/** 16:9 at a fixed size, so a cover that loads late or fails never changes a row's height. */
export const COVER_CLASS = "h-9 w-16 shrink-0";

const BADGE_TONE: Readonly<Record<string, string>> = {
  in_library: "bg-sunken text-ink",
  processing: "bg-accent-soft text-accent",
  in_collection: "text-muted ring-1 ring-line ring-inset",
  trashed: "bg-warn-soft text-warn",
  unavailable: "bg-danger-soft text-danger",
  // An image post is not broken, only not something Amber processes: a quiet badge.
  not_video: "bg-sunken text-muted",
};

export function EntryCover({ entry }: { entry: PreviewEntry }) {
  return <Cover url={entry.coverUrl} className={COVER_CLASS} />;
}

/** The entry's title, or that the platform does not show it; never a made-up one. */
export function EntryTitle({ entry, id, className = "" }: { entry: PreviewEntry; id?: string; className?: string }) {
  const { t } = useTranslation();
  const known = entry.title !== undefined && entry.title !== "";
  return (
    <span id={id} className={`line-clamp-2 break-words ${known ? "" : "text-muted"} ${className}`}>
      {known ? entry.title : t("shell.collectionPreview.untitled")}
    </span>
  );
}

export function EntryDuration({ entry }: { entry: PreviewEntry }) {
  return (
    <span className="w-14 shrink-0 text-right text-xs text-muted tabular-nums">
      {entry.durationMs === undefined || entry.state === "unavailable" ? "" : formatDuration(entry.durationMs)}
    </span>
  );
}

/** The multi-part note under a bilibili submission's title: only its first part is imported. */
export function PartsNote({ entry }: { entry: PreviewEntry }) {
  const { t } = useTranslation();
  if (entry.partCount === undefined || entry.partCount <= 1) return null;
  return (
    <span className="block text-note text-muted" data-testid="preview-entry-parts">
      {t("shell.collectionPreview.parts", { count: entry.partCount })}
    </span>
  );
}

/**
 * What choosing the entry does, as a badge and a short note under it; an entry new to the library
 * shows nothing (it is simply created and processed). `describeId` names the full sentence, for
 * the check box's description.
 */
export function EntryState({ entry, describeId }: { entry: PreviewEntry; describeId: string }) {
  const { t } = useTranslation();
  const state = entry.state ?? "new";
  if (state === "new") {
    return (
      <span id={describeId} className="sr-only">
        {t("shell.collectionPreview.stateNote.new")}
      </span>
    );
  }
  // An image post in a collection is its own state, named as such rather than "cannot be accessed".
  const imagePost = state === "unavailable" && entry.unavailableReason === "not_video";
  const label = imagePost ? t("shell.collectionPreview.unavailableReason.not_video") : t(`shell.collectionPreview.state.${state}`);
  const badge = (
    <span
      className={`inline-flex w-fit rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${BADGE_TONE[imagePost ? "not_video" : state] ?? ""}`}
      data-testid="preview-entry-state"
      data-state={state}
      {...(imagePost ? { "data-reason": "not_video" } : {})}
    >
      {label}
    </span>
  );
  let note: ReactNode;
  let full: string;
  if (imagePost) {
    full = t("shell.collectionPreview.stateNote.not_video");
    note = full;
  } else if (state === "unavailable") {
    full = t(`shell.collectionPreview.unavailableReason.${entry.unavailableReason ?? "unknown"}`);
    note = full;
  } else if (state === "trashed") {
    full = t("shell.collectionPreview.stateNote.trashed");
    note = (
      <Link to="/trash" className={TEXT_ACTION_CLASS} data-testid="preview-entry-open-trash">
        {t("shell.collectionPreview.openTrash")}
      </Link>
    );
  } else if (state === "in_library") {
    full = t("shell.collectionPreview.inLibraryDetail");
    note = t("shell.collectionPreview.stateNote.in_library");
  } else {
    full = t(`shell.collectionPreview.stateNote.${state}`);
    note = full;
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      {state === "in_library" ? <Tooltip content={full}>{badge}</Tooltip> : badge}
      <span className="text-note text-muted">{note}</span>
      <span id={describeId} className="sr-only">
        {`${label}: ${full}`}
      </span>
    </span>
  );
}
