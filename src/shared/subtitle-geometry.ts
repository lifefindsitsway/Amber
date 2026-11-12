import { SUBTITLE_EDGE_ZONE_BP, SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES, SUBTITLE_SPEAKER_LABEL_SCALE, SUBTITLE_SPEAKER_MAX_PARTS, SUBTITLE_SPEAKER_REPEAT_MS } from "./defaults.ts";
import type { BurnMode } from "./enums.ts";
import { graphemesOf } from "./speakers.ts";
import { BASIS_POINTS, type SubtitleAppearance, type SubtitlePlacement, type SubtitleSpeakerMode } from "./subtitle-style.ts";

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/**
 * The picture inside a box under `object-fit: contain`: subtitles are laid out
 * on it, never on the letterbox bars. Without usable intrinsic dimensions (audio only, metadata
 * not loaded yet) the whole box is the picture.
 */
export function pictureRect(box: Size, intrinsic: Size | undefined): Rect {
  if (intrinsic === undefined || !(intrinsic.width > 0 && intrinsic.height > 0) || !(box.width > 0 && box.height > 0)) {
    return { x: 0, y: 0, width: Math.max(0, box.width), height: Math.max(0, box.height) };
  }
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  const width = intrinsic.width * scale;
  const height = intrinsic.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

function hexByte(value: number): string {
  return Math.round(value).toString(16).toUpperCase().padStart(2, "0");
}

/**
 * `#RRGGBB` plus opacity as an ASS colour `&HAABBGGRR`: blue-green-red order,
 * and ASS alpha runs the other way round — `00` opaque, `FF` fully transparent.
 */
export function assColor(hex: string, opacityPct = 100): string {
  const red = hex.slice(1, 3);
  const green = hex.slice(3, 5);
  const blue = hex.slice(5, 7);
  const opacity = Math.min(100, Math.max(0, opacityPct));
  return `&H${hexByte(((100 - opacity) * 255) / 100)}${blue}${green}${red}`.toUpperCase();
}

const clampBp = (value: number): number => Math.min(BASIS_POINTS, Math.max(0, Math.round(value)));

/** Where a block of `block` size lands for `placement`: its top-left corner, in picture pixels. */
export function blockOrigin(placement: SubtitlePlacement, block: Size, picture: Size): { left: number; top: number } {
  const x = (placement.xBp / BASIS_POINTS) * picture.width;
  const y = (placement.yBp / BASIS_POINTS) * picture.height;
  const top = placement.anchor === "top" ? y : placement.anchor === "center" ? y - block.height / 2 : y - block.height;
  return { left: x - block.width / 2, top };
}

/**
 * The placement of a block drawn at `rect` (picture pixels), anchored by its edges:
 * a bottom edge within `SUBTITLE_EDGE_ZONE_BP` of the picture's bottom anchors there,
 * likewise for the top; a block reaching both zones takes the side its centre is on; anything
 * else anchors at its centre. The value written back describes the very rectangle it came
 * from, so a drag never jumps when the anchor changes.
 */
export function placementFromBlock(rect: Rect, picture: Size): SubtitlePlacement {
  const toBp = (value: number, extent: number): number => (extent > 0 ? (value / extent) * BASIS_POINTS : 0);
  const top = toBp(rect.y, picture.height);
  const bottom = toBp(rect.y + rect.height, picture.height);
  const centre = toBp(rect.y + rect.height / 2, picture.height);
  const nearBottom = bottom > BASIS_POINTS - SUBTITLE_EDGE_ZONE_BP;
  const nearTop = top < SUBTITLE_EDGE_ZONE_BP;
  const anchor = nearBottom && nearTop ? (centre >= BASIS_POINTS / 2 ? "bottom" : "top") : nearBottom ? "bottom" : nearTop ? "top" : "center";
  const y = anchor === "bottom" ? bottom : anchor === "top" ? top : centre;
  return { version: 1, xBp: clampBp(toBp(rect.x + rect.width / 2, picture.width)), yBp: clampBp(y), anchor };
}

/** One subtitle event on screen: the original line, its translation, or both. */
export interface TimedSubtitle {
  startMs: number;
  endMs: number;
  original?: string;
  translation?: string;
}

/** What a subtitle cue is built from: a transcript sentence. */
export interface SubtitleSentence {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  sourceSegmentIds: readonly string[];
  /** Who says the sentence; only read when subtitles show speaker labels. */
  speakerId?: string;
}

/**
 * One subtitle on screen as a unit of its own: its lines and, when it is to be shown, the
 * label of who is speaking. Subtitles that overlap in time stay separate units, each with
 * its own speaker, instead of being joined line by line.
 */
export interface SubtitleUnit {
  original?: string;
  translation?: string;
  speakerLabel?: string;
}

/** A stretch of time and the units on screen during it, in sentence order. Used instead of `TimedSubtitle` slices when speaker labels are shown. */
export interface UnitSubtitle {
  startMs: number;
  endMs: number;
  units: SubtitleUnit[];
}

/**
 * The cues of one display mode, in sentence order. A bilingual cue pairs each original
 * sentence with the translated sentence whose single source it is (a translation maps
 * sentence to sentence); an original without a translation shows alone.
 */
export function subtitleCues(mode: BurnMode, original: readonly SubtitleSentence[], translation: readonly SubtitleSentence[]): TimedSubtitle[] {
  switch (mode) {
    case "original":
      return original.map((sentence) => ({ startMs: sentence.startMs, endMs: sentence.endMs, original: sentence.text }));
    case "translation":
      return translation.map((sentence) => ({ startMs: sentence.startMs, endMs: sentence.endMs, translation: sentence.text }));
    case "bilingual": {
      const byParent = new Map<string, string>();
      for (const sentence of translation) {
        const parent = sentence.sourceSegmentIds[0];
        if (parent !== undefined && !byParent.has(parent)) {
          byParent.set(parent, sentence.text);
        }
      }
      return original.map((sentence) => {
        const paired = byParent.get(sentence.id);
        return { startMs: sentence.startMs, endMs: sentence.endMs, original: sentence.text, ...(paired === undefined ? {} : { translation: paired }) };
      });
    }
  }
}

/** The drawn form of each cue's own line (see `subtitleGlyphText`), joined: a line is judged alone, never together with the cues it overlaps. */
function joined(parts: readonly (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined).map((part) => subtitleGlyphText(part));
  return present.length === 0 ? undefined : present.join("\n");
}

/**
 * Cuts overlapping cues into non-overlapping slices: every start and end
 * splits the timeline, and each slice shows all cues active then, in input order, original
 * lines joined and translation lines joined, each cue's line in its drawn form. Gaps stay
 * empty. Styled subtitles carry fixed positions, so overlapping events would be drawn over
 * each other instead of stacked.
 */
export function sliceCues(cues: readonly TimedSubtitle[]): TimedSubtitle[] {
  const points = [...new Set(cues.flatMap((cue) => [cue.startMs, cue.endMs]))].sort((a, b) => a - b);
  const byStart = cues.map((_, index) => index).sort((a, b) => (cues[a] as TimedSubtitle).startMs - (cues[b] as TimedSubtitle).startMs || a - b);
  const active = new Set<number>();
  const slices: Array<TimedSubtitle & { key: string }> = [];
  let next = 0;
  for (let position = 0; position + 1 < points.length; position += 1) {
    const from = points[position] as number;
    const to = points[position + 1] as number;
    for (const index of [...active]) {
      if ((cues[index] as TimedSubtitle).endMs <= from) active.delete(index);
    }
    while (next < byStart.length && (cues[byStart[next] as number] as TimedSubtitle).startMs <= from) {
      const index = byStart[next] as number;
      if ((cues[index] as TimedSubtitle).endMs > from) active.add(index);
      next += 1;
    }
    if (active.size === 0) continue;
    const members = [...active].sort((a, b) => a - b);
    const key = members.join(",");
    const previous = slices.at(-1);
    if (previous !== undefined && previous.key === key && previous.endMs === from) {
      previous.endMs = to;
      continue;
    }
    const shown = members.map((index) => cues[index] as TimedSubtitle);
    const original = joined(shown.map((cue) => cue.original));
    const translation = joined(shown.map((cue) => cue.translation));
    slices.push({ key, startMs: from, endMs: to, ...(original === undefined ? {} : { original }), ...(translation === undefined ? {} : { translation }) });
  }
  return slices.map(({ key: _key, ...slice }) => slice);
}

/** The slice shown at `ms` (`startMs <= ms < endMs`) in time-ordered, non-overlapping slices; -1 in a gap. */
export function sliceIndexAt(slices: ReadonlyArray<{ startMs: number; endMs: number }>, ms: number): number {
  let low = 0;
  let high = slices.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((slices[middle] as { startMs: number }).startMs <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 && ms < (slices[found] as { endMs: number }).endMs ? found : -1;
}

/**
 * A speaker label as subtitles draw it: at most `SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES`
 * grapheme clusters, a longer one cut there and ended with an ellipsis. The player and the
 * exported video both draw this one string, so a long name can never fit on one and wrap on
 * the other. Cutting a label already cut gives the same label back.
 */
export function subtitleSpeakerLabel(label: string): string {
  const clusters = graphemesOf(label);
  return clusters.length > SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES ? `${clusters.slice(0, SUBTITLE_SPEAKER_LABEL_MAX_GRAPHEMES).join("")}…` : label;
}

/** A unit's lines as they are drawn, in the user's bilingual order; an absent or empty line is not drawn. */
export function subtitleUnitLines(unit: Pick<SubtitleUnit, "original" | "translation">, order: SubtitleAppearance["bilingualOrder"]): Array<{ line: "original" | "translation"; text: string }> {
  const lines = order === "translation_first" ? (["translation", "original"] as const) : (["original", "translation"] as const);
  return lines.flatMap((line) => {
    const text = unit[line];
    return text === undefined || text === "" ? [] : [{ line, text }];
  });
}

/** Font size of a speaker label in 1080p picture pixels, whole so the overlay and the ASS style agree exactly. */
export function speakerLabelFontSize(fontSize: number): number {
  return Math.max(1, Math.round(fontSize * SUBTITLE_SPEAKER_LABEL_SCALE));
}

/** A cue with the speaker label it may carry, and whether the display rule shows it there. */
export interface LabeledCue extends TimedSubtitle {
  /** The label of the cue's speaker, already cut to length; absent for an unassigned sentence or a speaker without one. */
  label?: string;
  /** Whether the cue shows `label`: the mode's rule names it and it is not crowded. */
  labeled: boolean;
  /** Whether the cue ever shares the screen with more than `SUBTITLE_SPEAKER_MAX_PARTS` cues; such a cue never shows a label. */
  crowded: boolean;
}

/**
 * The speaker label of each cue, in sentence order, by the mode's rule: `every` shows it
 * on each cue that has one; `change` on the first cue of each turn (a run of cues with the
 * same speaker; an unassigned sentence ends a turn too) and again on the next cue once
 * more than `SUBTITLE_SPEAKER_REPEAT_MS` have passed since the turn's last shown label, so a
 * long monologue is named again. A crowded cue (see `LabeledCue.crowded`) never shows a
 * label; when the rule names one, the name is held for the next cue of the same turn that
 * is not crowded and shows from that cue's start, and the repeat time keeps running from the
 * last label actually shown. A turn crowded throughout is never named. The rule is static,
 * decided per cue before slicing: a cue's label line is there for its whole display or not
 * at all. `speakerIds[i]` is the speaker of `cues[i]`.
 */
export function labelSubtitleCues(
  cues: readonly TimedSubtitle[],
  speakerIds: readonly (string | undefined)[],
  labels: ReadonlyMap<string, string>,
  mode: SubtitleSpeakerMode,
): LabeledCue[] {
  const crowdedCues = new Set(cueSlices(cues).flatMap((slice) => (slice.members.length > SUBTITLE_SPEAKER_MAX_PARTS ? slice.members : [])));
  let started = false;
  let previous: string | undefined;
  let labeledAt = 0;
  // A name the rule gave to a crowded cue of the current turn, still owed.
  let held = false;
  return cues.map((cue, index) => {
    const speakerId = speakerIds[index];
    const newTurn = !started || speakerId !== previous;
    started = true;
    previous = speakerId;
    if (newTurn) held = false;
    const raw = speakerId === undefined ? undefined : labels.get(speakerId);
    const label = raw === undefined || raw === "" ? undefined : subtitleSpeakerLabel(raw);
    const crowded = crowdedCues.has(index);
    const due = label !== undefined && (mode === "every" || newTurn || held || cue.startMs - labeledAt > SUBTITLE_SPEAKER_REPEAT_MS);
    const labeled = due && !crowded;
    if (labeled) {
      labeledAt = cue.startMs;
      held = false;
    } else if (due) {
      held = true;
    }
    return { ...cue, ...(label === undefined ? {} : { label }), labeled, crowded };
  });
}

/** One cue in a slice of `sliceSubtitleUnits`. */
export interface SlicedSubtitleUnit extends SubtitleUnit {
  /** The cue's index in the sliced list: a cue spanning several slices keeps it, so a player can follow one cue across them. */
  cue: number;
  /**
   * The label the cue may show at all — absent when it has none or ever shares the screen
   * with more than `SUBTITLE_SPEAKER_MAX_PARTS` cues — whether or not the rule shows it;
   * `speakerLabel` is set only where the rule does. A player labels a cue the rule leaves
   * bare (the first one after a seek) from this.
   */
  label?: string;
}

export interface SlicedUnitSubtitle extends UnitSubtitle {
  units: SlicedSubtitleUnit[];
}

/** Non-overlapping stretches of the timeline with the indexes of the cues active in each, in input order; consecutive stretches with the same cues are one. */
function cueSlices(cues: readonly TimedSubtitle[]): Array<{ startMs: number; endMs: number; members: number[] }> {
  const points = [...new Set(cues.flatMap((cue) => [cue.startMs, cue.endMs]))].sort((a, b) => a - b);
  const byStart = cues.map((_, index) => index).sort((a, b) => (cues[a] as TimedSubtitle).startMs - (cues[b] as TimedSubtitle).startMs || a - b);
  const active = new Set<number>();
  const slices: Array<{ startMs: number; endMs: number; members: number[]; key: string }> = [];
  let next = 0;
  for (let position = 0; position + 1 < points.length; position += 1) {
    const from = points[position] as number;
    const to = points[position + 1] as number;
    for (const index of [...active]) {
      if ((cues[index] as TimedSubtitle).endMs <= from) active.delete(index);
    }
    while (next < byStart.length && (cues[byStart[next] as number] as TimedSubtitle).startMs <= from) {
      const index = byStart[next] as number;
      if ((cues[index] as TimedSubtitle).endMs > from) active.add(index);
      next += 1;
    }
    if (active.size === 0) continue;
    const members = [...active].sort((a, b) => a - b);
    const key = members.join(",");
    const last = slices.at(-1);
    if (last !== undefined && last.key === key && last.endMs === from) {
      last.endMs = to;
      continue;
    }
    slices.push({ key, startMs: from, endMs: to, members });
  }
  return slices.map(({ key: _key, ...slice }) => slice);
}

/**
 * Cuts cues into the same non-overlapping slices as `sliceCues`, but keeps every cue
 * active in a slice as a unit of its own — its lines in their drawn form and its speaker
 * label — instead of joining the lines of all of them, so each overlapping subtitle keeps
 * its speaker. A cue that ever shares the screen with more than
 * `SUBTITLE_SPEAKER_MAX_PARTS` cues carries no label in any slice: a crowded picture shows
 * text only, and a label never appears or vanishes while its cue is on screen.
 */
export function sliceSubtitleUnits(cues: readonly LabeledCue[]): SlicedUnitSubtitle[] {
  return cueSlices(cues).map((slice) => ({
    startMs: slice.startMs,
    endMs: slice.endMs,
    units: slice.members.map((index) => {
      const cue = cues[index] as LabeledCue;
      const label = cue.label === undefined || cue.crowded ? undefined : subtitleGlyphText(cue.label);
      return {
        cue: index,
        ...(cue.original === undefined ? {} : { original: subtitleGlyphText(cue.original) }),
        ...(cue.translation === undefined ? {} : { translation: subtitleGlyphText(cue.translation) }),
        ...(label === undefined ? {} : { label }),
        ...(label !== undefined && cue.labeled ? { speakerLabel: label } : {}),
      };
    }),
  }));
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿＀-￯]/u;
const LATIN_APOSTROPHE = /(?<=[\p{Script=Latin}\p{N}])’(?=[\p{Script=Latin}\p{N}])/gu;

/**
 * The text a subtitle is drawn with. The bundled subtitle font is CJK-first, so it
 * draws curly quotes at full em width with the glyph hugging the left side: "They’re"
 * reads as "They’ re". Latin text is therefore drawn with straight quotes. An apostrophe
 * between two Latin letters or digits is always straightened. In a line without any CJK
 * character (judged on `context`) every curly quote is straightened; in a line with CJK the
 * remaining quotes stay curly, so a pair such as “老秦” is never left half straight. The
 * stored text never changes: the player overlay and the ASS output both draw through this
 * one rule, so a preview and an export look the same. `context` is the whole line when
 * `text` is only a piece of it, such as one karaoke word.
 */
export function subtitleGlyphText(text: string, context: string = text): string {
  const apostrophes = text.replace(LATIN_APOSTROPHE, "'");
  if (CJK.test(context)) {
    return apostrophes;
  }
  return apostrophes.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}
