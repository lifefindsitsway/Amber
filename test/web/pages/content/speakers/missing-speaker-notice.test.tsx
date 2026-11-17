import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MissingSpeakerNotice } from "../../../../../src/web/pages/content/speakers/missing-speaker-notice.tsx";
import { renderApp } from "../../../../fixtures/web/render.tsx";

describe("MissingSpeakerNotice", () => {
  it("says how many sentences name a deleted speaker and makes them unassigned on request", () => {
    const unassign = vi.fn();
    renderApp(<MissingSpeakerNotice count={3} onUnassign={unassign} />);
    const notice = screen.getByTestId("missing-speaker-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("有 3 句指向已删除的发言人");
    fireEvent.click(screen.getByRole("button", { name: "设为未分配" }));
    expect(unassign).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when no sentence does", () => {
    renderApp(<MissingSpeakerNotice count={0} onUnassign={() => undefined} />);
    expect(screen.queryByTestId("missing-speaker-notice")).toBeNull();
  });

  it("keeps the action off while the editor cannot change the draft", () => {
    renderApp(<MissingSpeakerNotice count={1} onUnassign={() => undefined} disabled />);
    expect((screen.getByRole("button", { name: "设为未分配" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
