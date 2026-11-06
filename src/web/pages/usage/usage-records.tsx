import type { TFunction } from "i18next";
import { ChevronRight } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { UsageActivity, UsageCall } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { useUsageCalls } from "../../api/queries.ts";
import { formatBeijingMonthDay, formatBeijingTime, formatBeijingTimeSeconds, formatCount } from "../../format.ts";
import { CostCell, UsageCell } from "./usage-cells.tsx";
import { UsageError } from "./usage-error.tsx";
import { useNarrowLayout } from "./usage-layout.tsx";
import { callCostView, costView, credentialVersionLabel, formatDurationRange, modelLabel, resultBadgeClass, resultLabel, usageInline } from "./usage-present.ts";
import { callsQueryOf, type UsageState } from "./usage-state.ts";

/** Fixed column widths of the record table; the content column takes what is left. */
const WIDE_COLUMNS = ["w-28", "", "w-[88px]", "w-[196px]", "w-28"] as const;
/** Narrow containers drop the request and usage columns into the content cell. */
const NARROW_COLUMNS = ["w-20", "", "w-24"] as const;
const SKELETON_ROWS = 5;
/** Features listed by name before the rest fold into a count. */
const FEATURES_NAMED = 2;
/** The chevron's width plus its gap, which child rows indent their time by so it lines up with the parent's. */
const CHILD_INDENT_CLASS = "pl-[26px]";
const ACCENT_BAR = "shadow-[inset_2px_0_0_0_var(--color-accent)]";
const CELL = "px-2 align-middle";

function featureText(activity: UsageActivity, t: TFunction): string {
  const names = activity.features.map((feature) => t(`usage.feature.${feature}`));
  if (names.length <= FEATURES_NAMED) return names.join(t("usage.records.listSeparator"));
  return t("usage.records.featuresMore", { names: names.slice(0, FEATURES_NAMED).join(t("usage.records.listSeparator")), n: names.length });
}

function modelsText(activity: UsageActivity, t: TFunction): string {
  const [first] = activity.models;
  if (first === undefined) return "";
  return activity.models.length > 1 ? t("usage.records.modelsMore", { model: first.modelId, n: activity.models.length }) : first.modelId;
}

/** The tested model as `profile · model`: a test row's title already names the purpose, so its small line names the target. */
function profileModelText(activity: UsageActivity, t: TFunction, deletedModels: ReadonlySet<string>): string {
  const [first] = activity.models;
  return first === undefined ? "" : modelLabel(first, t, deletedModels.has(first.modelKey));
}

function titleOf(activity: UsageActivity, t: TFunction): string {
  switch (activity.kind) {
    case "test":
      return t("usage.records.test");
    case "deleted_day":
      return t("usage.records.deletedContent");
    case "chat":
      return activity.title ?? t("usage.records.chat");
    default:
      return activity.title ?? t("usage.records.untitled");
  }
}

/** Rows that open their content: every kind except a test and the days whose content is gone. */
function opensContent(activity: UsageActivity): boolean {
  return activity.contentId !== null && activity.kind !== "test" && activity.kind !== "deleted_day";
}

function ColGroup(props: { narrow: boolean }) {
  return (
    <colgroup>
      {(props.narrow ? NARROW_COLUMNS : WIDE_COLUMNS).map((width, index) => (
        <col key={index} className={width} />
      ))}
    </colgroup>
  );
}

function Head(props: { narrow: boolean }) {
  const { t } = useTranslation();
  const numeric = "px-2 py-2 text-right font-normal";
  return (
    <thead className="text-xs text-muted">
      <tr>
        <th className="py-2 pr-2 pl-3 text-left font-normal">{t("usage.records.time")}</th>
        <th className="px-2 py-2 text-left font-normal">{t("usage.records.content")}</th>
        {props.narrow ? null : <th className={numeric}>{t("usage.records.requests")}</th>}
        {props.narrow ? null : <th className={numeric}>{t("usage.records.usage")}</th>}
        <th className={`${numeric} pr-3`}>{t("usage.records.cost")}</th>
      </tr>
    </thead>
  );
}

interface Badge {
  key: string;
  label: string;
  className: string;
}

function badgesOf(results: UsageActivity["results"], t: TFunction): Badge[] {
  const badges: Badge[] = [];
  if (results.failed > 0) badges.push({ key: "failed", label: t("usage.records.failed", { n: results.failed }), className: resultBadgeClass("failed") });
  if (results.outcome_unknown > 0) {
    badges.push({ key: "unknown", label: t("usage.records.unknown", { n: results.outcome_unknown }), className: resultBadgeClass("outcome_unknown") });
  }
  if (results.cancelled > 0) badges.push({ key: "cancelled", label: t("usage.records.cancelled", { n: results.cancelled }), className: resultBadgeClass("cancelled") });
  return badges;
}

function Badges(props: { badges: readonly Badge[]; className?: string }) {
  return (
    <span className={`flex flex-wrap gap-x-1 ${props.className ?? ""}`}>
      {props.badges.map((badge) => (
        <span key={badge.key} className={`rounded px-1 text-[11px] leading-4 whitespace-nowrap ${badge.className}`} data-testid={`usage-badge-${badge.key}`}>
          {badge.label}
        </span>
      ))}
    </span>
  );
}

function Chevron(props: { expanded: boolean; panelId: string; title: string; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="mt-0.5 shrink-0 rounded text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-expanded={props.expanded}
      aria-controls={props.panelId}
      aria-label={t(props.expanded ? "usage.records.collapse" : "usage.records.expand", { title: props.title })}
      data-testid="usage-record-toggle"
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
    >
      <ChevronRight size={16} className={`transition-transform ${props.expanded ? "rotate-90" : ""}`} aria-hidden="true" />
    </button>
  );
}

function ActivityRow(props: {
  activity: UsageActivity;
  expanded: boolean;
  onToggle: () => void;
  currency: PriceCurrency;
  onCurrency: (currency: PriceCurrency) => void;
  panelId: string;
  narrow: boolean;
  deletedModels: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const { activity, narrow } = props;
  const title = titleOf(activity, t);
  const daily = activity.kind === "content_day" || activity.kind === "deleted_day";
  const muted = activity.kind === "deleted_day";
  const details = [
    daily ? t("usage.records.dailySummary") : undefined,
    activity.kind === "test" ? undefined : featureText(activity, t),
    activity.kind === "test" ? profileModelText(activity, t, props.deletedModels) : modelsText(activity, t),
    activity.credentialVersions.length > 1 ? t("usage.records.manyVersions", { n: activity.credentialVersions.length }) : undefined,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  const span = activity.endedAt - activity.startedAt;
  const duration = activity.requests > 1 && span > 0 ? formatDurationRange(span, t) : undefined;
  const badges = badgesOf(activity.results, t);
  const requests = t("usage.summary.callsMain", { n: formatCount(activity.requests) });
  return (
    <tr
      className={`cursor-pointer border-t border-line hover:bg-panel ${narrow ? "h-[84px]" : "h-14"}`}
      onClick={props.onToggle}
      data-testid="usage-record-row"
      data-kind={activity.kind}
    >
      <td className="py-1 pr-2 pl-2 align-middle">
        <div className="flex items-start gap-1">
          <Chevron expanded={props.expanded} panelId={props.panelId} title={title} onToggle={props.onToggle} />
          <div className="min-w-0 text-[13px] leading-tight tabular-nums">
            {narrow ? (
              <>
                <p>{formatBeijingMonthDay(activity.startedAt)}</p>
                <p>{formatBeijingTime(activity.startedAt)}</p>
              </>
            ) : (
              <p className="whitespace-nowrap">{`${formatBeijingMonthDay(activity.startedAt)} ${formatBeijingTime(activity.startedAt)}`}</p>
            )}
            {duration === undefined ? null : <p className="text-xs whitespace-nowrap text-muted">{duration}</p>}
          </div>
        </div>
      </td>
      <td className={`${CELL} min-w-0`}>
        {opensContent(activity) ? (
          <Link
            to={`/contents/${activity.contentId}`}
            className="block truncate rounded font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
            title={title}
            onClick={(event) => event.stopPropagation()}
          >
            {title}
          </Link>
        ) : (
          <p className={`truncate font-medium ${muted ? "text-muted" : ""}`} title={title}>
            {title}
          </p>
        )}
        <p className="truncate text-xs text-muted" title={details}>
          {details}
        </p>
        {narrow ? (
          <>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <span className="tabular-nums">{requests}</span>
              <Badges badges={badges} />
            </p>
            <p className="truncate text-xs text-muted tabular-nums" title={usageInline(activity.usage, t)}>
              {usageInline(activity.usage, t)}
            </p>
          </>
        ) : null}
      </td>
      {narrow ? null : (
        <>
          <td className={`${CELL} text-right`}>
            <p className="leading-tight tabular-nums">{requests}</p>
            <Badges badges={badges} className="justify-end" />
          </td>
          <td className={`${CELL} text-right`}>
            <UsageCell usage={activity.usage} />
          </td>
        </>
      )}
      <td className={`${CELL} pr-3 text-right`}>
        <CostCell view={costView(activity.cost, props.currency)} currency={props.currency} onCurrency={props.onCurrency} />
      </td>
    </tr>
  );
}

function PlaceholderRow(props: { id: string; narrow: boolean; children: ReactNode; testId: string }) {
  return (
    <tr id={props.id} className="bg-sunken" data-testid={props.testId}>
      <td colSpan={props.narrow ? NARROW_COLUMNS.length : WIDE_COLUMNS.length} className={`h-12 ${ACCENT_BAR}`}>
        {props.children}
      </td>
    </tr>
  );
}

/** Child rows: the same columns as the parent, one row per call, on the sunken ground with the accent bar. */
function CallRows(props: {
  activity: UsageActivity;
  state: UsageState;
  currency: PriceCurrency;
  onCurrency: (currency: PriceCurrency) => void;
  panelId: string;
  narrow: boolean;
  deletedModels: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const calls = useUsageCalls(callsQueryOf(props.state, props.currency, props.activity.group));
  if (calls.isPending) {
    return (
      <PlaceholderRow id={props.panelId} narrow={props.narrow} testId="usage-calls-loading">
        <div className="mx-3 h-4 animate-pulse rounded bg-line" />
      </PlaceholderRow>
    );
  }
  if (calls.isError) {
    return (
      <PlaceholderRow id={props.panelId} narrow={props.narrow} testId="usage-calls-error">
        <div className="px-3">
          <UsageError message={t("usage.records.callsError")} onRetry={() => void calls.refetch()} compact />
        </div>
      </PlaceholderRow>
    );
  }
  return (
    <Fragment>
      {calls.data.items.map((call, index) => (
        <CallRow key={call.id} call={call} currency={props.currency} onCurrency={props.onCurrency} panelId={index === 0 ? props.panelId : undefined} narrow={props.narrow} deleted={props.deletedModels.has(call.modelKey)} />
      ))}
    </Fragment>
  );
}

function CallRow(props: { call: UsageCall; currency: PriceCurrency; onCurrency: (currency: PriceCurrency) => void; panelId: string | undefined; narrow: boolean; deleted: boolean }) {
  const { t } = useTranslation();
  const { call, narrow } = props;
  const model = modelLabel({ modelKey: call.modelKey, profileName: call.profileName, modelId: call.modelId }, t, props.deleted);
  const version = credentialVersionLabel({ credentialVersion: call.credentialVersion, setAt: call.credentialSetAt }, t);
  const label = `${model} · ${version}`;
  const badge = (
    <span className={`inline-block rounded px-1.5 text-xs whitespace-nowrap ${resultBadgeClass(call.result)}`} data-testid="usage-call-result">
      {resultLabel(call.result, call.accepted, t)}
    </span>
  );
  return (
    <tr id={props.panelId} className={`border-t border-line/60 bg-sunken ${narrow ? "h-[60px]" : "h-12"}`} data-testid="usage-call-row" data-result={call.result}>
      <td className={`py-1 pr-2 ${CHILD_INDENT_CLASS} align-middle text-[13px] tabular-nums ${ACCENT_BAR}`}>{formatBeijingTimeSeconds(call.occurredAt)}</td>
      <td className={`${CELL} min-w-0 text-muted`}>
        <p className="truncate" title={label}>
          {label}
        </p>
        {narrow ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs">
            {badge}
            <span className="min-w-0 truncate tabular-nums" title={usageInline(call.usage, t)}>
              {usageInline(call.usage, t)}
            </span>
          </p>
        ) : null}
      </td>
      {narrow ? null : (
        <>
          <td className={`${CELL} text-right`}>{badge}</td>
          <td className={`${CELL} text-right`}>
            <UsageCell usage={call.usage} />
          </td>
        </>
      )}
      <td className={`${CELL} pr-3 text-right`}>
        <CostCell view={callCostView(call.cost, props.currency)} currency={props.currency} onCurrency={props.onCurrency} />
      </td>
    </tr>
  );
}

function SkeletonRows(props: { narrow: boolean }) {
  const columns = props.narrow ? NARROW_COLUMNS : WIDE_COLUMNS;
  return (
    <>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <tr key={index} className={`border-t border-line ${props.narrow ? "h-[84px]" : "h-14"}`} data-testid="usage-record-skeleton">
          {columns.map((_width, column) => (
            <td key={column} className="px-3">
              <div className="h-4 animate-pulse rounded bg-sunken" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * The third layer: the list of activities, a row per group of calls that belong together,
 * expandable into the calls themselves. The pager is the page's, fixed at its foot like every list page.
 */
export function UsageRecords(props: {
  items: readonly UsageActivity[] | undefined;
  total: number | undefined;
  error: boolean;
  onRetry: () => void;
  state: UsageState;
  currency: PriceCurrency;
  onCurrency: (currency: PriceCurrency) => void;
  /** Keys of the models whose profile is deleted; activities and calls carry no such flag of their own. */
  deletedModels: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const narrow = useNarrowLayout();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const columnCount = narrow ? NARROW_COLUMNS.length : WIDE_COLUMNS.length;
  const toggle = (group: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  return (
    <section aria-label={t("usage.records.title")} data-testid="usage-records">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t("usage.records.title")}</h2>
        {props.total === undefined ? null : <span className="text-xs text-muted">{t("usage.records.count", { n: formatCount(props.total) })}</span>}
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full table-fixed text-sm">
          <ColGroup narrow={narrow} />
          <Head narrow={narrow} />
          <tbody>
            {props.error ? (
              <tr>
                <td colSpan={columnCount} className="h-20 px-3">
                  <UsageError message={t("usage.records.error")} onRetry={props.onRetry} compact />
                </td>
              </tr>
            ) : props.items === undefined ? (
              <SkeletonRows narrow={narrow} />
            ) : props.items.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="h-20 px-3 text-center text-sm text-muted">
                  {t("usage.records.empty")}
                </td>
              </tr>
            ) : (
              props.items.map((activity) => {
                const open = expanded.has(activity.group);
                const panelId = `usage-calls-${activity.group}`;
                return (
                  <Fragment key={activity.group}>
                    <ActivityRow
                      activity={activity}
                      expanded={open}
                      onToggle={() => toggle(activity.group)}
                      currency={props.currency}
                      onCurrency={props.onCurrency}
                      panelId={panelId}
                      narrow={narrow}
                      deletedModels={props.deletedModels}
                    />
                    {open ? (
                      <CallRows
                        activity={activity}
                        state={props.state}
                        currency={props.currency}
                        onCurrency={props.onCurrency}
                        panelId={panelId}
                        narrow={narrow}
                        deletedModels={props.deletedModels}
                      />
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
