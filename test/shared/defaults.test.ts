import { describe, expect, it } from "vitest";
import * as defaults from "../../src/shared/defaults.ts";
import { EXPECTED_DEFAULTS } from "../fixtures/spec/defaults.ts";

describe("src/shared/defaults.ts", () => {
  it("lists every named default once", () => {
    expect(Object.keys(EXPECTED_DEFAULTS)).toHaveLength(154);
  });

  it("exports exactly the named defaults", () => {
    expect(Object.keys(defaults).sort()).toEqual(Object.keys(EXPECTED_DEFAULTS).sort());
  });

  it.each(Object.entries(EXPECTED_DEFAULTS))("%s = %s", (name, value) => {
    expect(defaults[name as keyof typeof defaults]).toBe(value);
  });
});
