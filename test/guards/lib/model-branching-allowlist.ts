/**
 * Exceptions to the model-name branching guard. Each entry names one file allowed to match model
 * names, the single file allowed to import it, and why; the guard also requires the file to keep
 * type-only imports and to still contain a match, so an entry cannot outlive its reason.
 */
export interface ModelBranchingAllowlistEntry {
  /** Repository-relative path with forward slashes. */
  file: string;
  /** The only file that may import `file`. */
  importer: string;
  reason: string;
}

export const MODEL_BRANCHING_ALLOWLIST: readonly ModelBranchingAllowlistEntry[] = [
  {
    file: "src/web/models/model-family.ts",
    importer: "src/web/models/model-mark.tsx",
    reason:
      "Guesses a vendor from a model name only to pick the decorative icon drawn beside that name; it imports types only and only the icon component reads it, so the guess cannot reach requests, capabilities, pricing, filters or defaults.",
  },
];
