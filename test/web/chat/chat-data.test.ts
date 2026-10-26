import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageDto } from "../../../src/shared/dto/chat.ts";
import { effectiveAnswer, groupTurns, latestThread, readStoredThread, storeThread, threadStorageKey, turnDisplay } from "../../../src/web/chat/chat-data.ts";

const message = (id: string, role: "user" | "assistant", status: ChatMessageDto["status"] = "complete"): ChatMessageDto => ({
  id,
  role,
  text: id,
  status,
  citations: [],
  createdAt: 1,
});

describe("chat turns", () => {
  it("groups a question with every attempt that follows it", () => {
    const turns = groupTurns([message("u1", "user"), message("a1", "assistant"), message("u2", "user"), message("a2", "assistant", "failed"), message("a3", "assistant")]);
    expect(turns.map((turn) => [turn.key, turn.user?.id, turn.attempts.map((attempt) => attempt.id)])).toEqual([
      ["u1", "u1", ["a1"]],
      ["u2", "u2", ["a2", "a3"]],
    ]);
  });

  it("takes the last complete attempt as the effective answer, else the last attempt", () => {
    const [kept] = groupTurns([message("u1", "user"), message("a1", "assistant"), message("a2", "assistant", "failed")]);
    expect(effectiveAnswer(kept!)?.id).toBe("a1");
    const [none] = groupTurns([message("u1", "user"), message("a1", "assistant", "interrupted"), message("a2", "assistant", "failed")]);
    expect(effectiveAnswer(none!)?.id).toBe("a2");
  });

  it("shows a retry in progress over the old answer, and a failed retry beside it", () => {
    const [retrying] = groupTurns([message("u1", "user"), message("a1", "assistant"), message("a2", "assistant", "streaming")]);
    expect(turnDisplay(retrying!)).toEqual({ answer: expect.objectContaining({ id: "a2" }), failedAttempt: undefined });
    const [failed] = groupTurns([message("u1", "user"), message("a1", "assistant"), message("a2", "assistant", "interrupted")]);
    const shown = turnDisplay(failed!);
    expect(shown.answer?.id).toBe("a1");
    expect(shown.failedAttempt?.id).toBe("a2");
    const [plain] = groupTurns([message("u1", "user"), message("a1", "assistant", "failed")]);
    expect(turnDisplay(plain!)).toEqual({ answer: expect.objectContaining({ id: "a1" }), failedAttempt: undefined });
  });
});

describe("the open thread of a page session", () => {
  afterEach(() => sessionStorage.clear());

  it("is kept per Content under its own key", () => {
    storeThread("c1", "th2");
    expect(sessionStorage.getItem(threadStorageKey("c1"))).toBe("th2");
    expect(threadStorageKey("c1")).toBe("amber.chat.thread:c1");
    expect(readStoredThread("c1")).toBe("th2");
    expect(readStoredThread("c2")).toBeUndefined();
    storeThread("c1", undefined);
    expect(readStoredThread("c1")).toBeUndefined();
  });
});

describe("latestThread", () => {
  it("is the latest created thread, not the pinned one listed first, the larger id breaking a tie", () => {
    const pinned = { id: "01A", createdAt: 1, pinnedAt: 9 };
    expect(latestThread([pinned, { id: "01C", createdAt: 5 }, { id: "01B", createdAt: 3 }])?.id).toBe("01C");
    expect(latestThread([pinned, { id: "01B", createdAt: 5 }, { id: "01D", createdAt: 5 }])?.id).toBe("01D");
    expect(latestThread([])).toBeUndefined();
  });
});
