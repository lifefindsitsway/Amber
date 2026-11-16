import { describe, expect, it, vi } from "vitest";
import { runInitialScroll, type InitialScrollEnv, type InitialScrollGeometry } from "../../../../src/web/pages/content/editor-initial-scroll.ts";

/**
 * A list jsdom cannot lay out, as numbers: the row's top in content coordinates, the content's
 * height and the visible height. Writes are clamped like a browser's, and `onWrite` lets a
 * test move rows as a browser does once skipped rows get laid out.
 */
interface FakeList {
  rowContentTop: number;
  rowHeight: number;
  clientHeight: number;
  contentHeight: number;
  scrollTop: number;
}

function fake(list: Partial<FakeList>, options: { focus?: boolean; fonts?: Promise<unknown>; onWrite?: (state: FakeList) => void } = {}) {
  const state: FakeList = { rowContentTop: 1000, rowHeight: 40, clientHeight: 500, contentHeight: 5000, scrollTop: 0, ...list };
  let next = 1;
  const queue = new Map<number, () => void>();
  let onInput: (() => void) | undefined;
  const geometry = (): InitialScrollGeometry => ({
    rowTop: state.rowContentTop - state.scrollTop,
    rowHeight: state.rowHeight,
    clientHeight: state.clientHeight,
    scrollTop: state.scrollTop,
    maxScrollTop: Math.max(0, state.contentHeight - state.clientHeight),
  });
  const env = {
    requestFrame: vi.fn((callback: () => void) => {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    }),
    cancelFrame: vi.fn((handle: number) => {
      queue.delete(handle);
    }),
    measure: vi.fn((): InitialScrollGeometry | undefined => geometry()),
    scrollTo: vi.fn((top: number) => {
      state.scrollTop = Math.min(Math.max(top, 0), Math.max(0, state.contentHeight - state.clientHeight));
      options.onWrite?.(state);
    }),
    fontsReady: vi.fn(() => options.fonts),
    isEditableFocused: vi.fn(() => false),
    listen: vi.fn((callback: () => void) => {
      onInput = callback;
      return unlisten;
    }),
    focus: options.focus === false ? undefined : vi.fn(),
    onDone: vi.fn(),
  } satisfies InitialScrollEnv;
  const unlisten = vi.fn(() => {
    onInput = undefined;
  });
  /** Runs the frames queued so far, `count` times over. */
  const frames = (count = 1): void => {
    for (let at = 0; at < count; at += 1) {
      const pending = [...queue.entries()];
      queue.clear();
      for (const [, callback] of pending) callback();
    }
  };
  return { state, env, frames, geometry, unlisten, pending: () => queue.size, input: () => onInput?.() };
}

const outcome = (env: { onDone: { mock: { calls: unknown[][] } } }): unknown[] => env.onDone.mock.calls.map((call) => call[0]);

describe("runInitialScroll", () => {
  it("puts the row at the offset in the first, synchronous frame and settles after three stable frames", () => {
    const list = fake({});
    runInitialScroll(100, list.env);
    expect(list.state.scrollTop).toBe(900);
    expect(list.geometry().rowTop).toBe(100);
    list.frames(2);
    expect(list.env.onDone).not.toHaveBeenCalled();
    list.frames(1);
    expect(outcome(list.env)).toEqual(["settled"]);
    expect(list.env.focus).toHaveBeenCalledTimes(1);
    expect(list.unlisten).toHaveBeenCalledTimes(1);
    expect(list.pending()).toBe(0);
  });

  it("counts stable frames again from zero after the row moved", () => {
    const list = fake({});
    runInitialScroll(100, list.env);
    list.frames(2);
    // A row above gets laid out late and pushes the target down.
    list.state.rowContentTop += 400;
    list.frames(1);
    expect(list.state.scrollTop).toBe(1300);
    list.frames(2);
    expect(list.env.onDone).not.toHaveBeenCalled();
    list.frames(1);
    expect(outcome(list.env)).toEqual(["settled"]);
    expect(list.geometry().rowTop).toBe(100);
  });

  it("clamps the goal so the row stays in view", () => {
    const list = fake({ rowHeight: 80 });
    runInitialScroll(900, list.env);
    list.frames(3);
    expect(outcome(list.env)).toEqual(["settled"]);
    expect(list.geometry().rowTop).toBe(420);
  });

  it("ends at the top edge when the row cannot come down that far", () => {
    const list = fake({ rowContentTop: 50 });
    runInitialScroll(200, list.env);
    expect(list.env.scrollTo).not.toHaveBeenCalled();
    list.frames(3);
    expect(outcome(list.env)).toEqual(["edge"]);
    expect(list.env.focus).toHaveBeenCalledTimes(1);
  });

  it("ends at the bottom edge when the row cannot go up that far", () => {
    const list = fake({ rowContentTop: 4900 });
    runInitialScroll(0, list.env);
    expect(list.state.scrollTop).toBe(4500);
    list.frames(3);
    expect(outcome(list.env)).toEqual(["edge"]);
    expect(list.env.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("still ends aligned when the list's visible height changes mid-loop (a panel opened above it)", () => {
    const list = fake({}, { onWrite: (state) => (state.rowContentTop += 400) });
    runInitialScroll(400, list.env);
    list.frames(1);
    list.state.clientHeight = 300;
    list.frames(1);
    // Later writes no longer move rows.
    list.env.scrollTo.mockImplementation((top: number) => {
      list.state.scrollTop = Math.min(Math.max(top, 0), list.state.contentHeight - list.state.clientHeight);
    });
    list.frames(6);
    expect(outcome(list.env)).toEqual(["settled"]);
    // 400 no longer fits under a 300 px list: the row sits as low as it can while wholly visible.
    expect(list.geometry().rowTop).toBe(260);
  });

  it("caps after twelve unsteady frames with the row in view, and then focuses", () => {
    const list = fake({});
    runInitialScroll(100, list.env);
    for (let frame = 0; frame < 11; frame += 1) {
      list.state.rowContentTop += 50;
      list.frames(1);
    }
    expect(outcome(list.env)).toEqual(["capped"]);
    expect(list.geometry().rowTop).toBe(100);
    expect(list.env.focus).toHaveBeenCalledTimes(1);
    expect(list.env.requestFrame).toHaveBeenCalledTimes(11);
  });

  it("caps without focusing when the final measure finds the row out of view", () => {
    // Every write lays out rows above the target and pushes it far down again.
    const list = fake({ contentHeight: 1e6 }, { onWrite: (state) => (state.rowContentTop += 1000) });
    runInitialScroll(100, list.env);
    list.frames(20);
    expect(outcome(list.env)).toEqual(["capped"]);
    expect(list.geometry().rowTop).toBeGreaterThan(list.state.clientHeight);
    expect(list.env.focus).not.toHaveBeenCalled();
  });

  it("cancels on the user's input, stops for good and never focuses", () => {
    const list = fake({});
    runInitialScroll(100, list.env);
    list.frames(1);
    list.input();
    expect(outcome(list.env)).toEqual(["cancelled"]);
    expect(list.pending()).toBe(0);
    expect(list.unlisten).toHaveBeenCalledTimes(1);
    list.state.rowContentTop += 300;
    list.frames(5);
    expect(list.env.scrollTo).toHaveBeenCalledTimes(1);
    expect(list.env.focus).not.toHaveBeenCalled();
    expect(list.env.onDone).toHaveBeenCalledTimes(1);
  });

  it("cancels at once when an editable element already has the focus", () => {
    const list = fake({});
    list.env.isEditableFocused.mockReturnValue(true);
    runInitialScroll(100, list.env);
    expect(outcome(list.env)).toEqual(["cancelled"]);
    expect(list.env.scrollTo).not.toHaveBeenCalled();
    expect(list.env.focus).not.toHaveBeenCalled();
  });

  it("cancels when the focus moves into an editable element during the loop", () => {
    const list = fake({});
    runInitialScroll(100, list.env);
    list.env.isEditableFocused.mockReturnValue(true);
    list.frames(1);
    expect(outcome(list.env)).toEqual(["cancelled"]);
    expect(list.env.focus).not.toHaveBeenCalled();
  });

  it("does not focus without being asked to", () => {
    const list = fake({}, { focus: false });
    runInitialScroll(100, list.env);
    list.frames(3);
    expect(outcome(list.env)).toEqual(["settled"]);
  });

  it("runs once: nothing more is scheduled or reported after the end, and dispose is harmless", () => {
    const list = fake({});
    const run = runInitialScroll(100, list.env);
    list.frames(10);
    expect(list.env.requestFrame).toHaveBeenCalledTimes(3);
    expect(list.env.onDone).toHaveBeenCalledTimes(1);
    run.dispose();
    expect(list.env.onDone).toHaveBeenCalledTimes(1);
  });

  it("stops silently on dispose", () => {
    const list = fake({});
    const run = runInitialScroll(100, list.env);
    run.dispose();
    expect(list.pending()).toBe(0);
    expect(list.env.cancelFrame).toHaveBeenCalledTimes(1);
    expect(list.unlisten).toHaveBeenCalledTimes(1);
    list.frames(5);
    expect(list.env.onDone).not.toHaveBeenCalled();
  });

  it("runs one more round once the fonts are ready", async () => {
    let loaded: () => void = () => undefined;
    const fonts = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const list = fake({}, { fonts });
    runInitialScroll(100, list.env);
    list.frames(3);
    expect(list.env.onDone).not.toHaveBeenCalled();
    expect(list.pending()).toBe(0);
    // The web font changes the line heights above the row.
    list.state.rowContentTop += 30;
    loaded();
    await fonts;
    expect(list.state.scrollTop).toBe(930);
    list.frames(3);
    expect(outcome(list.env)).toEqual(["settled"]);
    expect(list.env.fontsReady).toHaveBeenCalledTimes(1);
    expect(list.env.focus).toHaveBeenCalledTimes(1);
  });

  it("does not correct after fonts are ready once cancelled while waiting for them", async () => {
    let loaded: () => void = () => undefined;
    const fonts = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const list = fake({}, { fonts });
    runInitialScroll(100, list.env);
    list.frames(3);
    list.input();
    expect(outcome(list.env)).toEqual(["cancelled"]);
    list.state.rowContentTop += 30;
    loaded();
    await fonts;
    list.frames(3);
    expect(list.env.scrollTo).toHaveBeenCalledTimes(1);
    expect(list.env.onDone).toHaveBeenCalledTimes(1);
    expect(list.env.focus).not.toHaveBeenCalled();
  });

  it("never waits for the fonts after a cancelled round", () => {
    const list = fake({}, { fonts: new Promise(() => undefined) });
    runInitialScroll(100, list.env);
    list.input();
    expect(list.env.fontsReady).not.toHaveBeenCalled();
    expect(outcome(list.env)).toEqual(["cancelled"]);
  });
});
