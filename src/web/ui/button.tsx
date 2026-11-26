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

/** The spinner keeps the colour the label had, since the label itself turns transparent. */
const SPINNER_TONE: Record<ButtonVariant, string> = {
  primary: "text-accent-ink",
  secondary: "text-ink",
  ghost: "text-ink",
  danger: "text-danger",
  "danger-solid": "text-surface",
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
   * Work started by this button is under way: a spinner takes the middle of the button, the
   * button is disabled and marked `aria-busy`. The label stays in place, only made transparent,
   * so the button keeps its width and its accessible name; callers keep the label unchanged.
   */
  loading?: boolean;
};

/** Never shrinks or wraps: a squeezed flex row would otherwise break short CJK labels one character per line. */
export function Button({ variant = "secondary", size = "lg", className = "", type = "button", loading = false, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      // The label turns transparent rather than hidden or removed: hiding it would drop the
      // accessible name, removing it would change the width. Icons follow through `currentColor`.
      className={`${buttonClass(variant, size)} ${loading ? "relative text-transparent!" : ""} ${className}`}
      disabled={loading || disabled}
      {...(loading ? { "aria-busy": true } : {})}
      {...rest}
    >
      {loading ? (
        <span aria-hidden="true" className={`absolute inset-0 flex items-center justify-center ${SPINNER_TONE[variant]}`} data-testid="button-spinner">
          <LoaderCircle size={size === "sm" ? 12 : 14} className="animate-spin" />
        </span>
      ) : null}
      {children}
    </button>
  );
}
