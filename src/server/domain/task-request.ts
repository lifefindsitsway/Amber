import { z } from "zod";
import { asrModelRefSchema, modelRefSchema } from "../../shared/dto/model-ref.ts";
import { CACHE_MEDIA_TYPES } from "../../shared/cache-file-name.ts";
import { BURN_MODES, CACHE_MEDIA_QUALITIES, SUBTITLE_DELIVERIES, SUBTITLE_VIDEO_CONTAINERS, type TaskKind } from "../../shared/enums.ts";
import { subtitleStyleSchema } from "../../shared/subtitle-style.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { AsrModelRef, ModelRef } from "./model-ref.ts";

/** A summary template version, resolved and frozen when a Task is submitted, so later template edits never reach it. */
export const templateRefSchema = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();

/**
 * `Task.requestJson` of a `process_content` Task, schema version 1. Frozen at submission;
 * stages read their inputs only from here. `templateRef` joins with
 * summary templates. `initialSubtitleRevisionId` records the subtitle imported together
 * with a new Content; it describes where the Content came from, not what to
 * do with it, so it does not take part in intent comparison. `asrModelRef` is the ASR
 * model chosen at submission; without it, a Content that needs transcription waits for
 * one to be chosen.
 */
export const processContentRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("process_content"),
    modelRef: modelRefSchema.exactOptional(),
    asrModelRef: asrModelRefSchema.exactOptional(),
    outputLanguage: z.string().min(1).exactOptional(),
    autoProofread: z.boolean(),
    templateRef: templateRefSchema.exactOptional(),
    initialSubtitleRevisionId: z.string().min(1).exactOptional(),
  })
  .strict();
export type ProcessContentRequest = z.infer<typeof processContentRequestSchema>;

/**
 * `Task.requestJson` of a `regenerate_summary` Task, schema version 1: the primary
 * transcript is frozen as `baseRevisionId` when the Task is created.
 * `templateRef` joins with summary templates.
 */
export const regenerateSummaryRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("regenerate_summary"),
    modelRef: modelRefSchema.exactOptional(),
    outputLanguage: z.string().min(1).exactOptional(),
    templateRef: templateRefSchema.exactOptional(),
    baseRevisionId: z.string().min(1),
  })
  .strict();
export type RegenerateSummaryRequest = z.infer<typeof regenerateSummaryRequestSchema>;

/**
 * `Task.requestJson` of a `summarize_collection` Task, schema version 1: the output
 * language and each member's `summary.core` current revision and primary transcript are
 * frozen at submission as `inputItems`, in collection order.
 */
export const summarizeCollectionRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("summarize_collection"),
    modelRef: modelRefSchema.exactOptional(),
    outputLanguage: z.string().min(1),
    inputItems: z
      .array(
        z
          .object({
            collectionItemId: z.string().min(1),
            contentId: z.string().min(1),
            summaryRevisionId: z.string().min(1),
            transcriptRevisionId: z.string().min(1),
            position: z.number().int(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type SummarizeCollectionRequest = z.infer<typeof summarizeCollectionRequestSchema>;

/**
 * `Task.requestJson` of a `retranscribe` Task, schema version 1: the ASR model chosen at
 * submission. Without one the stage waits for configuration and the model is supplied
 * through retry-stage.
 */
export const retranscribeRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("retranscribe"),
    asrModelRef: asrModelRefSchema.exactOptional(),
  })
  .strict();
export type RetranscribeRequest = z.infer<typeof retranscribeRequestSchema>;

/**
 * `Task.requestJson` of a `reproofread` Task, schema version 1: the primary transcript at
 * submission is frozen as `baseRevisionId`.
 */
export const reproofreadRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("reproofread"),
    modelRef: modelRefSchema.exactOptional(),
    baseRevisionId: z.string().min(1),
  })
  .strict();
export type ReproofreadRequest = z.infer<typeof reproofreadRequestSchema>;

/**
 * `Task.requestJson` of a `regenerate_chapters` Task, schema version 1: the primary
 * transcript and the chapter language are frozen at submission.
 */
export const regenerateChaptersRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("regenerate_chapters"),
    modelRef: modelRefSchema.exactOptional(),
    baseRevisionId: z.string().min(1),
    outputLanguage: z.string().min(1),
  })
  .strict();
export type RegenerateChaptersRequest = z.infer<typeof regenerateChaptersRequestSchema>;

/**
 * `Task.requestJson` of a `recompute_highlights` Task, schema version 1: the primary
 * transcript and the language of the highlight reasons are frozen at submission.
 */
export const recomputeHighlightsRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("recompute_highlights"),
    modelRef: modelRefSchema.exactOptional(),
    baseRevisionId: z.string().min(1),
    outputLanguage: z.string().min(1),
  })
  .strict();
export type RecomputeHighlightsRequest = z.infer<typeof recomputeHighlightsRequestSchema>;

/**
 * `Task.requestJson` of a `translate` Task, schema version 1: the source revision is frozen
 * as `baseRevisionId` at submission and `targetLanguages` are already normalized and
 * de-duplicated (canonical BCP-47 tags whose primary subtag differs from the source language).
 */
export const translateRequestSchema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("translate"),
    targetLanguages: z.array(z.string().min(1)).min(1),
    modelRef: modelRefSchema.exactOptional(),
    baseRevisionId: z.string().min(1),
  })
  .strict();
export type TranslateRequest = z.infer<typeof translateRequestSchema>;

/**
 * `Task.requestJson` of a `cache_media` Task, schema version 1: only the height tier was
 * frozen. Kept so such a Task parses; the stage refuses it with
 * `invalid_request.cache_request_outdated`.
 */
const cacheMediaTaskRequestV1Schema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("cache_media"),
    quality: z.union(CACHE_MEDIA_QUALITIES.map((quality) => z.literal(quality))),
  })
  .strict();

/**
 * `Task.requestJson` of a `cache_media` Task, schema version 2: the file name was decided
 * at submission, before the downloaded quality was known. Kept so such a Task parses; the
 * stage completes it only when its asset is already registered and otherwise removes the
 * file it may have left and fails with `invalid_request.cache_request_outdated`.
 */
export const cacheMediaTaskRequestV2Schema = z
  .object({
    requestSchemaVersion: z.literal(2),
    kind: z.literal("cache_media"),
    type: z.enum(CACHE_MEDIA_TYPES),
    quality: z.union(CACHE_MEDIA_QUALITIES.map((quality) => z.literal(quality))).exactOptional(),
    fileName: z.string().min(1),
    assetId: z.string().min(1),
  })
  .strict();
export type CacheMediaTaskRequestV2 = z.infer<typeof cacheMediaTaskRequestV2Schema>;

/**
 * `Task.requestJson` of a `cache_media` Task, schema version 3 (client only), frozen at
 * submission: what to cache, the height cap of a video, the cleaned stem of the file name,
 * the height the format check expected (absent when unknown), the id of the asset to
 * register and the user's confirmation to replace another Content's cache holding the
 * expected name. The quality label and extension of the file come from the finished
 * download, so the stem is frozen and the full name is not.
 */
export const cacheMediaTaskRequestV3Schema = z
  .object({
    requestSchemaVersion: z.literal(3),
    kind: z.literal("cache_media"),
    type: z.enum(CACHE_MEDIA_TYPES),
    quality: z.union(CACHE_MEDIA_QUALITIES.map((quality) => z.literal(quality))).exactOptional(),
    stem: z.string().min(1),
    expectedHeight: z.number().int().positive().exactOptional(),
    assetId: z.string().min(1),
    overwrite: z.object({ assetId: z.string().min(1), fileName: z.string().min(1) }).strict().exactOptional(),
  })
  .strict();
export type CacheMediaTaskRequestV3 = z.infer<typeof cacheMediaTaskRequestV3Schema>;

export const cacheMediaTaskRequestSchema = z.discriminatedUnion("requestSchemaVersion", [
  cacheMediaTaskRequestV1Schema,
  cacheMediaTaskRequestV2Schema,
  cacheMediaTaskRequestV3Schema,
]);
export type CacheMediaTaskRequest = z.infer<typeof cacheMediaTaskRequestSchema>;

/**
 * `Task.requestJson` of a `burn` Task, schema version 1 (client only): the
 * legacy fixed-style MP4 burn-in. The revisions are frozen at submission; the source video
 * is picked when the stage runs; `translationRevisionId` is present exactly for the
 * `translation` and `bilingual` modes.
 */
export const burnTaskRequestV1Schema = z
  .object({
    requestSchemaVersion: z.literal(1),
    kind: z.literal("burn"),
    mode: z.enum(BURN_MODES),
    revisionId: z.string().min(1),
    translationRevisionId: z.string().min(1).exactOptional(),
  })
  .strict();
export type BurnTaskRequestV1 = z.infer<typeof burnTaskRequestV1Schema>;

/**
 * Schema version 2, the styled subtitled video export: the source video
 * (`assetId` plus the fingerprint it had, absent when the asset never had one), the
 * delivery, the container and the full style are frozen at submission, so a re-run never
 * reads changed preferences or another file.
 */
export const burnTaskRequestV2Schema = z
  .object({
    requestSchemaVersion: z.literal(2),
    kind: z.literal("burn"),
    mode: z.enum(BURN_MODES),
    revisionId: z.string().min(1),
    translationRevisionId: z.string().min(1).exactOptional(),
    source: z.object({ assetId: z.string().min(1), fingerprint: z.string().min(1).exactOptional() }).strict(),
    delivery: z.enum(SUBTITLE_DELIVERIES),
    container: z.enum(SUBTITLE_VIDEO_CONTAINERS),
    style: subtitleStyleSchema,
  })
  .strict();
export type BurnTaskRequestV2 = z.infer<typeof burnTaskRequestV2Schema>;

export const burnTaskRequestSchema = z.discriminatedUnion("requestSchemaVersion", [burnTaskRequestV1Schema, burnTaskRequestV2Schema]);
export type BurnTaskRequest = z.infer<typeof burnTaskRequestSchema>;

/**
 * The fields every kind's request may carry that the pipeline itself interprets. Stage
 * executors parse the rest with their kind's own schema.
 */
export interface TaskRequestView {
  modelRef?: ModelRef;
  asrModelRef?: AsrModelRef;
  autoProofread?: boolean;
  templateRef?: { id: string; version: number };
  targetLanguages?: string[];
}

const requestViewSchema = z.object({
  modelRef: modelRefSchema.exactOptional(),
  asrModelRef: asrModelRefSchema.exactOptional(),
  autoProofread: z.boolean().exactOptional(),
  templateRef: templateRefSchema.exactOptional(),
  targetLanguages: z.array(z.string().min(1)).exactOptional(),
});

export function taskRequestView(requestJson: string): TaskRequestView {
  const parsed = requestViewSchema.safeParse(JSON.parse(requestJson));
  if (!parsed.success) {
    throw new TypeError("task request does not match the pipeline view");
  }
  return parsed.data;
}

/**
 * Input supplied through retry-stage and frozen on the StageRun (`StageRun.inputJson`).
 * It may only fill fields that the Task request lacks, or carry the model (or ASR model)
 * explicitly chosen when re-running a failed LLM (or ASR) stage.
 */
export const stageInputSchema = z
  .object({ modelRef: modelRefSchema.exactOptional(), asrModelRef: asrModelRefSchema.exactOptional() })
  .strict();
export type StageInput = z.infer<typeof stageInputSchema>;

export function parseStageInput(inputJson: string | undefined): StageInput {
  return inputJson === undefined ? {} : stageInputSchema.parse(JSON.parse(inputJson));
}

/**
 * Two submissions express the same intent when their canonical requests are equal; the
 * same Content may legitimately be processed again under a different intent.
 */
export function sameIntent(kind: TaskKind, requestJson: string, other: { kind: TaskKind; requestJson: string }): boolean {
  return kind === other.kind && intentOf(requestJson) === intentOf(other.requestJson);
}

const NOT_INTENT = new Set(["initialSubtitleRevisionId"]);

/**
 * Intent fields whose values differ between two requests of the same kind, ignoring the
 * fields that never express intent and those listed in `ignore`. Sorted.
 */
export function intentDifferences(requestJson: string, otherJson: string, ignore: readonly string[] = []): string[] {
  const a = JSON.parse(requestJson) as Record<string, unknown>;
  const b = JSON.parse(otherJson) as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((key) => !NOT_INTENT.has(key) && !ignore.includes(key))
    .filter((key) => canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null))
    .sort();
}

function intentOf(requestJson: string): string {
  const request = JSON.parse(requestJson) as Record<string, unknown>;
  return canonicalJson(Object.fromEntries(Object.entries(request).filter(([key]) => !NOT_INTENT.has(key))));
}
