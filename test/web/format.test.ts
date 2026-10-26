import { afterEach, describe, expect, it } from "vitest";
import { formatBeijingDate, formatBeijingDateTime, formatBeijingDateTimeSeconds, formatPublishedDate, formatPublishedDateTime } from "../../src/web/format.ts";

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

describe("Beijing date and time", () => {
  const original = process.env["TZ"];
  afterEach(() => {
    if (original === undefined) delete process.env["TZ"];
    else process.env["TZ"] = original;
  });

  it("stays in Beijing time while the machine is in another time zone", () => {
    process.env["TZ"] = "America/New_York";
    const moment = Date.UTC(2026, 9, 26, 15, 40);
    // The machine's own clock reads 11:40 on the 26th; Beijing is already past midnight.
    expect(new Date(moment).getHours()).toBe(11);
    expect(formatBeijingDateTime(moment)).toBe("2026-10-26 23:40");
    expect(formatBeijingDateTime(Date.UTC(2026, 9, 26, 16, 1))).toBe("2026-10-27 00:01");
    expect(formatBeijingDateTimeSeconds(Date.UTC(2026, 9, 26, 7, 52, 10))).toBe("2026-10-26 15:52:10");
    expect(formatBeijingDateTimeSeconds(Date.UTC(2026, 9, 26, 16, 0, 5))).toBe("2026-10-27 00:00:05");
    expect(formatBeijingDate(Date.UTC(2026, 9, 26, 16, 1))).toBe("2026-10-27");
  });
});
