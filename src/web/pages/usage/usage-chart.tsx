import { useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { UsageGranularity, UsageMetric } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { useElementSize } from "./use-element-size.ts";
import { axisFor, bucketGroupLabel, bucketRangeLabel, bucketTickLabel, tickLabelWidth } from "./usage-chart-scale.ts";
import { formatMetricValue } from "./usage-metric.ts";

export interface ChartSeries {
  key: string;
  /** The whole name, for tooltips and table headers. */
  label: string;
  /** The two halves of a model's name, kept apart so a long profile name gives way before the model id does. */
  parts?: { profile: string; model: string };
  /** A CSS colour (a theme variable), never a literal, so the four themes restyle the chart. */
  color: string;
  modelKey: string | null;
}

export interface ChartBucket {
  start: number;
  end: number;
  /** Numeric values aligned with the series, for geometry only. */
  values: number[];
  /** The exact strings the server sent, which the tooltip and the table show. */
  raw: string[];
  total: number;
  totalRaw: string;
}

const MARGIN = { top: 8, right: 8, bottom: 38 } as const;
const MAX_BAR_PX = 24;
/** Slot width over bar width: the space between bars is at least 30% of a bar. */
const SLOT_TO_BAR = 1.3;
const MIN_BAR_PX = 2;
const TOP_RADIUS_PX = 2;
/** A series that has a value never shrinks below this, so a thin sliver stays visible. */
const MIN_SEGMENT_PX = 2;
const GAP_PX = 2;
const Y_LABEL_CHAR_PX = 7;
const Y_LABEL_PAD_PX = 12;
const TOOLTIP_WIDTH_PX = 272;
const TOOLTIP_OFFSET_PX = 12;
const DIMMED_OPACITY = 0.25;
const FALLBACK_SIZE = { width: 640, height: 240 } as const;

/** Path of a column whose top corners are rounded and whose foot is square. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(TOP_RADIUS_PX, width / 2, height);
  return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
}

/** Path of a plain rectangle, for the segments under the topmost one. */
function blockPath(x: number, y: number, width: number, height: number): string {
  return `M${x},${y} h${width} v${height} h${-width} Z`;
}

/**
 * The stacked column chart: a continuous time axis (empty buckets keep their place), three
 * round gridlines, and one tooltip that lists every series of the bucket under the pointer or
 * the arrow keys. Enter or a click opens the bucket in finer buckets.
 */
export function UsageChart(props: {
  series: readonly ChartSeries[];
  buckets: readonly ChartBucket[];
  granularity: UsageGranularity;
  metric: UsageMetric;
  currency: PriceCurrency;
  highlight: string | undefined;
  active: number | undefined;
  onActive: (index: number | undefined) => void;
  /** Called with the bucket to open; absent when the buckets cannot be opened any finer. */
  onDrill: ((index: number) => void) | undefined;
  height: number;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const tooltipId = useId();
  const [frameRef, frame] = useElementSize<HTMLDivElement>({ width: FALLBACK_SIZE.width, height: props.height });
  const svgRef = useRef<SVGSVGElement>(null);
  const { buckets, series, granularity, metric, currency, active } = props;

  const max = Math.max(0, ...buckets.map((bucket) => bucket.total));
  const axis = axisFor(metric, max, currency, t);
  const left = Math.max(...axis.ticks.map((tick) => axis.label(tick).length)) * Y_LABEL_CHAR_PX + Y_LABEL_PAD_PX;
  const width = frame.width;
  const plotWidth = Math.max(0, width - left - MARGIN.right);
  const plotHeight = Math.max(0, props.height - MARGIN.top - MARGIN.bottom);
  const slot = buckets.length === 0 ? 0 : plotWidth / buckets.length;
  const barWidth = Math.max(MIN_BAR_PX, Math.min(MAX_BAR_PX, slot / SLOT_TO_BAR));
  const barX = (index: number): number => left + slot * index + (slot - barWidth) / 2;
  const y = (value: number): number => MARGIN.top + plotHeight - (axis.top === 0 ? 0 : (value / axis.top) * plotHeight);
  const labelEvery = slot === 0 ? 1 : Math.max(1, Math.ceil(tickLabelWidth(granularity) / slot));

  const indexAt = (event: { clientX: number }): number | undefined => {
    const box = svgRef.current?.getBoundingClientRect();
    if (box === undefined || slot === 0) return undefined;
    const x = event.clientX - box.left - left;
    return x < 0 || x > plotWidth ? undefined : Math.min(buckets.length - 1, Math.floor(x / slot));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (buckets.length === 0) return;
    const last = buckets.length - 1;
    switch (event.key) {
      case "ArrowRight":
        props.onActive(active === undefined ? 0 : Math.min(last, active + 1));
        break;
      case "ArrowLeft":
        props.onActive(active === undefined ? last : Math.max(0, active - 1));
        break;
      case "Home":
        props.onActive(0);
        break;
      case "End":
        props.onActive(last);
        break;
      case "Enter":
        if (active !== undefined) props.onDrill?.(active);
        break;
      case "Escape":
        props.onActive(undefined);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const activeBucket = active === undefined ? undefined : buckets[active];
  const tooltipRows =
    activeBucket === undefined
      ? []
      : series
          .map((item, index) => ({ item, value: activeBucket.values[index] ?? 0, raw: activeBucket.raw[index] ?? "0" }))
          .filter((row) => row.value > 0)
          .sort((a, b) => b.value - a.value);

  let lastGroup: string | undefined;
  return (
    <div
      ref={frameRef}
      className="relative outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{ height: props.height }}
      role="group"
      aria-label={props.ariaLabel}
      aria-describedby={activeBucket === undefined ? undefined : tooltipId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => (active === undefined && buckets.length > 0 ? props.onActive(buckets.length - 1) : undefined)}
      onBlur={() => props.onActive(undefined)}
      data-testid="usage-chart"
    >
      <svg
        ref={svgRef}
        width={width}
        height={props.height}
        className={props.onDrill === undefined ? "block" : "block cursor-pointer"}
        aria-hidden="true"
        onPointerMove={(event) => props.onActive(indexAt(event))}
        onPointerLeave={() => props.onActive(undefined)}
        onClick={(event) => {
          const index = indexAt(event);
          if (index !== undefined) props.onDrill?.(index);
        }}
      >
        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} className="stroke-line" strokeWidth={1} />
            <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {axis.label(tick)}
            </text>
          </g>
        ))}

        {active === undefined || slot === 0 ? null : (
          <rect x={left + slot * active} y={MARGIN.top} width={slot} height={plotHeight} className="fill-sunken" data-testid="usage-bar-highlight" />
        )}

        {buckets.map((bucket, index) => (
          <g key={bucket.start} data-testid="usage-bar" data-index={index} data-total={bucket.totalRaw}>
            {stackSegments(bucket.values, axis.top, plotHeight, MARGIN.top + plotHeight).map((segment) => {
              const item = series[segment.index];
              if (item === undefined) return null;
              const dimmed = props.highlight !== undefined && props.highlight !== item.key;
              return (
                <path
                  key={item.key}
                  d={segment.top ? columnPath(barX(index), segment.y, barWidth, segment.height) : blockPath(barX(index), segment.y, barWidth, segment.height)}
                  fill={item.color}
                  className="stroke-panel"
                  strokeWidth={GAP_PX}
                  strokeLinejoin="round"
                  opacity={dimmed ? DIMMED_OPACITY : 1}
                  paintOrder="stroke"
                  data-series={item.key}
                />
              );
            })}
          </g>
        ))}

        {buckets.map((bucket, index) => {
          if (index % labelEvery !== 0) return null;
          const group = bucketGroupLabel(bucket.start, granularity);
          const showGroup = group !== lastGroup;
          lastGroup = group;
          const cx = left + slot * index + slot / 2;
          return (
            <g key={bucket.start} data-testid="usage-tick">
              <text x={cx} y={MARGIN.top + plotHeight + 14} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
                {bucketTickLabel(bucket.start, granularity)}
              </text>
              {showGroup ? (
                <text x={cx} y={MARGIN.top + plotHeight + 28} textAnchor="middle" className="fill-muted text-[11px] tabular-nums" data-testid="usage-tick-group">
                  {group}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {activeBucket === undefined || active === undefined ? null : (
        <div
          id={tooltipId}
          role="tooltip"
          aria-live="polite"
          className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-lg"
          style={{
            top: MARGIN.top,
            width: TOOLTIP_WIDTH_PX,
            left: tooltipLeft(left + slot * active + slot / 2, width),
          }}
          data-testid="usage-tooltip"
        >
          <p className="mb-1 text-muted">{bucketRangeLabel(activeBucket.start, activeBucket.end, granularity)}</p>
          <ul className="flex flex-col gap-1">
            {tooltipRows.map((row) => (
              <li key={row.item.key} className="flex items-center gap-2">
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: row.item.color }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-muted" title={row.item.label}>
                  {row.item.label}
                </span>
                <span className="font-medium tabular-nums">{formatMetricValue(metric, row.raw, currency)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 flex justify-between border-t border-line pt-1.5">
            <span className="text-muted">{t("usage.chart.total")}</span>
            <span className="font-semibold tabular-nums">{formatMetricValue(metric, activeBucket.totalRaw, currency)}</span>
          </p>
        </div>
      )}
    </div>
  );
}

interface Segment {
  /** Index into the series. */
  index: number;
  y: number;
  height: number;
  /** The topmost segment of its column, which carries the rounded corners. */
  top: boolean;
}

/** Stacks a bucket's values upward from the baseline, series 0 at the bottom. */
function stackSegments(values: readonly number[], axisTop: number, plotHeight: number, baseline: number): Segment[] {
  const segments: Segment[] = [];
  let floor = baseline;
  values.forEach((value, index) => {
    if (value <= 0) return;
    const height = Math.max(MIN_SEGMENT_PX, (value / (axisTop || 1)) * plotHeight);
    floor -= height;
    segments.push({ index, y: floor, height, top: false });
  });
  const last = segments.at(-1);
  if (last !== undefined) last.top = true;
  return segments;
}

/** The tooltip sits beside the bucket, on the side that has room. */
function tooltipLeft(center: number, width: number): number {
  const right = center + TOOLTIP_OFFSET_PX;
  return right + TOOLTIP_WIDTH_PX <= width ? right : Math.max(0, center - TOOLTIP_OFFSET_PX - TOOLTIP_WIDTH_PX);
}
