import { describe, expect, it } from "vitest";
import { txtParagraph } from "../../../../src/server/domain/export/txt.ts";

describe("txtParagraph", () => {
  it("writes paragraphs separated by one blank line, without time stamps", () => {
    expect(txtParagraph({ startMs: 5000, text: "一" }, true) + txtParagraph({ startMs: 9000, text: "二" }, false)).toBe("一\n\n二\n");
  });

  it("starts a labelled paragraph with the speaker prefix", () => {
    expect(txtParagraph({ startMs: 5000, text: "一" }, true, "甲：") + txtParagraph({ startMs: 9000, text: "二" }, false, "乙：")).toBe("甲：一\n\n乙：二\n");
  });
});
