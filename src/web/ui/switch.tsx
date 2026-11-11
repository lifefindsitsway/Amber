import type { ReactNode } from "react";

/**
 * A compact on/off switch with its label. It is a native checkbox with the `switch` role,
 * so it is focusable, toggled by Space and announced as a switch, and it adds no button to
 * the toolbar it sits in. `describedBy` names the element that explains why it is disabled.
 */
export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  /** A tooltip for the whole control; the reason a disabled switch cannot be turned on. */
  title?: string | undefined;
  describedBy?: string | undefined;
  /** Sets the label's text size and weight; the switch itself has a fixed size. */
  className?: string;
  testId?: string;
}) {
  return (
    <label className={`inline-flex items-center gap-1.5 ${props.disabled === true ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${props.className ?? ""}`} title={props.title}>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.describedBy}
        onChange={(event) => props.onChange(event.target.checked)}
        data-testid={props.testId}
      />
      <span
        aria-hidden="true"
        className="relative h-4 w-7 shrink-0 rounded-full bg-muted/40 transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-surface after:shadow-sm after:transition-transform after:content-[''] peer-checked:bg-accent peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-1 motion-reduce:transition-none motion-reduce:after:transition-none"
      />
      <span>{props.children}</span>
    </label>
  );
}
