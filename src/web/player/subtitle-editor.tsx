import { ChevronsLeftRight, Minus } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  SUBTITLE_BACKGROUND_PADDING_MAX,
  SUBTITLE_FONT_SIZE_MAX,
  SUBTITLE_FONT_SIZE_MIN,
  SUBTITLE_ORIGINAL_COLOR,
  SUBTITLE_OUTLINE_COLOR,
  SUBTITLE_OUTLINE_WIDTH_MAX,
  SUBTITLE_PLACEMENT_Y_BP,
  SUBTITLE_TRANSLATION_COLOR,
} from "../../shared/defaults.ts";
import { SUBTITLE_BACKGROUND_SCOPES, SUBTITLE_BILINGUAL_ORDERS } from "../../shared/enums.ts";
import { BASIS_POINTS, defaultSubtitlePlacement, SUBTITLE_SPEAKER_MODES, type SubtitleAppearance, type SubtitlePlacement, type SubtitleSpeakerMode } from "../../shared/subtitle-style.ts";
import type { SubtitleTrackModel } from "./subtitle-overlay.tsx";

/** Swatches beside the colour picker: the default colours first, then a few common subtitle colours. */
const PRESET_COLORS = [SUBTITLE_ORIGINAL_COLOR, SUBTITLE_TRANSLATION_COLOR, SUBTITLE_OUTLINE_COLOR, "#00FFFF", "#7CFC00", "#FF6B6B"] as const;

const HALF = BASIS_POINTS / 2;
/** Position presets: the top one mirrors the default bottom margin; the corners keep the default height. */
const POSITION_PRESETS: ReadonlyArray<{ id: "bottom" | "top" | "bottomLeft" | "bottomRight" | "center"; placement: SubtitlePlacement }> = [
  { id: "bottom", placement: defaultSubtitlePlacement() },
  { id: "top", placement: { version: 1, xBp: HALF, yBp: BASIS_POINTS - SUBTITLE_PLACEMENT_Y_BP, anchor: "top" } },
  { id: "bottomLeft", placement: { version: 1, xBp: BASIS_POINTS / 4, yBp: SUBTITLE_PLACEMENT_Y_BP, anchor: "bottom" } },
  { id: "bottomRight", placement: { version: 1, xBp: (BASIS_POINTS * 3) / 4, yBp: SUBTITLE_PLACEMENT_Y_BP, anchor: "bottom" } },
  { id: "center", placement: { version: 1, xBp: HALF, yBp: HALF, anchor: "center" } },
];

const HEX = /^#[0-9A-Fa-f]{6}$/u;
const FIELD_CLASS = "flex items-center gap-2 text-xs";
const BUTTON_CLASS = "rounded border border-white/20 px-2 py-1 text-xs hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50";

function Section(props: { title: string; children: ReactNode; testId?: string }) {
  return (
    <fieldset className="flex flex-col gap-1.5 border-t border-white/15 pt-2" {...(props.testId === undefined ? {} : { "data-testid": props.testId })}>
      <legend className="pb-1 text-xs font-medium text-white/80">{props.title}</legend>
      {props.children}
    </fieldset>
  );
}

function RangeField(props: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; testId: string }) {
  return (
    <label className={FIELD_CLASS}>
      <span className="w-16 shrink-0 text-white/70">{props.label}</span>
      <input
        type="range"
        className="min-w-0 flex-1 accent-accent"
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        onChange={(event) => props.onChange(Math.round(Number(event.currentTarget.value)))}
        data-testid={props.testId}
      />
      <span className="w-7 text-right tabular-nums">{props.value}</span>
    </label>
  );
}

/** Any colour: the system picker, a typed `#RRGGBB`, or a swatch. */
function ColorField(props: { label: string; value: string; onChange: (value: string) => void; testId: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <div className="flex flex-col gap-1">
      <div className={FIELD_CLASS}>
        <span className="w-16 shrink-0 text-white/70">{props.label}</span>
        <input
          type="color"
          className="h-6 w-8 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent"
          aria-label={props.label}
          value={props.value.toLowerCase()}
          onChange={(event) => props.onChange(event.currentTarget.value.toUpperCase())}
          data-testid={`${props.testId}-picker`}
        />
        <input
          type="text"
          className="w-20 min-w-0 rounded border border-white/20 bg-black/40 px-1 py-0.5 font-mono text-xs"
          aria-label={t("contentView.player.subtitles.editor.hexColor")}
          value={text}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            if (HEX.test(next)) props.onChange(next.toUpperCase());
          }}
          onBlur={() => setText(props.value)}
          data-testid={`${props.testId}-hex`}
        />
      </div>
      <div className="flex gap-1 pl-[4.5rem]" role="group" aria-label={t("contentView.player.subtitles.editor.presetColors")}>
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`h-4 w-4 rounded-sm border ${props.value === color ? "border-accent ring-1 ring-accent" : "border-white/30"}`}
            style={{ background: color }}
            aria-label={color}
            aria-pressed={props.value === color}
            onClick={() => props.onChange(color)}
            data-testid={`${props.testId}-swatch-${color.slice(1)}`}
          />
        ))}
      </div>
    </div>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; testId: string }) {
  return (
    <label className={FIELD_CLASS}>
      <input type="checkbox" className="accent-accent" checked={props.checked} onChange={(event) => props.onChange(event.currentTarget.checked)} data-testid={props.testId} />
      {props.label}
    </label>
  );
}

/**
 * The appearance with speaker labels set to `mode`; `undefined` drops the key altogether, so
 * an appearance without labels is stored (and frozen into exports) exactly as before.
 */
export function withSpeakerMode(appearance: SubtitleAppearance, mode: SubtitleSpeakerMode | undefined): SubtitleAppearance {
  const { speaker: _speaker, ...rest } = appearance;
  return mode === undefined ? rest : { ...rest, speaker: mode };
}

/** A position in percent of the picture, two decimals: one basis point. */
function PercentField(props: { label: string; valueBp: number; onChange: (valueBp: number) => void; testId: string }) {
  const [text, setText] = useState(String(props.valueBp / 100));
  useEffect(() => setText(String(props.valueBp / 100)), [props.valueBp]);
  return (
    <label className={FIELD_CLASS}>
      <span className="w-16 shrink-0 text-white/70">{props.label}</span>
      <input
        type="number"
        className="w-20 min-w-0 rounded border border-white/20 bg-black/40 px-1 py-0.5 text-xs tabular-nums"
        min={0}
        max={100}
        step={0.1}
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          const percent = Number(next);
          if (next.trim() !== "" && Number.isFinite(percent)) props.onChange(Math.min(BASIS_POINTS, Math.max(0, Math.round(percent * 100))));
        }}
        onBlur={() => setText(String(props.valueBp / 100))}
        data-testid={props.testId}
      />
    </label>
  );
}

/**
 * The subtitle style and position panel: non-modal and never closed by a
 * click elsewhere, docked on `side` (the side away from the subtitles), collapsible, and
 * scrolling within `maxHeight`. 「完成」 or `Escape` inside it leaves the editor. Every
 * appearance change is written at once for the user; positions are this Content's.
 */
export function SubtitleEditor(props: { model: SubtitleTrackModel; side: "left" | "right"; top: number; maxHeight: number | undefined; onPreview: () => void }) {
  const { t } = useTranslation();
  const { model } = props;
  const { appearance, placement } = model;
  const [collapsed, setCollapsed] = useState(false);
  const update = (change: (current: SubtitleAppearance) => SubtitleAppearance): void => model.setAppearance(change(appearance));
  const showOriginal = model.mode !== "translation";
  const showTranslation = model.mode !== "original";
  const dock = { [props.side]: 8, top: props.top };
  // The panel is a form of its own: its keys must not play, skip or toggle fullscreen.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      model.stopEditing();
    }
  };
  const stop = (event: SyntheticEvent): void => event.stopPropagation();

  if (collapsed) {
    return (
      <button
        type="button"
        className="absolute z-[2] flex items-center gap-1 rounded-md bg-black/80 px-2 py-1 text-xs text-white shadow-lg hover:bg-black/90"
        style={dock}
        onClick={() => setCollapsed(false)}
        onKeyDown={onKeyDown}
        onDoubleClick={stop}
        data-testid="subtitle-editor-expand"
      >
        <ChevronsLeftRight size={14} aria-hidden="true" />
        {t("contentView.player.subtitles.editor.expand")}
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t("contentView.player.subtitles.editor.title")}
      className="absolute z-[2] flex w-72 max-w-[calc(100%-1rem)] flex-col rounded-md bg-black/85 text-white shadow-lg"
      style={{ ...dock, ...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight }) }}
      onKeyDown={onKeyDown}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      data-testid="subtitle-editor"
      data-side={props.side}
    >
      <div className="flex items-center gap-1 px-3 pt-2 pb-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t("contentView.player.subtitles.editor.title")}</h2>
        <button
          type="button"
          className="rounded p-1 hover:bg-white/15"
          aria-label={t("contentView.player.subtitles.editor.collapse")}
          title={t("contentView.player.subtitles.editor.collapse")}
          onClick={() => setCollapsed(true)}
          data-testid="subtitle-editor-collapse"
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button type="button" className="rounded bg-accent px-2 py-1 text-xs text-white hover:opacity-90" onClick={model.stopEditing} data-testid="subtitle-editor-done">
          {t("contentView.player.subtitles.editor.done")}
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 pb-3">
        <p className="text-xs text-white/60">{t("contentView.player.subtitles.editor.dragHint")}</p>
        {model.fontFallback ? (
          <p className="text-xs text-white/60" data-testid="subtitle-font-fallback">
            {t("contentView.player.subtitles.fontFallback")}
          </p>
        ) : null}
        {showOriginal ? (
          <Section title={t("contentView.player.subtitles.editor.originalLine")}>
            <RangeField
              label={t("contentView.player.subtitles.editor.fontSize")}
              value={appearance.original.fontSize}
              min={SUBTITLE_FONT_SIZE_MIN}
              max={SUBTITLE_FONT_SIZE_MAX}
              onChange={(fontSize) => update((current) => ({ ...current, original: { ...current.original, fontSize } }))}
              testId="subtitle-original-size"
            />
            <ColorField
              label={t("contentView.player.subtitles.editor.color")}
              value={appearance.original.color}
              onChange={(color) => update((current) => ({ ...current, original: { ...current.original, color } }))}
              testId="subtitle-original-color"
            />
          </Section>
        ) : null}
        {showTranslation ? (
          <Section title={t("contentView.player.subtitles.editor.translationLine")}>
            <RangeField
              label={t("contentView.player.subtitles.editor.fontSize")}
              value={appearance.translation.fontSize}
              min={SUBTITLE_FONT_SIZE_MIN}
              max={SUBTITLE_FONT_SIZE_MAX}
              onChange={(fontSize) => update((current) => ({ ...current, translation: { ...current.translation, fontSize } }))}
              testId="subtitle-translation-size"
            />
            <ColorField
              label={t("contentView.player.subtitles.editor.color")}
              value={appearance.translation.color}
              onChange={(color) => update((current) => ({ ...current, translation: { ...current.translation, color } }))}
              testId="subtitle-translation-color"
            />
          </Section>
        ) : null}
        <Section title={t("contentView.player.subtitles.editor.outline")}>
          <Toggle
            label={t("contentView.player.subtitles.editor.enabled")}
            checked={appearance.outline.enabled}
            onChange={(enabled) => update((current) => ({ ...current, outline: { ...current.outline, enabled } }))}
            testId="subtitle-outline-enabled"
          />
          <ColorField
            label={t("contentView.player.subtitles.editor.color")}
            value={appearance.outline.color}
            onChange={(color) => update((current) => ({ ...current, outline: { ...current.outline, color } }))}
            testId="subtitle-outline-color"
          />
          <RangeField
            label={t("contentView.player.subtitles.editor.outlineWidth")}
            value={appearance.outline.width}
            min={0}
            max={SUBTITLE_OUTLINE_WIDTH_MAX}
            onChange={(width) => update((current) => ({ ...current, outline: { ...current.outline, width } }))}
            testId="subtitle-outline-width"
          />
        </Section>
        <Section title={t("contentView.player.subtitles.editor.background")}>
          <Toggle
            label={t("contentView.player.subtitles.editor.enabled")}
            checked={appearance.background.enabled}
            onChange={(enabled) => update((current) => ({ ...current, background: { ...current.background, enabled } }))}
            testId="subtitle-background-enabled"
          />
          <ColorField
            label={t("contentView.player.subtitles.editor.color")}
            value={appearance.background.color}
            onChange={(color) => update((current) => ({ ...current, background: { ...current.background, color } }))}
            testId="subtitle-background-color"
          />
          <RangeField
            label={t("contentView.player.subtitles.editor.opacity")}
            value={appearance.background.opacityPct}
            min={0}
            max={100}
            onChange={(opacityPct) => update((current) => ({ ...current, background: { ...current.background, opacityPct } }))}
            testId="subtitle-background-opacity"
          />
          <RangeField
            label={t("contentView.player.subtitles.editor.padding")}
            value={appearance.background.padding}
            min={0}
            max={SUBTITLE_BACKGROUND_PADDING_MAX}
            onChange={(padding) => update((current) => ({ ...current, background: { ...current.background, padding } }))}
            testId="subtitle-background-padding"
          />
          {model.mode === "bilingual" ? (
            <div className="flex items-start gap-2 text-xs">
              <span className="w-16 shrink-0 text-white/70">{t("contentView.player.subtitles.editor.backgroundScope")}</span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1" role="radiogroup" aria-label={t("contentView.player.subtitles.editor.backgroundScope")}>
                {SUBTITLE_BACKGROUND_SCOPES.map((scope) => (
                  <label key={scope} className={FIELD_CLASS}>
                    <input
                      type="radio"
                      className="accent-accent"
                      name="subtitle-background-scope"
                      checked={appearance.background.scope === scope}
                      onChange={() => update((current) => ({ ...current, background: { ...current.background, scope } }))}
                      data-testid={`subtitle-background-scope-${scope}`}
                    />
                    {t(`contentView.player.subtitles.editor.backgroundScopeValue.${scope}`)}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </Section>
        {model.mode === "bilingual" ? (
          <Section title={t("contentView.player.subtitles.editor.bilingualOrder")}>
            <div className="flex gap-3" role="radiogroup" aria-label={t("contentView.player.subtitles.editor.bilingualOrder")}>
              {SUBTITLE_BILINGUAL_ORDERS.map((order) => (
                <label key={order} className={FIELD_CLASS}>
                  <input
                    type="radio"
                    className="accent-accent"
                    name="subtitle-bilingual-order"
                    checked={appearance.bilingualOrder === order}
                    onChange={() => update((current) => ({ ...current, bilingualOrder: order }))}
                    data-testid={`subtitle-order-${order}`}
                  />
                  {t(`contentView.player.subtitles.editor.orderValue.${order}`)}
                </label>
              ))}
            </div>
          </Section>
        ) : null}
        <Section title={t("contentView.player.subtitles.editor.position")}>
          <div className="flex flex-wrap gap-1">
            {POSITION_PRESETS.map((preset) => (
              <button key={preset.id} type="button" className={BUTTON_CLASS} onClick={() => model.setPlacement(preset.placement)} data-testid={`subtitle-preset-${preset.id}`}>
                {t(`contentView.player.subtitles.editor.presetValue.${preset.id}`)}
              </button>
            ))}
          </div>
          <PercentField
            label={t("contentView.player.subtitles.editor.x")}
            valueBp={placement.xBp}
            onChange={(xBp) => model.setPlacement({ ...placement, xBp })}
            testId="subtitle-position-x"
          />
          <PercentField
            label={t("contentView.player.subtitles.editor.y")}
            valueBp={placement.yBp}
            onChange={(yBp) => model.setPlacement({ ...placement, yBp })}
            testId="subtitle-position-y"
          />
        </Section>
        <Section title={t("subtitleSpeaker.editor.title")} testId="subtitle-speaker-section">
          <div className="flex flex-wrap gap-x-3 gap-y-1" role="radiogroup" aria-label={t("subtitleSpeaker.editor.title")} aria-describedby="subtitle-speaker-hint">
            {([undefined, ...SUBTITLE_SPEAKER_MODES] as const).map((mode) => (
              <label key={mode ?? "off"} className={FIELD_CLASS}>
                <input
                  type="radio"
                  className="accent-accent"
                  name="subtitle-speaker"
                  checked={appearance.speaker === mode}
                  onChange={() => update((current) => withSpeakerMode(current, mode))}
                  data-testid={`subtitle-speaker-${mode ?? "off"}`}
                />
                {t(`subtitleSpeaker.editor.value.${mode ?? "off"}`)}
              </label>
            ))}
          </div>
          <p id="subtitle-speaker-hint" className="text-xs text-white/60">
            {t("subtitleSpeaker.editor.hint")}
          </p>
        </Section>
        <div className="flex flex-wrap gap-1 border-t border-white/15 pt-2">
          <button type="button" className={BUTTON_CLASS} onClick={props.onPreview} data-testid="subtitle-preview">
            {t("contentView.player.subtitles.editor.preview")}
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={model.setDefaultPlacement} data-testid="subtitle-set-default-position">
            {t("contentView.player.subtitles.editor.setDefaultPosition")}
          </button>
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={!model.placementOverridden}
            onClick={model.resetPlacement}
            data-testid="subtitle-reset-position"
          >
            {t("contentView.player.subtitles.editor.resetPosition")}
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={model.resetAppearance} data-testid="subtitle-reset-style">
            {t("contentView.player.subtitles.editor.resetStyle")}
          </button>
        </div>
      </div>
    </div>
  );
}
