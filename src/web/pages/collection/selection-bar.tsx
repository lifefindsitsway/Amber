import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button.tsx";
import { useToastOffset } from "../../ui/toast.tsx";

/** Elements that handle `Esc` themselves, so it does not leave the selection mode there. */
const KEEPS_ESCAPE = ["input:not([type=checkbox])", "textarea", "select", "[contenteditable=true]", "[role=dialog]", "[role=menu]"].join(",");

/** A click on these keeps its own action instead of picking the row. */
export const ROW_INTERACTIVE = ["a", "button", "input", "select", "label"].join(",");

/** `Esc` leaves the selection mode, unless a dialog, a menu or a field takes the key itself. */
export function useSelectionEscape(selecting: boolean, exit: () => void): void {
  useEffect(() => {
    if (!selecting) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as Element | null;
      if (target?.closest(KEEPS_ESCAPE) != null) return;
      if (document.querySelector("[role=dialog]") !== null) return;
      exit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting, exit]);
}

/**
 * The bar at the page foot while rows are picked: 「已选 N 项 · 取消」 on the left, then the
 * notes that explain a disabled action, and the actions on the right after a divider. The
 * toasts rise above it while it is shown, so a result never covers the bar.
 */
export function SelectionBar(props: {
  count: number;
  onClear: () => void;
  /** Quiet notes beside the count, e.g. why an action is disabled. */
  notes?: ReactNode;
  /** The bar's actions, in reading order: the quieter one first, the main or destructive one last. */
  children: ReactNode;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = bar.current;
    if (element === null) return undefined;
    const measure = (): void => setLift(Math.max(0, window.innerHeight - element.getBoundingClientRect().top));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [props.notes]);
  useToastOffset(lift);
  return (
    <div
      ref={bar}
      role="region"
      aria-label={t("contentPack.select.barLabel")}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-panel px-6 py-2.5"
      data-testid={`${props.testIdPrefix}-selection-bar`}
    >
      <span className="text-sm font-medium" aria-live="polite" data-testid={`${props.testIdPrefix}-selection-count`}>
        {t("contentPack.select.count", { count: props.count })}
      </span>
      <Button size="sm" variant="ghost" onClick={props.onClear} data-testid={`${props.testIdPrefix}-selection-clear`}>
        {t("contentPack.select.clear")}
      </Button>
      {props.notes}
      <div className="ml-auto flex items-center gap-2">
        <span aria-hidden="true" className="mr-1 h-5 w-px bg-line" />
        {props.children}
      </div>
    </div>
  );
}
