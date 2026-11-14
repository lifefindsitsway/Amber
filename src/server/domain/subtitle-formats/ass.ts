import { ASS_RESTORE_EFFECT, ASS_RESTORE_PROTOCOL, assDialogueDigest, parseSubtitlePackage, type SubtitlePackage } from "../subtitle-package.ts";
import { formatError } from "../subtitle-file.ts";
import type { DocumentCue } from "../subtitle-document.ts";
import { DroppedCues } from "./dropped.ts";
import { speakerKeyOf } from "./speaker-names.ts";

/**
 * ASS / SSA read into document cues. Fields are located by the `[Events]` `Format:` line;
 * override blocks are removed, with `{\r…}` style switches kept to tell lines apart. Files
 * written by Amber are recognized by their style names and read with their meaning: the
 * `Translation*` styles are translation lines, `Speaker*` rows name the speaker of the unit
 * that follows, background-box events (`Box*` / `Line*` / `Ghost*`) are layout only, and a
 * styled document's time slices are rebuilt into sentences. Any other ASS is all original
 * text, its `Name` field the speaker.
 */

export interface AssDocument {
  cues: DocumentCue[];
  dropped: DroppedCues;
  package?: SubtitlePackage;
  restoreDataMismatch?: boolean;
  rebuiltFromSlices?: boolean;
}

/** Fields of v4+ events when a file has no `Format:` line of its own. */
const DEFAULT_EVENT_FORMAT = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];

// Every style an Amber export writes: text, speaker-label and background-box families.
const AMBER_STYLE = /^(?:Default|Translation|Speaker(?:Translation)?|(?:Box|Line|Ghost)(?:Speaker)?(?:Translation)?)$/u;
// A styled export starts each text event with its position: `{\anN\pos(x,y)}`.
const POSITIONED = /^\{\\an\d\\pos\(/u;
const RESTORE_HEADER = new RegExp(`^${ASS_RESTORE_EFFECT} (\\d+) ([0-9a-f]{64})$`, "u");
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

type RowKind = "original" | "translation" | "label" | "background";

function rowKind(style: string): RowKind {
  if (/^(?:Box|Line|Ghost)/u.test(style)) return "background";
  if (style.startsWith("Speaker")) return "label";
  if (style.startsWith("Translation")) return "translation";
  return "original";
}

interface AssEvent {
  kind: "dialogue" | "comment";
  fields: Readonly<Record<string, string>>;
}

interface ScannedAss {
  events: AssEvent[];
  styles: string[];
  /** Every `Dialogue:` line in file order, as the restore-data digest covers them. */
  dialogueLines: string[];
}

function scanAss(text: string): ScannedAss {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  let section = "";
  let eventFormat: string[] | undefined;
  let styleFormat: string[] | undefined;
  const events: AssEvent[] = [];
  const styles: string[] = [];
  const dialogueLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("Dialogue:")) dialogueLines.push(line);
    const trimmed = line.trim();
    if (/^\[[^\]]*\]$/u.test(trimmed)) {
      section = trimmed.toLowerCase();
      continue;
    }
    const entry = /^([A-Za-z]+)\s*:\s?(.*)$/u.exec(line);
    if (entry === null) continue;
    const key = (entry[1] as string).toLowerCase();
    const value = entry[2] as string;
    if (section === "[events]") {
      if (key === "format") {
        eventFormat = value.split(",").map((field) => field.trim().toLowerCase());
      } else if (key === "dialogue" || key === "comment") {
        events.push({ kind: key, fields: splitFields(value, eventFormat ?? DEFAULT_EVENT_FORMAT) });
      }
    } else if (section === "[v4+ styles]" || section === "[v4 styles]") {
      if (key === "format") {
        styleFormat = value.split(",").map((field) => field.trim().toLowerCase());
      } else if (key === "style") {
        const name = splitFields(value, styleFormat ?? ["name"]).name;
        if (name !== undefined) styles.push(name.trim());
      }
    }
  }
  return { events, styles, dialogueLines };
}

/** Splits an event or style line by its format; the last field (Text) keeps any commas it contains. */
function splitFields(value: string, format: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let rest = value;
  format.forEach((name, index) => {
    if (index === format.length - 1) {
      fields[name] = rest;
      return;
    }
    const comma = rest.indexOf(",");
    fields[name] = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    rest = comma < 0 ? "" : rest.slice(comma + 1);
  });
  return fields;
}

/** `H:MM:SS.cc` in milliseconds; `undefined` when it is not a time. */
function assTimeMs(stamp: string | undefined): number | undefined {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/u.exec((stamp ?? "").trim());
  if (match === null) return undefined;
  const fraction = Math.round(Number(`0.${match[4] ?? "0"}`) * 1000);
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + fraction;
}

type Token = { kind: "text"; text: string } | { kind: "break" } | { kind: "style"; style: string | undefined };

/** The next position of `char` from `from`, or the end of the text when there is none. */
function positionOf(text: string, char: string, from: number): number {
  const at = text.indexOf(char, from);
  return at < 0 ? text.length : at;
}

/**
 * The text of an event as tokens: plain text, line breaks (`\N`, `\n`) and style switches
 * (`{\r}` back to the event's style, `{\rName}`). `\h` is a space; every other override is
 * dropped, and so is the drawing between `\p1` and `\p0`. A `{` without its `}` is text.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let buffer = "";
  let drawing = false;
  const flush = (): void => {
    if (buffer !== "" && !drawing) tokens.push({ kind: "text", text: buffer });
    buffer = "";
  };
  // Text runs up to the next `{` or `\`, found once each and searched again only after they are
  // passed, so a long line costs one pass. Once no `}` follows, every later `{` is text too.
  let unclosed = false;
  let nextBrace = -1;
  let nextSlash = -1;
  let index = 0;
  while (index < text.length) {
    // A missing one is remembered as the end of the text, so it is never searched for again.
    if (!unclosed && nextBrace < index) nextBrace = positionOf(text, "{", index);
    if (nextSlash < index) nextSlash = positionOf(text, "\\", index);
    const brace = unclosed ? text.length : nextBrace;
    const slash = nextSlash;
    const stop = Math.min(brace, slash);
    if (stop > index) {
      buffer += text.slice(index, stop);
      index = stop;
      continue;
    }
    if (index === brace) {
      const close = text.indexOf("}", index);
      if (close < 0) {
        unclosed = true;
        continue;
      }
      flush();
      const block = text.slice(index + 1, close);
      const switches = [...block.matchAll(/\\r([^\\]*)/gu)];
      const last = switches.at(-1);
      if (last !== undefined) {
        const name = (last[1] as string).trim();
        tokens.push({ kind: "style", style: name === "" ? undefined : name });
      }
      const draw = [...block.matchAll(/\\p(\d+)/gu)].at(-1);
      if (draw !== undefined) drawing = Number(draw[1]) > 0;
      index = close + 1;
      continue;
    }
    // At a backslash.
    const command = text[index + 1];
    if (command === "N" || command === "n") {
      flush();
      if (!drawing) tokens.push({ kind: "break" });
      index += 2;
    } else if (command === "h") {
      buffer += " ";
      index += 2;
    } else {
      buffer += "\\";
      index += 1;
    }
  }
  flush();
  return tokens;
}

function trimmedLines(parts: readonly string[]): string[] {
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The lines of an event, style switches ignored: how a renderer would show any ASS. */
function plainLines(tokens: readonly Token[]): string[] {
  const parts = [""];
  for (const token of tokens) {
    if (token.kind === "text") parts[parts.length - 1] += token.text;
    else if (token.kind === "break") parts.push("");
  }
  return trimmedLines(parts);
}

interface Row {
  kind: RowKind;
  lines: string[];
}

/** The rows of an Amber event: each style switch starts a row, whose kind its style gives. */
function rowsOf(tokens: readonly Token[], eventStyle: string): Row[] {
  const raw: Array<{ style: string; parts: string[] }> = [{ style: eventStyle, parts: [""] }];
  for (const token of tokens) {
    const current = raw.at(-1) as { style: string; parts: string[] };
    if (token.kind === "text") current.parts[current.parts.length - 1] += token.text;
    else if (token.kind === "break") current.parts.push("");
    else raw.push({ style: token.style ?? eventStyle, parts: [""] });
  }
  return raw.map((row) => ({ kind: rowKind(row.style), lines: trimmedLines(row.parts) })).filter((row) => row.lines.length > 0);
}

/** One subtitle within a time slice of a styled export: its label, original and translation lines. */
interface Unit {
  label?: string;
  original: string[];
  translation: string[];
}

type TextKind = "original" | "translation";

/**
 * The units of a styled event. A label row opens a unit; within one, the lines follow the
 * document's bilingual order, so a row of a kind the unit already has, or out of that order,
 * opens the next unit.
 */
function unitsOf(rows: readonly Row[], order: readonly [TextKind, TextKind]): Unit[] {
  const units: Unit[] = [];
  let current: (Unit & { last?: TextKind }) | undefined;
  for (const row of rows) {
    if (row.kind === "background") continue;
    if (row.kind === "label") {
      current = { label: row.lines.join(" "), original: [], translation: [] };
      units.push(current);
      continue;
    }
    const kind = row.kind;
    const fits = current !== undefined && (current.last === undefined || (current.last === order[0] && kind === order[1]));
    if (!fits || current === undefined) {
      current = { original: [], translation: [] };
      units.push(current);
    }
    for (const line of row.lines) current[kind].push(line);
    current.last = kind;
  }
  return units.map(({ label, original, translation }) => ({ ...(label === undefined ? {} : { label }), original, translation }));
}

/**
 * Whether `part` equals `lines[at…at + part.length)`; every line compared is charged to the
 * budget, so a crafted near-match costs what it actually takes.
 */
function matchesAt(lines: readonly string[], at: number, part: readonly string[], budget: PeelBudget): boolean {
  for (let offset = 0; offset < part.length; offset += 1) {
    budget.left -= 1;
    if (lines[at + offset] !== part[offset]) return false;
  }
  return true;
}

/**
 * Bounds on splitting joined subtitles apart. An export joins only the few subtitles on screen
 * at once, so a run longer than `PEEL_LINES_MAX` lines is not something it wrote and stays one
 * sentence. `PEEL_WORK_MAX` is what one document may spend in all: each neighbour tried and line
 * compared costs one, each subtitle taken off `PEEL_COST`, so a crafted file can neither make
 * the work quadratic nor multiply a few bytes into countless sentences. Past the budget, runs
 * are left whole (read as plain text) instead of the import hanging or failing.
 */
const PEEL_LINES_MAX = 256;
const PEEL_WORK_MAX = 300_000;
const PEEL_COST = 10;

interface PeelBudget {
  left: number;
}

/**
 * Splits a unit that joins several overlapping subtitles (a styled export without speaker
 * rows writes them as one run of lines) by the subtitles the neighbouring slices show: a
 * neighbour's unit whose lines open or close this one's is taken off as a subtitle of its own,
 * repeatedly, until none fits. Cursors narrow the unit in place, so nothing is copied per step.
 */
function peel(unit: Unit, neighbours: readonly Unit[], budget: PeelBudget): Unit[] {
  let originalStart = 0;
  let originalEnd = unit.original.length;
  let translationStart = 0;
  let translationEnd = unit.translation.length;
  const heads: Unit[] = [];
  const tails: Unit[] = [];
  let progress = originalEnd + translationEnd <= PEEL_LINES_MAX;
  while (progress && budget.left > 0) {
    progress = false;
    for (const other of neighbours) {
      budget.left -= 1;
      if (budget.left <= 0) break;
      const originalSize = other.original.length;
      const translationSize = other.translation.length;
      const size = originalSize + translationSize;
      const originalLeft = originalEnd - originalStart;
      const translationLeft = translationEnd - translationStart;
      if (other.label !== unit.label || size === 0 || size >= originalLeft + translationLeft || originalSize > originalLeft || translationSize > translationLeft) continue;
      if (matchesAt(unit.original, originalStart, other.original, budget) && matchesAt(unit.translation, translationStart, other.translation, budget)) {
        heads.push(other);
        originalStart += originalSize;
        translationStart += translationSize;
        budget.left -= PEEL_COST;
        progress = true;
        break;
      }
      if (
        matchesAt(unit.original, originalEnd - originalSize, other.original, budget) &&
        matchesAt(unit.translation, translationEnd - translationSize, other.translation, budget)
      ) {
        tails.push(other);
        originalEnd -= originalSize;
        translationEnd -= translationSize;
        budget.left -= PEEL_COST;
        progress = true;
        break;
      }
    }
  }
  if (heads.length === 0 && tails.length === 0) return [unit];
  const rest: Unit = {
    ...(unit.label === undefined ? {} : { label: unit.label }),
    original: unit.original.slice(originalStart, originalEnd),
    translation: unit.translation.slice(translationStart, translationEnd),
  };
  heads.push(rest);
  for (let index = tails.length - 1; index >= 0; index -= 1) heads.push(tails[index] as Unit);
  return heads;
}

// Scripts written without spaces and full-width forms: the export breaks lines around them without a space.
const WIDE =
  /[\u2E80-\u303F\u3040-\u30FF\u3100-\u31FF\u3200-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{3FFFF}]/u;
const LETTER = /\p{L}/u;

/**
 * Lines one style run was broken into by an export, joined back the way they were broken:
 * directly around CJK characters and after a hyphen between letters, with a space elsewhere
 * (the export drops the space it breaks at).
 */
export function unwrapLines(lines: readonly string[]): string {
  const parts: string[] = [];
  // The last two characters joined so far: enough to decide each break.
  let beforeLast = "";
  let last: string | undefined;
  for (const line of lines) {
    if (line === "") continue;
    const head = String.fromCodePoint(line.codePointAt(0) as number);
    if (last !== undefined && !WIDE.test(last) && !WIDE.test(head) && !(last === "-" && LETTER.test(beforeLast) && LETTER.test(head))) {
      parts.push(" ");
    }
    parts.push(line);
    const end = Array.from(line.length > 4 ? line.slice(-4) : line);
    beforeLast = end.length >= 2 ? (end.at(-2) as string) : (last ?? "");
    last = end.at(-1) as string;
  }
  return parts.join("");
}

/** A slice of a styled export: a text event with its time, `Name` and units. */
interface Slice {
  startMs: number;
  endMs: number;
  name?: string;
  units: Unit[];
}

interface RebuiltCue {
  startMs: number;
  endMs: number;
  unit: Unit;
  name?: string;
}

/**
 * Sentences rebuilt from the time slices of a styled export: every subtitle present in
 * consecutive slices that touch in time is one sentence spanning its whole presence. Two
 * identical subtitles back to back cannot be told apart and become one.
 */
function rebuildSlices(slices: readonly Slice[], splitRuns: boolean): RebuiltCue[] {
  const resolved: Unit[][] = [];
  const budget: PeelBudget = { left: PEEL_WORK_MAX };
  slices.forEach((slice, index) => {
    if (!splitRuns) {
      resolved.push(slice.units);
      return;
    }
    const previous = slices[index - 1];
    const next = slices[index + 1];
    const neighbours: Unit[] = [];
    if (previous !== undefined && previous.endMs === slice.startMs) for (const unit of resolved[index - 1] as Unit[]) neighbours.push(unit);
    if (next !== undefined && next.startMs === slice.endMs) for (const unit of next.units) neighbours.push(unit);
    resolved.push(slice.units.flatMap((unit) => peel(unit, neighbours, budget)));
  });
  const cues: RebuiltCue[] = [];
  // The sentences still on screen at the end of the previous slice, by unit, in creation order;
  // `taken` counts those already continued by a unit of the current slice.
  let open = new Map<string, { cues: RebuiltCue[]; taken: number }>();
  slices.forEach((slice, index) => {
    const touches = index > 0 && (slices[index - 1] as Slice).endMs === slice.startMs;
    const next = new Map<string, { cues: RebuiltCue[]; taken: number }>();
    for (const unit of resolved[index] as Unit[]) {
      const key = unitKey(unit);
      const pool = touches ? open.get(key) : undefined;
      let cue = pool !== undefined && pool.taken < pool.cues.length ? pool.cues[pool.taken] : undefined;
      if (cue !== undefined && pool !== undefined) {
        pool.taken += 1;
        cue.endMs = slice.endMs;
        if (cue.name === undefined && slice.name !== undefined) cue.name = slice.name;
      } else {
        cue = { startMs: slice.startMs, endMs: slice.endMs, unit, ...(slice.name === undefined ? {} : { name: slice.name }) };
        cues.push(cue);
      }
      const continued = next.get(key);
      if (continued === undefined) next.set(key, { cues: [cue], taken: 0 });
      else continued.cues.push(cue);
    }
    open = next;
  });
  return cues;
}

/** A unit's identity: two slices show the same subtitle when label and lines are all equal. */
function unitKey(unit: Unit): string {
  return JSON.stringify([unit.label ?? null, unit.original, unit.translation]);
}

/** What names a dropped event in a preview: its text, or its times when it has none. */
function eventSample(event: AssEvent, lines: readonly string[]): string {
  return lines.length > 0 ? lines.join(" ") : `${(event.fields.start ?? "").trim()} --> ${(event.fields.end ?? "").trim()}`;
}

/**
 * The package carried by the restore data, when its protocol is this build's and its digest
 * matches the file's dialogue; `"mismatch"` when restore data is there but unusable.
 */
function restoredPackage(scanned: ScannedAss): SubtitlePackage | "mismatch" | undefined {
  const comments = scanned.events.filter((event) => event.kind === "comment" && (event.fields.effect ?? "").trim() === ASS_RESTORE_EFFECT);
  const head = comments[0];
  if (head === undefined) return undefined;
  const header = RESTORE_HEADER.exec((head.fields.text ?? "").trim());
  if (header === null || Number(header[1]) !== ASS_RESTORE_PROTOCOL || header[2] !== assDialogueDigest(scanned.dialogueLines)) {
    return "mismatch";
  }
  const base64 = comments
    .slice(1)
    .map((event) => (event.fields.text ?? "").trim())
    .join("");
  if (base64 === "" || !BASE64.test(base64)) return "mismatch";
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"));
    return parseSubtitlePackage(json);
  } catch {
    // Matching dialogue with a broken or unreadable package: the dialogue is still a subtitle.
    return "mismatch";
  }
}

/** Reads an ASS / SSA file; one without any usable dialogue is `invalid_request.subtitle_format`. */
export function readAssDocument(text: string): AssDocument {
  const scanned = scanAss(text);
  const restored = restoredPackage(scanned);
  const amber = scanned.styles.includes("Default") && scanned.styles.includes("Translation") && scanned.styles.every((style) => AMBER_STYLE.test(style));
  const dialogue = scanned.events.filter((event) => event.kind === "dialogue");
  const styled = amber && dialogue.some((event) => POSITIONED.test(event.fields.text ?? ""));
  const dropped = new DroppedCues();
  const cues: DocumentCue[] = [];

  const timed = dialogue.flatMap((event) => {
    const style = (event.fields.style ?? "").trim().replace(/^\*/u, "");
    if (amber && rowKind(style) === "background") return [];
    const tokens = tokenize(event.fields.text ?? "");
    const startMs = assTimeMs(event.fields.start);
    const endMs = assTimeMs(event.fields.end);
    const plain = plainLines(tokens);
    if (startMs === undefined || endMs === undefined || !(startMs < endMs) || plain.length === 0) {
      dropped.add(eventSample(event, plain));
      return [];
    }
    const name = speakerKeyOf(event.fields.name ?? "");
    return [{ startMs, endMs, tokens, plain, style, ...(name === undefined ? {} : { name }) }];
  });

  if (!amber) {
    for (const event of timed) {
      cues.push({ index: cues.length, startMs: event.startMs, endMs: event.endMs, lines: event.plain, ...(event.name === undefined ? {} : { voice: event.name }) });
    }
  } else if (!styled) {
    for (const event of timed) {
      const rows = rowsOf(event.tokens, event.style);
      const original = rows.flatMap((row) => (row.kind === "original" ? row.lines : []));
      const translation = rows.flatMap((row) => (row.kind === "translation" ? row.lines : []));
      const label = rows.find((row) => row.kind === "label");
      const voice = event.name ?? (label === undefined ? undefined : speakerKeyOf(label.lines.join(" ")));
      cues.push(documentCue(cues.length, event.startMs, event.endMs, original, translation, voice));
    }
  } else {
    const eventRows = timed.map((event) => rowsOf(event.tokens, event.style));
    // The bilingual order shows in events holding one subtitle with both lines.
    let translationFirst = 0;
    let originalFirst = 0;
    for (const rows of eventRows) {
      const text = rows.filter((row) => row.kind === "original" || row.kind === "translation");
      if (text.length === 2 && text[0]?.kind !== text[1]?.kind) {
        if (text[0]?.kind === "translation") translationFirst += 1;
        else originalFirst += 1;
      }
    }
    const order: [TextKind, TextKind] = translationFirst > originalFirst ? ["translation", "original"] : ["original", "translation"];
    // A document with speaker rows writes every subtitle of a slice as rows of its own; one
    // without joins overlapping subtitles into one run of lines, to be split by their neighbours.
    const rowPerUnit = eventRows.some((rows) => rows.some((row, index) => row.kind === "label" || (index > 0 && rows[index - 1]?.kind === row.kind)));
    const slices: Slice[] = timed.map((event, index) => ({
      startMs: event.startMs,
      endMs: event.endMs,
      ...(event.name === undefined ? {} : { name: event.name }),
      units: unitsOf(eventRows[index] as Row[], order),
    }));
    const rebuilt = rebuildSlices(slices, !rowPerUnit);
    const anyOriginal = rebuilt.some((cue) => cue.unit.original.length > 0);
    for (const cue of rebuilt) {
      const voice = cue.name ?? (cue.unit.label === undefined ? undefined : speakerKeyOf(cue.unit.label));
      // A document of translation lines only (a translation shown alone) is read as its text.
      const original = anyOriginal ? cue.unit.original : cue.unit.translation;
      const translation = anyOriginal ? cue.unit.translation : [];
      if (original.length === 0) {
        dropped.add(translation.join(" "));
        continue;
      }
      cues.push(documentCue(cues.length, cue.startMs, cue.endMs, [unwrapLines(original)], translation.length > 0 ? [unwrapLines(translation)] : [], voice));
    }
  }

  if (cues.length === 0 && (restored === undefined || restored === "mismatch")) {
    throw formatError("no usable dialogue");
  }
  return {
    cues,
    dropped,
    ...(restored !== undefined && restored !== "mismatch" ? { package: restored } : {}),
    ...(restored === "mismatch" ? { restoreDataMismatch: true } : {}),
    ...(styled && (restored === undefined || restored === "mismatch") ? { rebuiltFromSlices: true } : {}),
  };
}

function documentCue(index: number, startMs: number, endMs: number, original: string[], translation: string[], voice: string | undefined): DocumentCue {
  // A cue with a translation line but no original keeps its text as the original.
  const lines = original.length > 0 ? original : translation;
  const translationLines = original.length > 0 ? translation : [];
  return {
    index,
    startMs,
    endMs,
    lines,
    ...(translationLines.length > 0 ? { translationLines } : {}),
    ...(voice === undefined ? {} : { voice }),
  };
}
