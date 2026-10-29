import { CONTEXT_SAFETY_RATIO, LLM_MAX_OUTPUT_TOKENS_DEFAULT, ROLLUP_CARRY_BUDGET_CHARS } from "../../shared/defaults.ts";
import type { ArtifactInputRef, CollectionSummaryRevision } from "./artifact.ts";
import { amberError } from "./errors.ts";
import type { ModelRef } from "./model-ref.ts";
import { estimateTokens } from "./token-estimate.ts";

/**
 * Budget planning for summaries and rolling summarization. Every number is
 * an estimate from `estimateTokens`, never a tokenizer.
 */

export interface ModelLimits {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

/** Room for input left in one call: `contextWindowTokens × CONTEXT_SAFETY_RATIO − output reservation`. */
function inputRoom(limits: ModelLimits): number | undefined {
  if (limits.contextWindowTokens === undefined) {
    return undefined;
  }
  return Math.floor(limits.contextWindowTokens * CONTEXT_SAFETY_RATIO) - (limits.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS_DEFAULT);
}

/**
 * The transcript budget of a call whose prompt without transcript is `fixed`: `undefined`
 * when the window is unknown.
 */
export function transcriptBudget(limits: ModelLimits, fixed: string): number | undefined {
  const room = inputRoom(limits);
  return room === undefined ? undefined : room - estimateTokens(fixed);
}

/** The largest carry `rollup.carry` is asked to keep, as text for estimating (CJK is the costlier case). */
export function carryAllowance(): string {
  return "字".repeat(ROLLUP_CARRY_BUDGET_CHARS);
}

function contextLength(message: string): never {
  throw amberError("llm_capability", message, { code: "llm_capability.context_length" });
}

/**
 * A complete prompt must fit the model: otherwise `llm_capability.context_length` and no
 * further splitting (6.9: a collection group, a carry or a final over budget). Nothing is
 * checked when the window is unknown.
 */
export function assertFits(limits: ModelLimits, prompt: string): void {
  const room = inputRoom(limits);
  if (room !== undefined && estimateTokens(prompt) > room) {
    contextLength("the prompt exceeds the model's budget");
  }
}

/** One sentence of the transcript to summarize, as shown to the model. */
export interface PlannedSentence {
  line: string;
  startMs: number;
}

/** A group of consecutive sentences `[first, first + count)` and the chapter it came from, if any. */
export interface SentenceGroup {
  first: number;
  count: number;
  chapterIndex?: number;
}

export type SummaryPlan = { mode: "single" } | { mode: "rolling"; byChapters: boolean; groups: SentenceGroup[] };

/**
 * Single call or rolling summarization, and the groups of the latter:
 *
 * - known window: the whole transcript within the single-call budget → one call;
 *   otherwise rolling, by chapter when chapters are current (a chapter over the budget is
 *   split into the fewest equal runs of sentences that each fit; runs never cross a
 *   chapter), else greedily by sentence. A budget ≤ 0 or one sentence over the budget is
 *   `llm_capability.context_length`.
 * - unknown window: rolling by chapter without any budget check, and without chapters
 *   `llm_capability.context_window_unknown`.
 *
 * `singleFixed` and `partialFixed` are the single-call and partial prompts without
 * transcript; the latter already includes the largest carry.
 */
export function planSummary(input: {
  sentences: readonly PlannedSentence[];
  /** Start times of the current chapters, ascending; absent or empty without chapters. */
  chapterStarts?: readonly number[];
  singleFixed: string;
  partialFixed: string;
  limits: ModelLimits;
  modelRef: ModelRef;
}): SummaryPlan {
  const { sentences, limits, modelRef } = input;
  const chapters = input.chapterStarts ?? [];
  const singleBudget = transcriptBudget(limits, input.singleFixed);
  if (singleBudget === undefined) {
    if (chapters.length === 0) {
      throw amberError("llm_capability", "the model has no context window to plan a summary against", {
        code: "llm_capability.context_window_unknown",
        details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
      });
    }
    return { mode: "rolling", byChapters: true, groups: chapterGroups(sentences, chapters) };
  }
  if (singleBudget <= 0) {
    contextLength("no room for any transcript in the model's budget");
  }
  const costs = sentences.map((sentence) => estimateTokens(`${sentence.line}\n`));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= singleBudget) {
    return { mode: "single" };
  }
  const budget = transcriptBudget(limits, input.partialFixed) as number;
  if (budget <= 0) {
    contextLength("no room for any transcript in the model's budget");
  }
  if (costs.some((cost) => cost > budget)) {
    contextLength("a single sentence exceeds the model's budget");
  }
  if (chapters.length === 0) {
    return { mode: "rolling", byChapters: false, groups: greedy(costs, 0, costs.length, budget) };
  }
  const groups = chapterGroups(sentences, chapters).flatMap((group) => splitEvenly(costs, group, budget));
  return { mode: "rolling", byChapters: true, groups };
}

/**
 * Sentences by chapter: a sentence belongs to the last chapter starting at or before it;
 * sentences before the first chapter belong to the first. Chapters without sentences are
 * left out.
 */
function chapterGroups(sentences: readonly PlannedSentence[], starts: readonly number[]): SentenceGroup[] {
  const groups: SentenceGroup[] = [];
  sentences.forEach((sentence, position) => {
    let chapterIndex = 0;
    starts.forEach((start, index) => {
      if (start <= sentence.startMs) {
        chapterIndex = index;
      }
    });
    const last = groups.at(-1);
    if (last !== undefined && last.chapterIndex === chapterIndex) {
      last.count += 1;
    } else {
      groups.push({ first: position, count: 1, chapterIndex });
    }
  });
  return groups;
}

/** The fewest equal-count runs of one chapter that each fit the budget. */
function splitEvenly(costs: readonly number[], group: SentenceGroup, budget: number): SentenceGroup[] {
  for (let parts = 1; parts <= group.count; parts += 1) {
    const size = Math.ceil(group.count / parts);
    const runs: SentenceGroup[] = [];
    for (let first = group.first; first < group.first + group.count; first += size) {
      const count = Math.min(size, group.first + group.count - first);
      runs.push({ first, count, ...(group.chapterIndex === undefined ? {} : { chapterIndex: group.chapterIndex }) });
    }
    if (runs.every((run) => sum(costs, run) <= budget)) {
      return runs;
    }
  }
  // Unreachable: every single sentence fits, so one sentence per run always does.
  return [];
}

function greedy(costs: readonly number[], first: number, end: number, budget: number): SentenceGroup[] {
  const groups: SentenceGroup[] = [];
  let used = 0;
  for (let position = first; position < end; position += 1) {
    const cost = costs[position] as number;
    const current = groups.at(-1);
    if (current === undefined || used + cost > budget) {
      groups.push({ first: position, count: 1 });
      used = cost;
    } else {
      current.count += 1;
      used += cost;
    }
  }
  return groups;
}

function sum(costs: readonly number[], group: SentenceGroup): number {
  let total = 0;
  for (let position = group.first; position < group.first + group.count; position += 1) {
    total += costs[position] as number;
  }
  return total;
}

/**
 * The members a collection summary partial covered, as 1-based numbers in the revision's own
 * member order (its `inputItems` by ascending position, numbered without gaps). Taken from the
 * snapshot, never from the live collection, so a later reorder cannot relabel an old partial.
 * `undefined` unless the partial's inputs are member snapshots that map onto one run of
 * consecutive numbers exactly; a range that only approximates the inputs would mislead.
 */
export function partialItemRange(
  inputItems: readonly Pick<CollectionSummaryRevision["inputItems"][number], "collectionItemId" | "position">[],
  inputs: readonly ArtifactInputRef[],
): { first: number; last: number } | undefined {
  if (inputs.length === 0) {
    return undefined;
  }
  const numbers = new Map(
    [...inputItems].sort((a, b) => a.position - b.position).map((item, index) => [item.collectionItemId, index + 1] as const),
  );
  const covered = new Set<number>();
  for (const input of inputs) {
    if (input.kind !== "collectionItemSnapshot") {
      return undefined;
    }
    const number = numbers.get(input.collectionItemId);
    if (number === undefined || covered.has(number)) {
      return undefined;
    }
    covered.add(number);
  }
  const first = Math.min(...covered);
  const last = Math.max(...covered);
  return last - first + 1 === inputs.length ? { first, last } : undefined;
}
