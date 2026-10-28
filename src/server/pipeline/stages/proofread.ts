import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import {
  PROOFREAD_AUDIO_MAX_MB,
  PROOFREAD_CHUNK_SENTENCES,
  PROOFREAD_CONTEXT_SENTENCES,
  PROOFREAD_SPLIT_MAX_EXTRA_UNITS,
  PROOFREAD_SPLIT_MAX_UNITS_PER_ROOT,
} from "../../../shared/defaults.ts";
import type { SegmentId } from "../../../shared/ids.ts";
import { readingSeparator } from "../../../shared/reading.ts";
import { BYTES_PER_MB } from "../../../shared/units.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import type { Content } from "../../domain/content.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import type { LlmCompletion, LlmContentPart, LlmRequest, LlmStopReason } from "../../domain/llm.ts";
import type { MediaAsset } from "../../domain/media-asset.ts";
import type { ModelRef, PromptRef } from "../../domain/model-ref.ts";
import { composeProofreadAudioPrompt, renderPrompt, type ResolvedPrompt } from "../../domain/prompts.ts";
import { reproofreadRequestSchema } from "../../domain/task-request.ts";
import { termsSection } from "../../domain/terminology.ts";
import { revisionTakesPrimary, type TranscriptRevision, type TranscriptSegment } from "../../domain/transcript.ts";
import type { FileStore } from "../../ports/file-store.ts";
import type { LocalMediaIngest } from "../../ports/local-media-ingest.ts";
import type { Repository } from "../../ports/repository.ts";
import {
  assertBaseRevisionExists,
  StageDeferred,
  StageParked,
  stageUnitFailure,
  type StageExecutionContext,
  type StageExecutor,
  type StageOutcome,
  type UnitIdentity,
} from "../executor.ts";
import type { MediaFiles } from "../media-files.ts";
import { ensureExtractedAudio } from "./extracted-audio.ts";
import { platformTarget, taskContent, type PlatformAccess } from "./platform-access.ts";
import { availableMediaSource, taskScratchRef } from "./source-media.ts";

export interface ProofreadStageDeps {
  repository: Repository;
  /** The data store: audio clips and the Task's extracted audio live here. */
  files: FileStore;
  /** Where the source media is read from by its kind; defaults to `files` for every kind. */
  media?: Pick<MediaFiles, "storeFor">;
  ingest: LocalMediaIngest;
  /** Platform Contents without a cached video download their audio through here. */
  platforms?: PlatformAccess;
  now?: () => number;
  newId?: () => string;
}

const RANGE_KEY_PREFIX = "proofread:range:";
/**
 * How a mismatched answer is split, part of every range's input digest: a change to which
 * answers may split, where a range is cut or how a stored result reads must not reuse
 * results produced under the old rules.
 */
const SPLIT_STRATEGY = 1;
/** The paragraph-start mark of the `proofread.text` prompt: protocol, never content, so it is scrubbed from what is sent. */
const PARAGRAPH_MARK = "¶";
const LINE_PATTERN = /^\[s(\d+)\]\s*(¶)?\s*(.*)$/;
/** A paragraph mark inside a sentence's text, with the whitespace around it and any marks repeated after it. */
const INLINE_MARK_RUN = /\s*¶[\s¶]*/gu;
const CLIP_EXTENSIONS: Readonly<Record<string, string>> = { "audio/wav": "wav", "audio/mpeg": "mp3" };

const promptRefSchema = z.object({ id: z.string(), version: z.number().int() });
const aliasListSchema = z.array(z.number().int().positive());

/** What an answer's lines amount to against the range's aliases; counts and aliases only, never text. */
const diagnosticSchema = z.object({
  expectedCount: z.number().int().positive(),
  nonBlankLineCount: z.number().int().nonnegative(),
  validUniqueAliasCount: z.number().int().nonnegative(),
  missingAliases: aliasListSchema,
  duplicateAliases: aliasListSchema,
  outOfRangeAliases: z.array(z.number().int().nonnegative()),
  invalidLineCount: z.number().int().nonnegative(),
  stopReason: z.enum(["stop", "length", "error", "refused", "aborted"]),
  /** The answer was cut off by the output limit and only its last line is broken. */
  truncatedTail: z.boolean(),
});
type AnswerDiagnostic = z.infer<typeof diagnosticSchema>;

/**
 * One range's result as kept in `WorkUnitResult`, the range-level truth:
 * either its corrected sentences, or the decision to split it in two, which is a finished
 * unit of its own so that a re-run reuses it instead of asking the whole range again.
 */
const rangePayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("accepted"),
    texts: z.array(z.string()),
    /** Which target sentences the model marked as paragraph starts, in order. */
    paragraphStarts: z.array(z.boolean()),
    /**
     * Aliases whose text carried a paragraph mark: the paragraph turns after that sentence,
     * so the next one opens it. Ascending and unique.
     */
    paragraphBreakAfterAliases: aliasListSchema,
    emptyLines: z.number().int().nonnegative(),
    promptRef: promptRefSchema,
    audio: z.boolean(),
    audioDigest: z.string().exactOptional(),
    invocationId: z.string(),
  }),
  z.object({
    kind: z.literal("split"),
    diagnostic: diagnosticSchema,
    promptRef: promptRefSchema,
    audio: z.boolean(),
    invocationId: z.string(),
  }),
]);
type RangePayload = z.infer<typeof rangePayloadSchema>;
type AcceptedPayload = Extract<RangePayload, { kind: "accepted" }>;
type SplitPayload = Extract<RangePayload, { kind: "split" }>;

/**
 * Sentences proofread in one call: a chunk of `PROOFREAD_CHUNK_SENTENCES` (a root, depth 0)
 * or one half of a range that was split.
 */
interface Range {
  rootIndex: number;
  depth: number;
  targets: TranscriptSegment[];
  /** Global aliases: `s<position + 1>` inside the base revision. */
  firstAlias: number;
  before: TranscriptSegment[];
  after: TranscriptSegment[];
}

/** The Task's extracted audio and what it was made from, when audio assistance is on. */
interface AudioPlan {
  asset: MediaAsset;
  source: string;
  mimeType: string;
}

interface RangeInput {
  baseRevisionId: string;
  termsSection: string;
  modelRef: ModelRef;
  audio: AudioPlan | undefined;
  prompts: RangePrompts;
}

/**
 * The prompts a range may be sent with: the text proofreading prompt, and the audio variant
 * made of the audio preamble around it, both in effect for this stage.
 */
interface RangePrompts {
  text: ResolvedPrompt;
  audio: ResolvedPrompt;
}

/**
 * The `proofread` stage of `process_content` and `reproofread`. The base
 * revision — the runtime primary, or the one frozen in the request — is cut into chunks of
 * `PROOFREAD_CHUNK_SENTENCES` sentences; each is a range proofread by one paid DB-only
 * WorkUnit, sent with read-only context and the effective terminology in the line protocol
 * of the `proofread.text` prompt, the model also marking the sentences that open a
 * paragraph. When the model accepts audio, each range carries its clip of the Task's extracted audio, cut only
 * once the call was admitted, in a heavy-job slot, so a cooling lane leaves no clips behind;
 * a range whose clip is too large or cannot be made or encoded falls back to text alone.
 *
 * An answer whose lines do not match the range's aliases one to one is split when its
 * structure is clean and only some lines are missing or the answer was cut off: the range's
 * unit succeeds with a `split` result and its two halves are asked in the next wave, down to
 * single sentences. Any other mismatch is `output_mismatch` and the range is asked again as
 * a whole. Waves run one after another and children are reserved only between waves, in
 * (chunk, first alias) order, against two budgets, so a crash, a re-entry or a new attempt
 * reusing the earlier results always grows the same tree to the same limit.
 *
 * Once every range is accepted, one transaction publishes the `corrected` revision built
 * from them: same sentences and timing as the base, each pointing at exactly its parent
 * sentence and carrying its paragraph mark (the first sentence always opens one); it becomes
 * primary only if the base is still primary, and the calls of the accepted ranges are
 * attributed to it. Nothing is published while any range failed.
 */
export class ProofreadStageExecutor implements StageExecutor {
  private readonly deps: ProofreadStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: ProofreadStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const content = taskContent(repository, context);
    const owner = content.userId;
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "proofreading needs a model");
    }
    const model = context.llm.describe(modelRef);
    const { revision: base, segments } = this.baseRevision(context, content);
    if (segments.length === 0) {
      throw amberError("internal", "the base revision has no sentences");
    }
    const terms = termsSection(repository.withTransaction((scope) => scope.terminology.effectiveFor(owner, content.id)));

    // A model declared able to take audio behind a protocol that cannot encode any is still
    // proofread as text, range by range recorded as downgraded.
    const wantsAudio = model.capability.flags.audioInput === "supported";
    const mimeType = model.audioMimeTypes[0];
    const audio = wantsAudio && mimeType !== undefined ? await this.audioPlan(context, content, mimeType) : undefined;
    const textPrompt = context.prompt("proofread.text");
    const audioPrompt = context.prompt("proofread.audio");
    const prompts: RangePrompts = {
      text: textPrompt,
      audio: { ref: audioPrompt.ref, text: composeProofreadAudioPrompt(audioPrompt.text, textPrompt.text) },
    };
    const input: RangeInput = { baseRevisionId: base.id, termsSection: terms, modelRef, audio, prompts };

    const roots = rootsOf(segments);
    const tree = await this.proofreadTree(context, roots, segments, input);
    const accepted = tree.accepted;

    const reasons: string[] = [];
    const chunks = roots.map((root) => rootSummary(root, accepted.filter((leaf) => leaf.range.rootIndex === root.rootIndex), prompts));
    if (wantsAudio) {
      chunks.forEach((chunk) => {
        if (chunk.audioMode !== "audio") {
          reasons.push(`audio_downgraded:${chunk.i}`);
        }
      });
    }
    if (accepted.some((leaf) => leaf.payload.emptyLines > 0)) {
      reasons.push("proofread_empty_lines");
    }
    const paragraphStarts = accepted.flatMap((leaf) => leaf.payload.paragraphStarts);
    const paragraphMarks = moveInlineParagraphMarks(
      paragraphStarts,
      accepted.flatMap((leaf) => leaf.payload.paragraphBreakAfterAliases),
    );
    if (paragraphMarks.moved > 0) {
      reasons.push("proofread_paragraph_mark_moved");
    }
    if (paragraphMarks.droppedAtEnd > 0) {
      reasons.push("proofread_paragraph_mark_dropped_at_end");
    }
    for (const chunk of chunks) {
      if (chunk.split) {
        reasons.push(`proofread_split:${chunk.i}`);
      }
    }

    // Only the prompts that produced accepted text are recorded: audio ranges were sent the
    // audio preamble around the text prompt, text ranges the text prompt alone.
    const withAudio = accepted.some((leaf) => leaf.payload.audio);
    const prompt = withAudio ? prompts.audio : prompts.text;
    const promptRefs = withAudio ? [prompts.audio.ref, prompts.text.ref] : [prompts.text.ref];
    const revisionId = this.newId();
    const texts = accepted.flatMap((leaf) => leaf.payload.texts);
    const corrected: TranscriptSegment[] = segments.map((parent, position) => ({
      id: this.newId() as SegmentId,
      revisionId,
      ordinal: parent.ordinal,
      startMs: parent.startMs,
      endMs: parent.endMs,
      text: texts[position] as string,
      ...(parent.speakerId === undefined ? {} : { speakerId: parent.speakerId }),
      // A revision's first sentence opens its first paragraph whatever the model said.
      paragraphStart: position === 0 || (paragraphStarts[position] as boolean),
      sourceSegmentIds: [parent.id],
    }));
    const revision: TranscriptRevision = {
      id: revisionId,
      contentId: content.id,
      kind: "corrected",
      parentRevisionId: base.id,
      language: base.language,
      timingFidelity: "inherited_segment",
      generation: { kind: "llm", modelRef: model.snapshot, promptRef: prompt.ref, promptRefs, promptSnapshot: renderPrompt(prompt.text, { terms_section: terms }) },
      segmentCount: corrected.length,
      createdAt: this.now(),
    };
    // Only the calls whose answers went into the revision produced it; a call that decided a
    // split stays on its WorkUnit and in `ranges`.
    const invocationIds = accepted.map((leaf) => leaf.payload.invocationId);
    return {
      resultJson: {
        revisionId,
        baseRevisionId: base.id,
        chunks,
        ranges: tree.ranges,
        paragraphMarks,
        reasons,
      },
      publish: (scope) => {
        assertBaseRevisionExists(scope, owner, content.id, base.id);
        scope.transcripts.insertRevision(owner, revision, corrected);
        const current = scope.contents.getIncludingTrashed(owner, content.id);
        const primary =
          current?.primaryTranscriptRevisionId === undefined ? undefined : scope.transcripts.getRevision(owner, current.primaryTranscriptRevisionId);
        if (revisionTakesPrimary(revision, primary)) {
          scope.contents.setPrimaryTranscript(owner, content.id, revision.id, this.now());
          scope.search.syncContent(owner, content.id);
        }
        scope.tokenUsage.attach(owner, invocationIds, revision.id);
      },
    };
  }

  /**
   * Proofreads the roots wave by wave. Every wave settles before the next is planned, so the
   * children of the splits are reserved at one point, in a stable order, against the budgets
   * counted over every earlier wave, reused units included. A wave with a unit that failed,
   * waits for the user or waits for its retry time starts no further wave; the stage throws
   * as `stageUnitFailure` decides and, once re-entered, grows the same tree again from the
   * stored results.
   */
  private async proofreadTree(
    context: StageExecutionContext,
    roots: readonly Range[],
    segments: readonly TranscriptSegment[],
    input: RangeInput,
  ): Promise<{ accepted: Array<{ range: Range; payload: AcceptedPayload }>; ranges: RangeRecord[] }> {
    const unitsPerRoot = roots.map(() => 1);
    let extraUnits = 0;
    let acceptedSentences = 0;
    const accepted: Array<{ range: Range; payload: AcceptedPayload }> = [];
    const ranges: RangeRecord[] = [];
    let wave: Range[] = [...roots];
    while (wave.length > 0) {
      const settled = await Promise.allSettled(
        wave.map(async (range) => {
          const payload = await this.runRange(context, range, input);
          if (payload.kind === "accepted") {
            acceptedSentences += range.targets.length;
            context.reportProgress(acceptedSentences / segments.length);
          }
          return payload;
        }),
      );
      if (context.signal.aborted) {
        throw context.signal.reason;
      }
      const failure = stageUnitFailure(settled);
      if (failure !== undefined) {
        throw failure;
      }
      const results = wave
        .map((range, index) => ({ range, payload: (settled[index] as PromiseFulfilledResult<RangePayload>).value }))
        .sort((a, b) => a.range.rootIndex - b.range.rootIndex || a.range.firstAlias - b.range.firstAlias);
      const next: Range[] = [];
      for (const { range, payload } of results) {
        ranges.push({
          firstAlias: range.firstAlias,
          lastAlias: lastAliasOf(range),
          depth: range.depth,
          kind: payload.kind,
          promptRef: payload.promptRef,
          audio: payload.audio,
          invocationId: payload.invocationId,
        });
        if (payload.kind === "accepted") {
          accepted.push({ range, payload });
          continue;
        }
        const rootUnits = unitsPerRoot[range.rootIndex] as number;
        if (rootUnits + 2 > PROOFREAD_SPLIT_MAX_UNITS_PER_ROOT || extraUnits + 2 > PROOFREAD_SPLIT_MAX_EXTRA_UNITS) {
          throw splitLimit(range, payload, rootUnits, extraUnits);
        }
        unitsPerRoot[range.rootIndex] = rootUnits + 2;
        extraUnits += 2;
        next.push(...halvesOf(range, segments));
      }
      wave = next;
    }
    accepted.sort((a, b) => a.range.firstAlias - b.range.firstAlias);
    let expected = 1;
    for (const leaf of accepted) {
      if (leaf.range.firstAlias !== expected) {
        throw amberError("internal", "accepted proofread ranges do not tile the transcript");
      }
      expected += leaf.range.targets.length;
    }
    if (expected !== segments.length + 1) {
      throw amberError("internal", "accepted proofread ranges do not tile the transcript");
    }
    return { accepted, ranges };
  }

  private async runRange(context: StageExecutionContext, range: Range, input: RangeInput): Promise<RangePayload> {
    const { audio } = input;
    const clip = clipRange(range);
    const audioDigest = audio === undefined ? undefined : digestOf(canonicalJson({ source: audio.source, range: clip, mimeType: audio.mimeType }));
    const { prompts } = input;
    const lastAlias = lastAliasOf(range);
    const inputDigest = digestOf(
      canonicalJson({
        baseRevisionId: input.baseRevisionId,
        firstAlias: range.firstAlias,
        lastAlias,
        splitStrategy: SPLIT_STRATEGY,
        targetSegmentIds: range.targets.map((segment) => segment.id),
        targetTexts: range.targets.map((segment) => segment.text),
        contextIds: [...range.before, ...range.after].map((segment) => segment.id),
        termsSection: input.termsSection,
        // A range with audio may still fall back to text, so both prompts it may be sent with count.
        promptRef: audio === undefined ? prompts.text.ref : prompts.audio.ref,
        ...(audio === undefined ? {} : { textPromptRef: prompts.text.ref }),
        modelRef: input.modelRef,
        ...(audioDigest === undefined ? {} : { audioChunkDigest: audioDigest }),
      }),
    );
    const value = await context.runUnit({
      key: `${RANGE_KEY_PREFIX}${range.firstAlias}-${lastAlias}`,
      inputDigest,
      billing: "llm",
      run: async (signal: AbortSignal, unit: UnitIdentity): Promise<RangePayload> => {
        if (audio !== undefined) {
          const withAudio = await this.proofreadWithAudio(context, { range, termsSection: input.termsSection, modelRef: input.modelRef, audio, prompts }, clip, unit, signal);
          if (withAudio !== undefined) {
            return withAudio.kind === "accepted" && withAudio.audio ? { ...withAudio, audioDigest: audioDigest as string } : withAudio;
          }
        }
        return this.proofread(context, { range, termsSection: input.termsSection, modelRef: input.modelRef, prompt: prompts.text }, unit);
      },
    });
    const parsed = rangePayloadSchema.safeParse(value);
    if (!parsed.success || !fitsRange(parsed.data, range)) {
      throw amberError("internal", "stored proofread range does not match its range");
    }
    return parsed.data;
  }

  /** `process_content` proofreads the primary as it is now; `reproofread` the one frozen at submission. */
  private baseRevision(context: StageExecutionContext, content: Content): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
    const owner = content.userId;
    const revisionId =
      context.task.kind === "reproofread" ? reproofreadRequestSchema.parse(context.request).baseRevisionId : content.primaryTranscriptRevisionId;
    if (revisionId === undefined) {
      throw amberError("internal", "no primary transcript to proofread");
    }
    return this.deps.repository.withTransaction((scope) => {
      const revision = scope.transcripts.getRevision(owner, revisionId);
      if (revision === undefined || revision.contentId !== content.id) {
        throw amberError("not_found", "base transcript revision not found");
      }
      return { revision, segments: scope.transcripts.listSegments(owner, revisionId) };
    });
  }

  /**
   * The Task's extracted audio for clipping, or `undefined` when there is none to be had:
   * no media to take it from, no audio track, a failed download. Proofreading then goes on
   * as text, every chunk recorded as downgraded.
   */
  private async audioPlan(context: StageExecutionContext, content: Content, mimeType: string): Promise<AudioPlan | undefined> {
    const source = this.audioSource(content);
    if (source === undefined) {
      return undefined;
    }
    try {
      // No progress sinks: this stage's progress counts its chunks only.
      const { asset } = await ensureExtractedAudio(context, {
        repository: this.deps.repository,
        files: this.deps.files,
        ...(this.deps.media === undefined ? {} : { media: this.deps.media }),
        ingest: this.deps.ingest,
        ...(this.deps.platforms === undefined ? {} : { platforms: this.deps.platforms }),
        now: this.now,
        newId: this.newId,
      });
      return { asset, source, mimeType };
    } catch (error) {
      // Extraction that waits for the user or for its retry time is tried again with the stage.
      if (context.signal.aborted || error instanceof StageParked || error instanceof StageDeferred) {
        throw error;
      }
      return undefined;
    }
  }

  /**
   * What the audio is made from, stable across re-extraction: the clip digests must not
   * depend on extracted bytes, or a re-run after the Task's audio was cleaned up could never
   * reuse a completed range.
   */
  private audioSource(content: Content): string | undefined {
    const source = this.deps.repository.withTransaction((scope) => availableMediaSource(scope, content.userId, content.id));
    if (source !== undefined) {
      return source.fingerprint ?? `asset:${source.id}`;
    }
    const target = this.deps.platforms === undefined ? undefined : platformTarget(this.deps.platforms, content);
    return target === undefined ? undefined : `platform:${target.adapter.kind}:${target.ref.platformContentId}:${target.ref.platformPartId ?? ""}`;
  }

  /**
   * The audio variant of one range, built once the call was admitted: the clip is cut in a
   * heavy-job slot and, when it cannot be made or is too large, the same call is sent as
   * text instead. `undefined` asks the caller to fall back to text when the call reports it
   * cannot take the audio (`llm_capability`). The clip is scratch and removed afterwards.
   */
  private async proofreadWithAudio(
    context: StageExecutionContext,
    input: { range: Range; termsSection: string; modelRef: ModelRef; audio: AudioPlan; prompts: RangePrompts },
    range: { startMs: number; endMs: number },
    unit: UnitIdentity,
    signal: AbortSignal,
  ): Promise<RangePayload | undefined> {
    const { files } = this.deps;
    const { audio } = input;
    const clipRef = `${taskScratchRef(context.task.id)}/proofread-${unit.id}.${CLIP_EXTENSIONS[audio.mimeType] ?? "audio"}`;
    const base = { range: input.range, termsSection: input.termsSection, modelRef: input.modelRef };
    let clipped = false;
    const prepare = async (callSignal: AbortSignal): Promise<LlmRequest> => {
      try {
        const { sizeBytes } = await context.withHeavySlot(() =>
          files.writeAtomic(clipRef, (partial) => this.clipTaskAudio(context, audio.asset, partial, range, audio.mimeType, callSignal)),
        );
        if (sizeBytes <= PROOFREAD_AUDIO_MAX_MB * BYTES_PER_MB) {
          clipped = true;
          return rangeRequest({ ...base, prompt: input.prompts.audio, clip: { mimeType: audio.mimeType, dataRef: clipRef } });
        }
      } catch (error) {
        if (callSignal.aborted) {
          throw error;
        }
      }
      return rangeRequest({ ...base, prompt: input.prompts.text });
    };
    try {
      const completion = await context.llm.complete({ modelRef: input.modelRef, prepare }, { feature: "proofread", workUnitId: unit.id });
      return rangePayload(completion, input.range, clipped ? input.prompts.audio : input.prompts.text, clipped);
    } catch (error) {
      if (clipped && !signal.aborted && isAmberError(error) && error.appError.class === "llm_capability") {
        return undefined;
      }
      throw error;
    } finally {
      await files.remove(clipRef).catch(() => undefined);
    }
  }

  /** Clips only the Task's own extracted audio; no other file is ever handed to the tool. */
  private async clipTaskAudio(
    context: StageExecutionContext,
    asset: MediaAsset,
    partialPath: string,
    range: { startMs: number; endMs: number },
    mimeType: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (asset.kind !== "extracted_audio" || asset.taskId !== context.task.id) {
      throw amberError("internal", "only the Task's extracted audio may be clipped");
    }
    await this.deps.ingest.clipAudio({ path: this.deps.files.pathOf(asset.storageRef) }, { path: partialPath }, range, mimeType, signal);
  }

  /** One text call for one range and the check of its answer against the range's aliases. */
  private async proofread(
    context: StageExecutionContext,
    input: { range: Range; termsSection: string; modelRef: ModelRef; prompt: ResolvedPrompt },
    unit: UnitIdentity,
  ): Promise<RangePayload> {
    const completion = await context.llm.complete(rangeRequest(input), { feature: "proofread", workUnitId: unit.id });
    return rangePayload(completion, input.range, input.prompt, false);
  }
}

/** The request for one range in the line protocol of the `proofread.text` prompt, with its audio clip when given. */
function rangeRequest(input: {
  range: Range;
  termsSection: string;
  modelRef: ModelRef;
  prompt: ResolvedPrompt;
  clip?: { mimeType: string; dataRef: string };
}): LlmRequest {
  const { range } = input;
  const lines = (segments: readonly TranscriptSegment[], firstAlias: number): string =>
    segments.map((segment, offset) => `[s${firstAlias + offset}] ${oneLine(segment.text)}`).join("\n");
  const text = renderPrompt(input.prompt.text, {
    terms_section: input.termsSection,
    context_before: lines(range.before, range.firstAlias - range.before.length),
    count: String(range.targets.length),
    target_lines: lines(range.targets, range.firstAlias),
    context_after: lines(range.after, range.firstAlias + range.targets.length),
  });
  const parts: LlmContentPart[] = [{ type: "text", text }];
  if (input.clip !== undefined) {
    parts.push({ type: "audio", mimeType: input.clip.mimeType, dataRef: input.clip.dataRef });
  }
  return { modelRef: input.modelRef, system: "", messages: [{ role: "user", content: parts }] };
}

/** What `resultJson.ranges` records of each range, in the order the waves settled. */
interface RangeRecord {
  firstAlias: number;
  lastAlias: number;
  depth: number;
  kind: RangePayload["kind"];
  promptRef: PromptRef;
  audio: boolean;
  invocationId: string;
}

/** A range's answer checked against its aliases, with what was sent. */
function rangePayload(completion: LlmCompletion, range: Range, prompt: ResolvedPrompt, audio: boolean): RangePayload {
  const answer = parseAnswer(completion, range);
  const sent = { promptRef: prompt.ref, audio, invocationId: completion.invocationId };
  return answer.kind === "split" ? { kind: "split", diagnostic: answer.diagnostic, ...sent } : { kind: "accepted", ...answer.lines, ...sent };
}

/** A stored result read back must still describe this very range. */
function fitsRange(payload: RangePayload, range: Range): boolean {
  if (payload.kind === "split") {
    return range.targets.length > 1;
  }
  return (
    payload.texts.length === range.targets.length &&
    payload.paragraphStarts.length === range.targets.length &&
    aliasesWithin(payload.paragraphBreakAfterAliases, range.firstAlias, range.targets.length)
  );
}

/** Fixed-size chunks (the last one takes the rest), the roots of the range trees. */
function rootsOf(segments: readonly TranscriptSegment[]): Range[] {
  const roots: Range[] = [];
  for (let start = 0, index = 0; start < segments.length; start += PROOFREAD_CHUNK_SENTENCES, index += 1) {
    roots.push(rangeOf(segments, { rootIndex: index, depth: 0 }, start, Math.min(start + PROOFREAD_CHUNK_SENTENCES, segments.length)));
  }
  return roots;
}

/** The two halves of a range, the first taking the odd sentence, each with its own context. */
function halvesOf(range: Range, segments: readonly TranscriptSegment[]): [Range, Range] {
  const start = range.firstAlias - 1;
  const end = start + range.targets.length;
  const middle = start + Math.ceil(range.targets.length / 2);
  const tree = { rootIndex: range.rootIndex, depth: range.depth + 1 };
  return [rangeOf(segments, tree, start, middle), rangeOf(segments, tree, middle, end)];
}

/** Positions `[start, end)` of the base revision, with `PROOFREAD_CONTEXT_SENTENCES` of read-only context on each side. */
function rangeOf(segments: readonly TranscriptSegment[], tree: { rootIndex: number; depth: number }, start: number, end: number): Range {
  return {
    ...tree,
    targets: segments.slice(start, end),
    firstAlias: start + 1,
    before: segments.slice(Math.max(0, start - PROOFREAD_CONTEXT_SENTENCES), start),
    after: segments.slice(end, end + PROOFREAD_CONTEXT_SENTENCES),
  };
}

function lastAliasOf(range: Range): number {
  return range.firstAlias + range.targets.length - 1;
}

type AudioMode = "text" | "audio" | "mixed";

/**
 * A chunk's entry in `resultJson.chunks`. A chunk never split reads as before; a split one
 * aggregates its accepted ranges: `audio` only when all used audio, the audio prompt unless
 * all were text (as the revision's prompt is chosen), `audioMode` telling the three apart.
 */
function rootSummary(
  root: Range,
  leaves: ReadonlyArray<{ payload: AcceptedPayload }>,
  prompts: RangePrompts,
): { i: number; firstAlias: number; lastAlias: number; split: boolean; acceptedLeafCount: number; promptRef: PromptRef; audio: boolean; audioMode: AudioMode } {
  const withAudio = leaves.filter((leaf) => leaf.payload.audio).length;
  const audioMode: AudioMode = withAudio === leaves.length ? "audio" : withAudio === 0 ? "text" : "mixed";
  return {
    i: root.rootIndex,
    firstAlias: root.firstAlias,
    lastAlias: lastAliasOf(root),
    split: leaves.length > 1,
    acceptedLeafCount: leaves.length,
    promptRef: audioMode === "text" ? prompts.text.ref : prompts.audio.ref,
    audio: audioMode === "audio",
    audioMode,
  };
}

/** A split that would pass a budget: no child is made, and the same model would hit it again. */
function splitLimit(range: Range, payload: SplitPayload, rootUnitsUsed: number, stageExtraUnitsUsed: number): Error {
  return amberError("output_mismatch", "proofread range split budget exhausted", {
    code: "output_mismatch.proofread_split_limit",
    details: {
      rootIndex: range.rootIndex,
      firstAlias: range.firstAlias,
      lastAlias: lastAliasOf(range),
      depth: range.depth,
      rootUnitsUsed,
      stageExtraUnitsUsed,
      rootUnitLimit: PROOFREAD_SPLIT_MAX_UNITS_PER_ROOT,
      stageExtraUnitLimit: PROOFREAD_SPLIT_MAX_EXTRA_UNITS,
      missingAliases: aliasNames(payload.diagnostic.missingAliases),
    },
  });
}

interface ParsedLines {
  texts: string[];
  paragraphStarts: boolean[];
  paragraphBreakAfterAliases: number[];
  emptyLines: number;
}

/**
 * The answer read against the range's aliases. Blank lines are ignored; every other line
 * must be `[s<n>] text` or `[s<n>] ¶ text`, and the aliases exactly the range's, each once,
 * in an answer that was not cut off: then each target gets its corrected text and paragraph
 * mark. A mark inside the text is not a breach: the model saw the paragraph turn
 * mid-sentence, so the mark is taken out and the next sentence opens the paragraph instead.
 * An empty text keeps the original sentence rather than deleting it.
 *
 * Otherwise the range splits when the answer is otherwise clean — no repeated or foreign
 * alias, no stray line except the broken last line of an answer cut off by the output limit
 * — at least one alias is right, and lines are missing or the answer was cut off: a local
 * slip such as two fragments merged into one line. Anything else (a note, a code fence, no
 * usable line at all, a single sentence) is `output_mismatch` and the range is asked again.
 */
function parseAnswer(completion: LlmCompletion, range: Range): { kind: "accepted"; lines: ParsedLines } | { kind: "split"; diagnostic: AnswerDiagnostic } {
  const lastAlias = lastAliasOf(range);
  const byAlias = new Map<number, { text: string; paragraphStart: boolean }>();
  const duplicates = new Set<number>();
  const outOfRange = new Set<number>();
  let nonBlankLineCount = 0;
  let invalidLineCount = 0;
  let lastLineInvalid = false;
  for (const raw of completion.text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    nonBlankLineCount += 1;
    const match = LINE_PATTERN.exec(line);
    lastLineInvalid = match === null;
    if (match === null) {
      invalidLineCount += 1;
      continue;
    }
    const alias = Number(match[1]);
    if (!Number.isSafeInteger(alias) || alias < range.firstAlias || alias > lastAlias) {
      outOfRange.add(alias);
    } else if (byAlias.has(alias)) {
      duplicates.add(alias);
    } else {
      byAlias.set(alias, { text: (match[3] ?? "").trim(), paragraphStart: match[2] !== undefined });
    }
  }
  const missing = range.targets.map((_, offset) => range.firstAlias + offset).filter((alias) => !byAlias.has(alias));
  const cutOff = completion.stopReason === "length";
  const truncatedTail = cutOff && invalidLineCount === 1 && lastLineInvalid;
  const diagnostic: AnswerDiagnostic = {
    expectedCount: range.targets.length,
    nonBlankLineCount,
    validUniqueAliasCount: byAlias.size,
    missingAliases: missing,
    duplicateAliases: [...duplicates].sort((a, b) => a - b),
    outOfRangeAliases: [...outOfRange].sort((a, b) => a - b),
    invalidLineCount,
    stopReason: completion.stopReason,
    truncatedTail,
  };
  const clean = duplicates.size === 0 && outOfRange.size === 0 && (invalidLineCount === 0 || truncatedTail);
  if (clean && invalidLineCount === 0 && missing.length === 0 && !cutOff) {
    return { kind: "accepted", lines: acceptedLines(range, byAlias) };
  }
  if (clean && range.targets.length > 1 && byAlias.size > 0 && (missing.length > 0 || cutOff)) {
    return { kind: "split", diagnostic };
  }
  throw linesMismatch(diagnostic);
}

function acceptedLines(range: Range, byAlias: ReadonlyMap<number, { text: string; paragraphStart: boolean }>): ParsedLines {
  let emptyLines = 0;
  const texts: string[] = [];
  const paragraphStarts: boolean[] = [];
  const paragraphBreakAfterAliases: number[] = [];
  range.targets.forEach((segment, offset) => {
    const alias = range.firstAlias + offset;
    const line = byAlias.get(alias) as { text: string; paragraphStart: boolean };
    let text = line.text;
    if (text.includes(PARAGRAPH_MARK)) {
      // Built in alias order, so the list is ascending and unique as stored results must be.
      paragraphBreakAfterAliases.push(alias);
      text = stripInlineParagraphMarks(text);
    }
    if (text === "") {
      emptyLines += 1;
      text = segment.text;
    }
    texts.push(text);
    paragraphStarts.push(line.paragraphStart);
  });
  return { texts, paragraphStarts, paragraphBreakAfterAliases, emptyLines };
}

function linesMismatch(diagnostic: AnswerDiagnostic): Error {
  return amberError("output_mismatch", "proofread answer does not match the range's lines", {
    code: "output_mismatch.proofread_lines",
    details: {
      expectedCount: diagnostic.expectedCount,
      nonBlankLineCount: diagnostic.nonBlankLineCount,
      validUniqueAliasCount: diagnostic.validUniqueAliasCount,
      missingAliases: aliasNames(diagnostic.missingAliases),
      duplicateAliases: aliasNames(diagnostic.duplicateAliases),
      outOfRangeAliases: aliasNames(diagnostic.outOfRangeAliases),
      invalidLineCount: diagnostic.invalidLineCount,
      stopReason: diagnostic.stopReason,
      truncatedTail: diagnostic.truncatedTail,
    },
  });
}

function aliasNames(aliases: readonly number[]): string[] {
  return [...new Set(aliases)].sort((a, b) => a - b).map((alias) => `s${alias}`);
}

/** The range's clip covers its context sentences too, matching what the model reads. */
function clipRange(range: Range): { startMs: number; endMs: number } {
  const first = range.before[0] ?? (range.targets[0] as TranscriptSegment);
  const last = range.after.at(-1) ?? (range.targets.at(-1) as TranscriptSegment);
  return { startMs: first.startMs, endMs: last.endMs };
}

/**
 * A sentence's text without its inline paragraph marks. Where the mark sat between two
 * pieces with no whitespace (`中郎¶将`) they are joined as they were, since the mark split a
 * word; where whitespace surrounded it, the reading separator decides whether one space
 * stays (`end.¶ Next` keeps it, `的。¶ 势` and `老师 ¶ 和` drop it). Proofread output always
 * belongs to a revision with paragraph marks, so the separator is the marked one.
 */
export function stripInlineParagraphMarks(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(INLINE_MARK_RUN)) {
    const left = out + text.slice(last, match.index);
    const end = match.index + match[0].length;
    const spaced = match[0].replaceAll(PARAGRAPH_MARK, "") !== "";
    out = left + (spaced ? readingSeparator(left, text.slice(end), true) : "");
    last = end;
  }
  return (out + text.slice(last)).trim();
}

/**
 * Marks the sentence after each inline paragraph mark as a paragraph start, across range
 * boundaries; a mark on the last sentence of the transcript has nowhere to go.
 */
function moveInlineParagraphMarks(paragraphStarts: boolean[], breakAfterAliases: readonly number[]): { moved: number; droppedAtEnd: number } {
  let moved = 0;
  let droppedAtEnd = 0;
  for (const alias of breakAfterAliases) {
    // Alias `s<n>` is position n - 1, so the next sentence sits at position n.
    if (alias < paragraphStarts.length) {
      paragraphStarts[alias] = true;
      moved += 1;
    } else {
      droppedAtEnd += 1;
    }
  }
  return { moved, droppedAtEnd };
}

/** Ascending, unique and inside `[first, first + count - 1]`. */
function aliasesWithin(aliases: readonly number[], first: number, count: number): boolean {
  return aliases.every((alias, index) => alias >= first && alias < first + count && (index === 0 || alias > (aliases[index - 1] as number)));
}

/**
 * A segment is always one physical line on the wire, and never carries the paragraph mark,
 * so an echo of the input can only breach the protocol on purpose; the stored text is unchanged.
 */
function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n|¶/g, " ");
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
