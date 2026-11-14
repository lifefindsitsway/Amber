import { z } from "zod";
import { SPEAKER_LABEL_MODES } from "../speakers.ts";
import { subtitleStyleSchema } from "../subtitle-style.ts";

const idSchema = z.string().min(1);

/** Subtitle-like export formats; the bilingual ones pair a translation with its parent. */
export const SUBTITLE_EXPORT_FORMATS = ["srt", "srt-bilingual", "vtt", "txt", "ass", "ass-bilingual"] as const;
export type SubtitleExportFormat = (typeof SUBTITLE_EXPORT_FORMATS)[number];

export const BILINGUAL_EXPORT_FORMATS: ReadonlySet<SubtitleExportFormat> = new Set(["srt-bilingual", "ass-bilingual"]);

/** Formats that may carry a `style`: the ASS ones. */
export const STYLED_EXPORT_FORMATS: ReadonlySet<SubtitleExportFormat> = new Set(["ass", "ass-bilingual"]);

const markdownExportSchema = z
  .object({
    format: z.literal("markdown"),
    sections: z
      .object({
        summary: z.object({ templateId: idSchema }).strict().exactOptional(),
        chapters: z.boolean().exactOptional(),
        transcript: z.object({ revisionId: idSchema }).strict().exactOptional(),
        subtitles: z.object({ revisionId: idSchema }).strict().exactOptional(),
      })
      .strict(),
    backlinks: z.boolean(),
    /** Name the speaker of each turn in the transcript section; absent = no speakers, as before. */
    includeSpeakers: z.boolean().exactOptional(),
  })
  .strict();

const subtitleExportSchema = z
  .object({
    format: z.enum(SUBTITLE_EXPORT_FORMATS),
    revisionId: idSchema,
    translationRevisionId: idSchema.exactOptional(),
    style: subtitleStyleSchema.exactOptional(),
    /** Name the speakers; absent = no speakers, the output byte for byte as before. */
    includeSpeakers: z.boolean().exactOptional(),
    /** SRT and TXT only: name the speaker on the first cue or paragraph of each turn (default) or on every one. */
    speakerLabels: z.enum(SPEAKER_LABEL_MODES).exactOptional(),
  })
  .strict()
  .refine((body) => BILINGUAL_EXPORT_FORMATS.has(body.format) === (body.translationRevisionId !== undefined), {
    message: "translationRevisionId is required for bilingual formats and only for them",
    path: ["translationRevisionId"],
  })
  .refine((body) => body.style === undefined || STYLED_EXPORT_FORMATS.has(body.format), {
    message: "style applies to ASS exports only",
    path: ["style"],
  });

/**
 * An Amber subtitle package: the original revision with its speakers and every current
 * translation made from it, for restoring them exactly on another device. Speakers always
 * travel with it, so there is no `includeSpeakers`.
 */
const subtitlePackageExportSchema = z.object({ format: z.literal("ambersub"), revisionId: idSchema }).strict();

/**
 * `POST /api/contents/:id/export`: every revision is named explicitly; the
 * response is the file itself, streamed, with `Content-Disposition: attachment`.
 */
export const contentExportRequestSchema = z.union([markdownExportSchema, subtitleExportSchema, subtitlePackageExportSchema]);
export type ContentExportRequest = z.infer<typeof contentExportRequestSchema>;
export type MarkdownExportRequest = z.infer<typeof markdownExportSchema>;
export type SubtitleExportRequest = z.infer<typeof subtitleExportSchema>;
export type SubtitlePackageExportRequest = z.infer<typeof subtitlePackageExportSchema>;

/** `POST /api/collections/:id/export`: the collection Markdown. */
export const collectionExportRequestSchema = z.object({ backlinks: z.boolean() }).strict();
export type CollectionExportRequest = z.infer<typeof collectionExportRequestSchema>;
