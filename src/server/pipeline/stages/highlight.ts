import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { CITATION_INVALID_RATIO_MAX } from "../../../shared/defaults.ts";
import type { SegmentId } from "../../../shared/ids.ts";
import type { HighlightRevision } from "../../domain/artifact.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import type { Content } from "../../domain/content.ts";
import { amberError } from "../../domain/errors.ts";
import type { LlmRequest } from "../../domain/llm.ts";
import type { ModelRef } from "../../domain/model-ref.ts";
import { chapterWindowNote, HIGHLIGHT_DEFAULT_PROMPT, outputLanguageName, renderPrompt } from "../../domain/prompts.ts";
import { recomputeHighlightsRequestSchema } from "../../domain/task-request.ts";
import { estimateTokens } from "../../domain/token-estimate.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../domain/transcript.ts";
import type { Repository } from "../../ports/repository.ts";
import { assertBaseRevisionExists, stageUnitFailure, type StageExecutionContext, type StageExecutor, type StageOutcome, type UnitIdentity } from "../executor.ts";
import { taskContent } from "./platform-access.ts";
import { planSentenceWindows, type SentenceWindow } from "./windows.ts";

export interface HighlightStageDeps {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

/** The JSON object the `highlight.default` prompt asks for; the root is an object so structured output can describe it. */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: { alias: { type: "string" }, score: { type: "integer" }, text: { type: "string" } },
        required: ["alias", "score", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["highlights"],
  additionalProperties: false,
} as const;

/** The outer shape only; entries are judged one by one, and an unusable entry is dropped. */
const outputSchema = z.object({ highlights: z.array(z.unknown()) });
const entrySchema = z.object({ alias: z.string(), score: z.number(), text: z.string().optional() });

type HighlightItem = HighlightRevision["items"][number];

/** A window's result as persisted in `WorkUnitResult`. */
const windowPayloadSchema = z.object({
  items: z.array(z.object({ segmentId: z.string(), score: z.number().int().min(0).max(100), text: z.string() })),
  dropped: z.number().int().nonnegative(),
  invocationId: z.string(),
});
type WindowPayload = z.infer<typeof windowPayloadSchema>;

const ALIAS = /^s([1-9][0-9]*)$/;
const MAX_SCORE = 100;

/**
 * The `highlight` stage of `recompute_highlights`. The transcript frozen at submission is
 * cut into windows that fit the model's budget; each window is one DB-only WorkUnit asking
 * for scored sentences by `[[s<n>]]` alias (the `highlight.default` prompt). Entries naming
 * no sentence of their window are dropped, and a window that drops too many fails
 * as `output_mismatch` so it is asked again. The windows' items, merged in time order,
 * become one `HighlightRevision` made current, with the usage of the calls that produced
 * it attributed to it in the same transaction.
 */
export class HighlightStageExecutor implements StageExecutor {
  private readonly deps: HighlightStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: HighlightStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const content = taskContent(repository, context);
    const owner = content.userId;
    const { baseRevisionId, outputLanguage } = recomputeHighlightsRequestSchema.parse(context.request);
    const revision = this.baseOf(content, baseRevisionId);
    const segments = repository.withTransaction((scope) => scope.transcripts.listSegments(owner, revision.id));
    if (segments.length === 0) {
      throw amberError("internal", "the base transcript has no sentences");
    }
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "no model for the highlight stage");
    }
    const description = context.llm.describe(modelRef);
    const structured = description.capability.flags.structuredOutput === "supported";
    const template = renderPrompt(HIGHLIGHT_DEFAULT_PROMPT.text, { output_language: outputLanguageName(outputLanguage) });
    const fixedTokens =
      estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(segments.length, segments.length), transcript_with_aliases: "" })) +
      (structured ? estimateTokens(JSON.stringify(RESPONSE_SCHEMA)) : 0);
    const windows = planSentenceWindows(segments, { fixedTokens, limits: description.capability.limits, modelRef });

    let finished = 0;
    const settled = await Promise.allSettled(
      windows.map(async (window, index) => {
        const payload = await this.runWindow(context, { modelRef, revision, template, structured, outputLanguage, window, index, count: windows.length });
        finished += 1;
        context.reportProgress(finished / windows.length);
        return payload;
      }),
    );
    const failure = stageUnitFailure(settled);
    if (failure !== undefined) {
      throw failure;
    }
    const payloads = settled.map((result) => (result as PromiseFulfilledResult<WindowPayload>).value);
    const items = mergeWindows(segments, payloads);
    const invocationIds = payloads.map((payload) => payload.invocationId);
    const dropped = payloads.reduce((sum, payload) => sum + payload.dropped, 0);
    const revisionId = this.newId();
    const artifactId = this.newId();
    const createdAt = this.now();
    return {
      resultJson: { revisionId, windows: windows.length, dropped, reasons: [] },
      publish: (scope) => {
        assertBaseRevisionExists(scope, owner, content.id, revision.id);
        scope.highlights.insertRevision(owner, content.id, {
          id: revisionId,
          artifactId,
          transcriptRevisionId: revision.id,
          items,
          modelRef: description.snapshot,
          promptRef: HIGHLIGHT_DEFAULT_PROMPT.ref,
          promptSnapshot: template,
          quality: "normal",
          createdAt,
        });
        scope.highlights.setCurrent(owner, content.id, revisionId);
        scope.tokenUsage.attach(owner, invocationIds, revisionId);
      },
    };
  }

  /** The transcript frozen at submission; it must still belong to the Content. */
  private baseOf(content: Content, revisionId: string): TranscriptRevision {
    const revision = this.deps.repository.withTransaction((scope) => scope.transcripts.getRevision(content.userId, revisionId));
    if (revision === undefined || revision.contentId !== content.id) {
      throw amberError("internal", "the base transcript revision is gone");
    }
    return revision;
  }

  private async runWindow(
    context: StageExecutionContext,
    input: {
      modelRef: ModelRef;
      revision: TranscriptRevision;
      template: string;
      structured: boolean;
      outputLanguage: string;
      window: SentenceWindow;
      index: number;
      count: number;
    },
  ): Promise<WindowPayload> {
    const { modelRef, revision, template, structured, outputLanguage, window, index, count } = input;
    const prompt = renderPrompt(template, {
      window_note: chapterWindowNote(index + 1, count),
      transcript_with_aliases: window.lines.join("\n"),
    });
    const request: LlmRequest = {
      modelRef,
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      ...(structured ? { responseFormat: { type: "json_schema" as const, schema: RESPONSE_SCHEMA } } : {}),
    };
    const inputDigest = digestOf(
      canonicalJson({
        baseRevisionId: revision.id,
        i: index,
        n: count,
        segmentIds: window.segments.map((segment) => segment.id),
        promptRef: HIGHLIGHT_DEFAULT_PROMPT.ref,
        modelRef,
        outputLanguage,
        structured,
      }),
    );
    const value = await context.runUnit({
      key: `highlight:window:${index}`,
      inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity): Promise<WindowPayload> => {
        const completion = await context.llm.complete(request, { feature: "highlight", workUnitId: unit.id });
        return { ...parseWindow(completion.text, window), invocationId: completion.invocationId };
      },
    });
    const parsed = windowPayloadSchema.safeParse(value);
    if (!parsed.success) {
      throw amberError("internal", "a stored highlight window does not match its shape");
    }
    return parsed.data;
  }
}

/**
 * The highlights of one window, checked by the rules of the `highlight.default` prompt: an
 * entry whose alias names no sentence of this window or whose score is not a number is dropped; when the dropped share exceeds
 * `CITATION_INVALID_RATIO_MAX` the whole window is `output_mismatch`. A repeated alias keeps
 * its first entry. Scores are rounded and clamped to 0–100; the count is not enforced.
 */
function parseWindow(text: string, window: SentenceWindow): { items: HighlightItem[]; dropped: number } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw amberError("output_mismatch", "highlight output holds no JSON object");
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw amberError("output_mismatch", "highlight output is not valid JSON");
  }
  const parsed = outputSchema.safeParse(json);
  if (!parsed.success) {
    throw amberError("output_mismatch", "highlight output does not match the expected shape");
  }
  const entries = parsed.data.highlights;
  const items: HighlightItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of entries) {
    const entry = entrySchema.safeParse(raw);
    const match = entry.success ? ALIAS.exec(entry.data.alias.trim()) : null;
    const segment = match === null ? undefined : window.segments[Number(match[1]) - 1 - window.offset];
    if (!entry.success || segment === undefined) {
      dropped += 1;
      continue;
    }
    if (seen.has(segment.id)) {
      continue;
    }
    seen.add(segment.id);
    items.push({
      segmentId: segment.id as SegmentId,
      score: Math.min(MAX_SCORE, Math.max(0, Math.round(entry.data.score))),
      text: entry.data.text?.trim() ?? "",
    });
  }
  if (entries.length > 0 && dropped / entries.length > CITATION_INVALID_RATIO_MAX) {
    throw amberError("output_mismatch", "too many highlights name no sentence of their window");
  }
  return { items, dropped };
}

/** Items of all windows in sentence order; a sentence appears once. */
function mergeWindows(segments: readonly TranscriptSegment[], payloads: readonly WindowPayload[]): HighlightItem[] {
  const position = new Map(segments.map((segment, index) => [segment.id as string, index]));
  const byId = new Map<string, HighlightItem>();
  for (const item of payloads.flatMap((payload) => payload.items)) {
    if (!position.has(item.segmentId)) {
      throw amberError("internal", "a stored highlight points outside the base transcript");
    }
    if (!byId.has(item.segmentId)) {
      byId.set(item.segmentId, { segmentId: item.segmentId as SegmentId, score: item.score, text: item.text });
    }
  }
  return [...byId.values()].sort((a, b) => (position.get(a.segmentId) as number) - (position.get(b.segmentId) as number));
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
