import { beforeEach, describe, expect, it } from "vitest";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { CHAPTER_AI_PROMPT, ROLLUP_PARTIAL_PROMPT } from "../../../src/server/domain/prompts.ts";
import { effectivePromptRef, freezePromptRefs, promptTextOf, resolvePrompt } from "../../../src/server/pipeline/prompts.ts";
import { EXPECTED_PROMPT_HISTORY } from "../../fixtures/spec/prompts.ts";
import { insertRow, openTempDatabase } from "../../tools/sqlite.ts";

let repository: SqliteRepository;

beforeEach(() => {
  const { db } = openTempDatabase();
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: 1 });
  repository.withTransaction((scope) => scope.promptOverrides.addVersion({ userId: "alice", promptId: "chapter.ai", version: 1, text: "alice 的切章", createdAt: 1 }));
});

describe("prompt resolution", () => {
  it("takes the owner's current version, else the builtin one", () => {
    repository.withTransaction((scope) => {
      expect(effectivePromptRef(scope, "alice", "chapter.ai")).toEqual({ id: "custom:chapter.ai", version: 1 });
      expect(effectivePromptRef(scope, "bob", "chapter.ai")).toEqual(CHAPTER_AI_PROMPT.ref);
      expect(freezePromptRefs(scope, "alice", "regenerate_summary")).toEqual({
        "summary.envelope": { id: "summary.envelope", version: 2 },
        "rollup.partial": ROLLUP_PARTIAL_PROMPT.ref,
        "rollup.carry": { id: "rollup.carry", version: 1 },
        "rollup.final": { id: "rollup.final", version: 2 },
      });
      expect(freezePromptRefs(scope, "alice", "burn")).toEqual({});
      scope.promptOverrides.clearCurrent("alice", "chapter.ai", 2);
      expect(effectivePromptRef(scope, "alice", "chapter.ai")).toEqual(CHAPTER_AI_PROMPT.ref);
    });
  });

  it("finds the text of an own, a current builtin and a historical builtin version, and nothing of another user's", () => {
    repository.withTransaction((scope) => {
      expect(promptTextOf(scope, "alice", { id: "custom:chapter.ai", version: 1 })).toBe("alice 的切章");
      expect(promptTextOf(scope, "bob", { id: "custom:chapter.ai", version: 1 })).toBeUndefined();
      expect(promptTextOf(scope, "bob", CHAPTER_AI_PROMPT.ref)).toBe(CHAPTER_AI_PROMPT.text);
      expect(promptTextOf(scope, "bob", { id: "rollup.partial", version: 1 })).toBe(EXPECTED_PROMPT_HISTORY.find((prompt) => prompt.id === "rollup.partial")?.text);
    });
  });

  it("uses a frozen version even after the setting changed, and the current builtin when it cannot be found", () => {
    const unresolved: unknown[] = [];
    repository.withTransaction((scope) => {
      scope.promptOverrides.clearCurrent("alice", "chapter.ai", 2);
      expect(resolvePrompt(scope, "alice", "chapter.ai", { id: "custom:chapter.ai", version: 1 })).toEqual({ ref: { id: "custom:chapter.ai", version: 1 }, text: "alice 的切章" });
      expect(resolvePrompt(scope, "bob", "chapter.ai", { id: "custom:chapter.ai", version: 1 }, (ref) => unresolved.push(ref))).toEqual(CHAPTER_AI_PROMPT);
      expect(resolvePrompt(scope, "bob", "chapter.ai", undefined, (ref) => unresolved.push(ref))).toEqual(CHAPTER_AI_PROMPT);
    });
    expect(unresolved).toEqual([{ id: "custom:chapter.ai", version: 1 }]);
  });
});
