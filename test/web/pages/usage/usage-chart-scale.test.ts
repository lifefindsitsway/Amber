import { describe, expect, it } from "vitest";
import { initI18n } from "../../../../src/web/i18n.ts";
import { axisFor, bucketGroupLabel, bucketRangeLabel, bucketTickLabel, finerGranularity, niceStep } from "../../../../src/web/pages/usage/usage-chart-scale.ts";

const t = initI18n().t;
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const beijing = (year: number, month: number, day: number, hour = 0): number => Date.UTC(year, month - 1, day, hour) - BEIJING_OFFSET_MS;

describe("niceStep", () => {
  it("picks the smallest round step whose second multiple reaches the maximum", () => {
    expect(niceStep(1, false)).toBe(0.5);
    expect(niceStep(14, false)).toBe(10);
    expect(niceStep(20, false)).toBe(10);
    expect(niceStep(21, false)).toBe(20);
    expect(niceStep(0.9, false)).toBe(0.5);
    expect(niceStep(2.3, false)).toBe(2);
    expect(niceStep(4.6, false)).toBe(2.5);
  });

  it("never goes below one for counts", () => {
    expect(niceStep(1, true)).toBe(1);
    expect(niceStep(0, true)).toBe(1);
    expect(niceStep(7, true)).toBe(5);
  });
});

describe("axisFor", () => {
  it("draws three round gridlines in the currency, from zero", () => {
    const axis = axisFor("cost", 14.2, "CNY", t);
    expect(axis.ticks).toEqual([0, 10, 20]);
    expect(axis.top).toBe(20);
    expect(axis.ticks.map(axis.label)).toEqual(["¥0", "¥10", "¥20"]);
    expect(axisFor("cost", 0.9, "USD", t).ticks.map((tick) => axisFor("cost", 0.9, "USD", t).label(tick))).toEqual(["$0", "$0.5", "$1.0"]);
  });

  it("counts tokens in ten thousands once they reach one, and plain below", () => {
    const large = axisFor("llm_tokens", 1_500_000, "CNY", t);
    expect(large.ticks.map(large.label)).toEqual(["0", "100 万", "200 万"]);
    const small = axisFor("llm_tokens", 7000, "CNY", t);
    expect(small.ticks.map(small.label)).toEqual(["0", "5000", "10000"]);
  });

  it("measures processed audio in hours or in minutes by its size", () => {
    const hours = axisFor("audio", 5 * 3_600_000, "CNY", t);
    expect(hours.ticks.map(hours.label)).toEqual(["0", "2.5 小时", "5.0 小时"]);
    const minutes = axisFor("audio", 4 * 60_000, "CNY", t);
    expect(minutes.ticks.map(minutes.label)).toEqual(["0", "2 分钟", "4 分钟"]);
  });

  it("measures processed audio in seconds below one minute", () => {
    const short = axisFor("audio", 2_000, "CNY", t);
    expect(short.ticks.map(short.label)).toEqual(["0", "1 秒", "2 秒"]);
    const almostMinute = axisFor("audio", 45_000, "CNY", t);
    expect(almostMinute.ticks.map(almostMinute.label)).toEqual(["0", "25 秒", "50 秒"]);
    const minute = axisFor("audio", 60_000, "CNY", t);
    expect(minute.ticks.map(minute.label)).toEqual(["0", "0.5 分钟", "1.0 分钟"]);
  });

  it("keeps a usable axis when there is nothing to draw", () => {
    const money = axisFor("cost", 0, "CNY", t);
    expect(money.ticks.map(money.label)).toEqual(["¥0", "¥0.5", "¥1.0"]);
    const requests = axisFor("requests", 0, "CNY", t);
    expect(requests.ticks.map(requests.label)).toEqual(["0", "1", "2"]);
  });

  it("counts requests as whole numbers", () => {
    const axis = axisFor("requests", 9, "CNY", t);
    expect(axis.ticks.map(axis.label)).toEqual(["0", "5", "10"]);
  });
});

describe("time axis labels", () => {
  const moment = beijing(2026, 11, 5, 10);
  it("name a bucket by its own unit and the unit above it", () => {
    expect(bucketTickLabel(moment, "hour")).toBe("10:00");
    expect(bucketGroupLabel(moment, "hour")).toBe("11-05");
    expect(bucketTickLabel(moment, "day")).toBe("11-05");
    expect(bucketGroupLabel(moment, "day")).toBe("2026-11");
    expect(bucketTickLabel(moment, "month")).toBe("2026-11");
    expect(bucketGroupLabel(moment, "month")).toBe("2026");
  });

  it("give a bucket's range, the end exclusive", () => {
    expect(bucketRangeLabel(moment, moment + 3_600_000, "hour")).toBe("11-05 10:00 – 11:00");
    expect(bucketRangeLabel(beijing(2026, 11, 2), beijing(2026, 11, 9), "week")).toBe("11-02 – 11-08");
    expect(bucketRangeLabel(beijing(2026, 11, 1), beijing(2026, 12, 1), "month")).toBe("2026-11");
  });

  it("open months and weeks into days, days into hours, and hours no further", () => {
    expect(finerGranularity("month")).toBe("day");
    expect(finerGranularity("week")).toBe("day");
    expect(finerGranularity("day")).toBe("hour");
    expect(finerGranularity("hour")).toBeUndefined();
  });
});
