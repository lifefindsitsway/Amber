import { SUBTITLE_ASS_EM_RATIO, SUBTITLE_BREAK_SLACK, SUBTITLE_WRAP_RATIO } from "../../../shared/defaults.ts";
import {
  assColor,
  labelSubtitleCues,
  sliceCues,
  sliceSubtitleUnits,
  speakerLabelFontSize,
  subtitleGlyphText,
  subtitleUnitLines,
  type SlicedUnitSubtitle,
  type TimedSubtitle,
} from "../../../shared/subtitle-geometry.ts";
import type { BurnMode } from "../../../shared/enums.ts";
import { BASIS_POINTS, boxedLines, lineBoxPadding, type SubtitleStyle } from "../../../shared/subtitle-style.ts";
import type { TranscriptWord } from "../transcript.ts";
import type { ExportCue } from "./cues.ts";
import { breakSubtitleLine, type GlyphAdvances } from "./subtitle-breaks.ts";
import { assTime } from "./time-format.ts";

/**
 * Script header, styles and event format of the fixed ASS styles. The two style lines
 * and the script info are fixed text: an export without a style stays byte-for-byte the
 * same; `Translation` is the style of the second line of a
 * bilingual cue.
 */
export const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans SC,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,140,140,50,1
Style: Translation,Noto Sans SC,26,&H0000FFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,140,140,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

/**
 * Subtitle text as literal ASS text. ASS has no escape for override blocks: `{` always
 * opens one and `\` starts `\N` / `\h` / `\n`. Swapping them for their full-width forms
 * keeps the text readable while making sure transcript or translation text can never turn
 * into styling or line-break commands; real line breaks become `\N`.
 */
export function assText(text: string): string {
  return text
    .replace(/\\/g, "＼")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝")
    .replace(/\r\n|\r|\n/g, "\\N");
}

/**
 * A speaker name for the `Name` field. The field ends at the next comma, so commas become
 * full-width ones; line breaks would end the event, so they become spaces.
 */
export function assName(name: string | undefined): string {
  return name === undefined ? "" : name.replace(/,/g, "，").replace(/\r\n|\r|\n/g, " ");
}

/**
 * One `Dialogue` line. A bilingual cue stays a single event — `原文\N{\rTranslation}译文` —
 * because two events would overlap on screen. `karaoke` adds `{\k}` tags from real word
 * timing to the original line only; callers enable it for `exact_words` revisions alone.
 * `speaker` fills the `Name` field.
 */
export function assDialogue(cue: ExportCue, options: { karaoke: boolean; speaker?: string }): string {
  const original = options.karaoke && cue.words !== undefined && cue.words.length > 0 ? karaokeText(cue) : assText(subtitleGlyphText(cue.text));
  const text = cue.translation === undefined ? original : `${original}\\N{\\rTranslation}${assText(subtitleGlyphText(cue.translation))}`;
  return `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,${assName(options.speaker)},0,0,0,,${text}\n`;
}

/**
 * `{\kNN}` karaoke text in centiseconds from the sentence's words: each word lasts its
 * real duration and a silence before a word is its own tag without text, so highlighting
 * follows the speech rather than an even split. Durations come from cumulative
 * centisecond positions, so rounding never drifts across a long sentence. Each word's
 * text is cut from the sentence text in order, keeping the original spacing and
 * punctuation; a word missing from the text is emitted as is.
 */
function karaokeText(cue: ExportCue): string {
  const words = cue.words as readonly TranscriptWord[];
  const at = (ms: number): number => Math.round((ms - cue.startMs) / 10);
  const source = subtitleGlyphText(cue.text.replace(/\r\n|\r|\n/g, " "));
  let cursor = 0;
  let previousEnd = cue.startMs;
  let out = "";
  words.forEach((word, index) => {
    // Words are matched in the same drawn form as the sentence they are cut from.
    const wordText = subtitleGlyphText(word.text, cue.text);
    const found = source.indexOf(wordText, cursor);
    let piece: string;
    if (found === -1) {
      piece = cursor > 0 && /\w$/u.test(source.slice(0, cursor)) ? ` ${wordText}` : wordText;
    } else {
      piece = source.slice(cursor, found + wordText.length);
      cursor = found + wordText.length;
    }
    if (index === words.length - 1) {
      piece += source.slice(cursor);
    }
    const start = Math.max(word.startMs, previousEnd);
    if (start > previousEnd) {
      out += `{\\k${at(start) - at(previousEnd)}}`;
    }
    const end = Math.max(word.endMs, start);
    out += `{\\k${at(end) - at(start)}}${assText(piece)}`;
    previousEnd = end;
  });
  return out;
}

/** The canvas height of every styled ASS: style lengths are 1080p picture pixels. */
export const STYLED_ASS_PLAY_RES_Y = 1080;

/** The ASS canvas: `PlayResY` is always `STYLED_ASS_PLAY_RES_Y`; `PlayResX` follows the picture's display aspect. */
export interface AssPlayRes {
  width: number;
  height: number;
}

export interface StyledAssOptions {
  style: SubtitleStyle;
  /** The display mode: with the box scope it decides whether the box is one block or one line; the scope only matters for bilingual display. */
  mode: BurnMode;
  playRes: AssPlayRes;
  /**
   * Text events only, never the background box: the source of an MP4 `mov_text` track,
   * which keeps colour and size but not boxes or positions.
   */
  textOnly: boolean;
  /**
   * Speakers for the `Name` field: `ofCue[i]` is the speaker id of the i-th input cue and
   * `names` gives each id its display name. Absent = no names, as before.
   */
  speakers?: { ofCue: readonly (string | undefined)[]; names: ReadonlyMap<string, string> };
  /**
   * Speaker label lines, drawn when the style's appearance asks for them: `ofCue[i]` is the
   * speaker id of the i-th input cue and `labels` gives each id its label. Absent, or with
   * the appearance not asking, the document is exactly what it was without them. Never drawn
   * in `textOnly` output, whose `mov_text` target keeps no layout to stack them in.
   */
  speakerLines?: { ofCue: readonly (string | undefined)[]; labels: ReadonlyMap<string, string> };
  /**
   * Advances of the bundled font: with them every line wider than the wrap width is broken
   * here with `\N`, so no renderer has to wrap it. Absent, or in `textOnly` output, lines are
   * left to the renderer, as before.
   */
  glyphs?: GlyphAdvances;
}

const STYLE_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
const EVENT_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
/** The bundled font's family name; libass finds it in the bundled fonts directory. */
const FONT_NAME = "Noto Sans SC";
/** Fully transparent: the background-box styles draw only their box. */
const TRANSPARENT = assColor("#000000", 0);

/** `\an` numpad alignment of each anchor, horizontally centred: the block grows away from the anchored edge. */
const ALIGNMENT: Readonly<Record<SubtitleStyle["placement"]["anchor"], number>> = { top: 8, center: 5, bottom: 2 };

type Line = "original" | "translation";
const TEXT_STYLE: Readonly<Record<Line, string>> = { original: "Default", translation: "Translation" };
const BOX_STYLE: Readonly<Record<Line, string>> = { original: "Box", translation: "BoxTranslation" };
const LINE_STYLE: Readonly<Record<Line, string>> = { original: "Line", translation: "LineTranslation" };
const GHOST_STYLE: Readonly<Record<Line, string>> = { original: "Ghost", translation: "GhostTranslation" };
/** The speaker label's counterpart of each style family above, by the line whose look the label copies. */
const SPEAKER_TEXT_STYLE: Readonly<Record<Line, string>> = { original: "Speaker", translation: "SpeakerTranslation" };
const SPEAKER_BOX_STYLE: Readonly<Record<Line, string>> = { original: "BoxSpeaker", translation: "BoxSpeakerTranslation" };
const SPEAKER_LINE_STYLE: Readonly<Record<Line, string>> = { original: "LineSpeaker", translation: "LineSpeakerTranslation" };
const SPEAKER_GHOST_STYLE: Readonly<Record<Line, string>> = { original: "GhostSpeaker", translation: "GhostSpeakerTranslation" };
const LINES: readonly Line[] = ["original", "translation"];

/** The background box of a document: `textOnly` never has one. */
function boxOf(options: StyledAssOptions): ReturnType<typeof boxedLines> {
  return options.textOnly ? "none" : boxedLines(options.style.appearance, options.mode);
}

function styleLine(fields: {
  name: string;
  fontSize: number;
  primary: string;
  outlineColour: string;
  back: string;
  borderStyle: number;
  outline: number;
  alignment: number;
  margin: number;
}): string {
  const { name, fontSize, primary, outlineColour, back, borderStyle, outline, alignment, margin } = fields;
  return `Style: ${name},${FONT_NAME},${fontSize},${primary},${primary},${outlineColour},${back},0,0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},${margin},${margin},0,1`;
}

/**
 * Script header of a styled ASS: text styles `Default`
 * (original) and `Translation`, plus `Box` / `BoxTranslation` for a block box, or
 * `Line*` / `Ghost*` for a one-line box. `MarginL/R` keep wrapped lines within
 * `SUBTITLE_WRAP_RATIO` of the picture width. `speakers` are the lines whose look speaker
 * labels copy somewhere in the document; each adds its `Speaker*` counterparts, so a document
 * lists only the label styles it uses.
 */
function styledAssHeader(options: StyledAssOptions, speakers: ReadonlySet<Line> = new Set()): string {
  const { appearance, placement } = options.style;
  const width = options.playRes.width;
  const margin = wrapMargin(width);
  const alignment = ALIGNMENT[placement.anchor];
  const outlineColour = assColor(appearance.outline.color);
  const outline = appearance.outline.enabled ? appearance.outline.width : 0;
  const styles = (["original", "translation"] as const).map((line) =>
    styleLine({
      name: TEXT_STYLE[line],
      fontSize: appearance[line].fontSize,
      primary: assColor(appearance[line].color),
      outlineColour,
      back: TRANSPARENT,
      borderStyle: 1,
      outline,
      alignment,
      margin,
    }),
  );
  // A speaker label copies the size (scaled), colour and outline of the line it heads.
  const labelLines = LINES.filter((line) => speakers.has(line));
  const speakerSize = (line: Line): number => speakerLabelFontSize(appearance[line].fontSize);
  for (const line of labelLines) {
    styles.push(
      styleLine({ name: SPEAKER_TEXT_STYLE[line], fontSize: speakerSize(line), primary: assColor(appearance[line].color), outlineColour, back: TRANSPARENT, borderStyle: 1, outline, alignment, margin }),
    );
  }
  const box = boxOf(options);
  const back = assColor(appearance.background.color, appearance.background.opacityPct);
  if (box === "block") {
    for (const line of ["original", "translation"] as const) {
      styles.push(
        styleLine({
          name: BOX_STYLE[line],
          fontSize: appearance[line].fontSize,
          primary: TRANSPARENT,
          outlineColour: TRANSPARENT,
          back,
          borderStyle: 4,
          outline: appearance.background.padding,
          alignment,
          margin,
        }),
      );
    }
    for (const line of labelLines) {
      styles.push(
        styleLine({
          name: SPEAKER_BOX_STYLE[line],
          fontSize: speakerSize(line),
          primary: TRANSPARENT,
          outlineColour: TRANSPARENT,
          back,
          borderStyle: 4,
          outline: appearance.background.padding,
          alignment,
          margin,
        }),
      );
    }
  } else if (box !== "none") {
    // BorderStyle 4 boxes the whole event even after `{\r}`, so one line needs BorderStyle 3,
    // whose box is the outline colour and width. The ghost line only keeps the layout.
    for (const line of ["original", "translation"] as const) {
      styles.push(
        styleLine({
          name: LINE_STYLE[line],
          fontSize: appearance[line].fontSize,
          primary: TRANSPARENT,
          outlineColour: back,
          back: TRANSPARENT,
          borderStyle: 3,
          outline: lineBoxPadding(appearance),
          alignment,
          margin,
        }),
      );
    }
    for (const line of labelLines) {
      styles.push(
        styleLine({
          name: SPEAKER_LINE_STYLE[line],
          fontSize: speakerSize(line),
          primary: TRANSPARENT,
          outlineColour: back,
          back: TRANSPARENT,
          borderStyle: 3,
          outline: lineBoxPadding(appearance),
          alignment,
          margin,
        }),
      );
    }
    for (const line of ["original", "translation"] as const) {
      styles.push(
        styleLine({
          name: GHOST_STYLE[line],
          fontSize: appearance[line].fontSize,
          primary: TRANSPARENT,
          outlineColour: TRANSPARENT,
          back: TRANSPARENT,
          borderStyle: 1,
          outline: 0,
          alignment,
          margin,
        }),
      );
    }
    for (const line of labelLines) {
      styles.push(
        styleLine({ name: SPEAKER_GHOST_STYLE[line], fontSize: speakerSize(line), primary: TRANSPARENT, outlineColour: TRANSPARENT, back: TRANSPARENT, borderStyle: 1, outline: 0, alignment, margin }),
      );
    }
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${options.playRes.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    STYLE_FORMAT,
    ...styles,
    "",
    "[Events]",
    EVENT_FORMAT,
    "",
  ].join("\n");
}

/** `MarginL` and `MarginR`: what keeps wrapped lines within `SUBTITLE_WRAP_RATIO` of the canvas width. */
function wrapMargin(width: number): number {
  return Math.round(((1 - SUBTITLE_WRAP_RATIO) / 2) * width);
}

/** A line's text at a font size, as drawn: broken to the wrap width when the document breaks lines itself. */
type Wrap = (text: string, fontSize: number) => string;

/**
 * The document's line breaker: the width libass wraps at (`PlayResX` less both margins) with
 * `SUBTITLE_BREAK_SLACK` to spare, an em of `Fontsize × SUBTITLE_ASS_EM_RATIO` canvas pixels.
 * Lines already split by a line break are broken each on its own.
 */
function wrapOf(options: StyledAssOptions): Wrap {
  const { glyphs } = options;
  if (glyphs === undefined || options.textOnly) return (text) => text;
  const width = options.playRes.width;
  const available = (width - 2 * wrapMargin(width)) * SUBTITLE_BREAK_SLACK;
  return (text, fontSize) =>
    text
      .split(/\r\n|\r|\n/)
      .flatMap((line) => breakSubtitleLine(line, available, fontSize * SUBTITLE_ASS_EM_RATIO, glyphs))
      .join("\n");
}

/** The `{\anN\pos(x,y)}` tag every event starts with: the anchor's alignment at the placement on the canvas. */
function positionTag(options: StyledAssOptions): string {
  const { placement } = options.style;
  return `{\\an${ALIGNMENT[placement.anchor]}\\pos(${Math.round((placement.xBp / BASIS_POINTS) * options.playRes.width)},${Math.round((placement.yBp / BASIS_POINTS) * options.playRes.height)})}`;
}

/**
 * One event's text: the lines present in display order, the first in the event's own
 * style and the second switched to with `{\r<style>}`. Every piece of subtitle text goes
 * through `assText`; tags come only from here.
 */
function eventText(
  cue: TimedSubtitle,
  order: SubtitleStyle["appearance"]["bilingualOrder"],
  styles: Readonly<Record<Line, string>>,
  wrap: (text: string, line: Line) => string,
): { style: string; text: string } | undefined {
  const lines: Line[] = order === "translation_first" ? ["translation", "original"] : ["original", "translation"];
  const present = lines.filter((line) => cue[line] !== undefined);
  const first = present[0];
  if (first === undefined) {
    return undefined;
  }
  const text = present.map((line, index) => (index === 0 ? "" : `\\N{\\r${styles[line]}}`) + assText(wrap(subtitleGlyphText(cue[line] as string), line))).join("");
  return { style: styles[first], text };
}

/**
 * A styled ASS document: cues are first cut into
 * non-overlapping slices, since every event sits at one fixed position and overlapping
 * events would be drawn over each other. Each slice is a layer-0 background event (when
 * the box is on and not `textOnly`) and a layer-1 text event with the same position tag
 * `{\anN\pos(x,y)}`. A one-line box lays out both lines like the text event but draws
 * only the chosen one, and is skipped for a slice without that line. No `{\k}` karaoke:
 * the player overlay has none either. Speaker label lines, when the appearance asks for
 * them and labels are given, take `labeledAssDocument`; otherwise nothing of them shows.
 */
export function styledAssDocument(cues: readonly TimedSubtitle[], options: StyledAssOptions): string {
  const speakerMode = options.style.appearance.speaker;
  if (speakerMode !== undefined && options.speakerLines !== undefined && !options.textOnly) {
    return labeledAssDocument(options, labelSubtitleCues(cues, options.speakerLines.ofCue, options.speakerLines.labels, speakerMode));
  }
  const slices = sliceCues(cues);
  const names = sliceSpeakerNames(cues, slices, options.speakers);
  const { appearance } = options.style;
  const position = positionTag(options);
  const box = boxOf(options);
  const boxStyles = box === "block" ? BOX_STYLE : box === "none" ? undefined : { ...GHOST_STYLE, [box]: LINE_STYLE[box] };
  const wrapDocument = wrapOf(options);
  const wrap = (text: string, line: Line): string => wrapDocument(text, appearance[line].fontSize);
  const out = [styledAssHeader(options)];
  for (const [sliceIndex, slice] of slices.entries()) {
    const name = assName(names?.[sliceIndex]);
    const times = `${assTime(slice.startMs)},${assTime(slice.endMs)}`;
    if (boxStyles !== undefined && box !== "none" && (box === "block" || slice[box] !== undefined)) {
      const background = eventText(slice, appearance.bilingualOrder, boxStyles, wrap);
      if (background !== undefined) {
        out.push(`Dialogue: 0,${times},${background.style},${name},0,0,0,,${position}${background.text}\n`);
      }
    }
    const text = eventText(slice, appearance.bilingualOrder, TEXT_STYLE, wrap);
    if (text !== undefined) {
      out.push(`Dialogue: 1,${times},${text.style},${name},0,0,0,,${position}${text.text}\n`);
    }
  }
  return out.join("");
}

/**
 * The speaker name of each slice: the common name of the cues active in it, empty when they
 * disagree (two speakers, or a speaker and an unassigned sentence, share the slice). Cues are
 * compared by speaker id, so two speakers who happen to share a name still count as two.
 * `slices` come from `sliceCues(cues)`, time-ordered and each covering a whole set of cues.
 */
function sliceSpeakerNames(
  cues: readonly TimedSubtitle[],
  slices: readonly TimedSubtitle[],
  speakers: StyledAssOptions["speakers"],
): (string | undefined)[] | undefined {
  if (speakers === undefined) return undefined;
  const byStart = cues.map((_, index) => index).sort((a, b) => (cues[a] as TimedSubtitle).startMs - (cues[b] as TimedSubtitle).startMs || a - b);
  const active = new Set<number>();
  let next = 0;
  return slices.map((slice) => {
    for (const index of [...active]) {
      if ((cues[index] as TimedSubtitle).endMs <= slice.startMs) active.delete(index);
    }
    while (next < byStart.length && (cues[byStart[next] as number] as TimedSubtitle).startMs <= slice.startMs) {
      const index = byStart[next] as number;
      if ((cues[index] as TimedSubtitle).endMs > slice.startMs) active.add(index);
      next += 1;
    }
    const ids = new Set([...active].map((index) => speakers.ofCue[index]));
    const only = ids.size === 1 ? [...ids][0] : undefined;
    return only === undefined ? undefined : speakers.names.get(only);
  });
}

/** One line of a labelled event: a speaker label heads the line that follows it and copies its look. */
type Row = { kind: Line; text: string } | { kind: "speaker"; text: string; heads: Line };

/** The lines of a slice, cue by cue: each cue's label (when shown) and then its lines in the user's order. */
function rowsOf(slice: SlicedUnitSubtitle, order: SubtitleStyle["appearance"]["bilingualOrder"]): Row[] {
  return slice.units.flatMap((unit) => {
    const lines = subtitleUnitLines(unit, order);
    const present: Row[] = lines.map(({ line, text }) => ({ kind: line, text }));
    const first = lines[0];
    return first === undefined || unit.speakerLabel === undefined ? present : [{ kind: "speaker", text: unit.speakerLabel, heads: first.line }, ...present];
  });
}

/** An event's text from its rows: the first in the event's own style, each next one switched to with `{\r<style>}`; text only through `assText`. */
function rowsText(rows: readonly Row[], styleOf: (row: Row) => string, wrap: (row: Row) => string): { style: string; text: string } | undefined {
  const first = rows[0];
  if (first === undefined) return undefined;
  return { style: styleOf(first), text: rows.map((row, index) => (index === 0 ? "" : `\\N{\\r${styleOf(row)}}`) + assText(wrap(row))).join("") };
}

/**
 * The styled document with speaker label lines: cues are sliced keeping each cue a unit of
 * its own, and every slice's events stack the units — label (when shown), then the cue's
 * lines. A label wears the look of the first line its own cue shows, so in a bilingual
 * document a cue without a translation labels in the original's look even when the
 * translation goes first. The background event lays out exactly the same rows as the text
 * event: in a block box every row is boxed (the label inside the box); in a one-line box a
 * label is boxed when the line it heads is and is only a placeholder otherwise. The `Name`
 * field follows the same rule as without labels.
 */
function labeledAssDocument(options: StyledAssOptions, labeled: ReturnType<typeof labelSubtitleCues>): string {
  const { appearance } = options.style;
  const slices = sliceSubtitleUnits(labeled);
  const position = positionTag(options);
  const box = boxOf(options);
  const textStyle = (row: Row): string => (row.kind === "speaker" ? SPEAKER_TEXT_STYLE[row.heads] : TEXT_STYLE[row.kind]);
  const backgroundStyle = (row: Row): string => {
    if (box === "block") return row.kind === "speaker" ? SPEAKER_BOX_STYLE[row.heads] : BOX_STYLE[row.kind];
    const boxed = (row.kind === "speaker" ? row.heads : row.kind) === box;
    if (row.kind === "speaker") return boxed ? SPEAKER_LINE_STYLE[row.heads] : SPEAKER_GHOST_STYLE[row.heads];
    return boxed ? LINE_STYLE[row.kind] : GHOST_STYLE[row.kind];
  };
  const sliceRows = slices.map((slice) => rowsOf(slice, appearance.bilingualOrder));
  // A row breaks at its own size: a label at the label size of the line it heads.
  const wrapDocument = wrapOf(options);
  const wrap = (row: Row): string =>
    wrapDocument(row.text, row.kind === "speaker" ? speakerLabelFontSize(appearance[row.heads].fontSize) : appearance[row.kind].fontSize);
  const speakers = new Set(sliceRows.flatMap((rows) => rows.flatMap((row) => (row.kind === "speaker" ? [row.heads] : []))));
  const out = [styledAssHeader(options, speakers)];
  slices.forEach((slice, index) => {
    const rows = sliceRows[index] as Row[];
    const name = assName(sliceName(slice, options.speakers));
    const times = `${assTime(slice.startMs)},${assTime(slice.endMs)}`;
    if (box === "block" || (box !== "none" && rows.some((row) => row.kind === box))) {
      const background = rowsText(rows, backgroundStyle, wrap);
      if (background !== undefined) {
        out.push(`Dialogue: 0,${times},${background.style},${name},0,0,0,,${position}${background.text}\n`);
      }
    }
    const text = rowsText(rows, textStyle, wrap);
    if (text !== undefined) {
      out.push(`Dialogue: 1,${times},${text.style},${name},0,0,0,,${position}${text.text}\n`);
    }
  });
  return out.join("");
}

/** The `Name` of a labelled slice, by the rule of `sliceSpeakerNames`: the one speaker of all its cues, else none. */
function sliceName(slice: SlicedUnitSubtitle, speakers: StyledAssOptions["speakers"]): string | undefined {
  if (speakers === undefined) return undefined;
  const ids = new Set(slice.units.map((unit) => speakers.ofCue[unit.cue]));
  const only = ids.size === 1 ? [...ids][0] : undefined;
  return only === undefined ? undefined : speakers.names.get(only);
}
