import { CONTEXT_SAFETY_RATIO, LLM_MAX_OUTPUT_TOKENS_DEFAULT } from "../../../shared/defaults.ts";
import { amberError } from "../../domain/errors.ts";
import type { ModelRef } from "../../domain/model-ref.ts";
import type { SpeakerFraming } from "../../domain/speaker-context.ts";
import { estimateTokens } from "../../domain/token-estimate.ts";
import type { TranscriptSegment } from "../../domain/transcript.ts";

/** Consecutive sentences sent in one call, each as one `[[s<n>]]` line with its global alias. */
export interface SentenceWindow {
  /** Position of the window's first sentence in the revision. */
  offset: number;
  segments: TranscriptSegment[];
  lines: string[];
}

/**
 * Greedy windows of consecutive sentences within the model's budget:
 * `contextWindowTokens × CONTEXT_SAFETY_RATIO − fixed part − maxOutputTokens`. `fixedTokens`
 * is the caller's prompt with an empty transcript and its longest window note, plus any
 * JSON schema it sends. Aliases are global (`s<position + 1>`) and a sentence is always one
 * physical line. Without a known window nothing is sent.
 *
 * With `speakers` a sentence also pays for its header line where it has one: at a change of
 * speaker, and wherever it opens a window (`fixedTokens` then includes the rules fragment).
 */
export function planSentenceWindows(
  segments: readonly TranscriptSegment[],
  input: { fixedTokens: number; limits: { contextWindowTokens?: number; maxOutputTokens?: number }; modelRef: ModelRef; speakers?: SpeakerFraming },
): SentenceWindow[] {
  const { limits, modelRef } = input;
  const contextWindow = limits.contextWindowTokens;
  if (contextWindow === undefined) {
    throw amberError("llm_capability", "the model has no context window to plan windows against", {
      code: "llm_capability.context_window_unknown",
      details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
    });
  }
  const budget = windowBudget(contextWindow, limits.maxOutputTokens) - input.fixedTokens;
  if (budget <= 0) {
    throw amberError("llm_capability", "no room for any transcript in the model's budget", { code: "llm_capability.context_length" });
  }
  const { speakers } = input;
  const costOf = (line: string, position: number, first: boolean): number =>
    speakers === undefined ? estimateTokens(`${line}\n`) : speakers.cost(line, position, first);
  const windows: SentenceWindow[] = [];
  let current: SentenceWindow | undefined;
  let used = 0;
  segments.forEach((segment, position) => {
    const line = `[[s${position + 1}]] ${segment.text.replace(/\r\n|\r|\n/g, " ")}`;
    const opening = costOf(line, position, true);
    if (opening > budget) {
      throw amberError("llm_capability", "a single sentence exceeds the model's budget", { code: "llm_capability.context_length" });
    }
    const following = current === undefined ? opening : costOf(line, position, false);
    let cost = following;
    if (current === undefined || used + following > budget) {
      current = { offset: position, segments: [], lines: [] };
      windows.push(current);
      used = 0;
      cost = opening;
    }
    current.segments.push(segment);
    current.lines.push(line);
    used += cost;
  });
  return windows;
}

/** Room for input in one call: `contextWindowTokens × CONTEXT_SAFETY_RATIO − output reservation`. */
function windowBudget(contextWindowTokens: number, maxOutputTokens: number | undefined): number {
  return Math.floor(contextWindowTokens * CONTEXT_SAFETY_RATIO) - (maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS_DEFAULT);
}

/**
 * The check of a request as it will be sent (its prompt and `extraTokens`, e.g. the JSON
 * schema) against the same budget planning used: a window that reads speakers, whose header
 * lines planning only estimated, and a merge or selection over candidates, which is never
 * planned at all. Over budget, the stage fails with `llm_capability.context_length` —
 * nothing is cut and nothing is sent.
 */
export function assertWindowFits(prompt: string, extraTokens: number, limits: { contextWindowTokens?: number; maxOutputTokens?: number }): void {
  if (limits.contextWindowTokens === undefined) {
    return;
  }
  if (estimateTokens(prompt) + extraTokens > windowBudget(limits.contextWindowTokens, limits.maxOutputTokens)) {
    throw amberError("llm_capability", "a request as rendered exceeds the model's budget", { code: "llm_capability.context_length" });
  }
}
