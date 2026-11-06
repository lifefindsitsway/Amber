import type { UsageMetric } from "../../../shared/dto/usage-analytics.ts";
import type { PriceCurrency } from "../../../shared/model-pricing.ts";
import { formatCompactCount, formatCount, formatDuration, formatMoney } from "../../format.ts";

/**
 * A chart or table value as the page writes it. Each metric has its own unit and none is
 * converted into another: money in the display currency, tokens and requests as counts,
 * audio as a clock time.
 */
export function formatMetricValue(metric: UsageMetric, raw: string, currency: PriceCurrency): string {
  switch (metric) {
    case "cost":
      return formatMoney({ currency, amount: raw });
    case "llm_tokens":
    case "asr_billed_tokens":
      return formatCompactCount(raw);
    case "requests":
      return formatCount(raw);
    case "audio":
      return formatDuration(Number(raw));
  }
}
