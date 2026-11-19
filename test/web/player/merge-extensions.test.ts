import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { PlayerExtensionContext, PlayerExtensions } from "../../../src/web/player/player-extensions.ts";
import { mergeExtensions } from "../../../src/web/player/merge-extensions.ts";

const context = {} as PlayerExtensionContext;

describe("mergeExtensions", () => {
  it("passes a single part through and nothing through as undefined", () => {
    const only: PlayerExtensions = { controls: () => "a" };
    expect(mergeExtensions(undefined, only)).toBe(only);
    expect(mergeExtensions(undefined, undefined)).toBeUndefined();
  });

  it("renders every part in order and drops the parts that render nothing", () => {
    const merged = mergeExtensions(
      { controls: () => createElement("i", null, "a"), settingsItems: () => null },
      { controls: () => null, settingsItems: () => null, pictureLayers: () => "layer" },
      { controls: () => createElement("b", null, "c") },
    );
    const controls = merged?.controls?.(context) as Array<{ key: string }>;
    expect(controls.map((node) => node.key)).toEqual(["0", "2"]);
    expect(merged?.settingsItems?.(context)).toBeNull();
    expect(merged?.pictureLayers?.(context)).toHaveLength(1);
  });
});
