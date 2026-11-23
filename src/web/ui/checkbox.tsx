import { forwardRef, useCallback, useId, useLayoutEffect, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { CHOICE_FOCUS } from "./control.ts";

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children">;

/** 16 px, the theme's accent as the native accent colour, the shared focus ring. */
const CHOICE_CLASS = `size-4 shrink-0 cursor-pointer accent-accent ${CHOICE_FOCUS} disabled:cursor-not-allowed disabled:opacity-60`;

const LABEL_CLASS = "inline-flex items-center gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-60";

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref !== null && ref !== undefined) {
    (ref as { current: T | null }).current = value;
  }
}

export type CheckboxProps = NativeInputProps & {
  /**
   * Shows the mixed state ("some of these are picked"). The DOM property has no attribute, so it
   * is applied after every render while set. Leave it undefined to manage `indeterminate` through
   * the ref yourself: the component then never touches it.
   */
  indeterminate?: boolean;
  /** The label, wrapped with the box in a `<label>`; without it, label the box with `htmlFor` or `aria-label`. */
  children?: ReactNode;
  /** Classes of the wrapping `<label>` when there are children; `className` always goes on the box. */
  labelClassName?: string;
};

/**
 * A native check box in the app's look. Every native attribute and handler passes through, the
 * ref included (object or callback), so checked / defaultChecked, form reset and the native
 * change event behave as for a bare `<input type="checkbox">`.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ indeterminate, children, labelClassName = "", className = "", ...rest }, ref) {
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      inner.current = node;
      assignRef(ref, node);
    },
    [ref],
  );
  // No dependency list: a click clears the DOM property, and the next render must restore it
  // while the prop still asks for the mixed state.
  useLayoutEffect(() => {
    if (indeterminate !== undefined && inner.current !== null) inner.current.indeterminate = indeterminate;
  });
  const box = <input ref={setRef} type="checkbox" {...rest} className={`${CHOICE_CLASS} ${className}`} />;
  if (children === undefined) return box;
  return (
    <label className={`${LABEL_CLASS} cursor-pointer ${labelClassName}`}>
      {box}
      <span className="min-w-0">{children}</span>
    </label>
  );
});

/**
 * Arrow keys move to the previous / next enabled radio of the same group and select it, wrapping
 * around, as browsers do for native radios. Done here (and the native move suppressed) so that it
 * also holds where the platform does not (test DOMs) and stays identical across engines.
 */
function moveInGroup(event: KeyboardEvent<HTMLInputElement>): void {
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
  const current = event.currentTarget;
  if (step === 0 || current.name === "") return;
  const scope: ParentNode = current.form ?? current.ownerDocument;
  const group = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((radio) => radio.name === current.name && radio.form === current.form && (!radio.disabled || radio === current));
  const index = group.indexOf(current);
  if (index === -1 || group.length < 2) return;
  const next = group[(index + step + group.length) % group.length] as HTMLInputElement;
  event.preventDefault();
  next.focus();
  if (!next.checked) next.click();
}

export type RadioProps = NativeInputProps & {
  /** The label, wrapped with the radio in a `<label>`; without it, label the radio with `htmlFor`. */
  children?: ReactNode;
  labelClassName?: string;
};

/** A native radio in the app's look; everything passes through, the ref included. Give the group one `name`. */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({ children, labelClassName = "", className = "", onKeyDown, ...rest }, ref) {
  const radio = (
    <input
      ref={ref}
      type="radio"
      {...rest}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) moveInGroup(event);
      }}
      className={`${CHOICE_CLASS} ${className}`}
    />
  );
  if (children === undefined) return radio;
  return (
    <label className={`${LABEL_CLASS} cursor-pointer ${labelClassName}`}>
      {radio}
      <span className="min-w-0">{children}</span>
    </label>
  );
});

export type RadioCardProps = Omit<NativeInputProps, "title"> & {
  /** The option's name, read as the radio's label. */
  title: ReactNode;
  /** One or two sentences under the title, read as the radio's description. */
  description?: ReactNode;
  /** Anything else inside the card under the description (a badge, a preview). */
  children?: ReactNode;
  /** Classes of the card (the `<label>`); `className` goes on the radio itself. */
  cardClassName?: string;
  testId?: string;
};

/**
 * One choice of a single-choice group drawn as a card: the whole card is the radio's label, so a
 * click anywhere selects it; the arrow keys move through the group as with `Radio`. The chosen
 * card takes an accent border (a ring over the border, so nothing around it moves).
 */
export const RadioCard = forwardRef<HTMLInputElement, RadioCardProps>(function RadioCard({ title, description, children, cardClassName = "", className = "", testId, id, onKeyDown, ...rest }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = [rest["aria-describedby"], description === undefined ? undefined : `${inputId}-description`].filter((part) => part !== undefined && part !== "").join(" ");
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border border-line bg-surface p-3 transition duration-150 motion-reduce:transition-none hover:bg-panel has-checked:border-accent has-checked:ring-1 has-checked:ring-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent has-disabled:cursor-not-allowed has-disabled:opacity-60 ${cardClassName}`}
      data-testid={testId}
    >
      <input
        ref={ref}
        id={inputId}
        type="radio"
        // Named by the title alone; the wrapping label would read the whole card as the name.
        aria-labelledby={`${inputId}-title`}
        {...rest}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented) moveInGroup(event);
        }}
        // The card shows the focus; the radio's own ring would double it.
        className={`mt-0.5 size-4 shrink-0 cursor-pointer accent-accent outline-none disabled:cursor-not-allowed ${className}`}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span id={`${inputId}-title`} className="text-sm font-medium">
          {title}
        </span>
        {description === undefined ? null : (
          <span id={`${inputId}-description`} className="max-w-[70ch] text-note text-muted">
            {description}
          </span>
        )}
        {children}
      </span>
    </label>
  );
});
