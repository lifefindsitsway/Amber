import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="animate-spin text-muted" aria-hidden="true" />;
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted" role="status">
      <Spinner />
      {t("common.state.loading")}
    </div>
  );
}

/**
 * What an empty list or view says: a title, an optional hint, and optionally an icon above and one
 * action below (e.g. the button that creates the first item). `children` still render after the
 * hint for callers that compose their own content.
 */
export function EmptyState(props: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {props.icon === undefined ? null : (
        <span className="mb-1 text-muted" aria-hidden="true">
          {props.icon}
        </span>
      )}
      <p className="text-sm font-medium">{props.title}</p>
      {props.hint === undefined ? null : <p className="max-w-md text-note text-muted">{props.hint}</p>}
      {props.children}
      {props.action === undefined ? null : <div className="mt-2 flex flex-wrap justify-center gap-2">{props.action}</div>}
    </div>
  );
}

/**
 * A placeholder block of fixed size where content is loading, so the content replaces it without
 * moving anything around it. It pulses gently, and holds still under reduced motion. Decorative:
 * announce the loading on the surrounding region (see `SkeletonRows`).
 */
export function Skeleton(props: { width?: number | string; height?: number | string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      className={`block rounded bg-sunken animate-pulse motion-reduce:animate-none ${props.className ?? ""}`}
      style={{ width: props.width ?? "100%", height: props.height ?? 16 }}
    />
  );
}

/**
 * `count` skeleton lines standing in for a list while it loads, announced once as loading. Match
 * `rowHeight` to the real rows so nothing shifts when they arrive; the last line is shorter, as
 * the end of a paragraph would be.
 */
export function SkeletonRows(props: { count?: number; rowHeight?: number; gap?: number; className?: string; testId?: string }) {
  const { t } = useTranslation();
  const count = props.count ?? 3;
  return (
    <div role="status" aria-busy="true" className={`flex flex-col ${props.className ?? ""}`} style={{ gap: props.gap ?? 8 }} data-testid={props.testId}>
      <span className="sr-only">{t("common.state.loading")}</span>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} height={props.rowHeight ?? 16} width={index === count - 1 && count > 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}

export function PageHeader(props: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex min-h-14 items-center justify-between gap-4 border-b border-line px-6">
      <h1 className="truncate text-lg font-semibold">{props.title}</h1>
      <div className="flex items-center gap-2">{props.actions}</div>
    </header>
  );
}
