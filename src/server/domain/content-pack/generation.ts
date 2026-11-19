import type { PackGeneration, TranscriptGeneration, TranscriptRevision } from "../transcript.ts";

/**
 * How a revision was made, reduced to what may cross devices: its kind and generation where it
 * was made and the model's display name. Prompt snapshots, speaker context snapshots and
 * Profile ids stay behind. A revision that a pack carried in keeps its first origin.
 */
export function packGenerationOf(revision: Pick<TranscriptRevision, "kind" | "generation">): PackGeneration {
  const generation: TranscriptGeneration = revision.generation;
  switch (generation.kind) {
    case "pack":
      return {
        kind: "pack",
        originalKind: generation.originalKind,
        originalGeneration: generation.originalGeneration,
        ...(generation.modelName === undefined ? {} : { modelName: generation.modelName }),
      };
    case "llm": {
      const name = modelName(generation.modelRef.modelDisplaySnapshot || generation.modelRef.modelId);
      return { kind: "pack", originalKind: revision.kind, originalGeneration: "llm", ...(name === undefined ? {} : { modelName: name }) };
    }
    case "asr": {
      const name = modelName(generation.modelId);
      return { kind: "pack", originalKind: revision.kind, originalGeneration: "asr", ...(name === undefined ? {} : { modelName: name }) };
    }
    case "platform":
    case "imported":
    case "manual":
      return { kind: "pack", originalKind: revision.kind, originalGeneration: generation.kind };
  }
}

/** The longest model name a pack document accepts. */
const MODEL_NAME_MAX_CHARS = 200;

function modelName(value: string): string | undefined {
  const trimmed = value.trim().slice(0, MODEL_NAME_MAX_CHARS);
  return trimmed === "" ? undefined : trimmed;
}
