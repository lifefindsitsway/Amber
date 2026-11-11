import { Minus, Plus } from "lucide-react";
import { Popover } from "radix-ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN } from "../../../shared/defaults.ts";
import { READER_LINE_HEIGHT_OPTIONS, type ReaderTypography } from "../../../shared/reader-typography.ts";
import { Button } from "../../ui/button.tsx";

export type ReaderTypographyChange = Partial<Omit<ReaderTypography, "version">>;

const STEP_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";

/** Line heights print with one decimal, so the five choices line up (`2.0`, not `2`). */
const lineHeightLabel = (value: number): string => value.toFixed(1);

/**
 * The 「Aa」 control of the reading view: font size, line height and, when the text is read
 * by speakers, whether the turns show. Non-modal so the text stays readable and scrollable
 * while it is adjusted (the change shows at once); Esc or a press outside closes it. Every
 * control is a native input, so the keyboard works without extra wiring.
 */
export function ReaderTypographyPopover(props: {
  value: ReaderTypography;
  /** Whether the revision is read by speakers; only then is the speaker switch offered. */
  speakerMode: boolean;
  onChange: (change: ReaderTypographyChange) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const { value } = props;
  const sizeId = useId();
  const sizeText = t("speakerReader.typography.fontSizeValue", { px: value.fontSize });
  const setSize = (size: number): void => props.onChange({ fontSize: Math.min(READER_FONT_SIZE_MAX, Math.max(READER_FONT_SIZE_MIN, Math.round(size))) });
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" aria-label={t("speakerReader.typography.triggerLabel")} title={t("speakerReader.typography.label")} data-testid="reader-typography">
          <span aria-hidden="true" className="font-serif text-[13px] leading-none font-semibold tracking-tight">
            {t("speakerReader.typography.trigger")}
          </span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          aria-label={t("speakerReader.typography.label")}
          className="z-50 max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line bg-surface p-4 text-sm text-ink shadow-xl outline-none"
          data-testid="reader-typography-popover"
        >
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <label htmlFor={sizeId} className="font-medium">
                  {t("speakerReader.typography.fontSize")}
                </label>
                <output htmlFor={sizeId} className="text-muted tabular-nums" data-testid="reader-font-size-value">
                  {sizeText}
                </output>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={STEP_BUTTON}
                  aria-label={t("speakerReader.typography.smaller")}
                  title={t("speakerReader.typography.smaller")}
                  disabled={value.fontSize <= READER_FONT_SIZE_MIN}
                  onClick={() => setSize(value.fontSize - 1)}
                  data-testid="reader-font-smaller"
                >
                  <Minus size={14} aria-hidden="true" />
                </button>
                <input
                  id={sizeId}
                  type="range"
                  min={READER_FONT_SIZE_MIN}
                  max={READER_FONT_SIZE_MAX}
                  step={1}
                  value={value.fontSize}
                  aria-valuetext={sizeText}
                  className="min-w-0 flex-1 cursor-pointer accent-accent"
                  onChange={(event) => setSize(Number(event.target.value))}
                  data-testid="reader-font-size"
                />
                <button
                  type="button"
                  className={STEP_BUTTON}
                  aria-label={t("speakerReader.typography.larger")}
                  title={t("speakerReader.typography.larger")}
                  disabled={value.fontSize >= READER_FONT_SIZE_MAX}
                  onClick={() => setSize(value.fontSize + 1)}
                  data-testid="reader-font-larger"
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              </div>
            </div>

            <fieldset className="min-w-0">
              <legend className="mb-2 font-medium">{t("speakerReader.typography.lineHeight")}</legend>
              <div className="flex rounded-md border border-line bg-sunken p-0.5" data-testid="reader-line-heights">
                {READER_LINE_HEIGHT_OPTIONS.map((option) => (
                  <label
                    key={option}
                    className="flex flex-1 cursor-pointer items-center justify-center rounded px-1 py-1 text-xs tabular-nums text-muted transition-colors hover:text-ink has-checked:bg-surface has-checked:font-semibold has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent"
                  >
                    <input
                      type="radio"
                      name={`${sizeId}-line-height`}
                      className="sr-only"
                      value={option}
                      checked={value.lineHeight === option}
                      onChange={() => props.onChange({ lineHeight: option })}
                    />
                    {lineHeightLabel(option)}
                  </label>
                ))}
              </div>
            </fieldset>

            {props.speakerMode ? (
              <label className="flex cursor-pointer items-center justify-between gap-3">
                <span className="font-medium">{t("speakerReader.typography.showSpeakers")}</span>
                <span className="relative inline-flex shrink-0">
                  <input
                    type="checkbox"
                    role="switch"
                    className="peer sr-only"
                    checked={value.showSpeakers}
                    onChange={(event) => props.onChange({ showSpeakers: event.target.checked })}
                    data-testid="reader-show-speakers"
                  />
                  <span aria-hidden="true" className="h-5 w-9 rounded-full bg-sunken ring-1 ring-line transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent" />
                  <span aria-hidden="true" className="pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow transition-transform peer-checked:translate-x-4" />
                </span>
              </label>
            ) : null}

            <div className="flex justify-end border-t border-line pt-3">
              <Button size="sm" variant="ghost" onClick={props.onReset} data-testid="reader-typography-reset">
                {t("speakerReader.typography.reset")}
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
