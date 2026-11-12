import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComparisonSummary } from "../../../../../../src/web/pages/content/speakers/compare/comparison-summary.tsx";
import { mockApi, renderApp } from "../../../../../fixtures/web/render.tsx";
import { recognition, segmentRoute, turns } from "../../../../../fixtures/web/speaker-compare.ts";

const BASE = recognition("r1", "qwen-asr", { createdAt: 5 });
const OTHER = recognition("r2", "scribe_v2", { comparison: true });

describe("ComparisonSummary", () => {
  it("sums up the comparison in one line and leads to the editor", async () => {
    const { calls } = mockApi({
      ...segmentRoute("r1", turns([1, 2, 1, 2, 1, 2]), BASE),
      ...segmentRoute("r2", turns([3, 4, 3, 4, 4, 4]), OTHER),
    });
    const open = vi.fn();
    renderApp(<ComparisonSummary revisionId="r1" revisions={[BASE, OTHER]} onOpenEditor={open} />);
    expect((await screen.findByTestId("comparison-summary-line")).textContent).toBe("与 scribe_v2 的识别相比：归属不同 1 句 · 无法判断 0 句 · 身份未对应 0 句");
    fireEvent.click(screen.getByTestId("comparison-summary-open"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("names a recognition that recorded no model by its label", async () => {
    const unnamed = recognition("r2", "", { comparison: true });
    mockApi({
      ...segmentRoute("r1", turns([1, 2, 1, 2, 1, 2]), BASE),
      ...segmentRoute("r2", turns([3, 4, 3, 4, 4, 4]), unnamed),
    });
    renderApp(<ComparisonSummary revisionId="r1" revisions={[BASE, unnamed]} />);
    const line = (await screen.findByTestId("comparison-summary-line")).textContent ?? "";
    expect(line).toMatch(/^与 对比稿 · \d{2}-\d{2} \d{2}:\d{2} 的识别相比：/);
  });

  it("says there is nothing to compare with, and offers no paid action", async () => {
    mockApi({});
    renderApp(<ComparisonSummary revisionId="r1" revisions={[BASE]} onOpenEditor={() => undefined} />);
    expect((await screen.findByTestId("comparison-summary")).textContent).toContain("还没有另一家模型的识别稿可对比");
    expect(screen.queryByTestId("comparison-transcribe-submit")).toBeNull();
  });
});
