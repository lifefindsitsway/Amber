import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import { Fragment, type ReactNode } from "react";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "./context-menu.tsx";

export interface SelectOption<T extends string> {
  value: T;
  /** The written name: what is shown, typed ahead to and read aloud. */
  label: string;
  /** Decorative mark before the label, in the list and on the trigger. */
  icon?: ReactNode;
  /** A short muted qualifier after the label, e.g. that an endpoint is the legacy one. */
  tag?: string;
  /**
   * The heading of the group the option belongs to; consecutive options with the same heading
   * are listed under it (and read with it), so the same label can stand in two groups.
   */
  group?: string;
  /** Tells apart two groups with the same heading (e.g. two profiles of one name); the heading when absent. */
  groupKey?: string;
  /** What the closed trigger shows once chosen, when it should say more than the label. */
  valueContent?: ReactNode;
  /** The trigger's hover title once chosen: the full text when `valueContent` may be cut short. */
  valueTitle?: string;
  /** A divider below this option, e.g. between a "none" choice and the real ones. */
  dividerAfter?: boolean;
}

/** Trigger height: sm 28 px beside small text, md 32 px, lg 36 px like the form inputs (the default). */
export type SelectSize = "sm" | "md" | "lg";

/** Shaped like the form inputs; the placeholder reads in the secondary colour. */
const TRIGGER_BASE =
  "flex min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-surface px-2 text-left outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-muted aria-[invalid=true]:border-danger";

const TRIGGER_SIZE: Readonly<Record<SelectSize, string>> = {
  sm: "h-7 text-xs",
  md: "h-8 text-sm",
  lg: "h-9 text-sm",
};

const GROUP_LABEL_CLASS = "px-2 pt-1.5 pb-1 text-xs text-muted";

const ITEM_CLASS = `${MENU_ITEM_CLASS} pr-7 relative data-[state=checked]:bg-accent-soft data-[state=checked]:font-medium data-[state=checked]:data-[highlighted]:ring-1 data-[state=checked]:data-[highlighted]:ring-inset data-[state=checked]:data-[highlighted]:ring-accent/50`;

/**
 * A single-choice dropdown in the app's menu style (Radix Select): arrow keys, Home / End,
 * type-ahead on the first letters, Esc to close with focus back on the trigger. Label it with
 * a `<label htmlFor={id}>` or `ariaLabel`. `undefined` shows the placeholder. Radix treats the
 * empty string as "no value", so an option must not use it.
 *
 * Without `size`, `width` and `menuWidth` it fills its container at the form input height and
 * the list is exactly as wide as the trigger. `width: "content"` sizes the trigger to its text
 * (cap it with `className`); `menuWidth: "fit"` lets the list grow to its longest entry, at
 * least as wide as the trigger and at most 32rem.
 */
export function Select<T extends string>(props: {
  id?: string | undefined;
  value: T | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  placeholder: string;
  disabled?: boolean | undefined;
  ariaLabel?: string | undefined;
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  testId?: string | undefined;
  size?: SelectSize | undefined;
  width?: "fill" | "content" | undefined;
  menuWidth?: "trigger" | "fit" | undefined;
  /** Extra classes on the trigger, e.g. a maximum width. */
  className?: string | undefined;
}) {
  const chosen = props.value === undefined ? undefined : props.options.find((option) => option.value === props.value);
  // A caller's own maximum width wins over the default cap: both are single utilities and the
  // stylesheet order, not the class order, would decide between them.
  const width = props.width === "content" ? `w-auto ${props.className?.includes("max-w-") === true ? "" : "max-w-full"}` : "w-full";
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
        className={`${TRIGGER_BASE} ${TRIGGER_SIZE[props.size ?? "lg"]} ${width} ${props.className ?? ""}`}
        title={chosen?.valueTitle}
        aria-label={props.ariaLabel}
        aria-describedby={props.describedBy}
        aria-invalid={props.invalid === true ? true : undefined}
        data-testid={props.testId}
      >
        {/* Takes the trigger's free width, so trigger content can tell how much room it has. */}
        <span className="min-w-0 flex-1 truncate">
          {chosen?.valueContent === undefined ? (
            <RadixSelect.Value placeholder={props.placeholder} />
          ) : (
            // Given children, Radix shows them instead of copying the item's text into the trigger.
            <RadixSelect.Value placeholder={props.placeholder}>{chosen.valueContent}</RadixSelect.Value>
          )}
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
          className={`${MENU_CONTENT_CLASS} max-h-[min(24rem,var(--radix-select-content-available-height))] overflow-hidden ${
            props.menuWidth === "fit" ? "w-max max-w-[min(32rem,calc(100vw-16px))] min-w-[var(--radix-select-trigger-width)]" : "w-[var(--radix-select-trigger-width)]"
          }`}
        >
          <RadixSelect.Viewport>
            {groupRuns(props.options).map((run, index) =>
              run.group === undefined ? (
                <Fragment key={`${index}:`}>
                  {run.options.map((option) => (
                    <SelectItem key={option.value} option={option} />
                  ))}
                </Fragment>
              ) : (
                <RadixSelect.Group key={`${index}:${run.group}`}>
                  <RadixSelect.Label className={GROUP_LABEL_CLASS}>{run.group}</RadixSelect.Label>
                  {run.options.map((option) => (
                    <SelectItem key={option.value} option={option} />
                  ))}
                </RadixSelect.Group>
              ),
            )}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

function SelectItem<T extends string>({ option }: { option: SelectOption<T> }) {
  return (
    <>
      <RadixSelect.Item value={option.value} textValue={option.label} className={ITEM_CLASS}>
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
      {option.dividerAfter === true ? <RadixSelect.Separator className="my-1 h-px bg-line" /> : null}
    </>
  );
}

/** Splits the options into runs of the same group heading, keeping their order. */
function groupRuns<T extends string>(options: ReadonlyArray<SelectOption<T>>): Array<{ group: string | undefined; options: Array<SelectOption<T>> }> {
  const runs: Array<{ group: string | undefined; key: string | undefined; options: Array<SelectOption<T>> }> = [];
  for (const option of options) {
    const last = runs.at(-1);
    const key = option.group === undefined ? undefined : (option.groupKey ?? option.group);
    if (last !== undefined && last.key === key) {
      last.options.push(option);
    } else {
      runs.push({ group: option.group, key, options: [option] });
    }
  }
  return runs;
}
