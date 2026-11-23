import { useTranslation } from "react-i18next";
import { Skeleton } from "../../ui/feedback.tsx";
import { USAGE_CHART_HEIGHT_NARROW_PX, USAGE_CHART_HEIGHT_PX, useNarrowLayout } from "./usage-layout.tsx";

export function AnalysisSkeleton() {
  const { t } = useTranslation();
  const narrow = useNarrowLayout();
  return (
    <div className="rounded-lg border border-line bg-panel" role="status" aria-busy="true" data-testid="usage-analysis-skeleton">
      <span className="sr-only">{t("common.state.loading")}</span>
      <div className="flex h-12 items-center gap-3 border-b border-line px-4">
        <Skeleton width={96} height={20} />
      </div>
      <div className="p-4">
        <Skeleton height={20} />
        <Skeleton height={narrow ? USAGE_CHART_HEIGHT_NARROW_PX : USAGE_CHART_HEIGHT_PX} className="mt-3" />
      </div>
    </div>
  );
}
