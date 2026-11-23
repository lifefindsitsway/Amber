import type { TFunction } from "i18next";
import { ChevronRight } from "lucide-react";
import { Fragment, useState, type FocusEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { UsageActivity, UsageCall } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { useUsageCalls } from "../../api/queries.ts";
import { formatBeijingMonthDay, formatBeijingTime, formatBeijingTimeSeconds, formatCount } from "../../format.ts";
import { EmptyState, Skeleton } from "../../ui/feedback.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import { CostCell, UsageBreakdownTooltip, UsageCell, useBreakdownOpen, VersionTag } from "./usage-cells.tsx";
import { UsageError } from "./usage-error.tsx";
import { useNarrowLayout } from "./usage-layout.tsx";
import { UsageModelMark } from "./usage-marks.tsx";
import {
  breakdownDescription,
  breakdownSentence,
  callCostView,
  callDetailText,
  costView,
  formatDurationRange,
  modelLabel,
  profileKeyOfModel,
  resultBadgeClass,
  resultLabel,
  rowVersionLabels,
  usageBreakdown,
  usageInline,
  type CredentialVersionLabels,
} from "./usage-present.ts";
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
/** A mark inside a line of small text: inline, nudged onto the text's centre line. */
const INLINE_MARK_CLASS = "mr-1 inline-block align-[-2px]";

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

function Chevron(props: {
  expanded: boolean;
  panelId: string;
  title: string;
  onToggle: () => void;
  describedBy: string | undefined;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="mt-0.5 shrink-0 rounded text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-expanded={props.expanded}
      aria-controls={props.panelId}
      aria-label={t(props.expanded ? "usage.records.collapse" : "usage.records.expand", { title: props.title })}
      {...(props.describedBy === undefined ? {} : { "aria-describedby": props.describedBy })}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      data-testid="usage-record-toggle"
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
    >
      <ChevronRight size={16} className={`transition-transform duration-150 motion-reduce:transition-none ${props.expanded ? "rotate-90" : ""}`} aria-hidden="true" />
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
  const present = (part: string | undefined): part is string => part !== undefined && part !== "";
  const leading = [daily ? t("usage.records.dailySummary") : undefined, activity.kind === "test" ? undefined : featureText(activity, t)].filter(present);
  const modelPart = activity.kind === "test" ? profileModelText(activity, t, props.deletedModels) : modelsText(activity, t);
  const trailing = [activity.credentialVersions.length > 1 ? t("usage.records.manyVersions", { n: activity.credentialVersions.length }) : undefined].filter(present);
  const details = [...leading, modelPart, ...trailing].filter(present).join(" · ");
  // A row of several models names the first and a count; a mark there would claim one vendor for all of them.
  const [onlyModel] = activity.models.length === 1 ? activity.models : [];
  const span = activity.endedAt - activity.startedAt;
  const duration = activity.requests > 1 && span > 0 ? formatDurationRange(span, t) : undefined;
  const badges = badgesOf(activity.results, t);
  const requests = t("usage.summary.callsMain", { n: formatCount(activity.requests) });
  const breakdown = usageBreakdown(activity.usage, t);
  const descriptionId = breakdown.length === 0 ? undefined : `${props.panelId}-usage`;
  const hint = useBreakdownOpen();
  const usageTooltip = (child: ReactNode) => (
    <UsageBreakdownTooltip usage={activity.usage} open={hint.open} onOpenChange={hint.onOpenChange}>
      <div data-testid="usage-record-usage">{child}</div>
    </UsageBreakdownTooltip>
  );
  return (
    <tr
      className={`cursor-pointer border-t border-line hover:bg-panel ${narrow ? "h-[84px]" : "h-14"}`}
      onClick={props.onToggle}
      data-testid="usage-record-row"
      data-kind={activity.kind}
    >
      <td className="py-1 pr-2 pl-2 align-middle">
        <div className="flex items-start gap-1">
          <Chevron
            expanded={props.expanded}
            panelId={props.panelId}
            title={title}
            onToggle={props.onToggle}
            describedBy={descriptionId}
            onFocus={hint.onFocus}
            onBlur={hint.onBlur}
          />
          {descriptionId === undefined ? null : (
            <span id={descriptionId} hidden>
              {breakdownDescription(breakdown, t)}
            </span>
          )}
          <div className="min-w-0 text-[13px] leading-tight tabular-nums">
            {narrow ? (
              <>
                <p>{formatBeijingMonthDay(activity.startedAt)}</p>
                <p>{formatBeijingTime(activity.startedAt)}</p>
              </>
            ) : (
              <p className="whitespace-nowrap">{`${formatBeijingMonthDay(activity.startedAt)} ${formatBeijingTime(activity.startedAt)}`}</p>
            )}
            {duration === undefined ? null : <SpanLine duration={duration} narrow={narrow} />}
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
          {leading.join(" · ")}
          {modelPart === "" ? null : (
            <>
              {leading.length === 0 ? "" : " · "}
              {onlyModel === undefined ? null : <UsageModelMark modelKey={onlyModel.modelKey} modelId={onlyModel.modelId} size={14} className={INLINE_MARK_CLASS} />}
              {modelPart}
            </>
          )}
          {trailing.length === 0 ? "" : ` · ${trailing.join(" · ")}`}
        </p>
        {narrow ? (
          <>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <span className="tabular-nums">{requests}</span>
              <Badges badges={badges} />
            </p>
            {usageTooltip(<p className="truncate text-xs text-muted tabular-nums">{usageInline(activity.usage, t)}</p>)}
          </>
        ) : null}
      </td>
      {narrow ? null : (
        <>
          <td className={`${CELL} text-right`}>
            <p className="leading-tight tabular-nums">{requests}</p>
            <Badges badges={badges} className="justify-end" />
          </td>
          <td className={`${CELL} text-right`}>{usageTooltip(<UsageCell usage={activity.usage} />)}</td>
        </>
      )}
      <td className={`${CELL} pr-3 text-right`}>
        <CostCell view={costView(activity.cost, props.currency)} currency={props.currency} onCurrency={props.onCurrency} />
      </td>
    </tr>
  );
}

/**
 * How far apart the first and the last call of the row are. Wide rows name it a span so it is not
 * read as the task's duration and may wrap within the time column; the narrow column keeps the bare value.
 */
function SpanLine(props: { duration: string; narrow: boolean }) {
  const { t } = useTranslation();
  const hint = t("usage.records.spanHint");
  return (
    <Tooltip content={<p className="max-w-60">{hint}</p>} side="bottom" align="start" testId="usage-span-tooltip">
      <p className={`relative text-xs text-muted ${props.narrow ? "whitespace-nowrap" : "break-words"}`} data-testid="usage-record-span">
        {props.narrow ? props.duration : t("usage.records.span", { duration: props.duration })}
        <span className="sr-only">{hint}</span>
      </p>
    </Tooltip>
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
  versionLabels: CredentialVersionLabels;
}) {
  const { t } = useTranslation();
  const calls = useUsageCalls(callsQueryOf(props.state, props.currency, props.activity.group));
  if (calls.isPending) {
    return (
      <PlaceholderRow id={props.panelId} narrow={props.narrow} testId="usage-calls-loading">
        {/* The row's ground is the skeleton's own colour, so this one is drawn in the line colour. */}
        <Skeleton width="auto" height={16} className="mx-3 bg-line!" />
      </PlaceholderRow>
    );
  }
  if (calls.isError) {
    return (
      <PlaceholderRow id={props.panelId} narrow={props.narrow} testId="usage-calls-error">
        <div className="px-3">
          <UsageError message={t("usage.records.callsError")} onRetry={() => void calls.refetch()} />
        </div>
      </PlaceholderRow>
    );
  }
  return (
    <Fragment>
      {calls.data.items.map((call, index) => (
        <CallRow
          key={call.id}
          call={call}
          currency={props.currency}
          onCurrency={props.onCurrency}
          panelId={index === 0 ? props.panelId : undefined}
          narrow={props.narrow}
          deleted={props.deletedModels.has(call.modelKey)}
          versionLabels={props.versionLabels}
        />
      ))}
    </Fragment>
  );
}

/**
 * One call. Its usage parts (cache, reasoning) are written out on a second small line rather than
 * left to a tooltip, so they read without a pointer: on touch, from the keyboard, to a screen reader.
 */
function CallRow(props: {
  call: UsageCall;
  currency: PriceCurrency;
  onCurrency: (currency: PriceCurrency) => void;
  panelId: string | undefined;
  narrow: boolean;
  deleted: boolean;
  versionLabels: CredentialVersionLabels;
}) {
  const { t } = useTranslation();
  const { call, narrow } = props;
  const model = modelLabel({ modelKey: call.modelKey, profileName: call.profileName, modelId: call.modelId }, t, props.deleted);
  const versions = rowVersionLabels(props.versionLabels, profileKeyOfModel(call.modelKey), [call.credentialVersion]);
  const detail = callDetailText(call, t);
  const badge = (
    <span className={`inline-block rounded px-1.5 text-xs whitespace-nowrap ${resultBadgeClass(call.result)}`} data-testid="usage-call-result">
      {resultLabel(call.result, call.accepted, t)}
    </span>
  );
  const exact = breakdownSentence(usageBreakdown(call.usage, t), t);
  return (
    <tr id={props.panelId} className={`border-t border-line/60 bg-sunken ${narrow ? "h-[60px]" : "h-12"}`} data-testid="usage-call-row" data-result={call.result}>
      <td className={`py-1 pr-2 ${CHILD_INDENT_CLASS} align-middle text-[13px] tabular-nums ${ACCENT_BAR}`}>{formatBeijingTimeSeconds(call.occurredAt)}</td>
      <td className={`${CELL} min-w-0 py-1 text-muted`}>
        <p className="flex min-w-0 items-center gap-1.5" data-testid="usage-call-model">
          <UsageModelMark modelKey={call.modelKey} modelId={call.modelId} size={16} />
          <span className="min-w-0 truncate" title={model}>
            {model}
          </span>
          <VersionTag labels={versions} className="max-w-[50%] shrink-0 text-xs" />
        </p>
        {narrow ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs">
            {badge}
            {call.usage.llm === null && call.usage.asr === null ? null : (
              <UsageBreakdownTooltip usage={call.usage}>
                <span className="relative min-w-0 truncate tabular-nums">
                  <span aria-hidden="true">{usageInline(call.usage, t)}</span>
                  <span className="sr-only">{exact}</span>
                </span>
              </UsageBreakdownTooltip>
            )}
          </p>
        ) : null}
        {detail === "" ? null : (
          <p className="truncate text-xs leading-4 text-muted tabular-nums" title={detail} data-testid="usage-call-detail">
            {detail}
          </p>
        )}
      </td>
      {narrow ? null : (
        <>
          <td className={`${CELL} text-right`}>{badge}</td>
          <td className={`${CELL} text-right`}>
            <UsageBreakdownTooltip usage={call.usage}>
              <div data-testid="usage-call-usage">
                <UsageCell usage={call.usage} exact />
              </div>
            </UsageBreakdownTooltip>
          </td>
        </>
      )}
      <td className={`${CELL} pr-3 text-right`}>
        <CostCell view={callCostView(call.cost, props.currency)} currency={props.currency} onCurrency={props.onCurrency} />
      </td>
    </tr>
  );
}

function RecordSkeletonRows(props: { narrow: boolean }) {
  const columns = props.narrow ? NARROW_COLUMNS : WIDE_COLUMNS;
  return (
    <>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <tr key={index} className={`border-t border-line ${props.narrow ? "h-[84px]" : "h-14"}`} aria-hidden="true" data-testid="usage-record-skeleton">
          {columns.map((_width, column) => (
            <td key={column} className="px-3">
              <Skeleton height={16} />
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
  versionLabels: CredentialVersionLabels;
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
                  <UsageError message={t("usage.records.error")} onRetry={props.onRetry} />
                </td>
              </tr>
            ) : props.items === undefined ? (
              <RecordSkeletonRows narrow={narrow} />
            ) : props.items.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-3">
                  <EmptyState title={t("usage.records.empty")} />
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
                        versionLabels={props.versionLabels}
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
