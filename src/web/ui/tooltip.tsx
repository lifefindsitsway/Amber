import { Tooltip as RadixTooltip } from "radix-ui";
import { createContext, useContext, type FocusEvent, type ReactElement, type ReactNode, type SyntheticEvent } from "react";

/**
 * Hover delay before a tooltip opens: long enough that sweeping the pointer across a table does
 * not flash one per row, short enough that resting on a number answers promptly.
 */
const OPEN_DELAY_MS = 350;
/** Once one tooltip has shown, a neighbour opens without the delay for this long. */
const SKIP_DELAY_MS = 400;

/** Styled like the app's popovers and menus: surface, line border, shadow, small text. */
export const TOOLTIP_CONTENT_CLASS = "z-50 max-w-88 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink shadow-lg";

/**
 * How long after an Escape press or a pointer press a focus is treated as focus being handed
 * back (a popover or dialog closing returns focus to its trigger) rather than the user moving
 * to the control.
 */
const RESTORED_FOCUS_WINDOW_MS = 600;

let lastDismissAt = Number.NEGATIVE_INFINITY;
let dismissTrackerInstalled = false;

/**
 * Remembers when the user last pressed Escape or a pointer. Installed once, in the capture
 * phase, so it sees the event before any layer reacts to it.
 */
function trackDismissInput(): void {
  if (dismissTrackerInstalled || typeof document === "undefined") return;
  dismissTrackerInstalled = true;
  const mark = (): void => {
    lastDismissAt = performance.now();
  };
  document.addEventListener("pointerdown", mark, true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") mark();
      else lastDismissAt = Number.NEGATIVE_INFINITY;
    },
    true,
  );
}

/**
 * Focus handed back to a trigger right after an Escape or a click must not open its tooltip:
 * inside a dialog or popover the open tooltip becomes the topmost dismissable layer, so the
 * next Escape would only close the tooltip instead of the surface the user is trying to leave,
 * and after a mouse close a tooltip popping up out of nowhere is noise. Keyboard navigation
 * (Tab, arrows) and hover still open it. Cancelling the event skips Radix's own focus handler.
 */
function skipRestoredFocus(event: FocusEvent): void {
  if (performance.now() - lastDismissAt < RESTORED_FOCUS_WINDOW_MS) event.preventDefault();
}

const ProvidedContext = createContext(false);

/**
 * One provider for the whole app, so tooltips share their delays: after one has shown, the next
 * opens at once. Content is never hoverable: tooltips only explain, nothing in them is a control.
 */
export function TooltipProvider(props: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={OPEN_DELAY_MS} skipDelayDuration={SKIP_DELAY_MS} disableHoverableContent>
      <ProvidedContext.Provider value={true}>{props.children}</ProvidedContext.Provider>
    </RadixTooltip.Provider>
  );
}

/**
 * The content is portalled, yet React still bubbles its events through the component tree to
 * the trigger's ancestors; a click on a tooltip over a clickable row must not reach that row.
 */
function stop(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * A tooltip on `children` (one element that accepts a ref and pointer handlers). It opens on
 * hover; `open` / `onOpenChange` let the caller also open it from elsewhere, such as when a
 * control of the same row gets keyboard focus. The caller owns the accessible text: a tooltip is
 * extra help on top of what the page already states or describes.
 */
export function Tooltip(props: {
  content: ReactNode;
  children: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  testId?: string;
}) {
  const provided = useContext(ProvidedContext);
  trackDismissInput();
  const root = (
    <RadixTooltip.Root {...(props.open === undefined ? {} : { open: props.open })} {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}>
      <RadixTooltip.Trigger asChild onFocus={skipRestoredFocus}>
        {props.children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={props.side ?? "top"}
          align={props.align ?? "center"}
          sideOffset={6}
          collisionPadding={8}
          className={`${TOOLTIP_CONTENT_CLASS} ${props.className ?? ""}`}
          onClick={stop}
          onPointerDown={stop}
          onMouseDown={stop}
          {...(props.testId === undefined ? {} : { "data-testid": props.testId })}
        >
          {props.content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
  // A tooltip rendered outside the app's provider (an isolated test, a stray island) still works.
  return provided ? root : <TooltipProvider>{root}</TooltipProvider>;
}
