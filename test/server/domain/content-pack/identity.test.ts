import { describe, expect, it } from "vitest";
import { originOf, speakerOriginOf } from "../../../../src/server/domain/content-pack/identity.ts";

describe("transfer identity", () => {
  it("is the stored origin, else the record's own id", () => {
    expect(originOf({ id: "local" })).toBe("local");
    expect(originOf({ id: "local", originId: "carried" })).toBe("carried");
  });

  it("names a speaker by its Content identity and id, keeping a carried pair", () => {
    expect(speakerOriginOf({ id: "0" }, "content-a")).toEqual({ contentId: "content-a", speakerId: "0" });
    expect(speakerOriginOf({ id: "01J", origin: { contentId: "content-x", speakerId: "0" } }, "content-a")).toEqual({ contentId: "content-x", speakerId: "0" });
  });
});
