import { forwardRef, type SelectHTMLAttributes } from "react";
import { CONTROL_BASE, CONTROL_HEIGHT, type ControlSize } from "./control.ts";

/**
 * Every attribute of a native `<select>` except the number of visible rows (`size`), whose name
 * this component uses for its height; a list box showing several rows is not this control.
 */
export type NativeSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  /** sm 28 px, md 32 px, lg 36 px (the default, like the form inputs and the menu-style Select). */
  size?: ControlSize;
  /** Draws the danger border and sets `aria-invalid`; pair it with a `FieldError` via `aria-describedby`. */
  invalid?: boolean;
};

/**
 * A native `<select>` in the look of the menu-style `Select` trigger: same border, radius, focus
 * ring and chevron position. Prefer it where the platform list is the better fit (long option
 * lists, forms that rely on `name`, `required` and reset). Everything else passes straight
 * through, including the ref, `value` / `defaultValue` and the native change event.
 *
 * `className` is appended: use it for width and margins, not for padding, which leaves room for
 * the chevron.
 */
export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect({ size = "lg", invalid, className = "", ...rest }, ref) {
  return (
    <select
      ref={ref}
      {...rest}
      {...(invalid === true ? { "aria-invalid": true } : {})}
      className={`select-chevron cursor-pointer pr-7 pl-2 ${CONTROL_BASE} ${CONTROL_HEIGHT[size]} ${className}`}
    />
  );
});
