import {
  USAGE_RESULTS,
  USAGE_UNPRICED_REASONS,
  type UsageCostCell,
  type UsageMetric,
  type UsageModalityUsage,
  type UsageResult,
  type UsageResultCounts,
  type UsageUnpricedReason,
} from "../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../shared/model-pricing.ts";
import { USAGE_FLAG, type UsageClassFields, type UsageMeasures, type UsageModelDims } from "../domain/usage-analytics.ts";
import { toMoney, type GroupPricing } from "./usage-cost.ts";

/** A group of calls with the quantities and class the estimate needs. */
export type PricedInput = UsageModelDims & UsageClassFields & UsageMeasures;

function hasFlag(group: UsageClassFields, flag: number): boolean {
  return (group.flags & flag) !== 0;
}

function toCount(value: bigint): number {
  return Number(value);
}

/** LLM tokens as the page counts them: everything sent plus everything produced. */
function llmTokens(group: PricedInput): bigint {
  return group.modality === "llm" ? group.rawInput + group.output : 0n;
}

function asrTokens(group: PricedInput): bigint {
  return group.modality === "asr" ? group.rawInput + group.output : 0n;
}

/** What a group adds to a chart or ranking of `metric`; cost is in cost-denominator units and only counts in `currency`. */
export function metricOf(metric: UsageMetric, group: PricedInput, pricing: GroupPricing, currency: PriceCurrency): bigint {
  switch (metric) {
    case "cost":
      return pricing.kind === "counted" && pricing.currency === currency ? pricing.cost : 0n;
    case "llm_tokens":
      return llmTokens(group);
    case "asr_billed_tokens":
      return asrTokens(group);
    case "requests":
      return group.requests;
    case "audio":
      return group.modality === "asr" ? group.audioLocalMs : 0n;
  }
}

interface Coverage {
  counted: bigint;
  total: bigint;
}

/** Running sums over groups of calls: one summary, one model or one activity. */
export class UsageTotals {
  private readonly currency: PriceCurrency;
  private requests = 0n;
  private readonly results: Record<UsageResult, bigint> = { succeeded: 0n, failed: 0n, outcome_unknown: 0n, cancelled: 0n };
  private llmRequests = 0n;
  private asrRequests = 0n;
  private readonly llm = { input: 0n, output: 0n, reasoning: 0n, cacheRead: 0n, cacheWrite: 0n, cacheWrite1h: 0n };
  private readonly asr = { audioMs: 0n, billedInput: 0n, billedOutput: 0n };
  private costSum = 0n;
  private counted = 0n;
  private inCurrency = 0n;
  private otherCurrency = 0n;
  private unknownCurrency = 0n;
  private readonly leftOut = new Map<UsageUnpricedReason, { requests: bigint; modelKeys: Set<string> }>();
  private readonly cache = { cacheRead: 0n, reportedInput: 0n, reportedRequests: 0n };
  private inputMissing = 0n;
  private accepted = 0n;
  private readonly llmCoverage: Coverage = { counted: 0n, total: 0n };
  private readonly asrCoverage: Coverage = { counted: 0n, total: 0n };
  private readonly audioCoverage: Coverage = { counted: 0n, total: 0n };

  constructor(currency: PriceCurrency) {
    this.currency = currency;
  }

  /** Adds a group; `modelKey` names the model for the list of models behind each left-out reason. */
  add(group: PricedInput, pricing: GroupPricing, modelKey: string): void {
    this.addCalls(group);
    this.addCost(group, pricing, modelKey);
  }

  private addCalls(group: PricedInput): void {
    this.requests += group.requests;
    this.results[group.result] += group.requests;
    if (hasFlag(group, USAGE_FLAG.accepted)) {
      this.accepted += group.requests;
    }
    if (group.modality === "llm") {
      this.addLlm(group);
    } else {
      this.asrRequests += group.requests;
      this.asr.audioMs += group.audioLocalMs;
      this.asr.billedInput += group.rawInput;
      this.asr.billedOutput += group.output;
    }
  }

  private addLlm(group: PricedInput): void {
    this.llmRequests += group.requests;
    this.llm.input += group.rawInput;
    this.llm.output += group.output;
    this.llm.reasoning += group.reasoning;
    this.llm.cacheRead += group.cacheRead;
    this.llm.cacheWrite += group.cacheWrite + group.cacheWrite1h;
    this.llm.cacheWrite1h += group.cacheWrite1h;
    if (hasFlag(group, USAGE_FLAG.inputMissing)) {
      this.inputMissing += group.requests;
    } else if (hasFlag(group, USAGE_FLAG.cacheReported)) {
      // A request that reported no input would push the share above what was really sent.
      this.cache.cacheRead += group.cacheRead;
      this.cache.reportedInput += group.rawInput;
      this.cache.reportedRequests += group.requests;
    }
  }

  private addCost(group: PricedInput, pricing: GroupPricing, modelKey: string): void {
    if (pricing.kind === "no_snapshot") {
      this.unknownCurrency += group.requests;
      this.noteLeftOut("no_snapshot", group.requests, modelKey);
      return;
    }
    if (pricing.currency !== null && pricing.currency !== this.currency) {
      this.otherCurrency += group.requests;
      return;
    }
    this.inCurrency += group.requests;
    this.addCoverage(group, pricing.kind === "counted");
    if (pricing.kind === "counted") {
      this.counted += group.requests;
      this.costSum += pricing.cost;
    } else {
      this.noteLeftOut(pricing.reason, group.requests, modelKey);
    }
  }

  private addCoverage(group: PricedInput, counted: boolean): void {
    const pairs: Array<[Coverage, bigint]> = [
      [this.llmCoverage, llmTokens(group)],
      [this.asrCoverage, asrTokens(group)],
      [this.audioCoverage, group.modality === "asr" ? group.audioLocalMs : 0n],
    ];
    for (const [coverage, quantity] of pairs) {
      coverage.total += quantity;
      if (counted) {
        coverage.counted += quantity;
      }
    }
  }

  private noteLeftOut(reason: UsageUnpricedReason, requests: bigint, modelKey: string): void {
    const entry = this.leftOut.get(reason) ?? { requests: 0n, modelKeys: new Set<string>() };
    entry.requests += requests;
    entry.modelKeys.add(modelKey);
    this.leftOut.set(reason, entry);
  }

  requestCount(): number {
    return toCount(this.requests);
  }

  resultCounts(): UsageResultCounts {
    return Object.fromEntries(USAGE_RESULTS.map((result) => [result, toCount(this.results[result])])) as UsageResultCounts;
  }

  /** A modality with no calls is `null`, not a row of zeros. */
  usage(): UsageModalityUsage {
    return {
      llm:
        this.llmRequests === 0n
          ? null
          : {
              input: this.llm.input.toString(),
              output: this.llm.output.toString(),
              reasoning: this.llm.reasoning.toString(),
              cacheRead: this.llm.cacheRead.toString(),
              cacheWrite: this.llm.cacheWrite.toString(),
              cacheWrite1h: this.llm.cacheWrite1h.toString(),
            },
      asr:
        this.asrRequests === 0n
          ? null
          : {
              audioMs: this.asr.audioMs.toString(),
              billedInputTokens: this.asr.billedInput.toString(),
              billedOutputTokens: this.asr.billedOutput.toString(),
            },
    };
  }

  costCell(): UsageCostCell {
    return {
      amount: this.counted === 0n ? null : toMoney(this.currency, this.costSum),
      counted: toCount(this.counted),
      inCurrency: toCount(this.inCurrency),
      otherCurrency: toCount(this.otherCurrency),
      unknownCurrency: toCount(this.unknownCurrency),
      topReason: this.topReason(),
    };
  }

  /** The commonest reason a request in the display currency was left out; ties go to the earlier reason. */
  private topReason(): UsageCostCell["topReason"] {
    let best: UsageUnpricedReason | null = null;
    let bestCount = 0n;
    for (const reason of USAGE_UNPRICED_REASONS) {
      const entry = reason === "no_snapshot" ? undefined : this.leftOut.get(reason);
      if (entry !== undefined && entry.requests > bestCount) {
        best = reason;
        bestCount = entry.requests;
      }
    }
    if (best === null && this.inCurrency === 0n && this.otherCurrency === 0n && this.unknownCurrency > 0n) {
      return "no_snapshot";
    }
    return best;
  }

  /** `null` when no LLM call reported cache fields. */
  cacheHit(): { cacheRead: string; reportedInput: string; reportedRequests: number; llmRequests: number } | null {
    if (this.cache.reportedRequests === 0n) {
      return null;
    }
    return {
      cacheRead: this.cache.cacheRead.toString(),
      reportedInput: this.cache.reportedInput.toString(),
      reportedRequests: toCount(this.cache.reportedRequests),
      llmRequests: toCount(this.llmRequests),
    };
  }

  inputMissingRequests(): number {
    return toCount(this.inputMissing);
  }

  acceptedRequests(): number {
    return toCount(this.accepted);
  }

  coverage(): { llmTokens: { counted: string; total: string }; asrTokens: { counted: string; total: string }; audioMs: { counted: string; total: string } } {
    const text = (coverage: Coverage): { counted: string; total: string } => ({ counted: coverage.counted.toString(), total: coverage.total.toString() });
    return { llmTokens: text(this.llmCoverage), asrTokens: text(this.asrCoverage), audioMs: text(this.audioCoverage) };
  }

  /** Left-out reasons with their request counts and models, in the fixed order of the reason list. */
  unpriced(): Array<{ reason: UsageUnpricedReason; requests: number; modelKeys: string[] }> {
    return USAGE_UNPRICED_REASONS.flatMap((reason) => {
      const entry = this.leftOut.get(reason);
      return entry === undefined ? [] : [{ reason, requests: toCount(entry.requests), modelKeys: [...entry.modelKeys].sort() }];
    });
  }
}
