import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../../src/web/ui/button.tsx";

describe("Button", () => {
  it("keeps its defaults: a secondary, medium, non-submitting button", () => {
    render(<Button>保存</Button>);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "保存" });
    expect(button.type).toBe("button");
    expect(button.className).toContain("h-9");
    expect(button.className).toContain("border-line");
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("shows a visible focus ring on keyboard focus for every variant", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger", "danger-solid"] as const) {
      const { unmount } = render(<Button variant={variant}>操作</Button>);
      expect(screen.getByRole("button", { name: "操作" }).className).toContain("focus-visible:outline-accent");
      unmount();
    }
  });

  it("disables itself and is marked busy while loading, keeping its name", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="primary" loading onClick={onClick}>
        保存
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "保存" });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("button-spinner").getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(
      <Button variant="primary" onClick={onClick}>
        保存
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(screen.queryByTestId("button-spinner")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stays disabled when disabled even without loading", () => {
    render(<Button disabled>删除</Button>);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "删除" }).disabled).toBe(true);
  });

  it("fills the final destructive confirmation with the danger colour", () => {
    render(
      <>
        <Button variant="danger">删除</Button>
        <Button variant="danger-solid">永久删除</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "删除" }).className).toContain("text-danger");
    expect(screen.getByRole("button", { name: "删除" }).className).not.toContain("bg-danger");
    const solid = screen.getByRole("button", { name: "永久删除" });
    expect(solid.className).toContain("bg-danger");
    expect(solid.className).toContain("text-surface");
  });
});
