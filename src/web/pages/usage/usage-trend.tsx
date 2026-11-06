import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { decodeModelKey, type UsageGranularity, type UsageMetric, type UsageSummaryResponse } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { UsageChart, type ChartBucket, type ChartSeries } from "./usage-chart.tsx";
import { bucketRangeLabel, finerGranularity } from "./usage-chart-scale.ts";
import { USAGE_CHART_HEIGHT_NARROW_PX, USAGE_CHART_HEIGHT_PX, useNarrowLayout } from "./usage-layout.tsx";
import { formatMetricValue } from "./usage-metric.ts";
import { modelLabel, profileName } from "./usage-present.ts";

type SeriesBlock = UsageSummaryResponse["series"][number];

/** A drill-down request: open one bucket in finer buckets. */
export interface UsageDrill {
  from: number;
  to: number;
  granularity: UsageGranularity;
}

/** The CSS variable of a palette slot. */
export function seriesColor(colorKey: string): string {
  return `var(--usage-${colorKey})`;
}

/** Chart series with their display names, in the order the server stacked them. */
export function chartSeriesOf(block: SeriesBlock, response: UsageSummaryResponse, t: TFunction): ChartSeries[] {
  return block.series.map((item) => {
    const color = seriesColor(item.colorKey);
    const model = item.modelKey === null ? undefined : response.models.find((candidate) => candidate.modelKey === item.modelKey);
    if (item.modelKey === null) return { key: item.key, label: t("usage.chart.other"), color, modelKey: null };
    if (model === undefined) return { key: item.key, label: decodeModelKey(item.modelKey)?.[2] ?? item.key, color, modelKey: item.modelKey };
    const profile = profileName(model.profileName, model.profileDeleted, model.modelKey, t);
    const label = modelLabel({ modelKey: model.modelKey, profileName: model.profileName, modelId: model.modelId }, t, model.profileDeleted);
    return { key: item.key, label, parts: { profile, model: model.modelId }, color, modelKey: item.modelKey };
  });
}

export function chartBucketsOf(block: SeriesBlock): ChartBucket[] {
  return block.buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    values: bucket.values.map(Number),
    raw: bucket.values,
    total: Number(bucket.total),
    totalRaw: bucket.total,
  }));
}

/** The trend view: legend, then the stacked chart or, on request, the same numbers as a table. */
export function UsageTrend(props: {
  response: UsageSummaryResponse;
  metric: UsageMetric;
  currency: PriceCurrency;
  table: boolean;
  onDrill: (drill: UsageDrill) => void;
  onModelFilter: (modelKey: string) => void;
}) {
  const { t } = useTranslation();
  const narrow = useNarrowLayout();
  const [highlight, setHighlight] = useState<string | undefined>(undefined);
  const [active, setActive] = useState<number | undefined>(undefined);
  const { response, metric, currency } = props;
  const block = response.series.find((item) => item.metric === metric);
  if (block === undefined) return null;

  const series = chartSeriesOf(block, response, t);
  const buckets = chartBucketsOf(block);
  const { granularity } = response;
  const finer = finerGranularity(granularity);
  const empty = buckets.every((bucket) => bucket.total === 0);
  const drill = (index: number): void => {
    const bucket = buckets[index];
    if (bucket !== undefined && finer !== undefined) props.onDrill({ from: bucket.start, to: bucket.end, granularity: finer });
  };

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="usage-trend">
      <Legend series={series} onHighlight={setHighlight} onModelFilter={props.onModelFilter} />
      {props.table ? (
        <TrendTable series={series} buckets={buckets} granularity={granularity} metric={metric} currency={currency} />
      ) : (
        <>
          <UsageChart
            series={series}
            buckets={buckets}
            granularity={granularity}
            metric={metric}
            currency={currency}
            highlight={highlight}
            active={active}
            onActive={setActive}
            onDrill={finer === undefined ? undefined : drill}
            height={narrow ? USAGE_CHART_HEIGHT_NARROW_PX : USAGE_CHART_HEIGHT_PX}
            ariaLabel={t("usage.chart.label", { metric: t(`usage.metric.${metric}`) })}
          />
          {empty ? <p className="text-xs text-muted">{t("usage.chart.noData")}</p> : null}
        </>
      )}
    </div>
  );
}

/** A series' name that gives way profile-first when it does not fit; `maxWidthClass` bounds where it starts to. */
function SeriesName(props: { item: ChartSeries; maxWidthClass?: string }) {
  const { parts, label } = props.item;
  const maxWidth = props.maxWidthClass ?? "max-w-[280px]";
  if (parts === undefined) return <span className={`${maxWidth} truncate`} title={label}>
        {label}
      </span>;
  return (
    <span className={`flex ${maxWidth} min-w-0 items-baseline`} title={label}>
      <span className="min-w-0 shrink-[3] truncate">{parts.profile}</span>
      <span className="shrink-0 px-1">·</span>
      <span className="min-w-0 shrink truncate">{parts.model}</span>
    </span>
  );
}

function Legend(props: { series: readonly ChartSeries[]; onHighlight: (key: string | undefined) => void; onModelFilter: (modelKey: string) => void }) {
  const { t } = useTranslation();
  return (
    <ul className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label={t("usage.chart.legend")} data-testid="usage-legend">
      {props.series.map((item) => {
        const body = (
          <>
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: item.color }} aria-hidden="true" />
            <SeriesName item={item} />
          </>
        );
        return (
          <li key={item.key} onPointerEnter={() => props.onHighlight(item.key)} onPointerLeave={() => props.onHighlight(undefined)}>
            {item.modelKey === null ? (
              <span className="inline-flex items-center gap-1.5 text-muted" data-testid="usage-legend-item">
                {body}
              </span>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                title={t("usage.chart.legendFilter", { name: item.label })}
                data-testid="usage-legend-item"
                onFocus={() => props.onHighlight(item.key)}
                onBlur={() => props.onHighlight(undefined)}
                onClick={() => props.onModelFilter(item.modelKey ?? "")}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The chart's numbers as rows (one per bucket) and columns (one per series, then the total). */
function TrendTable(props: { series: readonly ChartSeries[]; buckets: readonly ChartBucket[]; granularity: UsageGranularity; metric: UsageMetric; currency: PriceCurrency }) {
  const { t } = useTranslation();
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-line" data-testid="usage-trend-table">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-panel text-xs text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-normal">{t("usage.table.period")}</th>
            {props.series.map((item) => (
              <th key={item.key} className="px-3 py-2 text-right font-normal" title={item.label}>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 shrink-0 rounded-sm" style={{ background: item.color }} aria-hidden="true" />
                  <SeriesName item={item} maxWidthClass="max-w-[200px]" />
                </span>
              </th>
            ))}
            <th className="px-3 py-2 text-right font-normal">{t("usage.table.total")}</th>
          </tr>
        </thead>
        <tbody>
          {props.buckets.map((bucket) => (
            <tr key={bucket.start} className="border-t border-line" data-testid="usage-trend-row">
              <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{bucketRangeLabel(bucket.start, bucket.end, props.granularity)}</td>
              {bucket.raw.map((raw, index) => (
                <td key={props.series[index]?.key ?? index} className="px-3 py-1.5 text-right tabular-nums">
                  {bucket.values[index] === 0 ? "—" : formatMetricValue(props.metric, raw, props.currency)}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right font-medium tabular-nums" data-testid="usage-trend-total">
                {formatMetricValue(props.metric, bucket.totalRaw, props.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
