import { describe, expect, it } from "vitest";
import { effectiveCapability, newModelCapability, withoutObserved, withUserLimits, type ModelCapability } from "../../../src/server/domain/provider-profile.ts";

const declared = {
  stream: "supported",
  tools: "unknown",
  structuredOutput: "unknown",
  vision: "unsupported",
  audioInput: "unknown",
  reasoning: "unknown",
} as const;

describe("effectiveCapability", () => {
  it("merges each field as userOverride ?? observed ?? declared", () => {
    const capability: ModelCapability = {
      modelId: "relay-model",
      flags: {
        declared,
        observed: { tools: "supported", structuredOutput: "unsupported" },
        userOverride: { structuredOutput: "supported" },
      },
      limits: {
        declared: { maxOutputTokens: 4096 },
        observed: { contextWindowTokens: 64000 },
        userOverride: { contextWindowTokens: 32000 },
      },
    };
    expect(effectiveCapability(capability)).toEqual({
      flags: { ...declared, tools: "supported", structuredOutput: "supported" },
      limits: { contextWindowTokens: 32000, maxOutputTokens: 4096 },
    });
  });

  it("leaves an unknown context window absent instead of inventing one", () => {
    const capability: ModelCapability = { modelId: "m", flags: { declared }, limits: { declared: {} } };
    expect(effectiveCapability(capability).limits).toEqual({});
  });
});

describe("user-stated limits", () => {
  it("records stated limits as the user's override and leaves the layer out when none are stated", () => {
    expect(newModelCapability("m", { contextWindowTokens: 128_000, maxOutputTokens: 4_096 }).limits).toEqual({
      declared: {},
      userOverride: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
    });
    expect(newModelCapability("m").limits).toEqual({ declared: {} });
    expect(newModelCapability("m", { contextWindowTokens: null, maxOutputTokens: null }).limits).toEqual({ declared: {} });
  });

  it("keeps an omitted limit, replaces a stated one and clears a null one, leaving other layers alone", () => {
    const kept: ModelCapability = {
      modelId: "m",
      flags: { declared, observed: { tools: "supported" } },
      limits: { declared: {}, observed: { maxOutputTokens: 1 }, userOverride: { contextWindowTokens: 64_000, maxOutputTokens: 2_000 } },
      observedAt: 5,
    };
    expect(withUserLimits(kept, {}).limits.userOverride).toEqual({ contextWindowTokens: 64_000, maxOutputTokens: 2_000 });
    expect(withUserLimits(kept, { contextWindowTokens: 128_000 }).limits.userOverride).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 2_000 });
    expect(withUserLimits(kept, { maxOutputTokens: null }).limits.userOverride).toEqual({ contextWindowTokens: 64_000 });
    const cleared = withUserLimits(kept, { contextWindowTokens: null, maxOutputTokens: null });
    expect(cleared.limits).toEqual({ declared: {}, observed: { maxOutputTokens: 1 } });
    expect(cleared.flags).toEqual(kept.flags);
    expect(cleared.observedAt).toBe(5);
  });

  it("drops every measured layer and its time, keeping declared values and overrides", () => {
    const measured: ModelCapability = {
      modelId: "m",
      flags: { declared, observed: { stream: "unsupported" }, userOverride: { tools: "supported" } },
      limits: { declared: {}, observed: { contextWindowTokens: 1 }, userOverride: { contextWindowTokens: 2 } },
      observedAt: 9,
      pricing: { currency: "USD", items: [{ unit: "per_request", amount: "1" }] },
    };
    expect(withoutObserved(measured)).toEqual({
      modelId: "m",
      flags: { declared, userOverride: { tools: "supported" } },
      limits: { declared: {}, userOverride: { contextWindowTokens: 2 } },
      pricing: { currency: "USD", items: [{ unit: "per_request", amount: "1" }] },
    });
  });
});
