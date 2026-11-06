import { USAGE_CHART_HEIGHT_NARROW_PX, USAGE_CHART_HEIGHT_PX, useNarrowLayout } from "./usage-layout.tsx";

function Bone(props: { className: string }) {
  return <div className={`animate-pulse rounded bg-sunken ${props.className}`} />;
}

export function AnalysisSkeleton() {
  const narrow = useNarrowLayout();
  return (
    <div className="rounded-lg border border-line bg-panel" role="status" aria-busy="true" data-testid="usage-analysis-skeleton">
      <div className="flex h-12 items-center gap-3 border-b border-line px-4">
        <Bone className="h-5 w-24" />
      </div>
      <div className="p-4">
        <Bone className="h-5 w-full" />
        <div style={{ height: narrow ? USAGE_CHART_HEIGHT_NARROW_PX : USAGE_CHART_HEIGHT_PX }} className="mt-3 animate-pulse rounded bg-sunken" />
      </div>
    </div>
  );
}
