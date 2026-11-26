import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { TWO_STEP_GUARD_MS } from "../../shared/defaults.ts";
import { Button, type ButtonProps } from "./button.tsx";

/** The two labels share one grid cell so the button is always as wide as the wider of them. */
const STACKED = "col-start-1 row-start-1";

/**
 * The filled destructive look carries a 1 px border, as the outlined one does; an unarmed ghost
 * button gets a transparent one, so arming never changes the width by the border's.
 */
const UNARMED_BORDER: Readonly<Record<"secondary" | "ghost", string>> = {
  secondary: "",
  ghost: "border border-transparent",
};

/**
 * A destructive action confirmed in place: the first press turns this same button into the
 * filled destructive look naming the action, and only a second press runs it. The armed state
 * ends on blur, on `Esc`, when the button is disabled and when `resetKey` changes, so a
 * confirmation never outlives the context it was asked in. Presses within `TWO_STEP_GUARD_MS`
 * of arming, and clicks from a held key, do not confirm. A failed action leaves the button
 * unarmed: trying again asks again.
 *
 * Both labels are always laid out, the hidden one invisible and `aria-hidden`, so arming never
 * changes the button's width and the accessible name is only the label shown.
 */
export function TwoStepButton(props: {
  /** The label of the unarmed button. */
  label: ReactNode;
  /** The label once armed, naming the action, e.g. 「确认放弃草稿」. */
  confirmLabel: ReactNode;
  onConfirm: () => void;
  /** Shown before the label in both states. */
  icon?: ReactNode;
  /** The unarmed look; armed is always `danger-solid`. */
  variant?: "secondary" | "ghost";
  size?: ButtonProps["size"];
  disabled?: boolean;
  /** The confirmed action is under way. */
  loading?: boolean;
  /** Compared with `Object.is`: pass a primitive that changes exactly when the target of the action does. */
  resetKey?: unknown;
  onArmedChange?: (armed: boolean) => void;
  title?: string;
  className?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
}) {
  const { disabled = false, resetKey } = props;
  const variant = props.variant ?? "secondary";
  // The button the arming press landed on; only an armed button listens for Esc.
  const button = useRef<HTMLButtonElement | null>(null);
  const [armed, setArmedState] = useState(false);
  const armedAt = useRef<number | undefined>(undefined);
  // Set by a held key's repeated keydown, so the click it produces is not taken as a press.
  const repeatedKey = useRef(false);
  const onArmedChange = useRef(props.onArmedChange);
  onArmedChange.current = props.onArmedChange;

  const setArmed = useCallback((next: boolean): void => {
    const wasArmed = armedAt.current !== undefined;
    if (wasArmed === next) return;
    armedAt.current = next ? performance.now() : undefined;
    setArmedState(next);
    onArmedChange.current?.(next);
  }, []);

  useEffect(() => {
    if (disabled) setArmed(false);
  }, [disabled, setArmed]);

  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (Object.is(lastResetKey.current, resetKey)) return;
    lastResetKey.current = resetKey;
    setArmed(false);
  }, [resetKey, setArmed]);

  useEffect(() => {
    if (!armed) return undefined;
    // On the window in the capture phase, so it runs before the page's own Escape handling: a
    // dialog listens on the document in the capture phase and would close, and an editor around
    // the button may act on Escape too. Pressed on the armed button, Esc only disarms it.
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.target !== button.current) return;
      event.preventDefault();
      event.stopPropagation();
      setArmed(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [armed, setArmed]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      repeatedKey.current = true;
    }
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (repeatedKey.current) {
      repeatedKey.current = false;
      return;
    }
    const since = armedAt.current;
    if (since === undefined) {
      button.current = event.currentTarget;
      setArmed(true);
      return;
    }
    if (performance.now() - since < TWO_STEP_GUARD_MS) return;
    setArmed(false);
    props.onConfirm();
  };

  return (
    <Button
      variant={armed ? "danger-solid" : variant}
      {...(props.size === undefined ? {} : { size: props.size })}
      disabled={disabled}
      loading={props.loading ?? false}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={() => {
        repeatedKey.current = false;
      }}
      onBlur={() => setArmed(false)}
      {...(armed ? { "data-armed": "" } : {})}
      {...(props.title === undefined ? {} : { title: props.title })}
      className={`${armed ? "" : UNARMED_BORDER[variant]} ${props.className ?? ""}`}
      {...(props["aria-describedby"] === undefined ? {} : { "aria-describedby": props["aria-describedby"] })}
      {...(props["data-testid"] === undefined ? {} : { "data-testid": props["data-testid"] })}
    >
      {props.icon}
      <span className="grid">
        <span className={`${STACKED} ${armed ? "invisible" : ""}`} {...(armed ? { "aria-hidden": true } : {})}>
          {props.label}
        </span>
        <span className={`${STACKED} ${armed ? "" : "invisible"}`} {...(armed ? {} : { "aria-hidden": true })}>
          {props.confirmLabel}
        </span>
      </span>
    </Button>
  );
}
