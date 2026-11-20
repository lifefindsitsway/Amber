import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import type { ReactNode } from "react";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "./context-menu.tsx";

export interface SelectOption<T extends string> {
  value: T;
  /** The written name: what is shown, typed ahead to and read aloud. */
  label: string;
  /** Decorative mark before the label, in the list and on the trigger. */
  icon?: ReactNode;
  /** A short muted qualifier after the label, e.g. that an endpoint is the legacy one. */
  tag?: string;
}

/** Shaped like the form inputs; the placeholder reads in the secondary colour. */
const TRIGGER_CLASS =
  "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-surface px-2 text-left text-sm outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-muted aria-[invalid=true]:border-danger";

const ITEM_CLASS = `${MENU_ITEM_CLASS} pr-7 relative data-[state=checked]:bg-accent-soft data-[state=checked]:font-medium data-[state=checked]:data-[highlighted]:ring-1 data-[state=checked]:data-[highlighted]:ring-inset data-[state=checked]:data-[highlighted]:ring-accent/50`;

/**
 * A single-choice dropdown in the app's menu style (Radix Select): arrow keys, Home / End,
 * type-ahead on the first letters, Esc to close with focus back on the trigger. Label it with
 * a `<label htmlFor={id}>` or `ariaLabel`. `undefined` shows the placeholder.
 */
export function Select<T extends string>(props: {
  id?: string;
  value: T | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  placeholder: string;
  disabled?: boolean;
  ariaLabel?: string;
  describedBy?: string;
  invalid?: boolean;
  testId?: string;
}) {
  return (
    <RadixSelect.Root
      value={props.value ?? ""}
      // Radix may report a change on its own when the options are swapped under a value they
      // no longer hold (e.g. regions of another vendor); only a choice among them counts.
      onValueChange={(value) => {
        const chosen = props.options.find((option) => option.value === value);
        if (chosen !== undefined) props.onChange(chosen.value);
      }}
      {...(props.disabled === true ? { disabled: true } : {})}
    >
      <RadixSelect.Trigger
        id={props.id}
        className={TRIGGER_CLASS}
        aria-label={props.ariaLabel}
        aria-describedby={props.describedBy}
        aria-invalid={props.invalid === true ? true : undefined}
        data-testid={props.testId}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value placeholder={props.placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0 text-muted">
          <ChevronDown size={14} aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={`${MENU_CONTENT_CLASS} max-h-[min(24rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] overflow-hidden`}
        >
          <RadixSelect.Viewport>
            {props.options.map((option) => (
              <RadixSelect.Item key={option.value} value={option.value} textValue={option.label} className={ITEM_CLASS}>
                <RadixSelect.ItemText>
                  <span className="flex min-w-0 items-center gap-2">
                    {option.icon}
                    <span className="truncate">{option.label}</span>
                    {option.tag === undefined ? null : (
                      <>
                        {/* A pause for screen readers, which would otherwise run the tag into the label. */}
                        <span className="sr-only">, </span>
                        <span className="shrink-0 rounded border border-line px-1 text-[11px] leading-4 font-normal text-muted">{option.tag}</span>
                      </>
                    )}
                  </span>
                </RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-2 flex items-center text-accent">
                  <Check size={14} aria-hidden="true" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
