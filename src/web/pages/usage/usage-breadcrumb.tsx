import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatBeijingMonth, formatBeijingMonthDay } from "../../format.ts";
import type { UsagePatch } from "./usage-state.ts";

const MS_PER_HOUR = 3_600_000;
const BEIJING_OFFSET_MS = 8 * MS_PER_HOUR;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DAYS_PER_WEEK = 7;
/** Epoch day 0 (1970-01-01) was a Thursday, three days after a Monday; Beijing weeks start on Monday. */
const DAYS_SINCE_MONDAY_AT_EPOCH = 3;

export interface Crumb {
  label: string;
  /** Where choosing the crumb leads; the last crumb is where the page is and has none. */
  patch?: UsagePatch;
}

/** Midnight of the Beijing month containing `ms`, and of the month after. */
function monthBounds(ms: number): { start: number; end: number } {
  const [year = 0, month = 1] = formatBeijingMonth(ms).split("-").map(Number);
  return { start: Date.UTC(year, month - 1, 1) - BEIJING_OFFSET_MS, end: Date.UTC(year, month, 1) - BEIJING_OFFSET_MS };
}

function isBeijingMidnight(ms: number): boolean {
  return (ms + BEIJING_OFFSET_MS) % MS_PER_DAY === 0;
}

function isBeijingMonday(ms: number): boolean {
  return isBeijingMidnight(ms) && (Math.floor((ms + BEIJING_OFFSET_MS) / MS_PER_DAY) + DAYS_SINCE_MONDAY_AT_EPOCH) % DAYS_PER_WEEK === 0;
}

/**
 * The path from the whole history down to a drilled range, derived from the range itself so
 * that a shared link shows the same trail: all › month › day for a day, all › month for a month.
 */
export function drillCrumbs(from: number, to: number, labels: { all: string; weekOf: (date: string) => string }): Crumb[] {
  const root: Crumb = { label: labels.all, patch: { range: "all" } };
  const month = monthBounds(from);
  const span = to - from;
  const monthPatch: UsagePatch = { range: "custom", from: month.start, to: month.end, granularity: "day" };
  if (from === month.start && to === month.end) return [root, { label: formatBeijingMonth(from) }];
  if (span === MS_PER_DAY && isBeijingMidnight(from)) {
    return [root, { label: formatBeijingMonth(from), patch: monthPatch }, { label: formatBeijingMonthDay(from) }];
  }
  if (span === DAYS_PER_WEEK * MS_PER_DAY && isBeijingMonday(from)) return [root, { label: labels.weekOf(formatBeijingMonthDay(from)) }];
  return [root, { label: `${formatBeijingMonthDay(from)} – ${formatBeijingMonthDay(to - 1)}` }];
}

/** The trail above the summary while a bucket is opened, with a way back one level up. */
export function UsageBreadcrumb(props: { from: number; to: number; onNavigate: (patch: UsagePatch) => void }) {
  const { t } = useTranslation();
  const crumbs = drillCrumbs(props.from, props.to, { all: t("usage.breadcrumb.all"), weekOf: (date) => t("usage.breadcrumb.weekOf", { date }) });
  const parent = crumbs.at(-2);
  return (
    <nav aria-label={t("usage.breadcrumb.label")} className="flex items-center justify-between gap-3 text-xs" data-testid="usage-breadcrumb">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-muted">
        {crumbs.map((crumb, index) => (
          <li key={`${index}-${crumb.label}`} className="flex items-center gap-1">
            {index > 0 ? <span aria-hidden="true">›</span> : null}
            {crumb.patch === undefined ? (
              <span className="text-ink" aria-current="page">
                {crumb.label}
              </span>
            ) : (
              <button
                type="button"
                className="rounded outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => crumb.patch !== undefined && props.onNavigate(crumb.patch)}
              >
                {crumb.label}
              </button>
            )}
          </li>
        ))}
      </ol>
      {parent?.patch === undefined ? null : (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-0.5 rounded text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          data-testid="usage-breadcrumb-back"
          onClick={() => parent.patch !== undefined && props.onNavigate(parent.patch)}
        >
          {t("usage.breadcrumb.back")}
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </nav>
  );
}
