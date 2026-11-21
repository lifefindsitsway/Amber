import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkScopeHint } from "../../../src/web/components/link-scope-hint.tsx";
import { parseLinkText } from "../../../src/web/links.ts";

const VIDEO = "https://www.bilibili.com/video/BV1xx411c7mD";

describe("LinkScopeHint", () => {
  it("lists at most twenty links left out and counts the rest, with the lines holding no link", () => {
    const others = Array.from({ length: 23 }, (_, index) => `https://example.com/item-${index}`);
    const parsed = parseLinkText([VIDEO, ...others, "一行说明"].join("\n"));
    render(<LinkScopeHint parsed={parsed} id="scope" />);
    expect(screen.getByTestId("link-scope").textContent).toContain("将处理 1 条链接，另有 23 条未加入");
    fireEvent.click(screen.getByTestId("link-scope-toggle"));
    const details = screen.getByTestId("link-scope-details");
    expect(details.querySelectorAll("li")).toHaveLength(20);
    expect(details.textContent).toContain("https://example.com/item-19");
    expect(details.textContent).not.toContain("https://example.com/item-20");
    expect(details.textContent).toContain("3");
    expect(details.textContent).toContain("1 行");
    expect(screen.getByTestId("link-scope-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("offers no list when only words were left out", () => {
    render(<LinkScopeHint parsed={parseLinkText(`【标题】 ${VIDEO}`)} id="scope" />);
    expect(screen.queryByTestId("link-scope-toggle")).toBeNull();
    expect(screen.getByTestId("link-scope").textContent).toContain("1");
  });
});
