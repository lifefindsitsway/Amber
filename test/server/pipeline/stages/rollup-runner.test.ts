import { describe, expect, it } from "vitest";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import type { LlmRequest } from "../../../../src/server/domain/llm.ts";
import { CITATION_NONE_FRAGMENT, ROLLUP_CARRY_PROMPT, ROLLUP_FINAL_PROMPT, ROLLUP_PARTIAL_PROMPT, renderPrompt, SPEAKER_RULES_FRAGMENT } from "../../../../src/server/domain/prompts.ts";
import { carryAllowance } from "../../../../src/server/domain/rollup.ts";
import { estimateTokens } from "../../../../src/server/domain/token-estimate.ts";
import type { StageExecutionContext } from "../../../../src/server/pipeline/executor.ts";
import { assertCarries, runRollup, type RollupGroup, type RollupSpec } from "../../../../src/server/pipeline/stages/rollup-runner.ts";
import { CONTEXT_SAFETY_RATIO, ROLLUP_CARRY_BUDGET_CHARS } from "../../../../src/shared/defaults.ts";

const MAX_OUTPUT = 10;
const modelRef = { providerProfileId: "p", modelId: "m" };

/** A context that runs every unit at once and answers every call with a short text, recording the prompts sent. */
function fakeContext(): { context: StageExecutionContext; sent: string[] } {
  const sent: string[] = [];
  const context = {
    runUnit: async (unit: { key: string; run: (signal: AbortSignal, identity: { id: string; attempt: number; retryCount: number }) => Promise<unknown> }) =>
      unit.run(new AbortController().signal, { id: unit.key, attempt: 1, retryCount: 0 }),
    llm: {
      complete: async (request: LlmRequest) => {
        const part = request.messages[0]?.content[0];
        sent.push(part?.type === "text" ? part.text : "");
        return { text: "归纳", invocationId: `call${sent.length}` };
      },
    },
    reportProgress: () => undefined,
  } as unknown as StageExecutionContext;
  return { context, sent };
}

const SHARED = { citation_rules: CITATION_NONE_FRAGMENT.text, output_language: "简体中文", terms_section: "", template_body: "要点" };

function spec(groups: RollupGroup[], room: number, extra: Partial<RollupSpec> = {}): RollupSpec {
  return {
    citations: { rules: CITATION_NONE_FRAGMENT },
    modelRef,
    limits: { contextWindowTokens: Math.ceil((room + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO), maxOutputTokens: MAX_OUTPUT },
    feature: "summary",
    templateBody: SHARED.template_body,
    outputLanguage: SHARED.output_language,
    terms: SHARED.terms_section,
    groups,
    partial: ROLLUP_PARTIAL_PROMPT,
    carry: ROLLUP_CARRY_PROMPT,
    final: { prompt: ROLLUP_FINAL_PROMPT, values: {} },
    digestBase: {},
    ...extra,
  };
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

describe("runRollup", () => {
  /**
   * Room for a partial prompt with the largest carry and 50 tokens of group content; the third
   * group is over it even with the short carry actually written.
   */
  const room = estimateTokens(renderPrompt(ROLLUP_PARTIAL_PROMPT.text, { ...SHARED, carry: carryAllowance(), group_content: "" })) + 50;
  const group = (content: string): RollupGroup => ({ ids: [content.slice(0, 8)], content, inputs: [] });
  const groups = [group("[[s1]] 第一组"), group("[[s2]] 第二组"), group(`[[s3]] ${"字".repeat(ROLLUP_CARRY_BUDGET_CHARS + 200)}`)];

  it("with the carry allowance, checks every partial as rendered before the first call: a later group over budget sends nothing", async () => {
    const { context, sent } = fakeContext();
    expect(await codeOf(runRollup(context, spec(groups, room, { precheckCarry: carryAllowance() })))).toBe("llm_capability.context_length");
    expect(sent).toEqual([]);
  });

  it("without it, finds the over-budget group only when it comes to it", async () => {
    const { context, sent } = fakeContext();
    expect(await codeOf(runRollup(context, spec(groups, room)))).toBe("llm_capability.context_length");
    expect(sent.length).toBe(4);
  });

  it("runs every group when each fits with the carry allowance", async () => {
    const { context, sent } = fakeContext();
    const outcome = await runRollup(context, spec(groups.slice(0, 2), room, { precheckCarry: carryAllowance() }));
    expect(outcome.partials.map((partial) => partial.index)).toEqual([0, 1]);
    expect(sent.length).toBe(5);
  });
});

describe("assertCarries", () => {
  it("fails a prompt without the fragment with prompt_protocol, naming the slot it lacks as the submission check does", () => {
    const failure = (() => {
      try {
        assertCarries("没有规则", SPEAKER_RULES_FRAGMENT, "{{group_content}}");
      } catch (error) {
        return isAmberError(error) ? error.appError : undefined;
      }
      return undefined;
    })();
    expect(failure).toMatchObject({ code: "invalid_request.prompt_protocol", details: { missing: ["{{group_content}}"], unknown: [] } });
    expect(() => assertCarries(`前文\n${SPEAKER_RULES_FRAGMENT.text}\n后文`, SPEAKER_RULES_FRAGMENT, "{{group_content}}")).not.toThrow();
    expect(() => assertCarries("没有规则", undefined)).not.toThrow();
  });
});
