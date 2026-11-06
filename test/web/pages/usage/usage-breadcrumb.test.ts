import { describe, expect, it } from "vitest";
import { drillCrumbs } from "../../../../src/web/pages/usage/usage-breadcrumb.tsx";

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const beijing = (year: number, month: number, day: number, hour = 0): number => Date.UTC(year, month - 1, day, hour) - BEIJING_OFFSET_MS;
const labels = { all: "全部", weekOf: (date: string) => `${date} 起一周` };

describe("drillCrumbs", () => {
  it("leads from the whole history to a day through its month", () => {
    const crumbs = drillCrumbs(beijing(2026, 10, 28), beijing(2026, 10, 29), labels);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["全部", "2026-10", "10-28"]);
    expect(crumbs[0]?.patch).toEqual({ range: "all" });
    expect(crumbs[1]?.patch).toEqual({ range: "custom", from: beijing(2026, 10, 1), to: beijing(2026, 11, 1), granularity: "day" });
    expect(crumbs[2]?.patch).toBeUndefined();
  });

  it("names a whole month and a week by themselves", () => {
    expect(drillCrumbs(beijing(2026, 10, 1), beijing(2026, 11, 1), labels).map((crumb) => crumb.label)).toEqual(["全部", "2026-10"]);
    expect(drillCrumbs(beijing(2026, 11, 2), beijing(2026, 11, 9), labels).map((crumb) => crumb.label)).toEqual(["全部", "11-02 起一周"]);
  });

  it("falls back to the dates of any other range", () => {
    expect(drillCrumbs(beijing(2026, 11, 2, 5), beijing(2026, 11, 4, 5), labels).map((crumb) => crumb.label)).toEqual(["全部", "11-02 – 11-04"]);
  });
});
