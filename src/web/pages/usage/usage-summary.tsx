import type { TFunction } from "i18next";
import { ChevronRight, Info } from "lucide-react";
import { Popover } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { UsageResult, UsageSummaryResponse } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { formatCompactCount, formatCount } from "../../format.ts";
import { UsageCostDetail } from "./usage-cost-detail.tsx";
import { useNarrowLayout } from "./usage-layout.tsx";
import { audioText, costView, otherCurrency, RESULT_TONE } from "./usage-present.ts";

type Summary = UsageSummaryResponse["summary"];

/** One column of the summary: the five rows every column has, whether or not it fills them. */
interface SummaryColumn {
  id: "cost" | "calls" | "usage";
  label: ReactNode;
  labelAction?: ReactNode;
  main: ReactNode;
  bar: ReactNode;
  caption: ReactNode;
  extra: ReactNode;
}

const ROWS = ["label", "main", "bar", "caption", "extra"] as const;
type Row = (typeof ROWS)[number];

const WIDE_ROW_CLASS: Record<Row, string> = {
  label: "pt-4",
  main: "pt-1",
  bar: "pt-2",
  caption: "pt-2",
  extra: "pt-1 pb-4",
};

function percent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.min(100, (part / whole) * 100);
}

/** A 4px track with a single accent fill. */
function FillBar(props: { ratio: number; label: string }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-sunken" role="img" aria-label={props.label}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${props.ratio}%` }} />
    </div>
  );
}

/**
 * The headline number. It steps down a size, and drops its unit, where three columns of the
 * page's own container are too narrow for "150.9 万 / 28.2 万 tokens"; the caption beneath names the unit anyway.
 */
function MainNumber(props: { children: ReactNode; unit?: string }) {
  // A stacked band has the whole width to itself, so it keeps the full size and the unit.
  const narrow = useNarrowLayout();
  return (
    <p className={`flex items-baseline gap-1.5 leading-8 font-semibold tabular-nums ${narrow ? "text-2xl" : "text-xl @[1200px]:text-2xl"}`}>
      <span className="min-w-0 truncate" title={typeof props.children === "string" ? props.children : undefined}>
        {props.children}
      </span>
      {props.unit === undefined ? null : <span className={`shrink-0 text-xs font-normal text-muted ${narrow ? "" : "hidden @[1200px]:inline"}`}>{props.unit}</span>}
    </p>
  );
}

const CALL_RESULTS: readonly UsageResult[] = ["succeeded", "failed", "outcome_unknown", "cancelled"];

function costColumn(props: {
  summary: Summary;
  currency: PriceCurrency;
  detailOpen: boolean;
  onDetailOpen: (open: boolean) => void;
  onCurrency: (currency: PriceCurrency) => void;
  detail: ReactNode;
  t: TFunction;
}): SummaryColumn {
  const { summary, currency, t } = props;
  const cell = summary.cost;
  const view = costView(cell, currency);
  const other = otherCurrency(currency);
  const currencyName = t(`usage.currencyNames.${currency}`);
  const otherName = t(`usage.currencyNames.${other}`);
  const parts: string[] = [];
  if (cell.otherCurrency > 0 && cell.inCurrency > 0) parts.push(t("usage.summary.otherCurrencyRequests", { n: formatCount(cell.otherCurrency), currency: otherName }));
  if (cell.unknownCurrency > 0) parts.push(t("usage.summary.unknownRequests", { n: formatCount(cell.unknownCurrency) }));

  let caption: ReactNode = "—";
  if (cell.inCurrency > 0) {
    caption = t("usage.summary.coverage", { counted: formatCount(cell.counted), total: formatCount(cell.inCurrency), currency: currencyName });
  } else if (cell.otherCurrency > 0) {
    caption = (
      <button
        type="button"
        className="max-w-full truncate rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="usage-switch-currency"
        title={t("usage.summary.switchCurrency", { currency: otherName })}
        onClick={() => props.onCurrency(other)}
      >
        {t("usage.summary.switchCurrency", { currency: otherName })}
      </button>
    );
  } else if (cell.unknownCurrency > 0) {
    caption = t("usage.summary.currencyUnknown");
  }

  return {
    id: "cost",
    label: t("usage.summary.cost"),
    labelAction: (
      <Popover.Root open={props.detailOpen} onOpenChange={props.onDetailOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="-mr-1 inline-flex h-5 items-center gap-1 rounded px-1 text-xs text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={t("usage.summary.detail")}
            title={t("usage.summary.detail")}
            data-testid="usage-cost-detail-button"
          >
            <Info size={14} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 w-[400px] max-w-[calc(100vw-16px)] rounded-md border border-line bg-surface p-4 text-sm shadow-lg"
            data-testid="usage-cost-detail"
          >
            {props.detail}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    ),
    main: <MainNumber>{view.kind === "amount" ? view.text : "—"}</MainNumber>,
    bar: cell.inCurrency > 0 ? <FillBar ratio={percent(cell.counted, cell.inCurrency)} label={t("usage.summary.coverageBar")} /> : null,
    caption,
    extra:
      parts.length === 0 ? null : (
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-0.5 rounded outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          data-testid="usage-cost-extra"
          onClick={() => props.onDetailOpen(true)}
        >
          <span className="truncate" title={t("usage.summary.costExtra", { parts: parts.join(" · ") })}>
            {t("usage.summary.costExtra", { parts: parts.join(" · ") })}
          </span>
          <ChevronRight size={12} className="shrink-0" aria-hidden="true" />
        </button>
      ),
  };
}

function callsColumn(summary: Summary, t: TFunction): SummaryColumn {
  const { results } = summary;
  const parts = CALL_RESULTS.filter((result) => result !== "cancelled" && results[result] > 0);
  const extra: string[] = [];
  if (results.cancelled > 0) extra.push(t("usage.summary.cancelled", { n: formatCount(results.cancelled) }));
  if (summary.acceptedRequests > 0) extra.push(t("usage.summary.accepted", { n: formatCount(summary.acceptedRequests) }));
  return {
    id: "calls",
    label: t("usage.summary.calls"),
    main: <MainNumber>{t("usage.summary.callsMain", { n: formatCount(summary.requests) })}</MainNumber>,
    bar: (
      <div className="flex h-1 overflow-hidden rounded-full bg-sunken" role="img" aria-label={t("usage.summary.resultsBar")}>
        {CALL_RESULTS.filter((result) => results[result] > 0).map((result) => (
          <div key={result} className={`h-full ${RESULT_TONE[result]}`} style={{ width: `${percent(results[result], summary.requests)}%` }} data-result={result} />
        ))}
      </div>
    ),
    caption: (
      <span className="flex items-center gap-x-2 overflow-hidden whitespace-nowrap">
        {parts.map((result) => (
          <span key={result} className="inline-flex items-center gap-1" data-testid={`usage-result-${result}`}>
            <span className={`size-1.5 shrink-0 rounded-full ${RESULT_TONE[result]}`} aria-hidden="true" />
            {t(`usage.summary.result.${result}`, { n: formatCount(results[result]) })}
          </span>
        ))}
      </span>
    ),
    extra: extra.length === 0 ? null : extra.join(" · "),
  };
}

function usageColumn(summary: Summary, t: TFunction): SummaryColumn {
  const { llm, asr } = summary.usage;
  const hit = summary.cacheHit;
  const hitRatio = hit !== null && Number(hit.reportedInput) > 0 ? percent(Number(hit.cacheRead), Number(hit.reportedInput)) : undefined;
  const asrTokens = asr === null ? 0 : Number(asr.billedInputTokens) + Number(asr.billedOutputTokens);
  const base = { id: "usage" as const, label: t("usage.summary.usage") };
  if (llm === null && asr === null) {
    return { ...base, main: <MainNumber>—</MainNumber>, bar: null, caption: null, extra: null };
  }
  if (llm === null && asr !== null) {
    return {
      ...base,
      main: <MainNumber>{audioText(asr.audioMs, t)}</MainNumber>,
      bar: null,
      caption: t("usage.summary.asrOnly"),
      extra:
        asrTokens > 0
          ? t("usage.summary.asrBilled", { input: formatCompactCount(asr.billedInputTokens), output: formatCompactCount(asr.billedOutputTokens) })
          : null,
    };
  }
  const partialHit = hit !== null && hit.reportedRequests < hit.llmRequests;
  const cacheCaption =
    hitRatio === undefined
      ? t("usage.summary.llmCaption")
      : t(partialHit ? "usage.summary.llmCaptionCachePartial" : "usage.summary.llmCaptionCache", {
          percent: Math.round(hitRatio),
          reported: hit === null ? 0 : hit.reportedRequests,
          total: hit === null ? 0 : hit.llmRequests,
        });
  const extra: string[] = [];
  if (asr !== null) extra.push(t("usage.summary.asrLine", { tokens: asrTokens > 0 ? `${formatCompactCount(asrTokens)} tokens · ` : "", audio: audioText(asr.audioMs, t) }));
  if (summary.inputMissingRequests > 0) extra.push(t("usage.summary.inputMissing", { n: formatCount(summary.inputMissingRequests) }));
  return {
    ...base,
    main: llm === null ? null : <MainNumber unit={t("usage.units.tokens")}>{`${formatCompactCount(llm.input)} / ${formatCompactCount(llm.output)}`}</MainNumber>,
    bar: hitRatio === undefined ? null : <FillBar ratio={hitRatio} label={t("usage.summary.cacheBar")} />,
    caption: cacheCaption,
    extra: extra.length === 0 ? null : extra.join(" · "),
  };
}

/** Wide: one grid, one track per row, so the rows line up across the columns by construction. */
function WideSummary(props: { columns: SummaryColumn[]; idPrefix: string }) {
  return (
    <div className="grid grid-cols-3" data-testid={`${props.idPrefix}-grid`} data-layout="wide">
      {ROWS.map((row) =>
        props.columns.map((column, index) => (
          <div
            key={`${row}-${column.id}`}
            className={`min-w-0 px-5 ${WIDE_ROW_CLASS[row]} ${index > 0 ? "border-l border-line" : ""}`}
            data-testid={`${props.idPrefix}-${column.id}-${row}`}
            data-row={row}
          >
            <SummaryCell row={row} column={column} />
          </div>
        )),
      )}
    </div>
  );
}

function SummaryCell(props: { row: Row; column: SummaryColumn; wrap?: boolean }) {
  const { row, column } = props;
  const lineClass = `min-h-4 text-xs leading-4 text-muted ${props.wrap === true ? "" : "truncate"}`;
  switch (row) {
    case "label":
      return (
        <div className="flex h-5 items-center justify-between text-xs text-muted" data-part="label">
          <span>{column.label}</span>
          {column.labelAction}
        </div>
      );
    case "main":
      return (
        <div className="min-h-8" data-part="main">
          {column.main}
        </div>
      );
    case "bar":
      return (
        <div className="h-1" data-part="bar">
          {column.bar}
        </div>
      );
    case "caption":
      return (
        <div className={lineClass} data-part="caption" title={typeof column.caption === "string" ? column.caption : undefined}>
          {column.caption}
        </div>
      );
    case "extra":
      return (
        <div className={lineClass} data-part="extra" title={typeof column.extra === "string" ? column.extra : undefined}>
          {column.extra}
        </div>
      );
  }
}

/**
 * Narrow: one band per metric, the label and number on the left and the bar and sentences on
 * the right; below the container width where both no longer fit side by side, the parts stack.
 */
function NarrowSummary(props: { columns: SummaryColumn[]; idPrefix: string }) {
  return (
    <div className="divide-y divide-line" data-testid={`${props.idPrefix}-grid`} data-layout="narrow">
      {props.columns.map((column) => (
        <div key={column.id} className="grid grid-cols-1 gap-x-5 gap-y-2 px-4 py-3 @[640px]:grid-cols-[auto_minmax(0,1fr)]" data-testid={`${props.idPrefix}-${column.id}`}>
          <div className="min-w-0">
            <SummaryCell row="label" column={column} />
            <SummaryCell row="main" column={column} />
          </div>
          <div className="min-w-0 self-center">
            <SummaryCell row="bar" column={column} />
            <div className="mt-2">
              <SummaryCell row="caption" column={column} wrap />
            </div>
            <SummaryCell row="extra" column={column} wrap />
          </div>
        </div>
      ))}
    </div>
  );
}

function Bone(props: { className: string }) {
  return <div className={`animate-pulse rounded bg-sunken ${props.className}`} />;
}

/** The summary's own grid filled with placeholders, so the numbers arrive without moving anything. */
export function SummarySkeleton() {
  const narrow = useNarrowLayout();
  const ids = ["cost", "calls", "usage"] as const;
  const columns: SummaryColumn[] = ids.map((id) => ({
    id,
    label: <Bone className="h-4 w-12" />,
    main: <Bone className="h-8 w-28" />,
    bar: <Bone className="h-1 w-full" />,
    caption: <Bone className="h-4 w-40 max-w-full" />,
    extra: <Bone className="h-4 w-32 max-w-full" />,
  }));
  return (
    <div className="rounded-lg border border-line bg-panel" role="status" aria-busy="true" data-testid="usage-summary-skeleton">
      {narrow ? <NarrowSummary columns={columns} idPrefix="usage-summary-skeleton" /> : <WideSummary columns={columns} idPrefix="usage-summary-skeleton" />}
    </div>
  );
}

/**
 * The first layer: estimated cost, calls and usage as three equal columns that share one grid,
 * with a one-line stand-in when the range holds no calls.
 */
export function UsageSummaryPanel(props: {
  response: UsageSummaryResponse;
  currency: PriceCurrency;
  simulate: boolean;
  onSimulate: (on: boolean) => void;
  onCurrency: (currency: PriceCurrency) => void;
}) {
  const { t } = useTranslation();
  const narrow = useNarrowLayout();
  const [detailOpen, setDetailOpen] = useState(false);
  const { summary } = props.response;

  if (summary.requests === 0) {
    return (
      <div className="flex min-h-12 items-center rounded-lg border border-line bg-panel px-5 text-sm text-muted" data-testid="usage-empty">
        <span>{t("usage.empty.text")}</span>
        <Link to="/settings/models" className="ml-2 inline-flex items-center text-accent hover:underline">
          {t("usage.empty.configure")}
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </div>
    );
  }

  const columns = [
    costColumn({
      summary,
      currency: props.currency,
      detailOpen,
      onDetailOpen: setDetailOpen,
      onCurrency: props.onCurrency,
      detail: (
        <UsageCostDetail
          response={props.response}
          simulate={props.simulate}
          onSimulate={props.onSimulate}
          onNavigate={() => setDetailOpen(false)}
        />
      ),
      t,
    }),
    callsColumn(summary, t),
    usageColumn(summary, t),
  ];
  return (
    <section className="rounded-lg border border-line bg-panel" aria-label={t("usage.summary.label")} data-testid="usage-summary">
      {narrow ? <NarrowSummary columns={columns} idPrefix="usage-summary" /> : <WideSummary columns={columns} idPrefix="usage-summary" />}
    </section>
  );
}
