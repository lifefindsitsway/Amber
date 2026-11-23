/**
 * The look shared by the form controls (text inputs, text areas, native selects) so that they
 * match the trigger of the menu-style `Select`: a line border, medium radius, the accent border
 * and a soft ring on focus, a danger border while `aria-invalid`, dimmed when disabled. An invalid
 * control keeps its danger border while focused, so focusing it does not hide the problem.
 */
export const CONTROL_BASE =
  "min-w-0 rounded-md border border-line bg-surface text-ink outline-none transition duration-150 motion-reduce:transition-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:border-danger aria-[invalid=true]:focus-visible:ring-danger/40";

/** Control height: sm 28 px beside small text, md 32 px in toolbars and filters, lg 36 px in forms. */
export type ControlSize = "sm" | "md" | "lg";

export const CONTROL_HEIGHT: Readonly<Record<ControlSize, string>> = {
  sm: "h-7 text-xs",
  md: "h-8 text-sm",
  lg: "h-9 text-sm",
};

/** Text size and vertical padding of a multi-line control, by the same scale. */
export const CONTROL_TEXT_AREA: Readonly<Record<ControlSize, string>> = {
  sm: "px-2 py-1 text-xs",
  md: "px-2 py-1.5 text-sm",
  lg: "px-2.5 py-2 text-sm",
};

/** Same ring as buttons for controls that are not text fields (check boxes, radios). */
export const CHOICE_FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
