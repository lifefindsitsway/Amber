import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../src/web/api/client.ts";
import { DraftSync, draftChangedVersion } from "../../../../src/web/pages/content/use-draft-sync.ts";

function draftChanged(currentVersion: number | null): ApiError {
  // A draft that is gone carries no `currentVersion` at all.
  const details = currentVersion === null ? {} : { currentVersion };
  return new ApiError(409, { class: "conflict", code: "conflict.draft_changed", retryDisposition: "never", userMessage: "", details } as never);
}

/**
 * A server with the draft CAS: a write must name the stored version (`null` = no draft), every
 * write raises it, and a write to a deleted draft is refused, never re-created. Each request
 * stays open until the test releases it, so overlap would be visible.
 */
function casServer() {
  const state = { version: null as number | null, text: undefined as string | undefined, open: 0, maxOpen: 0, puts: [] as Array<{ text: string; expected: number | null }> };
  const pending: Array<() => void> = [];
  const hold = <R>(work: () => R): Promise<R> => {
    state.open += 1;
    state.maxOpen = Math.max(state.maxOpen, state.open);
    return new Promise<R>((resolve, reject) => {
      pending.push(() => {
        state.open -= 1;
        try {
          resolve(work());
        } catch (error) {
          reject(error);
        }
      });
    });
  };
  const save = (text: string, expected: number | null) => {
    state.puts.push({ text, expected });
    return hold(() => {
      if (expected !== state.version) throw draftChanged(state.version);
      state.version = (state.version ?? 0) + 1;
      state.text = text;
      return { version: state.version };
    });
  };
  const remove = (version: number) =>
    hold(() => {
      if (version !== state.version) throw draftChanged(state.version);
      state.version = null;
      state.text = undefined;
    });
  const commit = (version: number) =>
    hold(() => {
      if (version !== state.version) throw draftChanged(state.version);
      const committed = state.text;
      state.version = null;
      state.text = undefined;
      return committed;
    });
  /** Answers the open requests one at a time until none is left. */
  const drain = async () => {
    for (let round = 0; round < 50; round += 1) {
      await flushMicrotasks();
      const next = pending.shift();
      if (next === undefined) {
        await flushMicrotasks();
        if (pending.length === 0) return;
        continue;
      }
      next();
    }
  };
  return { state, save, remove, commit, drain, pending };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("DraftSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps one save in flight, merges edits made meanwhile, and carries each new version", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    sync.init("a", null);
    sync.edit("ab");
    vi.advanceTimersByTime(100);
    expect(sync.getSnapshot().save).toBe("saving");
    sync.edit("abc");
    sync.edit("abcd");
    vi.advanceTimersByTime(100);
    expect(server.state.puts).toHaveLength(1);
    await server.drain();
    expect(server.state.maxOpen).toBe(1);
    expect(server.state.puts).toEqual([
      { text: "ab", expected: null },
      { text: "abcd", expected: 1 },
    ]);
    expect(sync.getSnapshot()).toMatchObject({ save: "saved", version: 2, unsaved: false });
  });

  it("commits after the save in flight with the version it produced, and nothing is saved after", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    sync.init("a", null);
    sync.edit("ab");
    vi.advanceTimersByTime(100);
    sync.edit("abc");
    const done = sync.commit((version) => server.commit(version));
    sync.edit("late");
    await server.drain();
    await expect(done).resolves.toBe("abc");
    vi.advanceTimersByTime(1000);
    await server.drain();
    expect(server.state.maxOpen).toBe(1);
    expect(server.state.puts.map((put) => put.text)).toEqual(["ab", "abc"]);
    expect(server.state.version).toBeNull();
    expect(sync.getSnapshot().phase).toBe("closed");
  });

  it("drops queued edits on discard, waits for the save in flight, and the draft stays gone", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    sync.init("a", null);
    sync.edit("ab");
    vi.advanceTimersByTime(100);
    sync.edit("abc");
    const done = sync.discard((version) => server.remove(version));
    await server.drain();
    await done;
    vi.advanceTimersByTime(1000);
    await sync.close();
    await server.drain();
    expect(server.state.maxOpen).toBe(1);
    expect(server.state.puts.map((put) => put.text)).toEqual(["ab"]);
    expect(server.state.version).toBeNull();
  });

  it("a discarded draft that never reached the server needs no request", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    sync.init("a", null);
    const remove = vi.fn();
    await sync.discard(remove);
    expect(remove).not.toHaveBeenCalled();
    expect(server.state.puts).toEqual([]);
  });

  it("on unmount saves queued edits, waits for the one in flight, and starts nothing after closing", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    sync.init("a", null);
    sync.edit("ab");
    vi.advanceTimersByTime(100);
    sync.edit("abc");
    sync.attach();
    sync.detach();
    await server.drain();
    await flushMicrotasks();
    await server.drain();
    expect(server.state.maxOpen).toBe(1);
    expect(server.state.puts).toEqual([
      { text: "ab", expected: null },
      { text: "abc", expected: 1 },
    ]);
    expect(sync.getSnapshot().phase).toBe("closed");
    sync.edit("after close");
    vi.advanceTimersByTime(1000);
    expect(server.state.puts).toHaveLength(2);
  });

  it("on unmount saves an edit whose autosave delay has not elapsed", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    sync.init("a", null);
    sync.edit("ab");
    sync.attach();
    sync.detach();
    await flushMicrotasks();
    await server.drain();
    await flushMicrotasks();
    expect(server.state.puts).toEqual([{ text: "ab", expected: null }]);
    expect(sync.getSnapshot().phase).toBe("closed");
  });

  it("a late save after another window discarded is refused and does not bring the draft back", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    server.state.version = 3;
    sync.init("a", 3);
    // Another window discards.
    server.state.version = null;
    sync.edit("ab");
    vi.advanceTimersByTime(100);
    await server.drain();
    expect(server.state.version).toBeNull();
    expect(sync.getSnapshot()).toMatchObject({ save: "conflict", conflict: { currentVersion: null }, unsaved: true });
    // No more autosaves until the user decides.
    sync.edit("abc");
    vi.advanceTimersByTime(1000);
    await server.drain();
    expect(server.state.puts).toHaveLength(1);
  });

  it("「以本窗口为准」 overwrites at the server's version, only when asked", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    server.state.version = 5;
    sync.init("a", 4);
    sync.edit("mine");
    vi.advanceTimersByTime(100);
    await server.drain();
    expect(sync.getSnapshot().conflict).toEqual({ currentVersion: 5 });
    sync.overwrite();
    await server.drain();
    expect(server.state.text).toBe("mine");
    expect(server.state.puts.at(-1)).toEqual({ text: "mine", expected: 5 });
    expect(sync.getSnapshot()).toMatchObject({ save: "saved", version: 6, conflict: undefined });
  });

  it("「载入最新」 takes the server's text and version and forgets this window's edits", async () => {
    const server = casServer();
    const sync = new DraftSync<string>(server.save, 100);
    server.state.version = 5;
    sync.init("a", 4);
    sync.edit("mine");
    vi.advanceTimersByTime(100);
    await server.drain();
    sync.reset("theirs", 5);
    expect(sync.getSnapshot()).toMatchObject({ save: "saved", version: 5, conflict: undefined, unsaved: false });
    sync.edit("theirs+");
    vi.advanceTimersByTime(100);
    await server.drain();
    expect(server.state.puts.at(-1)).toEqual({ text: "theirs+", expected: 5 });
  });

  it("keeps a failed save in memory and retries it on request", async () => {
    let fail = true;
    const puts: Array<[string, number | null]> = [];
    const sync = new DraftSync<string>(async (text, expected) => {
      puts.push([text, expected]);
      if (fail) throw new Error("offline");
      return { version: 1 };
    }, 100);
    sync.init("a", null);
    sync.edit("ab");
    vi.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(sync.getSnapshot()).toMatchObject({ save: "failed", unsaved: true });
    fail = false;
    sync.retry();
    await flushMicrotasks();
    expect(puts).toEqual([
      ["ab", null],
      ["ab", null],
    ]);
    expect(sync.getSnapshot()).toMatchObject({ save: "saved", version: 1, unsaved: false });
  });

  it("goes back to editing when a commit is refused, the edits kept", async () => {
    const sync = new DraftSync<string>(async () => ({ version: 2 }), 100);
    sync.init("a", 1);
    await expect(sync.commit(async () => Promise.reject(draftChanged(3)))).rejects.toBeInstanceOf(ApiError);
    expect(sync.getSnapshot()).toMatchObject({ phase: "editing", conflict: { currentVersion: 3 } });
  });

  it("reads the version out of a draft_changed refusal only", () => {
    expect(draftChangedVersion(draftChanged(7))).toEqual({ currentVersion: 7 });
    expect(draftChangedVersion(draftChanged(null))).toEqual({ currentVersion: null });
    expect(draftChangedVersion(new Error("x"))).toBeUndefined();
  });
});
