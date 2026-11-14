import { createHash } from "node:crypto";
import { z } from "zod";
import { SPEAKER_PALETTE_SIZE, SPEAKERS_PER_CONTENT_MAX } from "../../shared/defaults.ts";
import { normalizeSpeakerName } from "../../shared/speakers.ts";
import { amberError } from "./errors.ts";
import { canonicalLanguageTag } from "./subtitle-file.ts";

/**
 * The Amber subtitle package (`.ambersub`): one original revision with its speakers and
 * paragraph marks, plus translations made from it, as UTF-8 JSON. It exists so a subtitle
 * exported on one device restores exactly on another; it is a file format, so its shape is
 * versioned by `formatVersion` and never by the app version.
 */

export const SUBTITLE_PACKAGE_FORMAT = "amber-subtitle";
/** Raised only for changes an older reader must refuse; optional fields are added within a version. */
export const SUBTITLE_PACKAGE_VERSION = 1;
export const SUBTITLE_PACKAGE_EXTENSION = "ambersub";

export interface SubtitlePackageSpeaker {
  key: string;
  ordinal: number;
  /** Absent = unnamed ("Speaker N" by its ordinal). */
  name?: string;
  colorIndex: number;
}

export interface SubtitlePackageSegment {
  key: string;
  startMs: number;
  endMs: number;
  /** `TranscriptSegment.text` as stored, without any subtitle rendering applied. */
  text: string;
  /** A speaker key; `null` = unassigned. */
  speaker: string | null;
  /** Present on every segment exactly when the original has paragraph marks. */
  paragraphStart?: boolean;
}

export interface SubtitlePackageTranslation {
  language: string;
  segments: Array<{ sourceSegmentKey: string; text: string }>;
}

export interface SubtitlePackage {
  format: typeof SUBTITLE_PACKAGE_FORMAT;
  formatVersion: number;
  generator: { app: string; version: string };
  original: {
    language: string;
    paragraphMarks: boolean;
    speakers: SubtitlePackageSpeaker[];
    segments: SubtitlePackageSegment[];
  };
  translations: SubtitlePackageTranslation[];
}

const KEY_MAX = 64;
const keySchema = z.string().min(1).max(KEY_MAX);
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Unknown fields are dropped (not refused) so a reader of this version accepts optional additions. */
const packageSchema = z.object({
  format: z.literal(SUBTITLE_PACKAGE_FORMAT),
  formatVersion: z.literal(SUBTITLE_PACKAGE_VERSION),
  generator: z.object({ app: z.string().max(100), version: z.string().max(100) }),
  original: z.object({
    language: z.string().min(1).max(100),
    paragraphMarks: z.boolean(),
    speakers: z
      .array(
        z.object({
          key: keySchema,
          ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          name: z.string().max(1000).optional(),
          colorIndex: z
            .number()
            .int()
            .min(0)
            .max(SPEAKER_PALETTE_SIZE - 1),
        }),
      )
      .max(SPEAKERS_PER_CONTENT_MAX),
    segments: z
      .array(
        z.object({
          key: keySchema,
          startMs: timeSchema,
          endMs: timeSchema,
          text: z.string(),
          speaker: keySchema.nullable(),
          paragraphStart: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  translations: z.array(
    z.object({
      language: z.string().min(1).max(100),
      segments: z.array(z.object({ sourceSegmentKey: keySchema, text: z.string() })),
    }),
  ),
});

function invalidPackage(message: string): Error {
  return amberError("invalid_request", message, { code: "invalid_request.subtitle_format" });
}

function primarySubtag(tag: string): string {
  return (tag.split("-")[0] ?? "").toLowerCase();
}

/**
 * Reads and checks a package. Every rule the format states is enforced here — structure,
 * ranges, timing, unique keys that all resolve, distinct ordinals, palette indexes,
 * normalized names, canonical languages, at most one translation per sentence, paragraph
 * marks all-or-none with the first sentence starting one — so nothing downstream trusts the
 * file. Sentence order is kept as written. A newer `formatVersion` is
 * `invalid_request.subtitle_newer`; anything else wrong is `invalid_request.subtitle_format`.
 */
export function parseSubtitlePackage(text: string): SubtitlePackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalidPackage("subtitle package is not JSON");
  }
  if (typeof raw === "object" && raw !== null && (raw as { format?: unknown }).format === SUBTITLE_PACKAGE_FORMAT) {
    const version = (raw as { formatVersion?: unknown }).formatVersion;
    if (typeof version === "number" && Number.isInteger(version) && version > SUBTITLE_PACKAGE_VERSION) {
      throw amberError("invalid_request", "subtitle package is newer than this build reads", {
        code: "invalid_request.subtitle_newer",
        details: { formatVersion: version, supportedVersion: SUBTITLE_PACKAGE_VERSION },
      });
    }
  }
  const parsed = packageSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidPackage("subtitle package does not match its format");
  }
  const body = parsed.data;
  const language = canonicalLanguageTag(body.original.language);
  if (language === undefined) {
    throw invalidPackage("subtitle package language is not a BCP-47 tag");
  }

  const speakerKeys = new Set<string>();
  const ordinals = new Set<number>();
  const speakers: SubtitlePackageSpeaker[] = [];
  for (const speaker of body.original.speakers) {
    if (speakerKeys.has(speaker.key) || ordinals.has(speaker.ordinal)) {
      throw invalidPackage("subtitle package repeats a speaker key or ordinal");
    }
    speakerKeys.add(speaker.key);
    ordinals.add(speaker.ordinal);
    const name = speaker.name === undefined ? undefined : normalizeSpeakerName(speaker.name);
    if (name === "too_long") {
      throw invalidPackage("subtitle package speaker name is too long");
    }
    speakers.push({ key: speaker.key, ordinal: speaker.ordinal, ...(name === undefined ? {} : { name }), colorIndex: speaker.colorIndex });
  }

  const marks = body.original.paragraphMarks;
  const segmentKeys = new Set<string>();
  const segments: SubtitlePackageSegment[] = body.original.segments.map((segment, index) => {
    if (segmentKeys.has(segment.key)) {
      throw invalidPackage("subtitle package repeats a segment key");
    }
    segmentKeys.add(segment.key);
    if (segment.endMs <= segment.startMs) {
      throw invalidPackage("subtitle package segment ends before it starts");
    }
    if (segment.text.trim() === "") {
      throw invalidPackage("subtitle package segment has no text");
    }
    if (segment.speaker !== null && !speakerKeys.has(segment.speaker)) {
      throw invalidPackage("subtitle package segment names an unknown speaker");
    }
    if (marks !== (segment.paragraphStart !== undefined) || (marks && index === 0 && segment.paragraphStart !== true)) {
      throw invalidPackage("subtitle package paragraph marks are inconsistent");
    }
    return {
      key: segment.key,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speaker: segment.speaker,
      ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
    };
  });

  const languages = new Set<string>();
  const translations: SubtitlePackageTranslation[] = body.translations.map((translation) => {
    const target = canonicalLanguageTag(translation.language);
    if (target === undefined || languages.has(target) || primarySubtag(target) === primarySubtag(language)) {
      throw invalidPackage("subtitle package translation language is invalid, repeated or the original's");
    }
    languages.add(target);
    const sources = new Set<string>();
    const lines = translation.segments.map((line) => {
      if (!segmentKeys.has(line.sourceSegmentKey) || sources.has(line.sourceSegmentKey)) {
        throw invalidPackage("subtitle package translation names an unknown or repeated sentence");
      }
      sources.add(line.sourceSegmentKey);
      if (line.text.trim() === "") {
        throw invalidPackage("subtitle package translation line has no text");
      }
      return { sourceSegmentKey: line.sourceSegmentKey, text: line.text };
    });
    return { language: target, segments: lines };
  });

  return {
    format: SUBTITLE_PACKAGE_FORMAT,
    formatVersion: SUBTITLE_PACKAGE_VERSION,
    generator: { app: body.generator.app, version: body.generator.version },
    original: { language, paragraphMarks: marks, speakers, segments },
    translations,
  };
}

/** Compact JSON in a fixed key order, so the same revision always serializes to the same bytes. */
export function serializeSubtitlePackage(pkg: SubtitlePackage): string {
  const ordered = {
    format: pkg.format,
    formatVersion: pkg.formatVersion,
    generator: { app: pkg.generator.app, version: pkg.generator.version },
    original: {
      language: pkg.original.language,
      paragraphMarks: pkg.original.paragraphMarks,
      speakers: pkg.original.speakers.map((speaker) => ({
        key: speaker.key,
        ordinal: speaker.ordinal,
        ...(speaker.name === undefined ? {} : { name: speaker.name }),
        colorIndex: speaker.colorIndex,
      })),
      segments: pkg.original.segments.map((segment) => ({
        key: segment.key,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        speaker: segment.speaker,
        ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
      })),
    },
    translations: pkg.translations.map((translation) => ({
      language: translation.language,
      segments: translation.segments.map((line) => ({ sourceSegmentKey: line.sourceSegmentKey, text: line.text })),
    })),
  };
  return `${JSON.stringify(ordered)}\n`;
}

/**
 * Restore data inside a styled ASS download: `Comment` events whose Effect field is
 * `ASS_RESTORE_EFFECT`. The first carries `amber-data <protocol> <digest>`, the rest the
 * base64 of a serialized package in order. Renderers never draw `Comment` events.
 */
export const ASS_RESTORE_EFFECT = "amber-data";
export const ASS_RESTORE_PROTOCOL = 1;

/**
 * The digest that ties restore data to the dialogue it was written with: SHA-256 (lowercase
 * hex) of every `Dialogue:` line in file order, trailing `\r` removed, joined with `\n`. Any
 * edit, re-timing, addition or removal of a dialogue line changes it.
 */
export function assDialogueDigest(dialogueLines: readonly string[]): string {
  return createHash("sha256")
    .update(dialogueLines.map((line) => line.replace(/\r$/, "")).join("\n"), "utf8")
    .digest("hex");
}

/**
 * SHA-256 (lowercase hex) of a decoded subtitle text without a leading BOM: the `digest` an
 * import preview returns. A browser's `File.text()` already drops the BOM and the server's
 * file decoding does too, so text sent by the web client and a file read by path agree.
 */
export function subtitleTextDigest(text: string): string {
  return createHash("sha256").update(text.replace(/^\uFEFF/, ""), "utf8").digest("hex");
}
