import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signDouyinQuery } from "../../../../../src/server/adapters/platform/douyin/sign.ts";

describe("signDouyinQuery", () => {
  it("signs a fixed input to a fixed output", () => {
    expect(signDouyinQuery([["aweme_id", "7000000000000000001"], ["aid", "6383"]], "0123456789abcdef0123456789abcdef", 1795000000)).toBe(
      "aweme_id=7000000000000000001&aid=6383&uifid=0123456789abcdef0123456789abcdef&timestamp=1795000000&x-secsdk-web-signature=3c55ff7063b0ba1159870a908c9257f4",
    );
  });

  it("form-encodes the signed query as the reference client does, spaces as plus and only -_.~ left bare", () => {
    expect(signDouyinQuery([["q", "a b~*!()'/é"], ["aid", "6383"]], "fedcba9876543210", 1700000000)).toBe(
      "q=a+b~%2A%21%28%29%27%2F%C3%A9&aid=6383&uifid=fedcba9876543210&timestamp=1700000000&x-secsdk-web-signature=feec01264f5c31d5fdfd91c41c5ad99d",
    );
  });

  it("changes with the uifid, the timestamp and the parameters", () => {
    const signature = (query: string) => query.slice(query.lastIndexOf("=") + 1);
    const base = signature(signDouyinQuery([["aweme_id", "7000000000000000001"]], "0123456789abcdef", 1795000000));
    expect(signature(signDouyinQuery([["aweme_id", "7000000000000000001"]], "0123456789abcdee", 1795000000))).not.toBe(base);
    expect(signature(signDouyinQuery([["aweme_id", "7000000000000000001"]], "0123456789abcdef", 1795000001))).not.toBe(base);
    expect(signature(signDouyinQuery([["aweme_id", "7000000000000000002"]], "0123456789abcdef", 1795000000))).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{32}$/);
  });

  it("depends on node:crypto alone", () => {
    const source = readFileSync(new URL("../../../../../src/server/adapters/platform/douyin/sign.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["node:crypto"]);
  });
});
