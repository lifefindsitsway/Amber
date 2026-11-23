import { forwardRef, type InputHTMLAttributes, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { CONTROL_BASE, CONTROL_HEIGHT, CONTROL_TEXT_AREA, type ControlSize } from "./control.ts";

/** Every attribute of a native `<input>` except `size` (its width in characters); set widths with classes. */
export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  /** sm 28 px, md 32 px, lg 36 px (the default, the form input height). */
  size?: ControlSize;
  /** Draws the danger border and sets `aria-invalid`; pair it with a `FieldError` via `aria-describedby`. */
  invalid?: boolean;
  /**
   * Enter pressed to commit, except while an input method is composing: the Enter that picks a
   * Chinese candidate must not also submit. Runs after `onKeyDown`, and not when that handler
   * called `preventDefault()`.
   */
  onEnter?: (event: KeyboardEvent<HTMLInputElement>) => void;
};

/** Whether this Enter belongs to an input method (picking a candidate), not to the field. */
export function isComposingEnter(event: KeyboardEvent): boolean {
  // Some engines report the composing Enter only through the legacy 229 key code.
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * A native single-line input in the shared control look (see `NativeSelect`). Every native
 * attribute and the ref pass through; `onKeyDown` and the other handlers are the caller's,
 * untouched. `type` defaults to `text`. `className` is appended (widths, margins).
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput({ size = "lg", invalid, onEnter, className = "", type = "text", onKeyDown, ...rest }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      {...rest}
      {...(invalid === true ? { "aria-invalid": true } : {})}
      onKeyDown={
        onEnter === undefined
          ? onKeyDown
          : (event) => {
              onKeyDown?.(event);
              if (event.key === "Enter" && !event.defaultPrevented && !isComposingEnter(event)) onEnter(event);
            }
      }
      className={`px-2 ${CONTROL_BASE} ${CONTROL_HEIGHT[size]} ${className}`}
    />
  );
});

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Text size and padding on the same scale as `TextInput`; the height comes from `rows` or classes. */
  size?: ControlSize;
  invalid?: boolean;
};

/** A native `<textarea>` in the shared control look; everything passes through, `className` is appended. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ size = "lg", invalid, className = "", ...rest }, ref) {
  return <textarea ref={ref} {...rest} {...(invalid === true ? { "aria-invalid": true } : {})} className={`block ${CONTROL_BASE} ${CONTROL_TEXT_AREA[size]} ${className}`} />;
});
