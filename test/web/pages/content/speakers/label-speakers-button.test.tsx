import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LabelSpeakersButton } from "../../../../../src/web/pages/content/speakers/label-speakers-button.tsx";
import { renderApp } from "../../../../fixtures/web/render.tsx";

describe("LabelSpeakersButton", () => {
  it("is an icon button named and titled 「标注发言人」 that calls back when pressed", () => {
    const onClick = vi.fn();
    renderApp(<LabelSpeakersButton onClick={onClick} />);
    const button = screen.getByRole("button", { name: "标注发言人" });
    expect(button.getAttribute("title")).toBe("标注发言人");
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
