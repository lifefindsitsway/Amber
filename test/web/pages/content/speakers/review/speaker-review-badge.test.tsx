import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initI18n } from "../../../../../../src/web/i18n.ts";
import { reviewBadgeText, SpeakerReviewBadge } from "../../../../../../src/web/pages/content/speakers/review/speaker-review-badge.tsx";

describe("SpeakerReviewBadge", () => {
  it("says unreviewed, reviewed, and reviewed with names still to confirm", () => {
    const { t } = initI18n();
    expect(reviewBadgeText(t, false, 3)).toBe("发言人未核对");
    expect(reviewBadgeText(t, true, 0)).toBe("已核对");
    expect(reviewBadgeText(t, true, 2)).toBe("已核对 · 2 个姓名待确认");
  });

  it("is a button whose words and accessible name carry the state, not only its colour", () => {
    initI18n();
    const onClick = vi.fn();
    const { rerender } = render(<SpeakerReviewBadge confirmed={false} pendingNames={2} onClick={onClick} />);
    const badge = screen.getByRole("button", { name: "发言人核对状态：发言人未核对。打开核对面板" });
    expect(badge.textContent).toBe("发言人未核对");
    expect(badge.getAttribute("data-state")).toBe("unconfirmed");
    fireEvent.click(badge);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<SpeakerReviewBadge confirmed pendingNames={2} />);
    expect(screen.getByRole("button", { name: "发言人核对状态：已核对 · 2 个姓名待确认。打开核对面板" }).textContent).toBe("已核对 · 2 个姓名待确认");
    // The decorative icon stays out of the accessible tree.
    expect(screen.getByTestId("speaker-review-badge").querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
