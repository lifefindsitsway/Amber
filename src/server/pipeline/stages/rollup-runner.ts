import { createHash } from "node:crypto";
import { z } from "zod";
import type { TokenUsageFeature } from "../../../shared/enums.ts";
import type { ArtifactInputRef } from "../../domain/artifact.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import {
  applyRepair,
  checkCitations,
  markUnresolved,
  needsRepair,
  parseRepair,
  renderCandidates,
  repairCandidates,
  withoutCitations,
  type AliasTable,
} from "../../domain/citations.ts";
import { amberError } from "../../domain/errors.ts";
import type { LlmRequest } from "../../domain/llm.ts";
import type { ModelRef, PromptRef } from "../../domain/model-ref.ts";
import { CITATION_REPAIR_PROMPT, renderPrompt, type BuiltinPrompt, type ResolvedPrompt } from "../../domain/prompts.ts";
import { assertFits, type ModelLimits } from "../../domain/rollup.ts";
import type { StageExecutionContext, UnitIdentity } from "../executor.ts";
import { ROLLUP_CARRY_BUDGET_CHARS } from "../../../shared/defaults.ts";

const generationPayloadSchema = z.object({ text: z.string(), invocationId: z.string() });
const repairPayloadSchema = z.object({ mapping: z.record(z.string(), z.string()), invocationId: z.string(), degraded: z.boolean() });

/** One generation after its optional repair: the text with aliases, and what it cost. */
export interface Generated {
  /**
   * Repair applied; aliases still invalid are left for the caller to mark. A generation that
   * must not cite has every marker stripped instead.
   */
  text: string;
  invocationIds: string[];
  /** Still over `CITATION_INVALID_RATIO_MAX` after the one repair. */
  degraded: boolean;
  /** Digest of `text`, the link of the rolling digest chain. */
  digest: string;
}

export interface GenerationCall {
  key: string;
  inputDigest: string;
  prompt: string;
  feature: TokenUsageFeature;
}

/**
 * One citing generation as a paid DB-only WorkUnit, then — only when its invalid-citation
 * ratio is over the limit — one citation repair as its own `<key>:repair` WorkUnit. The
 * generation is persisted before the repair is sent, so a repair whose outcome is unknown is re-sent alone and the generation is never paid twice. The
 * repair's digest covers everything its answer depends on.
 */
export async function generateWithRepair(
  context: StageExecutionContext,
  table: AliasTable,
  modelRef: ModelRef,
  call: GenerationCall,
): Promise<Generated> {
  const generated = await generateOnce(context, modelRef, call);
  const check = checkCitations(generated.text, table);
  if (!needsRepair(check)) {
    return { text: generated.text, invocationIds: [generated.invocationId], degraded: false, digest: digestOf(generated.text) };
  }
  const candidates = repairCandidates(generated.text, check.invalidAliases, table);
  const repairPrompt = renderPrompt(CITATION_REPAIR_PROMPT.text, {
    invalid_aliases: check.invalidAliases.join("、"),
    candidates: renderCandidates(candidates, table),
  });
  const repairDigest = digestOf(
    canonicalJson({
      of: call.key,
      outputDigest: digestOf(generated.text),
      invalid: check.invalidAliases,
      candidates: [...candidates].map(([alias, entries]) => [alias, entries.map((entry) => entry.alias)]),
      aliases: digestOf(table.fingerprint()),
      promptRef: CITATION_REPAIR_PROMPT.ref,
      modelRef,
    }),
  );
  const repaired = repairPayloadSchema.parse(
    await context.runUnit({
      key: `${call.key}:repair`,
      inputDigest: repairDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity) => {
        const completion = await context.llm.complete(userRequest(modelRef, repairPrompt), { feature: "citation_repair", workUnitId: unit.id });
        const mapping = parseRepair(completion.text, check.invalidAliases, table);
        const after = checkCitations(applyRepair(generated.text, mapping), table);
        return { mapping, invocationId: completion.invocationId, degraded: needsRepair(after) };
      },
    }),
  );
  const text = applyRepair(generated.text, repaired.mapping);
  return { text, invocationIds: [generated.invocationId, repaired.invocationId], degraded: repaired.degraded, digest: digestOf(text) };
}

/**
 * One generation whose output must not cite, as a paid DB-only WorkUnit: whatever markers
 * the model writes anyway are stripped rather than checked, so it never needs a repair and
 * is never degraded by citations.
 */
async function generateWithoutCitations(context: StageExecutionContext, modelRef: ModelRef, call: GenerationCall): Promise<Generated> {
  const generated = await generateOnce(context, modelRef, call);
  const text = withoutCitations(generated.text);
  return { text, invocationIds: [generated.invocationId], degraded: false, digest: digestOf(text) };
}

/** The generation itself, as a paid DB-only WorkUnit. */
async function generateOnce(context: StageExecutionContext, modelRef: ModelRef, call: GenerationCall): Promise<z.infer<typeof generationPayloadSchema>> {
  return generationPayloadSchema.parse(
    await context.runUnit({
      key: call.key,
      inputDigest: call.inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity) => {
        const completion = await context.llm.complete(userRequest(modelRef, call.prompt), { feature: call.feature, workUnitId: unit.id });
        return { text: completion.text, invocationId: completion.invocationId };
      },
    }),
  );
}

/** One group of a rolling summary: what it is made of and how it is shown to the model. */
export interface RollupGroup {
  /** Digest material naming the group's inputs (sentence or member ids). */
  ids: readonly string[];
  /** `{{group_content}}`. */
  content: string;
  /** Provenance of the RollupPartial built from this group. */
  inputs: ArtifactInputRef[];
}

export interface RollupSpec {
  /**
   * How the outputs cite. `rules` fills `{{citation_rules}}` of the partial and final calls.
   * With a `table`, aliases are checked and repaired against it; without one the outputs
   * must not cite, and every marker a model still writes is stripped from each output.
   */
  citations: { rules: BuiltinPrompt; table?: AliasTable };
  modelRef: ModelRef;
  limits: ModelLimits;
  feature: TokenUsageFeature;
  /** `{{template_body}}` of the partial and carry calls. */
  templateBody: string;
  outputLanguage: string;
  terms: string;
  groups: readonly RollupGroup[];
  /** The `rollup.partial` and `rollup.carry` prompts as the stage uses them. */
  partial: ResolvedPrompt;
  carry: ResolvedPrompt;
  /** The final call: its prompt and the slot values besides `partials` and `carry`. */
  final: { prompt: ResolvedPrompt; values: Readonly<Record<string, string>> };
  /** Digest material shared by every call (template identity, base revision, …). */
  digestBase: unknown;
}

export interface RollupOutcome {
  partials: Array<{ index: number; text: string; invocationIds: string[]; inputs: ArtifactInputRef[] }>;
  final: Generated;
  /** Carry calls and their repairs, attributed to the revision. */
  carryInvocationIds: string[];
  degraded: boolean;
  /** `rollup.partial` with everything but carry and group content filled in. */
  partialSnapshot: string;
  /** The version of `rollup.partial` every partial was written with. */
  partialRef: PromptRef;
  /** The final prompt with everything but partials and carry filled in. */
  finalSnapshot: string;
}

/**
 * Rolling summarization (the `rollup.*` prompts): for each group a partial under the template
 * and the carry so far, then a carry compressing both; finally one call over every partial
 * and the last carry. Each call is a paid DB-only WorkUnit (`rollup:partial:N`,
 * `rollup:carry:N`, `rollup:final`) run in order; their digests chain through the previous
 * carry and partial, so after a crash finished units are reused and nothing is paid twice.
 * When citing, invalid aliases fed forward are marked `[[unresolved:…]]` and the revision is
 * degraded when any unit stays over the limit after its repair.
 */
export async function runRollup(context: StageExecutionContext, spec: RollupSpec): Promise<RollupOutcome> {
  const { modelRef, limits } = spec;
  const { table, rules } = spec.citations;
  const generate = (call: GenerationCall) =>
    table === undefined ? generateWithoutCitations(context, modelRef, call) : generateWithRepair(context, table, modelRef, call);
  const forward = (text: string) => (table === undefined ? text : markUnresolved(text, table));
  const shared = {
    citation_rules: rules.text,
    output_language: spec.outputLanguage,
    terms_section: spec.terms,
    template_body: spec.templateBody,
  };
  const base = digestOf(
    canonicalJson({
      base: spec.digestBase,
      modelRef,
      outputLanguage: spec.outputLanguage,
      terms: spec.terms,
      citationRules: rules.ref,
      aliases: table === undefined ? null : digestOf(table.fingerprint()),
    }),
  );
  const partials: RollupOutcome["partials"] = [];
  const carryInvocationIds: string[] = [];
  let degraded = false;
  let carry = "";
  let carryDigest = digestOf("");
  for (const [index, group] of spec.groups.entries()) {
    const partialPrompt = renderPrompt(spec.partial.text, { ...shared, carry, group_content: group.content });
    assertFits(limits, partialPrompt);
    const partial = await generate({
      key: `rollup:partial:${index}`,
      inputDigest: digestOf(canonicalJson({ base, promptRef: spec.partial.ref, ids: group.ids, carry: carryDigest })),
      prompt: partialPrompt,
      feature: spec.feature,
    });
    degraded ||= partial.degraded;
    const partialText = forward(partial.text);
    partials.push({ index, text: partialText, invocationIds: partial.invocationIds, inputs: group.inputs });
    context.reportProgress((2 * index + 1) / (2 * spec.groups.length + 1));

    const carryPrompt = renderPrompt(spec.carry.text, {
      ...shared,
      carry_budget: String(ROLLUP_CARRY_BUDGET_CHARS),
      carry,
      partial: partialText,
    });
    assertFits(limits, carryPrompt);
    const next = await generate({
      key: `rollup:carry:${index}`,
      inputDigest: digestOf(canonicalJson({ base, promptRef: spec.carry.ref, carry: carryDigest, partial: partial.digest })),
      prompt: carryPrompt,
      feature: spec.feature,
    });
    degraded ||= next.degraded;
    carryInvocationIds.push(...next.invocationIds);
    carry = forward(next.text);
    carryDigest = next.digest;
    context.reportProgress((2 * index + 2) / (2 * spec.groups.length + 1));
  }

  const finalValues = { ...shared, ...spec.final.values };
  const finalPrompt = renderPrompt(spec.final.prompt.text, {
    ...finalValues,
    partials: partials.map((partial) => `【第 ${partial.index + 1} 组】\n${partial.text}`).join("\n\n"),
    carry,
  });
  assertFits(limits, finalPrompt);
  const final = await generate({
    key: "rollup:final",
    inputDigest: digestOf(
      canonicalJson({
        base,
        promptRef: spec.final.prompt.ref,
        partials: partials.map((partial) => digestOf(partial.text)),
        carry: carryDigest,
      }),
    ),
    prompt: finalPrompt,
    feature: spec.feature,
  });
  degraded ||= final.degraded;
  return {
    partials,
    final,
    carryInvocationIds,
    degraded,
    partialSnapshot: renderPrompt(spec.partial.text, shared),
    partialRef: spec.partial.ref,
    finalSnapshot: renderPrompt(spec.final.prompt.text, finalValues),
  };
}

export function userRequest(modelRef: ModelRef, prompt: string): LlmRequest {
  return { modelRef, system: "", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
}

export function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** A stage-level invariant broken by stored data, never by the user. */
export function storedDataError(message: string): never {
  throw amberError("internal", message);
}
