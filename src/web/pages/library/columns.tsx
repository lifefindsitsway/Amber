import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContentDto } from "../../../shared/dto/content.ts";

/** `w-px` with no wrapping shrinks a column to its content. */
export const NARROW = "w-px whitespace-nowrap py-2 font-medium";
export const COLUMN = "px-2 py-2 font-medium";
/**
 * Columns by the width of the list area (a container query, in rem so it follows the font
 * size and the sidebar): from 64rem every column shows; below that source, duration and
 * update time fold into a line under the title; below 48rem cover and collections go too.
 * The collection page's member table folds at the same widths.
 */
export const WIDE_ONLY = "hidden @5xl:table-cell";
export const COMPACT_UP = "hidden @3xl:table-cell";
/**
 * Platform covers are loaded without a Referer: some CDNs refuse foreign referrers. The CSP
 * admits images over https only, so a cover stored with plain http is asked for over https;
 * one that still fails shows the empty placeholder instead of a broken image.
 */
export function Cover({ url, className = "h-12 w-20" }: { url?: string | undefined; className?: string }) {
  const [failed, setFailed] = useState<string>();
  const src = url?.replace(/^http:\/\//, "https://");
  if (src === undefined || src === failed) {
    return <div data-testid="cover-placeholder" className={`${className} rounded bg-sunken`} />;
  }
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(src)}
      // The base style's max-width: 100% lets a shrink-to-fit table column squeeze the image.
      className={`${className} max-w-none rounded object-cover`}
    />
  );
}

const STATUS_TONE: Record<string, string> = {
  // 「已导入」: a Content from a content pack with no processing task; a neutral fact, not a state of work.
  none: "text-muted ring-1 ring-line ring-inset",
  queued: "bg-sunken text-muted",
  running: "bg-accent-soft text-accent",
  waiting: "bg-accent-soft text-accent",
  succeeded: "bg-ok/10 text-ok",
  failed: "bg-danger/10 text-danger",
  cancelled: "bg-sunken text-muted",
};

export function StatusBadge({ status }: { status: ContentDto["processingStatus"] }) {
  const { t } = useTranslation();
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_TONE[status] ?? ""}`}>{t(`common.status.${status}`)}</span>;
}
