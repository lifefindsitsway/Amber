import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../../ui/context-menu.tsx";

/** Height shared by every control of the toolbar and the panel headers. */
const CONTROL = "h-8 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent";

export const MENU_SCROLL_CLASS = "max-h-96 overflow-auto";

/**
 * A menu's selection slot, empty for the unselected so labels line up. The chosen item shows a
 * soft glowing bar; it opts out of forced colours so it stays visible in high-contrast mode.
 */
export function RadioMark() {
  return (
    <span className="flex w-3.5 shrink-0 justify-center">
      <DropdownMenu.ItemIndicator>
        <span
          className="block h-4 w-[3px] rounded-full bg-accent shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent)_60%,transparent)] forced-colors:forced-color-adjust-none forced-colors:bg-[Highlight]"
          aria-hidden="true"
        />
      </DropdownMenu.ItemIndicator>
    </span>
  );
}

export function MenuLabel(props: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-xs text-muted">{props.children}</DropdownMenu.Label>;
}

/**
 * The selected entry is the current choice, so it takes the accent-soft fill an active filter
 * trigger uses. The compound selectors out-rank the plain highlighted background, so a selected
 * entry keeps its fill under keyboard focus and shows an inset ring instead of turning grey.
 */
const RADIO_ENTRY_CLASS = `${MENU_ITEM_CLASS} data-[state=checked]:bg-accent-soft data-[state=checked]:font-medium data-[state=checked]:data-[highlighted]:bg-accent-soft data-[state=checked]:data-[highlighted]:ring-1 data-[state=checked]:data-[highlighted]:ring-inset data-[state=checked]:data-[highlighted]:ring-accent/50`;

export function RadioEntry(props: { value: string; children: ReactNode; indent?: boolean; testId?: string }) {
  return (
    <DropdownMenu.RadioItem
      value={props.value}
      className={`${RADIO_ENTRY_CLASS} ${props.indent === true ? "pl-6" : ""}`}
      {...(props.testId === undefined ? {} : { "data-testid": props.testId })}
    >
      <RadioMark />
      <span className="min-w-0 flex-1 truncate" title={typeof props.children === "string" ? props.children : undefined}>
        {props.children}
      </span>
    </DropdownMenu.RadioItem>
  );
}

/**
 * A menu trigger shaped like the toolbar's other controls. `active` outlines it in the accent
 * colour (a filter is set).
 */
export function MenuTrigger(props: {
  children: ReactNode;
  active?: boolean;
  /** Tighter padding, for containers where three menus share one row. */
  compact?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  const title = props.title ?? (typeof props.children === "string" ? props.children : undefined);
  let tone = "border border-line bg-surface hover:bg-sunken";
  if (props.active === true) tone = "border border-accent bg-accent-soft";
  return (
    <DropdownMenu.Trigger asChild>
      <button
        type="button"
        className={`${CONTROL} inline-flex min-w-0 items-center gap-1 ${props.compact === true ? "px-2" : "gap-1.5 px-2.5"} ${tone} ${props.className ?? ""}`}
        {...(title === undefined ? {} : { title })}
        {...(props.ariaLabel === undefined ? {} : { "aria-label": props.ariaLabel })}
        {...(props.testId === undefined ? {} : { "data-testid": props.testId })}
      >
        <span className="min-w-0 truncate">{props.children}</span>
        <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden="true" />
      </button>
    </DropdownMenu.Trigger>
  );
}

/** A dropdown of exclusive choices; choosing one calls `onChange` and closes the menu. */
export function RadioMenu<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  triggerLabel: ReactNode;
  testId?: string;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu.Root>
      <MenuTrigger
        ariaLabel={props.ariaLabel}
        {...(props.testId === undefined ? {} : { testId: props.testId })}
      >
        {props.triggerLabel}
      </MenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={props.align ?? "start"} sideOffset={4} className={MENU_CONTENT_CLASS} aria-label={props.ariaLabel}>
          <DropdownMenu.RadioGroup value={props.value} onValueChange={(value) => props.onChange(value as T)}>
            {props.options.map((option) => (
              <RadioEntry key={option.value} value={option.value} {...(props.testId === undefined ? {} : { testId: `${props.testId}-${option.value}` })}>
                {option.label}
              </RadioEntry>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Not selectable; `hint` says why and is read as the tooltip. */
  disabled?: boolean;
  hint?: string;
}

/**
 * One segmented control for every short exclusive choice: a `bg-sunken` track with the chosen
 * segment raised on the surface colour. A disabled segment keeps its tooltip, which a truly
 * disabled button would swallow.
 */
export function SegmentedControl<T extends string>(props: {
  value: T | undefined;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  testId?: string;
  className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const enabled = props.options.filter((option) => option.disabled !== true);
  const select = (value: T): void => {
    props.onChange(value);
    refs.current.get(value)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || enabled.length === 0) return;
    event.preventDefault();
    const index = enabled.findIndex((option) => option.value === props.value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (next !== undefined) select(next.value);
  };
  const tabbable = enabled.some((option) => option.value === props.value) ? props.value : enabled[0]?.value;
  return (
    <div
      role="radiogroup"
      aria-label={props.ariaLabel}
      onKeyDown={onKeyDown}
      className={`inline-flex h-8 shrink-0 items-center rounded-md bg-sunken p-0.5 ${props.className ?? ""}`}
      {...(props.testId === undefined ? {} : { "data-testid": props.testId })}
    >
      {props.options.map((option) => {
        const selected = option.value === props.value;
        const disabled = option.disabled === true;
        return (
          <button
            key={option.value}
            ref={(element) => {
              if (element === null) refs.current.delete(option.value);
              else refs.current.set(option.value, element);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled || undefined}
            tabIndex={option.value === tabbable ? 0 : -1}
            title={option.hint}
            onClick={() => (disabled ? undefined : props.onChange(option.value))}
            className={`h-7 whitespace-nowrap rounded px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              selected ? "bg-surface text-ink ring-1 ring-line" : disabled ? "cursor-not-allowed text-muted opacity-50" : "text-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
