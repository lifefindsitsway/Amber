import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

/**
 * `primary` is the one main action of a view; `danger` (outlined) offers a destructive action;
 * `danger-solid` is reserved for the final confirmation of one, e.g. the confirm button of a
 * delete dialog, so a filled red button always means "this is the step that destroys".
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent-glow text-accent-ink hover:brightness-105",
  secondary: "border border-line bg-surface hover:bg-sunken",
  ghost: "hover:bg-sunken",
  danger: "border border-line text-danger hover:bg-sunken",
  "danger-solid": "bg-danger text-surface hover:brightness-110",
};

/**
 * One focus ring for every button: an outline, so it neither takes layout space nor clashes with
 * a caller's own `ring-*` (pressed toggles use rings for their state).
 */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /**
   * Work started by this button is under way: a spinner joins the label, the button is disabled
   * and marked `aria-busy`. The label stays, so the button keeps its width and accessible name.
   */
  loading?: boolean;
};

/** Never shrinks or wraps: a squeezed flex row would otherwise break short CJK labels one character per line. */
export function Button({ variant = "secondary", size = "md", className = "", type = "button", loading = false, disabled, children, ...rest }: ButtonProps) {
  const sizing = size === "sm" ? "h-7 px-2 text-xs" : "h-9 px-3 text-sm";
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${sizing} ${VARIANTS[variant]} ${className}`}
      disabled={loading || disabled}
      {...(loading ? { "aria-busy": true } : {})}
      {...rest}
    >
      {loading ? <LoaderCircle size={size === "sm" ? 12 : 14} className="shrink-0 animate-spin" aria-hidden="true" data-testid="button-spinner" /> : null}
      {children}
    </button>
  );
}
