import { Check, ChevronDown } from "lucide-react";
import { Popover } from "radix-ui";
import { forwardRef, useId, useImperativeHandle, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "list" | "role">;

/**
 * A free text input with a short list of quick fills in the app's menu style: the browser's
 * own `<datalist>` cannot be themed and lists value and label twice. ARIA combobox: the list
 * opens on click, ↓ or typing, ↑ / ↓ move, Enter fills, Esc closes (only the list, not the
 * dialog or form around it). Typing narrows the list to the entries that start with the text.
 */
export const SuggestionInput = forwardRef<
  HTMLInputElement,
  InputProps & {
    value: string;
    onValueChange: (value: string) => void;
    suggestions: readonly string[];
    /** Names the list and the button that opens it. */
    listLabel: string;
    /** A chevron at the right edge that opens the list; leave it off where the space is taken. */
    toggle?: boolean;
    /** Extra classes on the wrapper around the input and chevron. */
    wrapperClassName?: string;
  }
>(function SuggestionInput(props, forwarded) {
  const { value, onValueChange, suggestions, listLabel, toggle: wantToggle = true, wrapperClassName, className, onKeyDown, onBlur, onPointerDown, ...inputProps } = props;
  const listId = useId();
  const toggle = wantToggle && suggestions.length > 0;
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwarded, () => input.current as HTMLInputElement);
  const [open, setOpen] = useState(false);
  /** `undefined`: show every entry (opened by click or arrow); text: the entries it starts. */
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [active, setActive] = useState(-1);
  const needle = query?.trim().toLowerCase() ?? "";
  const shown = needle === "" ? suggestions : suggestions.filter((entry) => entry.toLowerCase().startsWith(needle) && entry.toLowerCase() !== needle);
  const expanded = open && shown.length > 0;
  const optionId = (index: number): string => `${listId}-${index}`;

  const show = (filter: string | undefined): void => {
    setQuery(filter);
    setActive(-1);
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    setActive(-1);
  };
  const pick = (entry: string): void => {
    onValueChange(entry);
    close();
    input.current?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (suggestions.length > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!expanded) {
          show(undefined);
          setActive(event.key === "ArrowDown" ? 0 : suggestions.length - 1);
          return;
        }
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => (current < 0 ? (step > 0 ? 0 : shown.length - 1) : (current + step + shown.length) % shown.length));
        return;
      }
      if (expanded && event.key === "Escape") {
        // Only the list closes; the dialog, form or row editor around it stays.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      const chosen = active >= 0 ? shown[active] : undefined;
      if (expanded && event.key === "Enter" && chosen !== undefined) {
        event.preventDefault();
        pick(chosen);
        return;
      }
      if (event.key === "Tab") close();
    }
    onKeyDown?.(event);
  };

  return (
    <Popover.Root open={expanded} modal={false}>
      <Popover.Anchor asChild>
        <span className={`relative flex min-w-0 items-center ${wrapperClassName ?? ""}`}>
          <input
            {...inputProps}
            ref={input}
            // With nothing to suggest it is a plain text field.
            role={suggestions.length > 0 ? "combobox" : undefined}
            aria-expanded={suggestions.length > 0 ? expanded : undefined}
            aria-controls={expanded ? listId : undefined}
            aria-autocomplete={suggestions.length > 0 ? "list" : undefined}
            aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
            className={`${className ?? ""} ${toggle ? "pr-7" : ""}`}
            value={value}
            onChange={(event) => {
              onValueChange(event.target.value);
              show(event.target.value);
            }}
            onPointerDown={(event) => {
              onPointerDown?.(event);
              if (event.button === 0) show(undefined);
            }}
            onKeyDown={handleKeyDown}
            onBlur={(event) => {
              close();
              onBlur?.(event);
            }}
          />
          {toggle ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={listLabel}
              className="absolute right-1 flex h-6 w-5 items-center justify-center rounded text-muted hover:text-ink"
              // Keeps the focus (and the caret) in the input.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (expanded) {
                  close();
                } else {
                  show(undefined);
                }
                input.current?.focus();
              }}
            >
              <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
          ) : null}
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          role="presentation"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-24 rounded-md border border-line bg-surface p-1 text-sm shadow-lg outline-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // The input owns Esc and closes on blur; a press on the input itself is not outside.
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target instanceof Node && input.current?.parentElement?.contains(event.target)) event.preventDefault();
            else close();
          }}
        >
          <ul id={listId} role="listbox" aria-label={listLabel} className="max-h-60 overflow-y-auto">
            {shown.map((entry, index) => {
              const selected = entry.toLowerCase() === value.trim().toLowerCase();
              return (
                <li
                  key={entry}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  data-highlighted={index === active ? "" : undefined}
                  className={`relative flex cursor-pointer items-center rounded px-2 py-1 pr-6 tabular-nums data-[highlighted]:bg-sunken ${selected ? "bg-accent-soft font-medium text-ink" : "text-ink/90"}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => setActive(index)}
                  onClick={() => pick(entry)}
                >
                  {entry}
                  {selected ? <Check size={12} aria-hidden="true" className="absolute right-1.5 text-accent" /> : null}
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
