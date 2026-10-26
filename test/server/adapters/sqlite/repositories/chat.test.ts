import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { ChatCompaction, ChatMessage } from "../../../../../src/server/domain/chat.ts";
import type { ChatWebSearch } from "../../../../../src/server/domain/web-search.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const SEG = "01J00000000000000000000001" as SegmentId;
const snapshot = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "P", modelDisplaySnapshot: "m", protocolSnapshot: "openai_compatible" as const };
let db: SqliteConnection;
let repository: SqliteRepository;

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, threadId: "t", role: "user", text: `text ${id}`, status: "complete", citations: [], createdAt: T0, ...overrides };
}

function compaction(id: string, throughMessageId: string, overrides: Partial<ChatCompaction> = {}): ChatCompaction {
  return {
    id, threadId: "t", throughMessageId, body: `summary ${id}`, modelRef: snapshot, promptRef: { id: "chat.compaction", version: 1 }, promptSnapshot: "prompt", createdAt: T0, ...overrides,
  };
}

const foreignKeyViolations = () => db.prepare("PRAGMA foreign_key_check").all();

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  repository.withTransaction((scope) => scope.chat.insertThread("alice", { id: "t", contentId: "c", createdAt: T0 }));
});

describe("chat repository", () => {
  it("stores messages in order, with JSON fields round-tripped", () => {
    const webSearch: ChatWebSearch = {
      mode: "force", status: "searched", planned: 1, requested: 1, succeeded: 1, queries: ["q"],
      sources: [{ id: "w1", index: 1, url: "https://example.com/a", title: "A", excerpt: "x", fetchedAt: T0 }],
    };
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("m2", { role: "assistant", status: "streaming", modelRef: snapshot, webSearch, replacesMessageId: "old", createdAt: T0 + 1 }));
      scope.chat.insertMessage("alice", message("m1", { citations: [{ transcriptRevisionId: "r", segmentId: SEG }] }));
    });
    const messages = repository.withTransaction((scope) => scope.chat.listMessages("alice", "t"));
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0]?.citations).toEqual([{ transcriptRevisionId: "r", segmentId: SEG }]);
    expect(messages[1]).toMatchObject({ role: "assistant", status: "streaming", modelRef: snapshot, webSearch, replacesMessageId: "old" });
    expect(messages[1]?.suggestions).toBeUndefined();
    expect(messages[1]?.finishedAt).toBeUndefined();
  });

  it("keeps several threads per Content, newest first, with title source and latest message time derived", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertThread("alice", { id: "t2", contentId: "c", createdAt: T0 + 10 });
      scope.chat.insertMessage("alice", message("a0", { role: "assistant", createdAt: T0 }));
      scope.chat.insertMessage("alice", message("m1", { text: "first\nsecond line", createdAt: T0 + 1 }));
      scope.chat.insertMessage("alice", message("m2", { text: "later", createdAt: T0 + 5 }));
    });
    const threads = repository.withTransaction((scope) => scope.chat.listThreads("alice", "c"));
    expect(threads).toEqual([
      { id: "t2", contentId: "c", createdAt: T0 + 10 },
      { id: "t", contentId: "c", createdAt: T0, firstQuestion: "first\nsecond line", lastMessageAt: T0 + 5 },
    ]);
    expect(repository.withTransaction((scope) => scope.chat.latestThread("alice", "c"))?.id).toBe("t2");
    expect(repository.withTransaction((scope) => scope.chat.getThread("alice", "t"))?.firstQuestion).toBe("first\nsecond line");
  });

  it("writes the final state of an answer", () => {
    repository.withTransaction((scope) => scope.chat.insertMessage("alice", message("a", { role: "assistant", status: "streaming", text: "" })));
    const webSearch: ChatWebSearch = { mode: "auto", status: "skipped", reason: "unconfigured", planned: 0, requested: 0, succeeded: 0, queries: [], sources: [] };
    repository.withTransaction((scope) =>
      scope.chat.finishMessage("alice", {
        id: "a", text: `done [[seg:${SEG}]]`, status: "complete", citations: [{ transcriptRevisionId: "r", segmentId: SEG }], suggestions: ["next?"], webSearch, finishedAt: T0 + 9,
      }),
    );
    expect(repository.withTransaction((scope) => scope.chat.getMessage("alice", "a"))).toMatchObject({
      text: `done [[seg:${SEG}]]`,
      status: "complete",
      suggestions: ["next?"],
      webSearch,
      finishedAt: T0 + 9,
    });
  });

  it("makes a new compaction the thread's current one", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("m1"));
      scope.chat.insertCompaction("alice", compaction("k", "m1"));
    });
    expect(repository.withTransaction((scope) => scope.chat.getThread("alice", "t"))?.currentCompactionId).toBe("k");
    expect(repository.withTransaction((scope) => scope.chat.getCompaction("alice", "k"))).toMatchObject({ body: "summary k", throughMessageId: "m1" });
  });

  it("moves a compaction's end, clears or sets the current one and deletes compactions; the body stays immutable", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("m1"));
      scope.chat.insertMessage("alice", message("m2", { createdAt: T0 + 1 }));
      scope.chat.insertCompaction("alice", compaction("k1", "m1"));
      scope.chat.insertCompaction("alice", compaction("k2", "m2", { createdAt: T0 + 2 }));
    });
    repository.withTransaction((scope) => scope.chat.moveCompaction("alice", "k2", "m1"));
    expect(repository.withTransaction((scope) => scope.chat.listCompactions("alice", "t")).map((row) => [row.id, row.throughMessageId])).toEqual([
      ["k1", "m1"],
      ["k2", "m1"],
    ]);
    expect(() => db.prepare("UPDATE chat_compaction SET body = 'x' WHERE id = 'k1'").run()).toThrow(/immutable/);
    expect(() => repository.withTransaction((scope) => scope.chat.moveCompaction("bob", "k2", "m2"))).toThrow(/not found/);
    repository.withTransaction((scope) => {
      scope.chat.setCurrentCompaction("alice", "t", "k1");
      scope.chat.deleteCompaction("alice", "k2");
      scope.chat.deleteMessages("alice", ["m2"]);
    });
    expect(repository.withTransaction((scope) => scope.chat.getThread("alice", "t"))?.currentCompactionId).toBe("k1");
    repository.withTransaction((scope) => scope.chat.setCurrentCompaction("alice", "t", undefined));
    expect(repository.withTransaction((scope) => scope.chat.getThread("alice", "t"))?.currentCompactionId).toBeUndefined();
    expect(countRows(db, "chat_compaction")).toBe(1);
    expect(foreignKeyViolations()).toEqual([]);
  });

  it("deletes messages, unlinking their usage rows, and refuses to orphan a compaction", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("m1"));
      scope.chat.insertMessage("alice", message("a1", { role: "assistant", createdAt: T0 + 1 }));
      scope.chat.insertCompaction("alice", compaction("k", "m1"));
      scope.tokenUsage.insert({ id: "u", userId: "alice", modelRef: snapshot, feature: "chat", chatMessageId: "a1", contentId: "c", outcome: "succeeded", createdAt: T0 });
    });
    expect(repository.withTransaction((scope) => scope.chat.deleteMessages("bob", ["a1"]))).toBe(0);
    expect(repository.withTransaction((scope) => scope.chat.deleteMessages("alice", ["a1", "unknown"]))).toBe(1);
    expect(repository.withTransaction((scope) => scope.tokenUsage.list("alice"))[0]?.chatMessageId).toBeUndefined();
    expect(() => repository.withTransaction((scope) => scope.chat.deleteMessages("alice", ["m1"]))).toThrow(/FOREIGN KEY/);
    expect(foreignKeyViolations()).toEqual([]);
  });

  it("hides another owner's chat and refuses writes into it", () => {
    repository.withTransaction((scope) => scope.chat.insertMessage("alice", message("m1")));
    expect(repository.withTransaction((scope) => scope.chat.getThread("bob", "t"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.chat.latestThread("bob", "c"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.chat.listThreads("bob", "c"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.chat.listMessages("bob", "t"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.chat.listCompactions("bob", "t"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.chat.getMessage("bob", "m1"))).toBeUndefined();
    expect(() => repository.withTransaction((scope) => scope.chat.insertMessage("bob", message("m9")))).toThrow(/not found/);
    expect(() => repository.withTransaction((scope) => scope.chat.insertThread("bob", { id: "x", contentId: "c", createdAt: 0 }))).toThrow(/not found/);
    expect(() => repository.withTransaction((scope) => scope.chat.setCurrentCompaction("bob", "t", undefined))).toThrow(/not found/);
    expect(repository.withTransaction((scope) => scope.chat.deleteThread("bob", "t"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.chat.deleteThreadsOf("bob", "c"))).toBe(0);
    expect(countRows(db, "chat_message")).toBe(1);
  });

  it("deletes one thread, compactions included, and keeps usage rows unlinked", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertThread("alice", { id: "t2", contentId: "c", createdAt: T0 + 1 });
      scope.chat.insertMessage("alice", message("m1"));
      scope.chat.insertMessage("alice", message("a1", { role: "assistant", createdAt: T0 + 1 }));
      scope.chat.insertMessage("alice", message("x1", { threadId: "t2" }));
      scope.chat.insertCompaction("alice", compaction("k", "a1"));
      scope.tokenUsage.insert({ id: "u", userId: "alice", modelRef: snapshot, feature: "chat", chatMessageId: "a1", contentId: "c", outcome: "succeeded", createdAt: T0 });
    });
    expect(repository.withTransaction((scope) => scope.chat.deleteThread("alice", "t"))).toBe(true);
    expect(countRows(db, "chat_thread")).toBe(1);
    expect(countRows(db, "chat_message")).toBe(1);
    expect(countRows(db, "chat_compaction")).toBe(0);
    expect(repository.withTransaction((scope) => scope.tokenUsage.list("alice"))[0]?.chatMessageId).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.chat.deleteThreadsOf("alice", "c"))).toBe(1);
    expect(countRows(db, "chat_message")).toBe(0);
    expect(foreignKeyViolations()).toEqual([]);
  });

  it("turns answers left streaming into interrupted ones at the given time", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("a1", { role: "assistant", status: "streaming" }));
      scope.chat.insertMessage("alice", message("a2", { role: "assistant", status: "complete", createdAt: T0 + 1, finishedAt: T0 + 2 }));
    });
    expect(repository.withTransaction((scope) => scope.chat.interruptStreaming(T0 + 7))).toBe(1);
    expect(repository.withTransaction((scope) => scope.chat.getMessage("alice", "a1"))).toMatchObject({ status: "interrupted", finishedAt: T0 + 7 });
    expect(repository.withTransaction((scope) => scope.chat.getMessage("alice", "a2"))?.finishedAt).toBe(T0 + 2);
  });
});
