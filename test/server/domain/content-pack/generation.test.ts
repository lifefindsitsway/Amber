import { describe, expect, it } from "vitest";
import { packGenerationOf } from "../../../../src/server/domain/content-pack/generation.ts";

describe("pack generation", () => {
  it("keeps only the kind, the generation and the model's display name", () => {
    expect(
      packGenerationOf({
        kind: "corrected",
        generation: {
          kind: "llm",
          modelRef: { providerProfileId: "profile", modelId: "deepseek-chat", providerNameSnapshot: "relay", modelDisplaySnapshot: "DeepSeek V3" },
          promptRef: { id: "proofread", version: 2 },
          promptSnapshot: "secret",
          speakerContext: { speakers: [] } as never,
        },
      }),
    ).toEqual({ kind: "pack", originalKind: "corrected", originalGeneration: "llm", modelName: "DeepSeek V3" });
    expect(packGenerationOf({ kind: "asr", generation: { kind: "asr", asrProfileId: "profile", modelId: "paraformer-v2", purpose: "comparison" } })).toEqual({
      kind: "pack",
      originalKind: "asr",
      originalGeneration: "asr",
      modelName: "paraformer-v2",
    });
    expect(packGenerationOf({ kind: "translated", generation: { kind: "manual", origin: { revisionId: "r", modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "n", modelDisplaySnapshot: "M" } } } })).toEqual({
      kind: "pack",
      originalKind: "translated",
      originalGeneration: "manual",
    });
    expect(packGenerationOf({ kind: "platform", generation: { kind: "platform", acquisition: "authenticated" } })).toEqual({ kind: "pack", originalKind: "platform", originalGeneration: "platform" });
  });

  it("keeps the first origin of a revision carried again", () => {
    const first = { kind: "pack", originalKind: "corrected", originalGeneration: "llm", modelName: "DeepSeek V3" } as const;
    expect(packGenerationOf({ kind: "imported", generation: first })).toEqual(first);
  });

  it("falls back to the model id and leaves an empty name out", () => {
    expect(
      packGenerationOf({
        kind: "translated",
        generation: { kind: "llm", modelRef: { providerProfileId: "p", modelId: "gpt-x", providerNameSnapshot: "n", modelDisplaySnapshot: "" }, promptRef: { id: "t", version: 1 }, promptSnapshot: "" },
      }).modelName,
    ).toBe("gpt-x");
    expect(packGenerationOf({ kind: "asr", generation: { kind: "asr", asrProfileId: "p", modelId: " " } })).toEqual({ kind: "pack", originalKind: "asr", originalGeneration: "asr" });
  });
});
