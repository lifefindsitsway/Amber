import type { SegmentId } from "../../shared/ids.ts";
import { amberError } from "./errors.ts";
import type { TranscriptRevision, TranscriptSegment } from "./transcript.ts";

export type TimedSubtitleFormat = "srt" | "vtt";

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ParsedSubtitle {
  format: TimedSubtitleFormat;
  /** In time order. */
  cues: SubtitleCue[];
  /** Cues whose end is not after their start. Invariant: every segment has valid timing, so these cannot become segments. */
  droppedCues: number;
}

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:[ \t].*)?$/;
const VTT_HEADER = /^WEBVTT(?:[ \t].*)?$/;
const VTT_METADATA_BLOCK = /^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/;
const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };

/** `invalid_request.subtitle_format`: the text is not a subtitle file of the format it claims or looks like. */
export function formatError(message: string): Error {
  return amberError("invalid_request", message, { code: "invalid_request.subtitle_format" });
}

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** A BCP-47 tag in canonical case (`zh-cn` → `zh-CN`); `undefined` when it is not one. */
export function canonicalLanguageTag(tag: string): string | undefined {
  if (!LANGUAGE_TAG.test(tag)) {
    return undefined;
  }
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/** Subtitle files are accepted as UTF-8 only; a leading BOM is dropped. */
export function decodeSubtitleText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw amberError("invalid_request", "subtitle is not valid UTF-8", { code: "invalid_request.subtitle_encoding" });
  }
}

function timestampMs(stamp: string): number {
  const [clock, fraction = "0"] = stamp.split(/[.,]/) as [string, string?];
  const parts = clock.split(":").map(Number);
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts];
  return ((hours as number) * 3600 + (minutes as number) * 60 + (seconds as number)) * 1000 + Number(fraction.padEnd(3, "0"));
}

/** Cue lines are display wrapping; Latin words get a space, CJK text joins directly. */
export function joinLines(lines: readonly string[]): string {
  return lines.reduce((joined, line) => {
    if (joined === "") {
      return line;
    }
    const needsSpace = /[A-Za-z0-9.,!?;:'")\]]$/.test(joined) && /^[A-Za-z0-9"'(\[]/.test(line);
    return `${joined}${needsSpace ? " " : ""}${line}`;
  }, "");
}

/** Character references a cue may carry, as text. */
export function unescapeCueEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * A cue line split into its text and its `<…>` tags (each without the brackets). A tag runs from
 * a `<` to the next `>`; once a `<` has no `>` after it, neither has any later one, so the rest
 * is text. One pass, linear in the line, unlike a backtracking tag pattern on a line of `<`s.
 */
export function scanCueTags(line: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  let text = "";
  let at = 0;
  for (;;) {
    const open = line.indexOf("<", at);
    const close = open < 0 ? -1 : line.indexOf(">", open + 1);
    if (close < 0) {
      text += line.slice(at);
      return { text, tags };
    }
    text += line.slice(at, open);
    tags.push(line.slice(open + 1, close));
    at = close + 1;
  }
}

/** One cue line as text: every `<…>` tag removed, character references resolved, trimmed. */
export function cleanCueLine(line: string): string {
  return unescapeCueEntities(scanCueTags(line).text).trim();
}

/** A cue's text lines after cleaning, empty ones left out. */
export function cueLines(lines: readonly string[]): string[] {
  return lines.map(cleanCueLine).filter((line) => line !== "");
}

function cueText(lines: readonly string[]): string {
  return joinLines(cueLines(lines));
}

/** One cue block of an SRT or WebVTT file as written, in file order, before any filtering. */
export interface ScannedCue {
  startMs: number;
  endMs: number;
  /** The timing line as written. */
  timing: string;
  /** The raw lines after the timing line. */
  lines: string[];
}

/**
 * Splits SRT or WebVTT into cue blocks in file order; the format is decided by content, never
 * by file name: a `WEBVTT` header means VTT, otherwise cue timing lines mean SRT; a text with
 * neither is `invalid_request.subtitle_format`. Nothing is filtered here.
 */
export function scanTimedSubtitle(text: string): { format: TimedSubtitleFormat; cues: ScannedCue[] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const format: TimedSubtitleFormat | undefined = VTT_HEADER.test(lines[0] ?? "")
    ? "vtt"
    : lines.some((line) => TIMING.test(line))
      ? "srt"
      : undefined;
  if (format === undefined) {
    throw formatError("no WEBVTT header and no cue timing lines");
  }
  const blocks: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === "") {
      if ((blocks.at(-1) as string[]).length > 0) {
        blocks.push([]);
      }
    } else {
      (blocks.at(-1) as string[]).push(line);
    }
  }
  const cues: ScannedCue[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.length === 0 || (format === "vtt" && (index === 0 || VTT_METADATA_BLOCK.test(block[0] as string)))) {
      continue;
    }
    const timingIndex = block.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) {
      continue;
    }
    const timing = block[timingIndex] as string;
    const match = TIMING.exec(timing) as RegExpExecArray;
    cues.push({ startMs: timestampMs(match[1] as string), endMs: timestampMs(match[2] as string), timing: timing.trim(), lines: block.slice(timingIndex + 1) });
  }
  return { format, cues };
}

/**
 * Parses SRT or WebVTT; the format is decided by content, never by file name: a `WEBVTT`
 * header means VTT, otherwise cue timing lines mean SRT. Cues with empty text are skipped;
 * cues whose end is not after their start are dropped and counted.
 */
export function parseTimedSubtitle(text: string): ParsedSubtitle {
  const { format, cues: scanned } = scanTimedSubtitle(text);
  const cues: SubtitleCue[] = [];
  let droppedCues = 0;
  for (const cue of scanned) {
    const body = cueText(cue.lines);
    if (!(cue.startMs < cue.endMs)) {
      droppedCues += 1;
      continue;
    }
    if (body !== "") {
      cues.push({ startMs: cue.startMs, endMs: cue.endMs, text: body });
    }
  }
  if (cues.length === 0) {
    throw formatError("no usable cues");
  }
  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { format, cues, droppedCues };
}

/** The `imported` revision a parsed subtitle becomes. */
export function importedTranscript(input: {
  revisionId: string;
  contentId: string;
  language: string;
  subtitle: ParsedSubtitle;
  /** ULID factory. Invariant: segment ids are globally unique ULIDs. */
  newId: () => string;
  createdAt: number;
}): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const { revisionId, subtitle } = input;
  const segments = subtitle.cues.map(
    (cue, ordinal): TranscriptSegment => ({
      id: input.newId() as SegmentId,
      revisionId,
      ordinal,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text,
      sourceSegmentIds: [],
    }),
  );
  return {
    revision: {
      id: revisionId,
      contentId: input.contentId,
      kind: "imported",
      language: input.language,
      timingFidelity: "segment_only",
      generation: { kind: "imported", format: subtitle.format },
      segmentCount: segments.length,
      createdAt: input.createdAt,
    },
    segments,
  };
}
