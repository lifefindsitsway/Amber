import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { TRANSLATE_BATCH_LINES } from "../../../shared/defaults.ts";
import type { SegmentId } from "../../../shared/ids.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import { amberError } from "../../domain/errors.ts";
import type { ModelRef } from "../../domain/model-ref.ts";
import { outputLanguageName, renderPrompt, type ResolvedPrompt } from "../../domain/prompts.ts";
import { translateRequestSchema } from "../../domain/task-request.ts";
import { termsSection } from "../../domain/terminology.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../domain/transcript.ts";
import type { Repository } from "../../ports/repository.ts";
import { assertBaseRevisionExists, stageUnitFailure, type StageExecutionContext, type StageExecutor, type StageOutcome, type UnitIdentity } from "../executor.ts";
import { taskContent } from "./platform-access.ts";

export interface TranslateStageDeps {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

const LINE_PATTERN = /^(\d+)\.\s*(.*)$/;

/** One batch's result as kept in `WorkUnitResult`. */
const batchPayloadSchema = z.object({
  texts: z.array(z.string()),
  invocationId: z.string(),
});
type BatchPayload = z.infer<typeof batchPayloadSchema>;

interface Batch {
  language: string;
  index: number;
  segments: TranscriptSegment[];
}

/**
 * The `translate` stage (the `translate.subtitles` prompt). The base revision frozen at
 * submission is cut into batches of `TRANSLATE_BATCH_LINES` sentences per target language; each batch is a
 * paid DB-only WorkUnit sent as a numbered list and answered as one, so a missing, extra,
 * duplicated or empty line is caught at once as `output_mismatch` and the batch re-asked.
 * Every batch is queued at once; how many run together is up to the model lane.
 * Batch size is fixed, so the model's context window plays no part.
 *
 * Once every batch is done, one transaction publishes a `translated` revision per language:
 * the base's sentences and timing, each pointing at exactly its parent sentence. It becomes
 * the language's current translation, never the primary, and the calls that produced it
 * are attributed to it.
 */
export class TranslateStageExecutor implements StageExecutor {
  private readonly deps: TranslateStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: TranslateStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const content = taskContent(repository, context);
    const owner = content.userId;
    const request = translateRequestSchema.parse(context.request);
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "translation needs a model");
    }
    const model = context.llm.describe(modelRef);
    const prompt = context.prompt("translate.subtitles");
    const { base, segments, terms } = repository.withTransaction((scope) => {
      const revision = scope.transcripts.getRevision(owner, request.baseRevisionId);
      if (revision === undefined || revision.contentId !== content.id || revision.kind === "translated") {
        throw amberError("internal", "the base revision of the translation is gone or not translatable");
      }
      return {
        base: revision,
        segments: scope.transcripts.listSegments(owner, revision.id),
        terms: termsSection(scope.terminology.effectiveFor(owner, content.id)),
      };
    });
    if (segments.length === 0) {
      throw amberError("internal", "the base revision has no sentences");
    }

    // Every batch is queued at once; how many run together is up to the model lane.
    const batches = request.targetLanguages.flatMap((language) => batchesOf(language, segments));
    let settledCount = 0;
    const settled = await Promise.allSettled(
      batches.map(async (batch) => {
        const payload = await this.runBatch(context, { batch, base, termsSection: terms, modelRef, prompt });
        settledCount += 1;
        context.reportProgress(settledCount / batches.length);
        return payload;
      }),
    );
    if (context.signal.aborted) {
      throw context.signal.reason;
    }
    // A batch waiting for the user or for its retry time keeps the stage waiting; completed ones are kept and reused.
    const failure = stageUnitFailure(settled);
    if (failure !== undefined) {
      throw failure;
    }
    const payloads = settled.map((result) => (result as PromiseFulfilledResult<BatchPayload>).value);

    const createdAt = this.now();
    const published = request.targetLanguages.map((language) => {
      const own = batches.flatMap((batch, position) => (batch.language === language ? [payloads[position] as BatchPayload] : []));
      const texts = own.flatMap((payload) => payload.texts);
      const revisionId = this.newId();
      const translated: TranscriptSegment[] = segments.map((parent, position) => ({
        id: this.newId() as SegmentId,
        revisionId,
        ordinal: parent.ordinal,
        startMs: parent.startMs,
        endMs: parent.endMs,
        text: texts[position] as string,
        ...(parent.speakerId === undefined ? {} : { speakerId: parent.speakerId }),
        // One sentence per parent sentence, so the parent's paragraphing holds for the translation.
        ...(parent.paragraphStart === undefined ? {} : { paragraphStart: parent.paragraphStart }),
        sourceSegmentIds: [parent.id],
      }));
      const revision: TranscriptRevision = {
        id: revisionId,
        contentId: content.id,
        kind: "translated",
        parentRevisionId: base.id,
        language,
        timingFidelity: "segment_only",
        generation: {
          kind: "llm",
          modelRef: model.snapshot,
          promptRef: prompt.ref,
          promptRefs: [prompt.ref],
          promptSnapshot: renderPrompt(prompt.text, { target_language: outputLanguageName(language), terms_section: terms }),
        },
        segmentCount: translated.length,
        createdAt,
      };
      return { language, revision, segments: translated, artifactId: this.newId(), invocationIds: own.map((payload) => payload.invocationId) };
    });

    return {
      resultJson: {
        revisions: published.map(({ language, revision }) => ({ language, revisionId: revision.id })),
        batches: batches.length,
        reasons: [],
      },
      publish: (scope) => {
        assertBaseRevisionExists(scope, owner, content.id, base.id);
        for (const entry of published) {
          scope.transcripts.insertRevision(owner, entry.revision, entry.segments);
          scope.translations.setCurrent(owner, content.id, entry.language, entry.revision.id, entry.artifactId);
          scope.tokenUsage.attach(owner, entry.invocationIds, entry.revision.id);
        }
      },
    };
  }

  private async runBatch(
    context: StageExecutionContext,
    input: { batch: Batch; base: TranscriptRevision; termsSection: string; modelRef: ModelRef; prompt: ResolvedPrompt },
  ): Promise<BatchPayload> {
    const { batch, modelRef } = input;
    const sources = batch.segments.map((segment) => oneLine(segment.text));
    const inputDigest = digestOf(
      canonicalJson({
        baseRevisionId: input.base.id,
        language: batch.language,
        i: batch.index,
        segmentIds: batch.segments.map((segment) => segment.id),
        texts: sources,
        termsSection: input.termsSection,
        promptRef: input.prompt.ref,
        modelRef,
      }),
    );
    const prompt = renderPrompt(input.prompt.text, {
      target_language: outputLanguageName(batch.language),
      count: String(sources.length),
      terms_section: input.termsSection,
      subtitles: sources.map((text, offset) => `${offset + 1}. ${text}`).join("\n"),
    });
    const value = await context.runUnit({
      key: `translate:${batch.language}:batch:${batch.index}`,
      inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity): Promise<BatchPayload> => {
        const completion = await context.llm.complete(
          { modelRef, system: "", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
          { feature: "translate", workUnitId: unit.id },
        );
        return { texts: parseAnswer(completion.text, sources.length), invocationId: completion.invocationId };
      },
    });
    const parsed = batchPayloadSchema.safeParse(value);
    if (!parsed.success || parsed.data.texts.length !== batch.segments.length) {
      throw amberError("internal", "a stored translation batch does not match its batch");
    }
    return parsed.data;
  }
}

/** Fixed-size batches of one language (the last one takes the rest), numbered from 0. */
function batchesOf(language: string, segments: readonly TranscriptSegment[]): Batch[] {
  const batches: Batch[] = [];
  for (let start = 0, index = 0; start < segments.length; start += TRANSLATE_BATCH_LINES, index += 1) {
    batches.push({ language, index, segments: segments.slice(start, start + TRANSLATE_BATCH_LINES) });
  }
  return batches;
}

/**
 * The translation of each line, in order. Blank lines are ignored; every other line must be
 * `N. text` with the numbers exactly 1..count, each once, and no translation may be empty —
 * a source line is never carried over into a translated revision.
 */
function parseAnswer(answer: string, count: number): string[] {
  const byNumber = new Map<number, string>();
  for (const raw of answer.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const match = LINE_PATTERN.exec(line);
    const number = match === null ? Number.NaN : Number(match[1]);
    const text = (match?.[2] ?? "").trim();
    if (!Number.isInteger(number) || number < 1 || number > count || byNumber.has(number) || text === "") {
      throw amberError("output_mismatch", "translation answer does not match the batch's numbered lines");
    }
    byNumber.set(number, text);
  }
  if (byNumber.size !== count) {
    throw amberError("output_mismatch", "translation answer does not match the batch's numbered lines");
  }
  return Array.from({ length: count }, (_, offset) => byNumber.get(offset + 1) as string);
}

/** A segment is always one physical line on the wire; the stored text is unchanged. */
function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
