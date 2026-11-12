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
 * further splitting (a collection group, a carry or a final over budget). Nothing is
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
 *
 * `cost` prices a sentence by its place: whether it opens its call's block of sentences (the
 * single call has one block). Without it a sentence costs its line wherever it is; with
 * speakers it adds the header line the sentence carries at a change of speaker or at the
 * start of a block, so a cut that makes a sentence a group's first is paid for.
 *
 * `chapterHeadings` are the texts a group of each chapter opens with (its title line): every
 * group cut by chapter, each run of a split chapter included, is sent with its chapter's
 * heading, so the heading is priced with the group's first sentence.
 */
export function planSummary(input: {
  sentences: readonly PlannedSentence[];
  /** Start times of the current chapters, ascending; absent or empty without chapters. */
  chapterStarts?: readonly number[];
  /** What each group of chapter `i` opens with, index-aligned with `chapterStarts`. */
  chapterHeadings?: readonly string[];
  singleFixed: string;
  partialFixed: string;
  limits: ModelLimits;
  modelRef: ModelRef;
  cost?: SentenceCost;
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
  const price = input.cost;
  const costs: Costs =
    price === undefined
      ? uniformCosts(sentences.map((sentence) => estimateTokens(`${sentence.line}\n`)))
      : {
          opening: sentences.map((sentence, position) => price(sentence.line, position, true)),
          following: sentences.map((sentence, position) => price(sentence.line, position, false)),
        };
  const total = costs.opening.reduce((sum, cost, position) => sum + (position === 0 ? cost : (costs.following[position] as number)), 0);
  if (total <= singleBudget) {
    return { mode: "single" };
  }
  const budget = transcriptBudget(limits, input.partialFixed) as number;
  if (budget <= 0) {
    contextLength("no room for any transcript in the model's budget");
  }
  if (costs.opening.some((cost) => cost > budget)) {
    contextLength("a single sentence exceeds the model's budget");
  }
  if (chapters.length === 0) {
    return { mode: "rolling", byChapters: false, groups: greedy(costs, 0, sentences.length, budget) };
  }
  const byChapter = chapterGroups(sentences, chapters);
  const headed = withHeadings(costs, byChapter, input.chapterHeadings ?? []);
  if (headed.opening.some((cost) => cost > budget)) {
    contextLength("a single sentence and its chapter heading exceed the model's budget");
  }
  const groups = byChapter.flatMap((group) => splitEvenly(headed, group, budget));
  return { mode: "rolling", byChapters: true, groups };
}

/** `costs` with each sentence's opening cost raised by the heading of the chapter it belongs to. */
function withHeadings(costs: Costs, byChapter: readonly SentenceGroup[], headings: readonly string[]): Costs {
  if (headings.length === 0) {
    return costs;
  }
  const opening = [...costs.opening];
  for (const group of byChapter) {
    const heading = estimateTokens(headings[group.chapterIndex as number] ?? "");
    for (let position = group.first; position < group.first + group.count; position += 1) {
      opening[position] = (opening[position] as number) + heading;
    }
  }
  return { opening, following: costs.following };
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

/**
 * The price of sentence `position` (shown as `line`) in a call's block of sentences, by
 * whether it is the block's first.
 */
export type SentenceCost = (line: string, position: number, blockStart: boolean) => number;

/** Each sentence's cost as the first of a block and anywhere after it. */
interface Costs {
  opening: readonly number[];
  following: readonly number[];
}

function uniformCosts(costs: readonly number[]): Costs {
  return { opening: costs, following: costs };
}

/** The fewest equal-count runs of one chapter that each fit the budget. */
function splitEvenly(costs: Costs, group: SentenceGroup, budget: number): SentenceGroup[] {
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

function greedy(costs: Costs, first: number, end: number, budget: number): SentenceGroup[] {
  const groups: SentenceGroup[] = [];
  let used = 0;
  for (let position = first; position < end; position += 1) {
    const current = groups.at(-1);
    const following = costs.following[position] as number;
    if (current === undefined || used + following > budget) {
      groups.push({ first: position, count: 1 });
      used = costs.opening[position] as number;
    } else {
      current.count += 1;
      used += following;
    }
  }
  return groups;
}

function sum(costs: Costs, group: SentenceGroup): number {
  let total = 0;
  for (let position = group.first; position < group.first + group.count; position += 1) {
    total += (position === group.first ? costs.opening[position] : costs.following[position]) as number;
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
