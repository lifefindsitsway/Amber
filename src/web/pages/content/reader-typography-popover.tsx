import { LoaderCircle, Minus, Plus } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  READER_FONT_NAME_MAX_CHARS,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_MARGIN_MAX,
  READER_MARGIN_MIN,
  READER_MARGIN_STEP,
} from "../../../shared/defaults.ts";
import { READER_LINE_HEIGHT_OPTIONS, readerCustomFontSchema, readerSideMargin, type ReaderFont, type ReaderTypography } from "../../../shared/reader-typography.ts";
import type { BundledFontFace } from "../../bundled-fonts.ts";
import { Button } from "../../ui/button.tsx";
import { bundledFaceOf, isLocalFontAvailable, READER_FONT_CHOICES, type ReaderFontChoice } from "./reader-font.ts";
import type { ReaderTypographyChange } from "./reader-typography.ts";

export type { ReaderTypographyChange };

const STEP_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";

/** Line heights print with one decimal, so the five choices line up (`2.0`, not `2`). */
const lineHeightLabel = (value: number): string => value.toFixed(1);

/** One segment of a segmented choice (font, line height): a visually hidden radio inside its label. */
const SEGMENT =
  "flex flex-1 cursor-pointer items-center justify-center gap-1 rounded px-1 py-1 text-xs text-muted transition-colors hover:text-ink has-checked:bg-surface has-checked:font-semibold has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent";

const choiceOf = (font: ReaderFont | undefined): ReaderFontChoice => font ?? "default";

/**
 * The 「Aa」 control of the reading view: font, font size, line height, the side margin and,
 * when the text is read by speakers, whether the turns show. Non-modal so the text stays readable and scrollable
 * while it is adjusted (the change shows at once); Esc or a press outside closes it. Every
 * control is a native input, so the keyboard works without extra wiring.
 */
export function ReaderTypographyPopover(props: {
  value: ReaderTypography;
  /** Whether the revision is read by speakers; only then is the speaker switch offered. */
  speakerMode: boolean;
  /** Reads and registers a bundled face; false when it cannot be had. */
  loadFont: (face: BundledFontFace) => Promise<boolean>;
  /** The stored bundled face could not be loaded, so the text shows in the default font. */
  fontUnavailable?: boolean;
  /** The stored bundled face is being read (a restored choice, a retry); the text keeps the default font meanwhile. */
  fontLoading?: boolean;
  /** Reads the stored face again; picking the face already chosen changes nothing stored. */
  onRetryFont?: () => void;
  onChange: (change: ReaderTypographyChange) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const { value } = props;
  const groupId = useId();
  const sizeText = t("speakerReader.typography.fontSizeValue", { px: value.fontSize });
  const sideMargin = readerSideMargin(value);
  const marginText = t("speakerReader.typography.sideMarginValue", { px: sideMargin });
  const fontPick = useFontPick(props.loadFont, props.onChange);
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
            <FontGroup value={value} name={`${groupId}-font`} pick={fontPick} fontUnavailable={props.fontUnavailable === true} fontLoading={props.fontLoading === true} onRetry={props.onRetryFont} onChange={props.onChange} />

            <SteppedSlider
              label={t("speakerReader.typography.fontSize")}
              valueText={sizeText}
              value={value.fontSize}
              min={READER_FONT_SIZE_MIN}
              max={READER_FONT_SIZE_MAX}
              step={1}
              lessLabel={t("speakerReader.typography.smaller")}
              moreLabel={t("speakerReader.typography.larger")}
              testIds={{ slider: "reader-font-size", value: "reader-font-size-value", less: "reader-font-smaller", more: "reader-font-larger" }}
              onSet={(size) => props.onChange({ fontSize: size })}
            />

            <fieldset className="min-w-0">
              <legend className="mb-2 font-medium">{t("speakerReader.typography.lineHeight")}</legend>
              <div className="flex rounded-md border border-line bg-sunken p-0.5" data-testid="reader-line-heights">
                {READER_LINE_HEIGHT_OPTIONS.map((option) => (
                  <label key={option} className={`${SEGMENT} tabular-nums`}>
                    <input
                      type="radio"
                      name={`${groupId}-line-height`}
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

            <SteppedSlider
              label={t("speakerReader.typography.sideMargin")}
              valueText={marginText}
              value={sideMargin}
              min={READER_MARGIN_MIN}
              max={READER_MARGIN_MAX}
              step={READER_MARGIN_STEP}
              lessLabel={t("speakerReader.typography.narrower")}
              moreLabel={t("speakerReader.typography.wider")}
              testIds={{ slider: "reader-margin", value: "reader-margin-value", less: "reader-margin-narrower", more: "reader-margin-wider" }}
              onSet={(margin) => props.onChange({ sideMargin: margin })}
            />

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

/**
 * A labelled range with 「−」 and 「+」 beside it, for a number that moves in steps (the font
 * size, the side margin). Whatever is set is snapped to a step and kept within the range.
 */
function SteppedSlider(props: {
  label: string;
  valueText: string;
  value: number;
  min: number;
  max: number;
  step: number;
  lessLabel: string;
  moreLabel: string;
  testIds: { slider: string; value: string; less: string; more: string };
  onSet: (value: number) => void;
}) {
  const id = useId();
  const { min, max, step } = props;
  const set = (next: number): void => props.onSet(Math.min(max, Math.max(min, min + Math.round((next - min) / step) * step)));
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-medium">
          {props.label}
        </label>
        <output htmlFor={id} className="text-muted tabular-nums" data-testid={props.testIds.value}>
          {props.valueText}
        </output>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={STEP_BUTTON}
          aria-label={props.lessLabel}
          title={props.lessLabel}
          disabled={props.value <= min}
          onClick={() => set(props.value - step)}
          data-testid={props.testIds.less}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={props.value}
          aria-valuetext={props.valueText}
          className="min-w-0 flex-1 cursor-pointer accent-accent"
          onChange={(event) => set(Number(event.target.value))}
          data-testid={props.testIds.slider}
        />
        <button
          type="button"
          className={STEP_BUTTON}
          aria-label={props.moreLabel}
          title={props.moreLabel}
          disabled={props.value >= max}
          onClick={() => set(props.value + step)}
          data-testid={props.testIds.more}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

interface FontPick {
  /** The bundled face being read for the latest pick, if any. */
  pending: BundledFontFace | undefined;
  /** The latest pick's face could not be read; the font in use stays. */
  failed: boolean;
  pick: (choice: ReaderFontChoice) => void;
}

/**
 * Picking a font. A bundled face is read first and chosen only once it is ready, so the text
 * never shows a fallback in between; a failed read keeps the font in use. Kept with the
 * popover's root, which stays mounted while the popover is closed, so a read that finishes
 * after the popover closed still applies; only the latest pick may apply.
 */
function useFontPick(loadFont: (face: BundledFontFace) => Promise<boolean>, onChange: (change: ReaderTypographyChange) => void): FontPick {
  const [pending, setPending] = useState<BundledFontFace | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const latest = useRef({ loadFont, onChange });
  latest.current = { loadFont, onChange };
  // A read that settles after the reading view went away has nobody to apply to.
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const pick = (choice: ReaderFontChoice): void => {
    const ticket = ++request.current;
    setFailed(false);
    const face = choice === "default" || choice === "custom" ? undefined : bundledFaceOf(choice);
    if (face === undefined) {
      setPending(undefined);
      latest.current.onChange({ font: choice === "default" ? undefined : "custom" });
      return;
    }
    setPending(face);
    void latest.current.loadFont(face).then((ok) => {
      if (ticket !== request.current) return;
      setPending(undefined);
      if (ok) latest.current.onChange({ font: face });
      else setFailed(true);
    });
  };
  return { pending, failed, pick };
}

/**
 * The font group: the default, the three bundled faces and a font of this machine, as one
 * segmented choice like the line heights. A bundled face being read spins in its segment
 * while the font in use stays checked; so does a stored face read in the background.
 */
function FontGroup(props: {
  value: ReaderTypography;
  name: string;
  pick: FontPick;
  fontUnavailable: boolean;
  fontLoading: boolean;
  onRetry: (() => void) | undefined;
  onChange: (change: ReaderTypographyChange) => void;
}) {
  const { t } = useTranslation();
  const { pending, failed, pick } = props.pick;
  const current = choiceOf(props.value.font);
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 font-medium">{t("readerFont.label")}</legend>
      <div className="flex rounded-md border border-line bg-sunken p-0.5" data-testid="reader-fonts">
        {READER_FONT_CHOICES.map((choice) => {
          const label = t(`readerFont.choice.${choice}`);
          // A pick being read spins in its own segment; otherwise the stored face being read spins in the checked one.
          const loading = pending === undefined ? props.fontLoading && choice === current : choice === pending;
          return (
            <label key={choice} className={SEGMENT} aria-busy={loading || undefined} data-loading={loading ? "true" : undefined}>
              <input
                type="radio"
                name={props.name}
                className="sr-only"
                value={choice}
                checked={current === choice}
                aria-label={loading ? t("readerFont.loading", { name: label }) : label}
                onChange={() => pick(choice)}
                // A checked radio fires no change, so the stored face that failed to load is retried on click.
                onClick={() => {
                  if (choice === current && props.fontUnavailable && pending === undefined) props.onRetry?.();
                }}
              />
              {loading ? <LoaderCircle size={12} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {label}
            </label>
          );
        })}
      </div>
      {failed || (props.fontUnavailable && pending === undefined) ? (
        <p role="status" className="mt-2 text-xs text-danger" data-testid="reader-font-failed">
          {t("readerFont.loadFailed")}
        </p>
      ) : null}
      {current === "custom" ? <CustomFontField stored={props.value.customFont} onChange={props.onChange} /> : null}
    </fieldset>
  );
}

/**
 * The name of a font of this machine. A valid name is stored as it is typed (trimmed); an
 * invalid one stays in the field with the rule beside it and is not stored; clearing the field
 * removes the name, which shows the default font. Whether the font is installed is measured
 * and only hinted: the name is used either way.
 */
function CustomFontField(props: { stored: string | undefined; onChange: (change: ReaderTypographyChange) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(props.stored ?? "");
  const name = draft.trim();
  const valid = name !== "" && readerCustomFontSchema.safeParse(name).success;
  const invalid = name !== "" && !valid;
  const [found, setFound] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    setFound(valid ? isLocalFontAvailable(name) : undefined);
  }, [name, valid]);

  const change = (text: string): void => {
    setDraft(text);
    const next = text.trim();
    if (next === "") props.onChange({ customFont: undefined });
    else if (readerCustomFontSchema.safeParse(next).success) props.onChange({ customFont: next });
  };

  return (
    <div className="mt-2">
      <label htmlFor={id} className="sr-only">
        {t("readerFont.customLabel")}
      </label>
      <input
        id={id}
        type="text"
        value={draft}
        placeholder={t("readerFont.customPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-status`}
        className="h-7 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent aria-invalid:border-danger"
        onChange={(event) => change(event.target.value)}
        data-testid="reader-custom-font"
      />
      <p id={`${id}-status`} role="status" className={`mt-1 text-xs ${invalid ? "text-danger" : "text-muted"}`} data-testid="reader-custom-font-status">
        {invalid
          ? t("readerFont.customInvalid", { max: READER_FONT_NAME_MAX_CHARS })
          : found === undefined
            ? null
            : found
              ? t("readerFont.customFound")
              : t("readerFont.customMissing")}
      </p>
    </div>
  );
}
