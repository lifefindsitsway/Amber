import { describe, expect, it } from "vitest";
import { chatThreadTitle, effectiveAnswer, groupTurns, lastMessageOf, type ChatMessage } from "../../../src/server/domain/chat.ts";

function message(id: string, role: ChatMessage["role"], status: ChatMessage["status"] = "complete"): ChatMessage {
  return { id, threadId: "t", role, text: id, status, citations: [], createdAt: 0 };
}

describe("chat turns", () => {
  it("groups a question with every attempt up to the next question; leading answers belong to no turn", () => {
    const turns = groupTurns([message("x", "assistant"), message("u1", "user"), message("a1", "assistant"), message("a2", "assistant", "failed"), message("u2", "user")]);
    expect(turns.map((turn) => [turn.user.id, turn.attempts.map((attempt) => attempt.id)])).toEqual([
      ["u1", ["a1", "a2"]],
      ["u2", []],
    ]);
    expect(turns.map((turn) => lastMessageOf(turn).id)).toEqual(["a2", "u2"]);
  });

  it("takes the last complete attempt as the effective answer, else the last attempt", () => {
    const user = message("u", "user");
    expect(effectiveAnswer({ user, attempts: [message("a", "assistant"), message("b", "assistant", "failed")] })?.id).toBe("a");
    expect(effectiveAnswer({ user, attempts: [message("a", "assistant", "interrupted"), message("b", "assistant", "failed")] })?.id).toBe("b");
    expect(effectiveAnswer({ user, attempts: [message("a", "assistant"), message("b", "assistant", "streaming")] })?.id).toBe("a");
    expect(effectiveAnswer({ user, attempts: [] })).toBeUndefined();
  });
});

describe("chatThreadTitle", () => {
  it("is the first line of the first question, cut by code points", () => {
    expect(chatThreadTitle("  第一行  \r\n第二行", 40)).toBe("第一行");
    expect(chatThreadTitle("😀😀😀", 2)).toBe("😀😀");
    expect(chatThreadTitle(undefined, 40)).toBeUndefined();
    expect(chatThreadTitle("   ", 40)).toBeUndefined();
  });
});
