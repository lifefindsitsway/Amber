import { Table2 } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { USAGE_GRANULARITIES, USAGE_METRICS, type UsageGranularity, type UsageMetric, type UsageSummaryResponse } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { RadioMenu, SegmentedControl } from "./usage-controls.tsx";
import { MODEL_SORTS, UsageModelsView, type ModelSort } from "./usage-models-view.tsx";
import { credentialVersionLabel } from "./usage-present.ts";
import type { UsagePatch, UsageView } from "./usage-state.ts";
import { UsageTrend, type UsageDrill } from "./usage-trend.tsx";

const TAB_CLASS = [
  "-mb-px flex h-12 items-center border-b-2 border-transparent px-3 text-sm text-muted outline-none",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
  "data-[state=active]:border-accent data-[state=active]:text-ink",
].join(" ");

/**
 * The second layer: a panel whose header row holds the two views and the controls of the one
 * showing. Trend charts one metric over time; by-model ranks the models of the range.
 */
export function UsageAnalysisPanel(props: {
  response: UsageSummaryResponse;
  view: UsageView;
  metric: UsageMetric;
  currency: PriceCurrency;
  modelKey: string | undefined;
  stale: boolean;
  onPatch: (patch: UsagePatch) => void;
  onDrill: (drill: UsageDrill) => void;
  onCurrency: (currency: PriceCurrency) => void;
}) {
  const { t } = useTranslation();
  const [table, setTable] = useState(false);
  const [sort, setSort] = useState<ModelSort>("cost");
  const { response } = props;
  const versionLabel = (profileKey: string, credentialVersion: string): string => {
    const version = response.options.profiles.find((profile) => profile.profileKey === profileKey)?.versions.find((item) => item.credentialVersion === credentialVersion);
    return credentialVersionLabel(version ?? { credentialVersion, setAt: null }, t);
  };
  const setModelFilter = (modelKey: string): void => props.onPatch({ modelKey });

  return (
    <Tabs.Root
      value={props.view}
      onValueChange={(value) => props.onPatch({ view: value === "models" ? "models" : "trend" })}
      className={`rounded-lg border border-line bg-panel transition-opacity ${props.stale ? "opacity-60" : ""}`}
      data-testid="usage-analysis"
    >
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 border-b border-line px-2">
        <Tabs.List className="flex" aria-label={t("usage.analysis.label")}>
          <Tabs.Trigger value="trend" className={TAB_CLASS} data-testid="usage-tab-trend">
            {t("usage.analysis.trend")}
          </Tabs.Trigger>
          <Tabs.Trigger value="models" className={TAB_CLASS} data-testid="usage-tab-models">
            {t("usage.analysis.models")}
          </Tabs.Trigger>
        </Tabs.List>
        <div className="flex flex-wrap items-center gap-2 py-1.5 pr-2" data-testid="usage-analysis-controls">
          {props.view === "trend" ? (
            <>
              <RadioMenu
                value={props.metric}
                options={USAGE_METRICS.map((value) => ({ value, label: t(`usage.metric.${value}`) }))}
                onChange={(metric) => props.onPatch({ metric })}
                ariaLabel={t("usage.analysis.metricLabel")}
                triggerLabel={t(`usage.metric.${props.metric}`)}
                testId="usage-metric"
              />
              <SegmentedControl<UsageGranularity>
                value={response.granularity}
                options={USAGE_GRANULARITIES.map((value) => {
                  const allowed = response.allowedGranularities.includes(value);
                  return { value, label: t(`usage.analysis.granularity.${value}`), disabled: !allowed, ...(allowed ? {} : { hint: t("usage.analysis.granularityDisabled") }) };
                })}
                onChange={(granularity) => props.onPatch({ granularity })}
                ariaLabel={t("usage.analysis.granularityLabel")}
                testId="usage-granularity"
              />
              <button
                type="button"
                className={`inline-flex size-8 items-center justify-center rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  table ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-sunken"
                }`}
                aria-pressed={table}
                aria-label={t("usage.analysis.table")}
                title={t("usage.analysis.table")}
                data-testid="usage-table-toggle"
                onClick={() => setTable(!table)}
              >
                <Table2 size={16} aria-hidden="true" />
              </button>
            </>
          ) : (
            <RadioMenu
              value={sort}
              options={MODEL_SORTS.map((value) => ({ value, label: t(`usage.analysis.sort.${value}`) }))}
              onChange={setSort}
              ariaLabel={t("usage.analysis.sortLabel")}
              triggerLabel={t(`usage.analysis.sort.${sort}`)}
              testId="usage-sort"
              align="end"
            />
          )}
        </div>
      </div>
      <Tabs.Content value="trend" className="outline-none">
        <UsageTrend response={response} metric={props.metric} currency={props.currency} table={table} onDrill={props.onDrill} onModelFilter={setModelFilter} />
      </Tabs.Content>
      <Tabs.Content value="models" className="outline-none">
        <UsageModelsView
          models={response.models}
          sort={sort}
          currency={props.currency}
          selectedModelKey={props.modelKey}
          onSelect={setModelFilter}
          onCurrency={props.onCurrency}
          versionLabel={versionLabel}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}
