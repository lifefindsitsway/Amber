import { afterEach, describe, expect, it } from "vitest";
import {
  formatBeijingDate,
  formatBeijingDateTime,
  formatBeijingDateTimeSeconds,
  formatBeijingMonth,
  formatBeijingMonthDay,
  formatBeijingMonthDayTime,
  formatBeijingTime,
  formatBeijingTimeSeconds,
  formatCompactCount,
  formatCount,
  formatMoney,
  formatPublishedDate,
  formatPublishedDateTime,
} from "../../src/web/format.ts";

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

describe("usage counts", () => {
  it("groups thousands of whole numbers and accepts decimal strings", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount("1234567")).toBe("1,234,567");
    expect(formatCount("123456789012345678901234567890")).toBe("123,456,789,012,345,678,901,234,567,890");
    expect(formatCount("not a number")).toBe("0");
  });

  it("writes the whole number below ten thousand and x.x 万 from there", () => {
    expect(formatCompactCount("9999")).toBe("9,999");
    expect(formatCompactCount("10000")).toBe("1.0 万");
    expect(formatCompactCount("14999")).toBe("1.5 万");
    expect(formatCompactCount("14949")).toBe("1.5 万");
    expect(formatCompactCount("14940")).toBe("1.5 万");
    expect(formatCompactCount("14449")).toBe("1.4 万");
    expect(formatCompactCount("711000")).toBe("71.1 万");
    expect(formatCompactCount("1234500000")).toBe("123,450.0 万");
    // Beyond what a double holds exactly: the digits stay exact.
    expect(formatCompactCount("123456789012345678")).toBe("12,345,678,901,234.6 万");
  });
});

describe("estimated cost", () => {
  it("shows two decimals, rounding half up on the exact decimal string", () => {
    expect(formatMoney({ currency: "CNY", amount: "5.26" })).toBe("¥5.26");
    expect(formatMoney({ currency: "CNY", amount: "0" })).toBe("¥0.00");
    expect(formatMoney({ currency: "USD", amount: "12.345" })).toBe("$12.35");
    expect(formatMoney({ currency: "USD", amount: "0.015" })).toBe("$0.02");
    expect(formatMoney({ currency: "CNY", amount: "1234567.8" })).toBe("¥1,234,567.80");
    expect(formatMoney({ currency: "CNY", amount: "99999999999999999999.99999999" })).toBe("¥100,000,000,000,000,000,000.00");
  });

  it("reads a positive amount below one cent as less than one cent, never as zero", () => {
    expect(formatMoney({ currency: "CNY", amount: "0.00000001" })).toBe("< ¥0.01");
    expect(formatMoney({ currency: "USD", amount: "0.0099" })).toBe("< $0.01");
    expect(formatMoney({ currency: "USD", amount: "0.01" })).toBe("$0.01");
  });
});

describe("Beijing clock helpers of the usage page", () => {
  it("name a moment in short forms", () => {
    const moment = Date.UTC(2026, 10, 5, 2, 0, 27);
    expect(formatBeijingTime(moment)).toBe("10:00");
    expect(formatBeijingTimeSeconds(moment)).toBe("10:00:27");
    expect(formatBeijingMonthDay(moment)).toBe("11-05");
    expect(formatBeijingMonthDayTime(moment)).toBe("11-05 10:00");
    expect(formatBeijingMonth(moment)).toBe("2026-11");
  });
});
