import { describe, expect, it } from "vitest";
import type { KeyboardEvent } from "react";
import { isCommitEnter, NamingStore } from "../../../../../src/web/pages/content/speakers/new-speaker.tsx";

describe("NamingStore", () => {
  it("holds the latest request, each with a new nonce, until closed", () => {
    const store = new NamingStore();
    let calls = 0;
    store.subscribe(() => (calls += 1));
    expect(store.current()).toBeUndefined();
    store.open({ speakerId: "a", ordinal: 4, anchorKey: "k1" });
    const first = store.current();
    store.open({ speakerId: "b", ordinal: 5, anchorKey: "k2" });
    expect(store.current()).toMatchObject({ speakerId: "b", anchorKey: "k2" });
    expect(store.current()?.nonce).not.toBe(first?.nonce);
    store.close();
    store.close();
    expect(store.current()).toBeUndefined();
    expect(calls).toBe(3);
  });
});

describe("isCommitEnter", () => {
  const key = (init: { key: string; isComposing?: boolean; keyCode?: number }): KeyboardEvent<HTMLElement> =>
    ({ key: init.key, keyCode: init.keyCode ?? 13, nativeEvent: { isComposing: init.isComposing ?? false } }) as unknown as KeyboardEvent<HTMLElement>;

  it("is the Enter that ends typing, not the one an input method uses to commit its text", () => {
    expect(isCommitEnter(key({ key: "Enter" }))).toBe(true);
    expect(isCommitEnter(key({ key: "Enter", isComposing: true }))).toBe(false);
    // Some browsers report the composition's Enter only through keyCode 229.
    expect(isCommitEnter(key({ key: "Enter", keyCode: 229 }))).toBe(false);
    expect(isCommitEnter(key({ key: "a", keyCode: 65 }))).toBe(false);
  });
});
