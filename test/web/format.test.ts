import { describe, expect, it } from "vitest";
import { formatPublishedDate, formatPublishedDateTime } from "../../src/web/format.ts";

describe("publish dates", () => {
  it("reads in Beijing time whatever the machine's time zone", () => {
    const moment = Date.UTC(2024, 4, 17, 13, 25);
    expect(formatPublishedDate(moment)).toBe("2024-05-17");
    expect(formatPublishedDateTime(moment)).toBe("2024-05-17 21:25");
  });

  it("rolls over to the next day once it is past midnight in Beijing", () => {
    const moment = Date.UTC(2024, 4, 16, 16, 30);
    expect(formatPublishedDate(moment)).toBe("2024-05-17");
    expect(formatPublishedDateTime(moment)).toBe("2024-05-17 00:30");
  });

  it("pads single digits and shows midnight as 00", () => {
    expect(formatPublishedDateTime(Date.UTC(2026, 0, 1, 16, 5))).toBe("2026-01-02 00:05");
  });
});
