import { SUBTITLE_BILINGUAL_LINE_RATIO, SUBTITLE_SPEAKER_PREFIX_MIN } from "../../shared/defaults.ts";
import type { SubtitleImportLimit, SubtitleImportOptions, SubtitleInspectResponse, TimedSubtitleFormat } from "../../shared/dto/subtitle-import.ts";
import { amberError } from "./errors.ts";
import { readAssDocument } from "./subtitle-formats/ass.ts";
import { defaultLabelOrdinal, defaultSpeakerLabel, linePrefix } from "./subtitle-formats/speaker-names.ts";
import { readTimedDocument } from "./subtitle-formats/timed.ts";
import { canonicalLanguageTag, formatError, joinLines } from "./subtitle-file.ts";
import { parseSubtitlePackage, SUBTITLE_PACKAGE_EXTENSION, SUBTITLE_PACKAGE_FORMAT, type SubtitlePackage } from "./subtitle-package.ts";
import { normalizeTargetLanguages } from "./translation.ts";

/**
 * One kept cue of an imported subtitle file, in file order. Markup is already removed from
 * every line; what each line means (speaker prefix, translation) is decided by planning.
 */
export interface DocumentCue {
  /** Position among the kept cues in file order, from 0; stable across preview and import. */
  index: number;
  startMs: number;
  endMs: number;
  /** The cue's original-language lines, in order. */
  lines: string[];
  /** Second-language lines the file marks as such (an ASS translation style). */
  translationLines?: string[];
  /**
   * The speaker the file itself names (a VTT voice, an ASS `Name` field or speaker label line):
   * absent = none named, `null` = several different ones (the cue stays unassigned).
   */
  voice?: string | null;
}

/** A subtitle file read into the shape every timed format shares. */
export interface SubtitleDocument {
  format: TimedSubtitleFormat;
  cues: DocumentCue[];
  /** Cues without text or with invalid timing, with up to a few of their texts as samples. */
  dropped: { count: number; samples: string[] };
  /** The package itself, or the restore data of a styled ASS whose digest matched. */
  package?: SubtitlePackage;
  /** A styled ASS carried restore data that no longer matches its dialogue; it was read as a plain ASS. */
  restoreDataMismatch?: boolean;
  /** A styled ASS written by Amber was read without restore data: overlapping time slices were rebuilt into sentences. */
  rebuiltFromSlices?: boolean;
}

/** A speaker an import would register, keyed as the preview's candidates are. */
export interface PlannedSpeaker {
  key: string;
  /** Normalized name; absent = unnamed. */
  name?: string;
  /** The ordinal the file asks for (a package ordinal, or N of an unnamed "Speaker N" label). */
  ordinal?: number;
  /** When `ordinal` is taken, register under this name instead (the label as written in the file). */
  fallbackName?: string;
  colorIndex?: number;
}

/** Everything an import writes, decided from the file and the user's choices; ids are assigned by the writer. */
export interface SubtitleImportPlan {
  format: TimedSubtitleFormat;
  /** Canonical BCP-47 language of the original. */
  language: string;
  paragraphMarks: boolean;
  /** In the order they first appear (package order for a package). */
  speakers: PlannedSpeaker[];
  /** In final sentence order (time order, or package order for a package). */
  segments: Array<{ startMs: number; endMs: number; text: string; speakerKey: string | null; paragraphStart?: boolean }>;
  /** Each translation names its sentences by index into `segments`; at most one line per sentence. */
  translations: Array<{ language: string; lines: Array<{ segmentIndex: number; text: string }> }>;
  droppedCues: number;
}

/** What a preview reports about the file alone; the service adds the digest and the target Content. */
export type SubtitleDocumentInspection = Omit<SubtitleInspectResponse, "digest" | "target">;


const EXTENSION_FORMATS: Readonly<Record<string, TimedSubtitleFormat>> = {
  srt: "srt",
  vtt: "vtt",
  ass: "ass",
  ssa: "ass",
  [SUBTITLE_PACKAGE_EXTENSION]: "ambersub",
};

function extensionFormat(filename: string | undefined): TimedSubtitleFormat | undefined {
  const match = /\.([A-Za-z0-9]+)$/u.exec(filename ?? "");
  return match === null ? undefined : EXTENSION_FORMATS[(match[1] as string).toLowerCase()];
}

/** What the content looks like: a package's JSON, an ASS script, or else SRT / WebVTT by their own rules. */
function sniffFormat(text: string): TimedSubtitleFormat {
  const start = text.trimStart();
  if (start.startsWith("{")) {
    try {
      const raw: unknown = JSON.parse(start);
      if (typeof raw === "object" && raw !== null && (raw as { format?: unknown }).format === SUBTITLE_PACKAGE_FORMAT) {
        return "ambersub";
      }
    } catch {
      // Not JSON: SRT and WebVTT decide below.
    }
  }
  if (/^\[Script Info\]/iu.test(start) || /^\[Events\][ \t]*$/imu.test(text)) {
    return "ass";
  }
  return "srt";
}

/** The cues of a package, one per sentence in package order, so counts and ranges read the same as for any file. */
function packageCues(pkg: SubtitlePackage): DocumentCue[] {
  return pkg.original.segments.map((segment, index) => ({
    index,
    startMs: segment.startMs,
    endMs: segment.endMs,
    lines: [segment.text],
    ...(segment.speaker === null ? {} : { voice: segment.speaker }),
  }));
}

/**
 * Reads a timed subtitle file: the format is the hint if given, else the file extension
 * (`srt`, `vtt`, `ass` / `ssa`, `ambersub`), else what the content looks like. A file that
 * is none of them is `invalid_request.subtitle_format`.
 */
export function readSubtitleDocument(text: string, hint: { format?: TimedSubtitleFormat; filename?: string }): SubtitleDocument {
  const body = text.replace(/^\uFEFF/u, "");
  const format = hint.format ?? extensionFormat(hint.filename) ?? sniffFormat(body);
  if (format === "ambersub") {
    const pkg = parseSubtitlePackage(body);
    return { format, cues: packageCues(pkg), dropped: { count: 0, samples: [] }, package: pkg };
  }
  if (format === "ass") {
    const read = readAssDocument(body);
    const { package: pkg, restoreDataMismatch, rebuiltFromSlices } = read;
    return {
      format,
      // Verified restore data is the file's content: preview counts read the package an import writes.
      cues: pkg === undefined ? read.cues : packageCues(pkg),
      dropped: pkg === undefined ? read.dropped.toJSON() : { count: 0, samples: [] },
      ...(pkg === undefined ? {} : { package: pkg }),
      ...(restoreDataMismatch === true ? { restoreDataMismatch } : {}),
      ...(rebuiltFromSlices === true ? { rebuiltFromSlices } : {}),
    };
  }
  // SRT and WebVTT tell themselves apart by content, as the plain import always has; only an
  // explicit hint that disagrees is refused.
  const read = readTimedDocument(body);
  if (hint.format !== undefined && hint.format !== read.format) {
    throw formatError("subtitle content does not match its declared format");
  }
  if (read.cues.length === 0) {
    throw formatError("no usable cues");
  }
  return { format: read.format, cues: read.cues, dropped: read.dropped.toJSON() };
}

/** Speaker keys of a package's sentences in order, only for speakers some sentence names. */
function packageSpeakers(pkg: SubtitlePackage): SubtitlePackage["original"]["speakers"] {
  const used = new Set(pkg.original.segments.flatMap((segment) => (segment.speaker === null ? [] : [segment.speaker])));
  return pkg.original.speakers.filter((speaker) => used.has(speaker.key));
}

/** Runs `[candidateIndex, length]` of consecutive equal labels, `-1` for none. */
function runsOf(labels: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const label of labels) {
    const last = runs.at(-1);
    if (last !== undefined && last[0] === label) last[1] += 1;
    else runs.push([label, 1]);
  }
  return runs;
}

type Candidate = SubtitleDocumentInspection["speakers"]["candidates"][number];

/** Candidates in first-appearance order with their counts, and each cue's candidate index. */
function tally(keys: readonly (string | undefined)[], describe: (key: string, count: number) => Omit<Candidate, "key" | "count">): {
  candidates: Candidate[];
  sequence: Array<[number, number]>;
} {
  const order = new Map<string, number>();
  const counts: number[] = [];
  const labels = keys.map((key) => {
    if (key === undefined) return -1;
    let index = order.get(key);
    if (index === undefined) {
      index = order.size;
      order.set(key, index);
      counts.push(0);
    }
    counts[index] = (counts[index] as number) + 1;
    return index;
  });
  const candidates = [...order.keys()].map((key, index) => ({ key, count: counts[index] as number, ...describe(key, counts[index] as number) }));
  return { candidates, sequence: runsOf(labels) };
}

function speakersOf(document: SubtitleDocument): SubtitleDocumentInspection["speakers"] {
  const pkg = document.package;
  if (pkg !== undefined) {
    const speakers = packageSpeakers(pkg);
    const index = new Map(speakers.map((speaker, position) => [speaker.key, position]));
    const counts = speakers.map((speaker) => pkg.original.segments.filter((segment) => segment.speaker === speaker.key).length);
    return {
      source: "package",
      candidates: speakers.map((speaker, position) => ({
        key: speaker.key,
        label: speaker.name ?? defaultSpeakerLabel(speaker.ordinal),
        count: counts[position] as number,
        preselected: true,
      })),
      sequence: runsOf(pkg.original.segments.map((segment) => (segment.speaker === null ? -1 : (index.get(segment.speaker) as number)))),
    };
  }
  if (document.cues.some((cue) => cue.voice !== undefined)) {
    return { source: "explicit", ...tally(document.cues.map((cue) => cue.voice ?? undefined), (key) => ({ label: key, preselected: true })) };
  }
  if (document.format === "srt") {
    const keys = document.cues.map((cue) => linePrefix(cue.lines[0] ?? "")?.key);
    if (keys.some((key) => key !== undefined)) {
      return { source: "prefix", ...tally(keys, (key, count) => ({ label: key, preselected: count >= SUBTITLE_SPEAKER_PREFIX_MIN })) };
    }
  }
  return { source: "none", candidates: [], sequence: document.cues.length === 0 ? [] : [[-1, document.cues.length]] };
}

/** How many sample pairs a bilingual suggestion shows. */
const BILINGUAL_SAMPLES = 2;

function bilingualOf(document: SubtitleDocument): SubtitleDocumentInspection["bilingual"] {
  const pkg = document.package;
  if (pkg !== undefined) {
    const first = pkg.translations[0];
    if (first === undefined) return undefined;
    const texts = new Map(pkg.original.segments.map((segment) => [segment.key, segment.text]));
    const translated = new Set(pkg.translations.flatMap((translation) => translation.segments.map((line) => line.sourceSegmentKey)));
    return {
      source: "package",
      count: translated.size,
      samples: first.segments.slice(0, BILINGUAL_SAMPLES).map((line) => ({ original: texts.get(line.sourceSegmentKey) as string, translation: line.text })),
      languages: pkg.translations.map((translation) => translation.language),
    };
  }
  if (document.format === "ass") {
    const paired = document.cues.filter((cue) => (cue.translationLines ?? []).length > 0);
    if (paired.length === 0) return undefined;
    return {
      source: "style",
      count: paired.length,
      samples: paired.slice(0, BILINGUAL_SAMPLES).map((cue) => ({ original: joinLines(cue.lines), translation: joinLines(cue.translationLines ?? []) })),
    };
  }
  if (document.format === "srt") {
    const paired = document.cues.filter((cue) => cue.lines.length === 2);
    if (document.cues.length === 0 || paired.length / document.cues.length < SUBTITLE_BILINGUAL_LINE_RATIO) return undefined;
    return {
      source: "lines",
      count: paired.length,
      samples: paired.slice(0, BILINGUAL_SAMPLES).map((cue) => ({ original: cue.lines[0] as string, translation: cue.lines[1] as string })),
    };
  }
  return undefined;
}

function limitsOf(document: SubtitleDocument, speakers: SubtitleDocumentInspection["speakers"]): SubtitleImportLimit[] {
  if (document.package !== undefined) return ["package_scope"];
  const named = speakers.candidates.length > 0;
  const limits: SubtitleImportLimit[] = [];
  if (named) limits.push("speaker_identity");
  if (speakers.source === "prefix") limits.push("unlabeled_inferred");
  if (document.format === "vtt" && document.cues.some((cue) => cue.voice === null)) limits.push("multi_voice");
  limits.push("markup_removed");
  if (document.format === "ass") {
    limits.push("centisecond_timing", "glyphs_changed");
    if (document.rebuiltFromSlices === true) limits.push("overlap_slices");
    if (document.restoreDataMismatch === true) limits.push("restore_data_mismatch");
  }
  return limits;
}

/** First start and last end over cues; a loop, since a long file has more cues than a call takes arguments. */
function rangeOf(cues: readonly DocumentCue[]): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const cue of cues) {
    if (cue.startMs < start) start = cue.startMs;
    if (cue.endMs > end) end = cue.endMs;
  }
  return { start, end };
}

/** The preview of a read file: counts, range, speaker candidates and label runs, bilingual suggestion, package summary, limits. */
export function inspectSubtitleDocument(document: SubtitleDocument): SubtitleDocumentInspection {
  const { cues, package: pkg } = document;
  const speakers = speakersOf(document);
  const bilingual = bilingualOf(document);
  return {
    format: document.format,
    cueCount: cues.length,
    droppedCues: { count: document.dropped.count, samples: [...document.dropped.samples] },
    ...(cues.length === 0 ? {} : { rangeMs: rangeOf(cues) }),
    speakers,
    ...(bilingual === undefined ? {} : { bilingual }),
    ...(pkg === undefined
      ? {}
      : {
          package: {
            formatVersion: pkg.formatVersion,
            generator: { app: pkg.generator.app, version: pkg.generator.version },
            language: pkg.original.language,
            segmentCount: pkg.original.segments.length,
            speakerCount: packageSpeakers(pkg).length,
            translationLanguages: pkg.translations.map((translation) => translation.language),
          },
        }),
    limits: limitsOf(document, speakers),
  };
}

function planFromPackage(format: TimedSubtitleFormat, pkg: SubtitlePackage, options: SubtitleImportOptions | undefined): SubtitleImportPlan {
  const marks = pkg.original.paragraphMarks;
  const indexOf = new Map(pkg.original.segments.map((segment, index) => [segment.key, index]));
  const translations =
    options?.translationLanguage === null
      ? []
      : pkg.translations
          .map((translation) => ({
            language: translation.language,
            lines: translation.segments.map((line) => ({ segmentIndex: indexOf.get(line.sourceSegmentKey) as number, text: line.text })),
          }))
          .filter((translation) => translation.lines.length > 0);
  return {
    format,
    language: pkg.original.language,
    paragraphMarks: marks,
    speakers: packageSpeakers(pkg).map((speaker) => ({
      key: speaker.key,
      ordinal: speaker.ordinal,
      ...(speaker.name === undefined ? {} : { name: speaker.name }),
      colorIndex: speaker.colorIndex,
    })),
    segments: pkg.original.segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speakerKey: segment.speaker,
      ...(marks ? { paragraphStart: segment.paragraphStart === true } : {}),
    })),
    translations,
    droppedCues: 0,
  };
}

/** A speaker named by a file: the default label of an unnamed one asks for its number, any other name is a name. */
function plannedSpeaker(key: string): PlannedSpeaker {
  const ordinal = defaultLabelOrdinal(key);
  return ordinal === undefined ? { key, name: key } : { key, ordinal, fallbackName: key };
}

/** A cue resolved in file order: its sentence text, speaker and translation line. */
interface ResolvedCue {
  startMs: number;
  endMs: number;
  text: string;
  speakerKey: string | null;
  translation?: string;
}

function resolveCues(document: SubtitleDocument, options: SubtitleImportOptions | undefined, translate: boolean): ResolvedCue[] {
  const { format } = document;
  const explicit = format === "ass" || (format === "vtt" && options !== undefined);
  const selected = new Set(format === "srt" && options !== undefined ? (options.speakers?.prefixNames ?? []) : []);
  const inherit = (options?.speakers?.unlabeled ?? "inherit") === "inherit";
  let previous: string | null = null;
  return document.cues.map((cue) => {
    let lines = cue.lines;
    let translationLines: readonly string[] = [];
    if (translate && format === "srt" && lines.length === 2) {
      translationLines = [lines[1] as string];
      lines = [lines[0] as string];
    } else if (translate && format === "ass") {
      translationLines = cue.translationLines ?? [];
    }
    let speakerKey: string | null = null;
    if (explicit) {
      speakerKey = typeof cue.voice === "string" ? cue.voice : null;
    } else if (selected.size > 0) {
      const first = lines[0] ?? "";
      const prefix = linePrefix(first);
      if (prefix !== undefined && selected.has(prefix.key)) {
        speakerKey = prefix.key;
        previous = prefix.key;
        const rest = [prefix.rest, ...lines.slice(1)].filter((line) => line !== "");
        // A cue that is only a name keeps the name as its text: a sentence is never empty.
        lines = rest.length > 0 ? rest : [first];
      } else {
        speakerKey = inherit ? previous : null;
      }
    }
    const translation = joinLines(translationLines);
    return { startMs: cue.startMs, endMs: cue.endMs, text: joinLines(lines), speakerKey, ...(translation === "" ? {} : { translation }) };
  });
}

/**
 * What to import from a read file under the user's choices. Without `options`, SRT and VTT
 * come out exactly as the plain import always did (no speakers, no translations), an ASS
 * keeps its `Name` speakers and drops translations of unknown language, and a package keeps
 * everything. `language` is required for every format except a package.
 */
export function planSubtitleImport(document: SubtitleDocument, input: { language?: string; options?: SubtitleImportOptions }): SubtitleImportPlan {
  const { options } = input;
  if (document.package !== undefined) {
    return planFromPackage(document.format, document.package, options);
  }
  const language = input.language === undefined ? undefined : canonicalLanguageTag(input.language);
  if (language === undefined) {
    throw amberError("invalid_request", "a timed subtitle needs its language", { params: { detail: "language" } });
  }
  let translationLanguage: string | undefined;
  if (typeof options?.translationLanguage === "string" && (document.format === "srt" || document.format === "ass")) {
    const normalized = normalizeTargetLanguages([options.translationLanguage], language);
    const canonical = "languages" in normalized ? canonicalLanguageTag(normalized.languages[0] ?? "") : undefined;
    if (canonical === undefined) {
      throw amberError("invalid_request", `translation language ${options.translationLanguage} is invalid or the original's`, {
        params: { detail: "translationLanguage" },
      });
    }
    translationLanguage = canonical;
  }
  const resolved = resolveCues(document, options, translationLanguage !== undefined);
  // Attribution is settled in file order; sentences are then put in time order, stably, as the plain import sorts them.
  const order = resolved.map((_, index) => index).sort((a, b) => {
    const left = resolved[a] as ResolvedCue;
    const right = resolved[b] as ResolvedCue;
    return left.startMs - right.startMs || left.endMs - right.endMs || a - b;
  });
  const speakers: PlannedSpeaker[] = [];
  const seen = new Set<string>();
  for (const cue of resolved) {
    if (cue.speakerKey !== null && !seen.has(cue.speakerKey)) {
      seen.add(cue.speakerKey);
      speakers.push(plannedSpeaker(cue.speakerKey));
    }
  }
  const segments = order.map((index) => {
    const cue = resolved[index] as ResolvedCue;
    return { startMs: cue.startMs, endMs: cue.endMs, text: cue.text, speakerKey: cue.speakerKey };
  });
  const lines = order.flatMap((index, segmentIndex) => {
    const translation = (resolved[index] as ResolvedCue).translation;
    return translation === undefined ? [] : [{ segmentIndex, text: translation }];
  });
  return {
    format: document.format,
    language,
    paragraphMarks: false,
    speakers,
    segments,
    translations: translationLanguage === undefined || lines.length === 0 ? [] : [{ language: translationLanguage, lines }],
    droppedCues: document.dropped.count,
  };
}
