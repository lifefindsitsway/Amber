import { z } from "zod";
import { SPEAKERS_PER_CONTENT_MAX } from "../defaults.ts";
import { languageTagSchema } from "./language.ts";

const idSchema = z.string().min(1);

/** Timed subtitle formats an import accepts; each becomes an `imported` revision. */
export const TIMED_SUBTITLE_FORMATS = ["srt", "vtt", "ass", "ambersub"] as const;
export type TimedSubtitleFormat = (typeof TIMED_SUBTITLE_FORMATS)[number];
export const timedSubtitleFormatSchema = z.enum(TIMED_SUBTITLE_FORMATS);

/** What a subtitle file was read as; TXT and Markdown become reference text and are not previewed. */
export const INSPECTED_SUBTITLE_FORMATS = [...TIMED_SUBTITLE_FORMATS, "txt", "md"] as const;
export type InspectedSubtitleFormat = (typeof INSPECTED_SUBTITLE_FORMATS)[number];

/** SHA-256 (lowercase hex) of the subtitle text after decoding and dropping a BOM; computed by the server only. */
export const subtitleDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A key that names a speaker within one file: a package `speakerKey`, a voice or `Name`, or an
 * SRT prefix name. Names are limited in grapheme clusters, and one cluster may carry any number
 * of combining marks, so no length in UTF-16 units is imposed here; the request body limit
 * bounds it.
 */
const speakerKeySchema = z.string().min(1);

/**
 * How to read speakers, translations and identities out of a previewed subtitle file.
 * Absent from a request = the import behaves exactly as before options existed.
 */
export const subtitleImportOptionsSchema = z
  .object({
    /** The preview's `digest`; a different file read now is `conflict.subtitle_changed`. */
    expectedDigest: subtitleDigestSchema,
    /** SRT only: the leading names taken as speakers, and how cues without one are attributed. */
    speakers: z
      .object({
        prefixNames: z.array(speakerKeySchema).max(SPEAKERS_PER_CONTENT_MAX * 4).exactOptional(),
        /** `inherit` = the previous labelled speaker continues (names given on turns); `unassigned` = no speaker. */
        unlabeled: z.enum(["inherit", "unassigned"]).exactOptional(),
      })
      .strict()
      .exactOptional(),
    /**
     * Language of the translation lines of an SRT or ASS file; absent = no translation is
     * imported from them. `null` also drops the translations of a package.
     */
    translationLanguage: z.union([languageTagSchema, z.null()]).exactOptional(),
    /** Existing Content only: speakers to map onto existing identities; any speaker not listed is created. */
    identities: z
      .array(z.object({ key: speakerKeySchema, speakerId: idSchema.exactOptional() }).strict())
      .max(SPEAKERS_PER_CONTENT_MAX)
      .exactOptional(),
    /** Existing Content only: make the import the primary and its translations current; absent = true. */
    setCurrent: z.boolean().exactOptional(),
    /** Existing Content only: what the preview saw, rechecked inside the import transaction. */
    expectedState: z
      .object({
        primaryRevisionId: idSchema.nullable(),
        currentTranslations: z.record(z.string().min(1), idSchema),
        speakers: z.array(z.object({ id: idSchema, name: z.string().exactOptional() }).strict()).max(SPEAKERS_PER_CONTENT_MAX),
        speakerRoom: z.number().int().nonnegative(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();
export type SubtitleImportOptions = z.infer<typeof subtitleImportOptionsSchema>;

/** `POST /api/subtitles/inspect`: preview a subtitle text without writing anything. */
export const subtitleInspectRequestSchema = z
  .object({
    text: z.string().min(1),
    filename: z.string().max(1024).exactOptional(),
    format: z.enum(INSPECTED_SUBTITLE_FORMATS).exactOptional(),
    language: languageTagSchema.exactOptional(),
    /** The Content an import would go into; adds `target` to the response. */
    contentId: idSchema.exactOptional(),
  })
  .strict();
export type SubtitleInspectRequest = z.infer<typeof subtitleInspectRequestSchema>;

/** Restoration limits a preview names for the file it read; the client words each one. */
export const SUBTITLE_IMPORT_LIMITS = [
  // Standard formats keep no speaker identity: same-named speakers merge.
  "speaker_identity",
  // Cues without a name were attributed by the chosen rule, not by the file.
  "unlabeled_inferred",
  // Markup inside cue text (<…> tags, ASS override blocks) is removed.
  "markup_removed",
  // A VTT cue with several voices stays unassigned.
  "multi_voice",
  // ASS timing has 10 ms precision.
  "centisecond_timing",
  // ASS text was changed for rendering on export (straight quotes, full-width \ { }, commas in names).
  "glyphs_changed",
  // An older styled ASS: overlapping sentences are rebuilt from time slices.
  "overlap_slices",
  // The restore data of a styled ASS no longer matches its dialogue lines; read as a plain ASS.
  "restore_data_mismatch",
  // A package carries no word timing, chapters, notes, highlights, avatars, review or reading preferences.
  "package_scope",
] as const;
export type SubtitleImportLimit = (typeof SUBTITLE_IMPORT_LIMITS)[number];

const countSchema = z.number().int().nonnegative();

export const subtitleInspectResponseSchema = z.object({
  format: z.enum(INSPECTED_SUBTITLE_FORMATS),
  digest: subtitleDigestSchema,
  cueCount: countSchema,
  droppedCues: z.object({ count: countSchema, samples: z.array(z.string()) }),
  /** First start and last end over the kept cues; absent when none was kept. */
  rangeMs: z.object({ start: countSchema, end: countSchema }).exactOptional(),
  speakers: z.object({
    source: z.enum(["none", "explicit", "prefix", "package"]),
    candidates: z.array(z.object({ key: speakerKeySchema, label: z.string(), count: countSchema, preselected: z.boolean() })),
    /**
     * Cues in file order as runs `[candidateIndex, length]`, `-1` for a cue without a label,
     * so the client recounts labelled, inherited and unassigned cues for any choice offline.
     */
    sequence: z.array(z.tuple([z.number().int().min(-1), z.number().int().positive()])),
  }),
  bilingual: z
    .object({
      source: z.enum(["style", "lines", "package"]),
      /** Cues that carry a second-language line. */
      count: countSchema,
      samples: z.array(z.object({ original: z.string(), translation: z.string() })),
      /** Known languages (package or verified restore data); absent = the user picks one. */
      languages: z.array(z.string().min(1)).exactOptional(),
    })
    .exactOptional(),
  package: z
    .object({
      formatVersion: z.number().int().positive(),
      generator: z.object({ app: z.string(), version: z.string() }),
      language: z.string().min(1),
      segmentCount: countSchema,
      speakerCount: countSchema,
      translationLanguages: z.array(z.string().min(1)),
    })
    .exactOptional(),
  limits: z.array(z.enum(SUBTITLE_IMPORT_LIMITS)),
  target: z
    .object({
      primaryRevisionId: idSchema.nullable(),
      speakers: z.array(
        z.object({
          id: idSchema,
          ordinal: z.number().int().positive(),
          name: z.string().exactOptional(),
          colorIndex: countSchema,
          avatarVersion: z.number().int().positive().exactOptional(),
          used: z.boolean(),
        }),
      ),
      speakerRoom: countSchema,
      currentTranslations: z.record(z.string().min(1), idSchema),
      durationMs: countSchema.exactOptional(),
      /** The subtitle's time range does not fit the media duration by the subtitle coverage rules. */
      coverageWarning: z.boolean(),
    })
    .exactOptional(),
});
export type SubtitleInspectResponse = z.infer<typeof subtitleInspectResponseSchema>;
