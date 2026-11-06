import { describe, expect, it } from "vitest";
import { LIST_PAGE_SIZE_DEFAULT } from "../../../src/shared/defaults.ts";
import {
  USAGE_UNPRICED_REASONS,
  USAGE_UNPRICED_REASON_GROUP,
  countStringSchema,
  decodeModelKey,
  decodeProfileKey,
  encodeModelKey,
  encodeProfileKey,
  moneySchema,
  usageActivitiesQuerySchema,
  usageCallsQuerySchema,
  usageFilterQuerySchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
} from "../../../src/shared/dto/usage-analytics.ts";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("usage keys", () => {
  it("round-trips a profile key, including the empty profile of indistinguishable historic rows", () => {
    expect(decodeProfileKey(encodeProfileKey(["llm", "01HX"]))).toEqual(["llm", "01HX"]);
    expect(decodeProfileKey(encodeProfileKey(["asr", ""]))).toEqual(["asr", ""]);
  });

  it("round-trips a model key whose id has unicode, slashes and quotes", () => {
    for (const modelId of ["claude-sonnet-x", "模型/带斜杠 \"q\"", "😀", ""]) {
      expect(decodeModelKey(encodeModelKey(["llm", "p-1", modelId]))).toEqual(["llm", "p-1", modelId]);
    }
  });

  it("encodes without padding or characters that need escaping in a URL", () => {
    const key = encodeModelKey(["asr", "", "模型??>>"]);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).toBe(b64url(JSON.stringify(["asr", "", "模型??>>"])));
  });

  it("keeps different profiles, modalities and models apart", () => {
    const keys = new Set([
      encodeModelKey(["llm", "p", "m"]),
      encodeModelKey(["asr", "p", "m"]),
      encodeModelKey(["llm", "q", "m"]),
      encodeModelKey(["llm", "p", "n"]),
    ]);
    expect(keys.size).toBe(4);
  });

  it("answers undefined for anything that is not a key", () => {
    const malformed = [
      "",
      "!!!",
      "a b",
      "abc=",
      "A",
      b64url("not json"),
      b64url("{}"),
      b64url("null"),
      b64url(JSON.stringify(["llm"])),
      b64url(JSON.stringify(["llm", "p", "m", "x"])),
      b64url(JSON.stringify(["web", "p", "m"])),
      b64url(JSON.stringify(["llm", 1, "m"])),
      b64url(JSON.stringify(["llm", "p", null])),
      Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url"),
      // The same parts spelled with extra whitespace are not the key the server issues.
      b64url('["llm", "p", "m"]'),
    ];
    for (const key of malformed) {
      expect(decodeModelKey(key), key).toBeUndefined();
    }
    expect(decodeProfileKey(encodeModelKey(["llm", "p", "m"]))).toBeUndefined();
    expect(decodeModelKey(encodeProfileKey(["llm", "p"]))).toBeUndefined();
    expect(decodeProfileKey(b64url(JSON.stringify(["llm", 7])))).toBeUndefined();
  });
});

describe("scalars", () => {
  it("accepts a count string only as a plain non-negative decimal", () => {
    for (const ok of ["0", "7", "10", "123456789012345678901234567890"]) {
      expect(countStringSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "-1", "01", "1.0", "1e3", " 1", "1 ", "0x10", "١٢"]) {
      expect(countStringSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(countStringSchema.safeParse(5).success).toBe(false);
  });

  it("accepts an amount of up to 8 fraction digits and a known currency only", () => {
    for (const amount of ["0", "12", "0.5", "0.00000001", "1234.12345678"]) {
      expect(moneySchema.safeParse({ currency: "CNY", amount }).success, amount).toBe(true);
    }
    for (const amount of ["", "-0.1", "00.1", "1.", ".5", "1.123456789", "1e-3", "1,5"]) {
      expect(moneySchema.safeParse({ currency: "USD", amount }).success, amount).toBe(false);
    }
    expect(moneySchema.safeParse({ currency: "EUR", amount: "1" }).success).toBe(false);
    expect(moneySchema.safeParse({ currency: "CNY", amount: "1", extra: 1 }).success).toBe(false);
  });
});

describe("usage filter", () => {
  it("takes a preset alone and rejects bounds beside it", () => {
    expect(usageFilterQuerySchema.safeParse({ range: "7d" }).success).toBe(true);
    expect(usageFilterQuerySchema.safeParse({ range: "all" }).success).toBe(true);
    expect(usageFilterQuerySchema.safeParse({ range: "24h", from: "1" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "30d", to: "5" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "yesterday" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({}).success).toBe(false);
  });

  it("needs both bounds for a custom range, in order, and reads them from strings", () => {
    expect(usageFilterQuerySchema.parse({ range: "custom", from: "1000", to: "2000" })).toEqual({ range: "custom", from: 1000, to: 2000 });
    expect(usageFilterQuerySchema.safeParse({ range: "custom" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "custom", from: "1000" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "custom", to: "1000" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "custom", from: "2000", to: "2000" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "custom", from: "3000", to: "2000" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "custom", from: "-1", to: "2000" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "custom", from: "1.5", to: "2000" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "custom", from: "abc", to: "2000" }).success).toBe(false);
  });

  it("lets a credential version narrow only a chosen profile", () => {
    expect(usageFilterQuerySchema.safeParse({ range: "7d", credentialVersion: "v1" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "7d", profileKey: "k", credentialVersion: "legacy" }).success).toBe(true);
  });

  it("refuses unknown parameters and modalities", () => {
    expect(usageFilterQuerySchema.safeParse({ range: "7d", surprise: "1" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "7d", modality: "tts" }).success).toBe(false);
    expect(usageFilterQuerySchema.safeParse({ range: "7d", modality: "asr", modelKey: "k" }).success).toBe(true);
  });
});

describe("analysis queries", () => {
  it("requires a display currency on every one that shows money, and applies the filter rules", () => {
    expect(usageSummaryQuerySchema.safeParse({ range: "7d" }).success).toBe(false);
    expect(usageSummaryQuerySchema.parse({ range: "7d", displayCurrency: "USD", granularity: "day", simulate: "1" })).toEqual({
      range: "7d",
      displayCurrency: "USD",
      granularity: "day",
      simulate: "1",
    });
    expect(usageSummaryQuerySchema.safeParse({ range: "7d", displayCurrency: "CNY", simulate: "2" }).success).toBe(false);
    expect(usageSummaryQuerySchema.safeParse({ range: "7d", displayCurrency: "CNY", granularity: "year" }).success).toBe(false);
    expect(usageSummaryQuerySchema.safeParse({ range: "custom", displayCurrency: "CNY" }).success).toBe(false);
    expect(usageCallsQuerySchema.safeParse({ range: "7d", displayCurrency: "CNY" }).success).toBe(false);
    expect(usageCallsQuerySchema.safeParse({ range: "7d", displayCurrency: "CNY", group: "" }).success).toBe(false);
    expect(usageCallsQuerySchema.safeParse({ range: "7d", displayCurrency: "CNY", group: "g" }).success).toBe(true);
  });

  it("pages the activity list from 1 with a default size, accepting only the sizes the pager offers", () => {
    expect(usageActivitiesQuerySchema.parse({ range: "30d", displayCurrency: "CNY" })).toMatchObject({ page: 1, pageSize: LIST_PAGE_SIZE_DEFAULT });
    for (const size of ["10", "15", "20", "50"]) {
      expect(usageActivitiesQuerySchema.parse({ range: "30d", displayCurrency: "CNY", pageSize: size }).pageSize).toBe(Number(size));
    }
    for (const size of ["0", "5", "100", "12.5", "abc"]) {
      expect(usageActivitiesQuerySchema.safeParse({ range: "30d", displayCurrency: "CNY", pageSize: size }).success, size).toBe(false);
    }
    expect(usageActivitiesQuerySchema.parse({ range: "30d", displayCurrency: "CNY", page: "3" }).page).toBe(3);
    expect(usageActivitiesQuerySchema.safeParse({ range: "30d", displayCurrency: "CNY", page: "0" }).success).toBe(false);
  });
});

describe("unpriced reasons", () => {
  it("groups every reason as a price, usage or history matter", () => {
    expect(Object.keys(USAGE_UNPRICED_REASON_GROUP).sort()).toEqual([...USAGE_UNPRICED_REASONS].sort());
    expect(USAGE_UNPRICED_REASONS.filter((reason) => USAGE_UNPRICED_REASON_GROUP[reason] === "price")).toHaveLength(5);
    expect(USAGE_UNPRICED_REASONS.filter((reason) => USAGE_UNPRICED_REASON_GROUP[reason] === "usage")).toHaveLength(4);
    expect(USAGE_UNPRICED_REASON_GROUP.no_snapshot).toBe("history");
  });
});

describe("summary response", () => {
  const cost = { amount: null, counted: 0, inCurrency: 0, otherCurrency: 0, unknownCurrency: 0, topReason: null };
  const results = { succeeded: 0, failed: 0, outcome_unknown: 0, cancelled: 0 };
  const empty = {
    range: { preset: "all", from: null, to: 1_790_000_000_000 },
    granularity: "month",
    allowedGranularities: ["month"],
    displayCurrency: "CNY",
    currencies: [],
    summary: { requests: 0, results, cost, usage: { llm: null, asr: null }, cacheHit: null, inputMissingRequests: 0, acceptedRequests: 0 },
    costDetail: {
      unpriced: [],
      coverage: { llmTokens: { counted: "0", total: "0" }, asrTokens: { counted: "0", total: "0" }, audioMs: { counted: "0", total: "0" } },
      simulated: null,
    },
    series: [],
    models: [],
    options: { profiles: [], models: [] },
  };

  it("accepts an empty history and refuses unknown fields", () => {
    expect(usageSummaryResponseSchema.safeParse(empty).success).toBe(true);
    expect(usageSummaryResponseSchema.safeParse({ ...empty, surprise: 1 }).success).toBe(false);
    expect(usageSummaryResponseSchema.safeParse({ ...empty, summary: { ...empty.summary, usage: { llm: null } } }).success).toBe(false);
  });
});
