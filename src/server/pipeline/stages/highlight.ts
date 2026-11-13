import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { CITATION_INVALID_RATIO_MAX, HIGHLIGHT_COUNT_MAX } from "../../../shared/defaults.ts";
import type { SegmentId } from "../../../shared/ids.ts";
import type { HighlightRevision } from "../../domain/artifact.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import type { Content } from "../../domain/content.ts";
import { amberError } from "../../domain/errors.ts";
import type { LlmRequest } from "../../domain/llm.ts";
import type { ModelRef, PromptRef } from "../../domain/model-ref.ts";
import {
  candidateClock,
  chapterWindowNote,
  HIGHLIGHT_DEFAULT_PROMPT,
  HIGHLIGHT_SELECT_PROMPT,
  isBuiltinVersion,
  outputLanguageName,
  renderPrompt,
} from "../../domain/prompts.ts";
import { framingForRead, speakerContextDigest, type SpeakerFraming } from "../../domain/speaker-context.ts";
import { recomputeHighlightsRequestSchema } from "../../domain/task-request.ts";
import { estimateTokens } from "../../domain/token-estimate.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../domain/transcript.ts";
import type { Repository } from "../../ports/repository.ts";
import { assertBaseRevisionExists, stageUnitFailure, type StageExecutionContext, type StageExecutor, type StageOutcome, type UnitIdentity } from "../executor.ts";
import { taskContent } from "./platform-access.ts";
import { assertCarries } from "./rollup-runner.ts";
import { assertWindowFits, planSentenceWindows, type SentenceWindow } from "./windows.ts";

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

/** The JSON object the `highlight.select` prompt asks for: aliases and new scores only, the reasons stay the candidates'. */
const SELECT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: { alias: { type: "string" }, score: { type: "integer" } },
        required: ["alias", "score"],
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
 *
 * A request with a frozen speaker context sends each window with its speakers, planned and
 * checked like the chapter stage's windows.
 *
 * Only the current builtin `highlight.default` states `HIGHLIGHT_COUNT_MAX` in its text, so
 * only a Task frozen on exactly that version is capped. One window over the cap keeps its
 * best-scored items without another call. Several windows scored on scales of their own, so
 * their items become candidates of one more call (`highlight.select`, its own
 * `highlight:select` WorkUnit) that rescores them together; reasons stay the windows'. A
 * custom version or an older builtin one is sent, digested and published exactly as before
 * the cap existed.
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
    const { baseRevisionId, outputLanguage, speakerContext } = recomputeHighlightsRequestSchema.parse(context.request);
    const revision = this.baseOf(content, baseRevisionId);
    const segments = repository.withTransaction((scope) => scope.transcripts.listSegments(owner, revision.id));
    if (segments.length === 0) {
      throw amberError("internal", "the base transcript has no sentences");
    }
    const framing = framingForRead(speakerContext, segments);
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "no model for the highlight stage");
    }
    const description = context.llm.describe(modelRef);
    const structured = description.capability.flags.structuredOutput === "supported";
    const prompt = context.prompt("highlight.default");
    const template = renderPrompt(prompt.text, { output_language: outputLanguageName(outputLanguage) });
    const limits = description.capability.limits;
    const schemaTokens = structured ? estimateTokens(JSON.stringify(RESPONSE_SCHEMA)) : 0;
    const emptyTranscript = framing === undefined ? "" : framing.slotValue("");
    const fixedTokens =
      estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(segments.length, segments.length), transcript_with_aliases: emptyTranscript })) +
      schemaTokens;
    const windows = planSentenceWindows(segments, { fixedTokens, limits, modelRef, ...(framing === undefined ? {} : { speakers: framing }) });
    const prompts = windows.map((window, index) =>
      renderPrompt(template, {
        window_note: chapterWindowNote(index + 1, windows.length),
        transcript_with_aliases: framing === undefined ? window.lines.join("\n") : framing.slotValue(framing.block(window.lines, window.offset).join("\n")),
      }),
    );
    if (framing !== undefined) {
      prompts.forEach((rendered) => assertWindowFits(rendered, schemaTokens, limits));
    }

    const capped = isBuiltinVersion(prompt.ref, HIGHLIGHT_DEFAULT_PROMPT);
    const selecting = capped && windows.length > 1;
    const steps = windows.length + (selecting ? 1 : 0);
    let finished = 0;
    const settled = await Promise.allSettled(
      windows.map(async (window, index) => {
        const payload = await this.runWindow(context, {
          modelRef,
          promptRef: prompt.ref,
          revision,
          prompt: prompts[index] as string,
          structured,
          outputLanguage,
          window,
          index,
          count: windows.length,
          framing,
        });
        finished += 1;
        context.reportProgress(finished / steps);
        return payload;
      }),
    );
    const failure = stageUnitFailure(settled);
    if (failure !== undefined) {
      throw failure;
    }
    const payloads = settled.map((result) => (result as PromiseFulfilledResult<WindowPayload>).value);
    const position = new Map(segments.map((segment, index) => [segment.id as string, index]));
    const dropped = payloads.reduce((sum, payload) => sum + payload.dropped, 0);
    let items: HighlightItem[];
    let selected: WindowPayload | undefined;
    let candidateCount: number | undefined;
    if (!capped) {
      items = mergeWindows(position, payloads);
    } else if (!selecting) {
      items = cappedItems(mergeWindows(position, payloads), position);
    } else {
      const candidates = candidatesOf(position, payloads);
      candidateCount = candidates.length;
      // Nothing to choose from: the selection would cost a call to return nothing.
      selected =
        candidates.length === 0
          ? undefined
          : await this.runSelect(context, { modelRef, revision, segments, position, candidates, payloads, structured, outputLanguage, limits });
      items = selected === undefined ? [] : cappedItems(selected.items as HighlightItem[], position);
    }
    const invocationIds = [...payloads.map((payload) => payload.invocationId), ...(selected === undefined ? [] : [selected.invocationId])];
    const promptRefs = [prompt.ref, ...(framing === undefined ? [] : [framing.rules.ref]), ...(selected === undefined ? [] : [HIGHLIGHT_SELECT_PROMPT.ref])];
    const revisionId = this.newId();
    const artifactId = this.newId();
    const createdAt = this.now();
    return {
      resultJson: {
        revisionId,
        windows: windows.length,
        dropped,
        ...(candidateCount === undefined ? {} : { selected: { candidates: candidateCount, dropped: selected?.dropped ?? 0 } }),
        reasons: [],
      },
      publish: (scope) => {
        assertBaseRevisionExists(scope, owner, content.id, revision.id);
        scope.highlights.insertRevision(owner, content.id, {
          id: revisionId,
          artifactId,
          transcriptRevisionId: revision.id,
          items,
          modelRef: description.snapshot,
          promptRef: prompt.ref,
          promptRefs,
          promptSnapshot: template,
          ...(framing === undefined ? {} : { speakerContext: framing.snapshot }),
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
      promptRef: PromptRef;
      revision: TranscriptRevision;
      prompt: string;
      structured: boolean;
      outputLanguage: string;
      window: SentenceWindow;
      index: number;
      count: number;
      framing: SpeakerFraming | undefined;
    },
  ): Promise<WindowPayload> {
    const { modelRef, promptRef, revision, prompt, structured, outputLanguage, window, index, count, framing } = input;
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
        promptRef,
        modelRef,
        outputLanguage,
        structured,
        ...(framing === undefined ? {} : { speakerContext: speakerContextDigest(framing.snapshot) }),
      }),
    );
    const value = await context.runUnit({
      key: `highlight:window:${index}`,
      inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity): Promise<WindowPayload> => {
        assertCarries(prompt, framing?.rules, "{{transcript_with_aliases}}");
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

  /**
   * The `highlight.select` call over every window's items, as one paid DB-only WorkUnit
   * whose digest covers the windows' results (so after a crash a finished selection is
   * reused with the finished windows). The request is checked against the budget as
   * rendered; a candidate list that does not fit fails the stage.
   */
  private async runSelect(
    context: StageExecutionContext,
    input: {
      modelRef: ModelRef;
      revision: TranscriptRevision;
      segments: readonly TranscriptSegment[];
      position: ReadonlyMap<string, number>;
      candidates: readonly HighlightItem[];
      payloads: readonly WindowPayload[];
      structured: boolean;
      outputLanguage: string;
      limits: { contextWindowTokens?: number; maxOutputTokens?: number };
    },
  ): Promise<WindowPayload> {
    const { modelRef, revision, segments, position, candidates, payloads, structured, outputLanguage, limits } = input;
    const lines = candidates.map((item) => {
      const at = position.get(item.segmentId) as number;
      const segment = segments[at] as TranscriptSegment;
      const head = `[[s${at + 1}]] ${candidateClock(segment.startMs)} ${oneLine(segment.text)}`;
      return item.text === "" ? head : `${head}｜${oneLine(item.text)}`;
    });
    const prompt = renderPrompt(HIGHLIGHT_SELECT_PROMPT.text, { max_highlights: String(HIGHLIGHT_COUNT_MAX), candidates: lines.join("\n") });
    assertWindowFits(prompt, structured ? estimateTokens(JSON.stringify(SELECT_RESPONSE_SCHEMA)) : 0, limits);
    const request: LlmRequest = {
      modelRef,
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      ...(structured ? { responseFormat: { type: "json_schema" as const, schema: SELECT_RESPONSE_SCHEMA } } : {}),
    };
    const inputDigest = digestOf(
      canonicalJson({
        baseRevisionId: revision.id,
        windows: payloads.map((payload) => digestOf(canonicalJson(payload.items))),
        promptRef: HIGHLIGHT_SELECT_PROMPT.ref,
        maxHighlights: HIGHLIGHT_COUNT_MAX,
        modelRef,
        outputLanguage,
        structured,
      }),
    );
    const value = await context.runUnit({
      key: "highlight:select",
      inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity): Promise<WindowPayload> => {
        const completion = await context.llm.complete(request, { feature: "highlight", workUnitId: unit.id });
        return { ...parseSelect(completion.text, segments, candidates), invocationId: completion.invocationId };
      },
    });
    const parsed = windowPayloadSchema.safeParse(value);
    if (!parsed.success) {
      throw amberError("internal", "a stored highlight selection does not match its shape");
    }
    return parsed.data;
  }
}

/**
 * The highlights of one window, checked by the rules of the `highlight.default` prompt: an
 * entry whose alias names no sentence of this window or whose score is not a number is dropped; when the dropped share exceeds
 * `CITATION_INVALID_RATIO_MAX` the whole window is `output_mismatch`. A repeated alias keeps
 * its first entry. Scores are rounded and clamped to 0–100; the count is not enforced here.
 */
function parseWindow(text: string, window: SentenceWindow): { items: HighlightItem[]; dropped: number } {
  return judgedEntries(
    text,
    (position) => window.segments[position - window.offset],
    (_segment, entry) => entry.text?.trim() ?? "",
    "too many highlights name no sentence of their window",
  );
}

/**
 * The selection, checked by the rules of the `highlight.select` prompt like a window's
 * answer: an entry naming no candidate is dropped, too many dropped is `output_mismatch`,
 * scores are rounded and clamped, and each kept entry takes its candidate's reason.
 */
function parseSelect(text: string, segments: readonly TranscriptSegment[], candidates: readonly HighlightItem[]): { items: HighlightItem[]; dropped: number } {
  const reasons = new Map(candidates.map((item) => [item.segmentId as string, item.text]));
  return judgedEntries(
    text,
    (position) => {
      const segment = segments[position];
      return segment !== undefined && reasons.has(segment.id) ? segment : undefined;
    },
    (segment) => reasons.get(segment.id) as string,
    "too many selected highlights name no candidate",
  );
}

/**
 * The entries of a highlight answer whose alias resolves through `segmentAt` (by position
 * in the revision), each with the reason `reasonOf` gives it.
 */
function judgedEntries(
  text: string,
  segmentAt: (position: number) => TranscriptSegment | undefined,
  reasonOf: (segment: TranscriptSegment, entry: z.infer<typeof entrySchema>) => string,
  tooMany: string,
): { items: HighlightItem[]; dropped: number } {
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
    const segment = match === null ? undefined : segmentAt(Number(match[1]) - 1);
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
      text: reasonOf(segment, entry.data),
    });
  }
  if (entries.length > 0 && dropped / entries.length > CITATION_INVALID_RATIO_MAX) {
    throw amberError("output_mismatch", tooMany);
  }
  return { items, dropped };
}

/** Items of all windows in sentence order; a sentence appears once. */
function mergeWindows(position: ReadonlyMap<string, number>, payloads: readonly WindowPayload[]): HighlightItem[] {
  const byId = new Map<string, HighlightItem>();
  for (const item of payloads.flatMap((payload) => payload.items)) {
    if (!position.has(item.segmentId)) {
      throw amberError("internal", "a stored highlight points outside the base transcript");
    }
    if (!byId.has(item.segmentId)) {
      byId.set(item.segmentId, { segmentId: item.segmentId as SegmentId, score: item.score, text: item.text });
    }
  }
  return inTimeOrder([...byId.values()], position);
}

/** The candidates of a selection: every window's items in sentence order, a sentence once with its best score. */
function candidatesOf(position: ReadonlyMap<string, number>, payloads: readonly WindowPayload[]): HighlightItem[] {
  const byId = new Map<string, HighlightItem>();
  for (const item of payloads.flatMap((payload) => payload.items)) {
    if (!position.has(item.segmentId)) {
      throw amberError("internal", "a stored highlight points outside the base transcript");
    }
    const kept = byId.get(item.segmentId);
    if (kept === undefined || item.score > kept.score) {
      byId.set(item.segmentId, { segmentId: item.segmentId as SegmentId, score: item.score, text: item.text });
    }
  }
  return inTimeOrder([...byId.values()], position);
}

/** At most `HIGHLIGHT_COUNT_MAX` items, the best scores first (the earlier on a tie), shown in time order. */
function cappedItems(items: readonly HighlightItem[], position: ReadonlyMap<string, number>): HighlightItem[] {
  const at = (item: HighlightItem) => position.get(item.segmentId) as number;
  const best = [...items].sort((a, b) => b.score - a.score || at(a) - at(b)).slice(0, HIGHLIGHT_COUNT_MAX);
  return inTimeOrder(best, position);
}

function inTimeOrder(items: HighlightItem[], position: ReadonlyMap<string, number>): HighlightItem[] {
  return items.sort((a, b) => (position.get(a.segmentId) as number) - (position.get(b.segmentId) as number));
}

/** A sentence or a model-written reason on one candidate line. */
function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
