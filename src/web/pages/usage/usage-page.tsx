import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUsageActivities, useUsageSummary } from "../../api/queries.ts";
import { PageHeader } from "../../ui/feedback.tsx";
import { Pagination, useListPosition, usePagination } from "../../ui/pagination.tsx";
import { useDocumentTitle } from "../../use-document-title.ts";
import { UsageAnalysisPanel } from "./usage-analysis.tsx";
import { UsageBasisButton } from "./usage-basis.tsx";
import { UsageBreadcrumb } from "./usage-breadcrumb.tsx";
import { UsageLoadError } from "./usage-error.tsx";
import { UsageLayoutProvider, USAGE_NARROW_CONTAINER_PX } from "./usage-layout.tsx";
import { UsageRecords } from "./usage-records.tsx";
import { AnalysisSkeleton } from "./usage-skeleton.tsx";
import { activitiesQueryOf, defaultUsageCurrency, summaryQueryOf, useUsageState } from "./usage-state.ts";
import { SummarySkeleton, UsageSummaryPanel } from "./usage-summary.tsx";
import { UsageToolbar } from "./usage-toolbar.tsx";
import { useElementSize } from "./use-element-size.ts";

/** No model is known deleted while the summary is still loading. */
const NO_MODELS: ReadonlySet<string> = new Set();

/** Width assumed where nothing can be measured; wide, so the page lays out as on a desktop. */
const UNMEASURED_SIZE = { width: 1200, height: 0 } as const;

/**
 * `/usage`: the owner's AI calls in three layers under one sticky toolbar: the summary
 * (cost, calls, usage), the analysis (trend and by-model) and the record list. The whole
 * state, filters and drill-down included, lives in the address.
 */
export function UsagePage() {
  const { t } = useTranslation();
  useDocumentTitle(t("usage.title"));
  const handle = useUsageState();
  const { state, currency } = handle;
  const [containerRef, container] = useElementSize<HTMLDivElement>(UNMEASURED_SIZE);
  const [scrolled, setScrolled] = useState(false);
  const narrow = container.width < USAGE_NARROW_CONTAINER_PX;

  const summary = useUsageSummary(summaryQueryOf(state, currency));
  const position = useListPosition("usage");
  // Until the currency is settled the list would be asked for in a currency the user may not see.
  const activities = useUsageActivities(activitiesQueryOf(state, currency, position), handle.currencyChosen);
  const pager = usePagination({ scope: "usage", total: activities.data?.total, totalStale: activities.isPlaceholderData });

  // A first visit shows the owner's only currency, else yuan; the choice is then remembered like any other,
  // and the address always names the currency so a shared link reads the same.
  const { chooseCurrency, remembered } = handle;
  const resolved = summary.data !== undefined && !summary.isPlaceholderData ? summary.data : undefined;
  useEffect(() => {
    if (state.currency !== undefined) return;
    if (remembered !== undefined) chooseCurrency(remembered, { replace: true });
    else if (resolved !== undefined) chooseCurrency(defaultUsageCurrency(resolved.currencies), { replace: true });
  }, [state.currency, remembered, resolved, chooseCurrency]);

  const data = summary.data;
  const stale = summary.isPlaceholderData;
  const empty = data !== undefined && data.summary.requests === 0;
  const drilled = state.range === "custom" && state.from !== undefined && state.to !== undefined;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("usage.title")} actions={<UsageBasisButton />} />
      <div className="min-h-0 flex-1 overflow-auto" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)} data-testid="usage-scroll">
        <div className="mx-auto w-full max-w-7xl px-6 pb-8">
          <div ref={containerRef} className="@container">
            <UsageLayoutProvider narrow={narrow}>
              <div className={`sticky top-0 z-10 -mx-6 border-b bg-surface px-6 ${scrolled ? "border-line" : "border-transparent"}`} data-testid="usage-sticky">
                <UsageToolbar state={state} currency={currency} options={data?.options} onPatch={handle.patch} onCurrency={(next) => handle.chooseCurrency(next)} />
              </div>
              <div className="flex flex-col gap-6 pt-3">
                {drilled && state.from !== undefined && state.to !== undefined ? (
                  <UsageBreadcrumb from={state.from} to={state.to} onNavigate={(patch) => handle.patch(patch)} />
                ) : null}
                {summary.isPending ? (
                  <>
                    <SummarySkeleton />
                    <AnalysisSkeleton />
                    <UsageRecords
                      items={undefined}
                      total={undefined}
                      error={false}
                      onRetry={() => undefined}
                      state={state}
                      currency={currency}
                      onCurrency={handle.chooseCurrency}
                      deletedModels={NO_MODELS}
                    />
                  </>
                ) : summary.isError && data === undefined ? (
                  <UsageLoadError error={summary.error} onRetry={() => void summary.refetch()} />
                ) : data === undefined ? null : (
                  <>
                    <div className={`transition-opacity ${stale ? "opacity-60" : ""}`}>
                      <UsageSummaryPanel
                        response={data}
                        currency={currency}
                        simulate={state.simulate}
                        onSimulate={(on) => handle.patch({ simulate: on ? true : null })}
                        onCurrency={handle.chooseCurrency}
                      />
                    </div>
                    {empty ? null : (
                      <>
                        <UsageAnalysisPanel
                          response={data}
                          view={state.view}
                          metric={state.metric}
                          currency={currency}
                          modelKey={state.modelKey}
                          stale={stale}
                          onPatch={handle.patch}
                          onDrill={(drill) => handle.patch({ range: "custom", from: drill.from, to: drill.to, granularity: drill.granularity })}
                          onCurrency={handle.chooseCurrency}
                        />
                        <UsageRecords
                          items={activities.data?.items}
                          total={activities.data?.total}
                          error={activities.isError && activities.data === undefined}
                          onRetry={() => void activities.refetch()}
                              state={state}
                          currency={currency}
                          onCurrency={handle.chooseCurrency}
                          deletedModels={new Set(data.models.filter((model) => model.profileDeleted).map((model) => model.modelKey))}
                        />
                      </>
                    )}
                  </>
                )}
              </div>
            </UsageLayoutProvider>
          </div>
        </div>
      </div>
      {data === undefined || empty ? null : <Pagination pager={pager} className="border-t border-line px-6 py-3" />}
    </div>
  );
}
