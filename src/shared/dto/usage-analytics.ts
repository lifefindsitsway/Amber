import { z } from "zod";
import { LIST_PAGE_SIZE_DEFAULT } from "../defaults.ts";
import { ASR_USAGE_FEATURES, TOKEN_USAGE_FEATURES } from "../enums.ts";
import { isListPageSize, type ListPageSize } from "../list-pagination.ts";
import { PRICE_CURRENCIES } from "../model-pricing.ts";

export const USAGE_RANGES = ["24h", "48h", "7d", "30d", "all", "custom"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const USAGE_GRANULARITIES = ["hour", "day", "week", "month"] as const;
export type UsageGranularity = (typeof USAGE_GRANULARITIES)[number];

export const USAGE_MODALITIES = ["llm", "asr"] as const;
export type UsageModality = (typeof USAGE_MODALITIES)[number];

/** What a chart or a ranking can measure; each has its own unit and none is converted into another. */
export const USAGE_METRICS = ["cost", "llm_tokens", "asr_billed_tokens", "requests", "audio"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/**
 * How a call ended, as the user reads it. An ASR job reports its remote outcome once known,
 * so its effective result is `jobOutcome ?? outcome`; an unknown result is not a failure.
 */
export const USAGE_RESULTS = ["succeeded", "failed", "outcome_unknown", "cancelled"] as const;
export type UsageResult = (typeof USAGE_RESULTS)[number];

/** Why a request is left out of an estimated cost. */
export const USAGE_UNPRICED_REASONS = [
  "missing_price",
  "missing_cache_read_price",
  "missing_cache_write_price",
  "missing_cache_write_1h_price",
  "conflicting_units",
  "input_missing",
  "usage_missing",
  "unknown_without_usage",
  "failed_without_usage",
  "no_snapshot",
] as const;
export type UsageUnpricedReason = (typeof USAGE_UNPRICED_REASONS)[number];

/** What a reason asks of the user: fix a price, nothing (the upstream sent no usage), or nothing (an old record). */
export type UsageUnpricedGroup = "price" | "usage" | "history";

export const USAGE_UNPRICED_REASON_GROUP: Readonly<Record<UsageUnpricedReason, UsageUnpricedGroup>> = {
  missing_price: "price",
  missing_cache_read_price: "price",
  missing_cache_write_price: "price",
  missing_cache_write_1h_price: "price",
  conflicting_units: "price",
  input_missing: "usage",
  usage_missing: "usage",
  unknown_without_usage: "usage",
  failed_without_usage: "usage",
  no_snapshot: "history",
};

/** What one row of the activity list stands for. */
export const USAGE_ACTIVITY_KINDS = ["task", "chat", "test", "content_day", "deleted_day"] as const;
export type UsageActivityKind = (typeof USAGE_ACTIVITY_KINDS)[number];

/** Palette slots of a chart; `other` is the merged remainder beyond the individually coloured series. */
export const USAGE_COLOR_KEYS = ["series-0", "series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7", "other"] as const;
export type UsageColorKey = (typeof USAGE_COLOR_KEYS)[number];

/** Credential filter value for rows recorded before credential versions were kept. */
export const USAGE_LEGACY_CREDENTIAL = "legacy";

// Keys ------------------------------------------------------------------------------------

/** `[modality, profileId]`; `profileId` is empty for historic ASR rows whose profile cannot be told apart. */
export type UsageProfileKeyParts = readonly [modality: UsageModality, profileId: string];
/** `[modality, profileId, modelId]`; models of different profiles or modalities never merge. */
export type UsageModelKeyParts = readonly [modality: UsageModality, profileId: string, modelId: string];

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(key: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    return undefined;
  }
  try {
    const binary = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function isModality(value: unknown): value is UsageModality {
  return typeof value === "string" && (USAGE_MODALITIES as readonly string[]).includes(value);
}

function decodeParts(key: string, length: number): string[] | undefined {
  const text = fromBase64Url(key);
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== length || !isModality(parsed[0]) || !parsed.every((part) => typeof part === "string")) {
    return undefined;
  }
  // Only the exact encoding of the parts is a key: a differently spelled equivalent would give one profile two keys.
  return toBase64Url(JSON.stringify(parsed)) === key ? (parsed as string[]) : undefined;
}

/** Opaque to clients: the server builds keys and clients echo them back. */
export function encodeProfileKey(parts: UsageProfileKeyParts): string {
  return toBase64Url(JSON.stringify([parts[0], parts[1]]));
}

/** `undefined` for anything that is not a key this module encoded. */
export function decodeProfileKey(key: string): UsageProfileKeyParts | undefined {
  const parts = decodeParts(key, 2);
  return parts === undefined ? undefined : [parts[0] as UsageModality, parts[1] as string];
}

export function encodeModelKey(parts: UsageModelKeyParts): string {
  return toBase64Url(JSON.stringify([parts[0], parts[1], parts[2]]));
}

/** `undefined` for anything that is not a key this module encoded. */
export function decodeModelKey(key: string): UsageModelKeyParts | undefined {
  const parts = decodeParts(key, 3);
  return parts === undefined ? undefined : [parts[0] as UsageModality, parts[1] as string, parts[2] as string];
}

// Scalars ---------------------------------------------------------------------------------

const keySchema = z.string().min(1);
const requestCountSchema = z.number().int().nonnegative();
const msSchema = z.number().int().nonnegative();
const currencySchema = z.enum(PRICE_CURRENCIES);
const colorKeySchema = z.enum(USAGE_COLOR_KEYS);
const resultSchema = z.enum(USAGE_RESULTS);
const reasonSchema = z.enum(USAGE_UNPRICED_REASONS);
const granularitySchema = z.enum(USAGE_GRANULARITIES);

/** A non-negative integer as a decimal string: token and millisecond sums can exceed what a JSON number holds exactly. */
export const countStringSchema = z.string().regex(/^(0|[1-9]\d*)$/);

/** An exact sum, rounded half-up to 8 fraction digits with trailing zeros trimmed, in `currency`. */
export const moneySchema = z
  .object({
    currency: currencySchema,
    amount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/),
  })
  .strict();
export type Money = z.infer<typeof moneySchema>;

// Queries ---------------------------------------------------------------------------------

const timestampQuerySchema = z.coerce.number().int().min(0);

const usageFilterShape = {
  range: z.enum(USAGE_RANGES),
  from: timestampQuerySchema.exactOptional(),
  to: timestampQuerySchema.exactOptional(),
  profileKey: keySchema.exactOptional(),
  credentialVersion: keySchema.exactOptional(),
  modelKey: keySchema.exactOptional(),
  modality: z.enum(USAGE_MODALITIES).exactOptional(),
};

interface UsageFilterFields {
  range: UsageRange;
  from?: number | undefined;
  to?: number | undefined;
  profileKey?: string | undefined;
  credentialVersion?: string | undefined;
}

/** A custom range is a half-open interval the client names; a preset is anchored to now by the server. */
function checkUsageFilter(filter: UsageFilterFields, ctx: z.core.$RefinementCtx): void {
  if (filter.range === "custom") {
    if (filter.from === undefined || filter.to === undefined) {
      ctx.addIssue({ code: "custom", message: "a custom range needs both from and to", path: [filter.from === undefined ? "from" : "to"] });
    } else if (filter.from >= filter.to) {
      ctx.addIssue({ code: "custom", message: "from must be before to", path: ["from"] });
    }
  } else {
    for (const bound of ["from", "to"] as const) {
      if (filter[bound] !== undefined) {
        ctx.addIssue({ code: "custom", message: "only a custom range takes from and to", path: [bound] });
      }
    }
  }
  // A version belongs to one profile; on its own it would match unrelated profiles.
  if (filter.credentialVersion !== undefined && filter.profileKey === undefined) {
    ctx.addIssue({ code: "custom", message: "a credential version needs its profile", path: ["credentialVersion"] });
  }
}

/** The filter every usage analysis shares; it never includes the display currency. */
export const usageFilterQuerySchema = z.object(usageFilterShape).strict().superRefine(checkUsageFilter);
export type UsageFilterQuery = z.infer<typeof usageFilterQuerySchema>;

/** `GET /api/usage/summary`; a missing granularity lets the server pick one for the range. */
export const usageSummaryQuerySchema = z
  .object({
    ...usageFilterShape,
    granularity: granularitySchema.exactOptional(),
    displayCurrency: currencySchema,
    simulate: z.enum(["0", "1"]).exactOptional(),
  })
  .strict()
  .superRefine(checkUsageFilter);
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>;

const pageSizeSchema = z.coerce
  .number()
  .int()
  .refine((value): value is ListPageSize => isListPageSize(value))
  .default(LIST_PAGE_SIZE_DEFAULT);

/** `GET /api/usage/activities` */
export const usageActivitiesQuerySchema = z
  .object({
    ...usageFilterShape,
    displayCurrency: currencySchema,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: pageSizeSchema,
  })
  .strict()
  .superRefine(checkUsageFilter);
export type UsageActivitiesQuery = z.infer<typeof usageActivitiesQuerySchema>;

/** `GET /api/usage/calls`; `group` is an activity's opaque group key. */
export const usageCallsQuerySchema = z
  .object({
    ...usageFilterShape,
    displayCurrency: currencySchema,
    group: keySchema,
  })
  .strict()
  .superRefine(checkUsageFilter);
export type UsageCallsQuery = z.infer<typeof usageCallsQuerySchema>;

// Responses -------------------------------------------------------------------------------

export const usageResultCountsSchema = z
  .object({
    succeeded: requestCountSchema,
    failed: requestCountSchema,
    outcome_unknown: requestCountSchema,
    cancelled: requestCountSchema,
  })
  .strict();
export type UsageResultCounts = z.infer<typeof usageResultCountsSchema>;

/** Quantities by modality; a modality with no calls in scope is `null` rather than a row of zeros. */
export const usageModalityUsageSchema = z
  .object({
    llm: z
      .object({
        input: countStringSchema,
        output: countStringSchema,
        reasoning: countStringSchema,
        cacheRead: countStringSchema,
        cacheWrite: countStringSchema,
        cacheWrite1h: countStringSchema,
      })
      .strict()
      .nullable(),
    asr: z
      .object({
        audioMs: countStringSchema,
        billedInputTokens: countStringSchema,
        billedOutputTokens: countStringSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type UsageModalityUsage = z.infer<typeof usageModalityUsageSchema>;

/**
 * The estimated cost of an aggregate in the display currency. `inCurrency` counts the
 * requests priced in that currency, counted or not; `topReason` is the commonest reason
 * among those that were left out, or `no_snapshot` when only unknown-currency requests exist.
 */
export const usageCostCellSchema = z
  .object({
    amount: moneySchema.nullable(),
    counted: requestCountSchema,
    inCurrency: requestCountSchema,
    otherCurrency: requestCountSchema,
    unknownCurrency: requestCountSchema,
    topReason: reasonSchema.nullable(),
  })
  .strict();
export type UsageCostCell = z.infer<typeof usageCostCellSchema>;

const coverageSchema = z.object({ counted: countStringSchema, total: countStringSchema }).strict();

const seriesSchema = z
  .object({
    metric: z.enum(USAGE_METRICS),
    series: z.array(
      z
        .object({
          key: z.string(),
          /** `null` for the merged "other" series. */
          modelKey: z.string().nullable(),
          colorKey: colorKeySchema,
        })
        .strict(),
    ),
    /** Contiguous, empty buckets included; `values` align with `series`: money amounts for cost, count strings otherwise. */
    buckets: z.array(z.object({ start: msSchema, end: msSchema, values: z.array(z.string()), total: z.string() }).strict()),
  })
  .strict();

const usageModelSchema = z
  .object({
    modelKey: keySchema,
    profileKey: keySchema,
    modality: z.enum(USAGE_MODALITIES),
    profileName: z.string().nullable(),
    profileDeleted: z.boolean(),
    modelId: z.string(),
    credentialVersions: z.array(z.string()),
    colorKey: colorKeySchema,
    requests: requestCountSchema,
    results: usageResultCountsSchema,
    usage: usageModalityUsageSchema,
    cost: usageCostCellSchema,
  })
  .strict();

const usageOptionsSchema = z
  .object({
    profiles: z.array(
      z
        .object({
          profileKey: keySchema,
          modality: z.enum(USAGE_MODALITIES),
          profileName: z.string().nullable(),
          deleted: z.boolean(),
          versions: z.array(
            z
              .object({
                /** A credential version id, or `USAGE_LEGACY_CREDENTIAL` for rows recorded before versions were kept. */
                credentialVersion: keySchema,
                setAt: msSchema.nullable(),
                requests: requestCountSchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    models: z.array(z.object({ modelKey: keySchema, profileKey: keySchema, modelId: z.string() }).strict()),
  })
  .strict();

/** `GET /api/usage/summary` */
export const usageSummaryResponseSchema = z
  .object({
    /** Resolved half-open bounds; `from` is `null` only for `all` over an empty history. */
    range: z.object({ preset: z.enum(USAGE_RANGES), from: msSchema.nullable(), to: msSchema }).strict(),
    granularity: granularitySchema,
    allowedGranularities: z.array(granularitySchema),
    displayCurrency: currencySchema,
    /** Currencies seen in any of the owner's snapshots, over all time and unfiltered; decides the default display currency. */
    currencies: z.array(currencySchema),
    summary: z
      .object({
        requests: requestCountSchema,
        results: usageResultCountsSchema,
        cost: usageCostCellSchema,
        usage: usageModalityUsageSchema,
        cacheHit: z
          .object({
            cacheRead: countStringSchema,
            reportedInput: countStringSchema,
            reportedRequests: requestCountSchema,
            llmRequests: requestCountSchema,
          })
          .strict()
          .nullable(),
        inputMissingRequests: requestCountSchema,
        /** ASR jobs submitted successfully whose remote result is not known yet. */
        acceptedRequests: requestCountSchema,
      })
      .strict(),
    costDetail: z
      .object({
        unpriced: z.array(z.object({ reason: reasonSchema, requests: requestCountSchema, modelKeys: z.array(z.string()) }).strict()),
        coverage: z.object({ llmTokens: coverageSchema, asrTokens: coverageSchema, audioMs: coverageSchema }).strict(),
        simulated: z.object({ cost: moneySchema, requests: requestCountSchema, unavailable: requestCountSchema }).strict().nullable(),
      })
      .strict(),
    /** One entry per metric. */
    series: z.array(seriesSchema),
    models: z.array(usageModelSchema),
    /** Covers the time range only, ignoring the other filters, so every menu stays switchable. */
    options: usageOptionsSchema,
  })
  .strict();
export type UsageSummaryResponse = z.infer<typeof usageSummaryResponseSchema>;

const usageFeatureSchema = z.union([z.enum(TOKEN_USAGE_FEATURES), z.enum(ASR_USAGE_FEATURES)]);

/** One row of the activity list: the calls that belong together, grouped before paging. */
export const usageActivitySchema = z
  .object({
    /** Opaque; `GET /api/usage/calls` takes it back. */
    group: keySchema,
    kind: z.enum(USAGE_ACTIVITY_KINDS),
    startedAt: msSchema,
    endedAt: msSchema,
    title: z.string().nullable(),
    contentId: z.string().nullable(),
    taskId: z.string().nullable(),
    chatMessageId: z.string().nullable(),
    features: z.array(usageFeatureSchema),
    /** The primary model first. */
    models: z.array(z.object({ modelKey: keySchema, profileName: z.string().nullable(), modelId: z.string(), requests: requestCountSchema }).strict()),
    credentialVersions: z.array(z.string()),
    requests: requestCountSchema,
    results: usageResultCountsSchema,
    usage: usageModalityUsageSchema,
    cost: usageCostCellSchema,
  })
  .strict();
export type UsageActivity = z.infer<typeof usageActivitySchema>;

/** `GET /api/usage/activities` */
export const usageActivitiesResponseSchema = z
  .object({
    items: z.array(usageActivitySchema),
    total: requestCountSchema,
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  })
  .strict();
export type UsageActivitiesResponse = z.infer<typeof usageActivitiesResponseSchema>;

/** One call, with the cost it contributes or why it contributes none. */
export const usageCallSchema = z
  .object({
    id: keySchema,
    modality: z.enum(USAGE_MODALITIES),
    occurredAt: msSchema,
    feature: usageFeatureSchema,
    modelKey: keySchema,
    profileName: z.string().nullable(),
    modelId: z.string(),
    credentialVersion: z.string().nullable(),
    credentialSetAt: msSchema.nullable(),
    result: resultSchema,
    /** An ASR job that was accepted but has no remote outcome yet. */
    accepted: z.boolean(),
    inputMissing: z.boolean(),
    usage: usageModalityUsageSchema,
    cost: z
      .object({
        status: z.enum(["counted", "other_currency", "not_counted"]),
        amount: moneySchema.nullable(),
        currency: currencySchema.nullable(),
        reason: reasonSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type UsageCall = z.infer<typeof usageCallSchema>;

/** `GET /api/usage/calls`, chronological. */
export const usageCallsResponseSchema = z.object({ items: z.array(usageCallSchema) }).strict();
export type UsageCallsResponse = z.infer<typeof usageCallsResponseSchema>;

/** `GET /api/usage/cache-observed`: LLM models whose usage ever reported a cache read, as model keys. */
export const usageCacheObservedResponseSchema = z.object({ models: z.array(z.object({ modelKey: keySchema }).strict()) }).strict();
export type UsageCacheObservedResponse = z.infer<typeof usageCacheObservedResponseSchema>;
