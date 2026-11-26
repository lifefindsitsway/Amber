import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

/**
 * `primary` is the one main action of a view; `danger` (outlined) offers a destructive action;
 * `danger-solid` is reserved for the final confirmation of one, e.g. the confirm button of a
 * delete dialog, so a filled red button always means "this is the step that destroys".
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

// A pressed toggle sinks (darker fill, firmer outline) instead of turning to the brand colour, so
// the one main action of a view stays the only brand-coloured button. `danger-solid` carries a
// border of its own colour so it is exactly as large as an outlined button it replaces in place.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent-glow text-accent-ink hover:brightness-105",
  secondary: "border border-line bg-surface hover:bg-sunken aria-pressed:border-ink/25 aria-pressed:bg-sunken",
  ghost: "hover:bg-sunken aria-pressed:bg-sunken",
  danger: "border border-line text-danger hover:bg-sunken",
  "danger-solid": "border border-danger bg-danger text-surface hover:brightness-110",
};

/**
 * Three heights matching the form controls: `lg` 36 px (the default: page headers, dialog
 * footers, forms), `md` 32 px (list toolbars, selection bars, pagers), `sm` 28 px (inline, cards,
 * popovers, notices, reader and editor toolbars).
 */
export type ButtonSize = "sm" | "md" | "lg";

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
  lg: "h-9 px-3.5 text-sm",
};

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The button look for an element that must stay a link (`<a href>`, a router `<Link>`), so it
 * keeps its native navigation and download behaviour. Not for labels or other non-buttons: they
 * cannot take the keyboard focus a button has.
 */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "lg"): string {
  return `${BASE} ${FOCUS_RING} ${SIZES[size]} ${VARIANTS[variant]}`;
}

/**
 * One focus ring for every button: an outline, so it neither takes layout space nor clashes with
 * a caller's own `ring-*` (pressed toggles use rings for their state).
 */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Work started by this button is under way: a spinner joins the label, the button is disabled
   * and marked `aria-busy`. The label stays, so the button keeps its width and accessible name.
   */
  loading?: boolean;
};

/** Never shrinks or wraps: a squeezed flex row would otherwise break short CJK labels one character per line. */
export function Button({ variant = "secondary", size = "lg", className = "", type = "button", loading = false, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`${buttonClass(variant, size)} ${className}`}
      disabled={loading || disabled}
      {...(loading ? { "aria-busy": true } : {})}
      {...rest}
    >
      {loading ? <LoaderCircle size={size === "sm" ? 12 : 14} className="shrink-0 animate-spin" aria-hidden="true" data-testid="button-spinner" /> : null}
      {children}
    </button>
  );
}
