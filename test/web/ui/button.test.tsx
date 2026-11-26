import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, buttonClass } from "../../../src/web/ui/button.tsx";

describe("Button", () => {
  it("keeps its defaults: a secondary, 36 px, non-submitting button", () => {
    render(<Button>保存</Button>);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "保存" });
    expect(button.type).toBe("button");
    expect(button.className).toContain("h-9");
    expect(button.className).toContain("px-3.5");
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
    // The label stays where it was, only transparent, so neither the width nor the name changes.
    expect(button.textContent).toBe("保存");
    expect(button.className).toContain("text-transparent!");
    expect(screen.getByTestId("button-spinner").className).toContain("absolute");
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
    expect(button.className).not.toContain("text-transparent");
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

  it("comes in the three control heights with their own padding and text size", () => {
    render(
      <>
        <Button size="sm">小</Button>
        <Button size="md">中</Button>
        <Button size="lg">大</Button>
      </>,
    );
    const classes = (name: string): string[] => screen.getByRole("button", { name }).className.split(" ");
    expect(classes("小")).toEqual(expect.arrayContaining(["h-7", "px-2.5", "text-xs"]));
    expect(classes("中")).toEqual(expect.arrayContaining(["h-8", "px-3", "text-sm"]));
    expect(classes("大")).toEqual(expect.arrayContaining(["h-9", "px-3.5", "text-sm"]));
  });

  it("sinks while pressed instead of taking the brand colour", () => {
    render(
      <Button aria-pressed size="md">
        完成选择
      </Button>,
    );
    const button = screen.getByRole("button", { name: "完成选择" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("aria-pressed:bg-sunken");
    expect(button.className).not.toContain("bg-accent-glow");
  });

  it("gives the solid danger button a border of its own colour, so it matches an outlined one in size", () => {
    render(<Button variant="danger-solid">确认</Button>);
    expect(screen.getByRole("button", { name: "确认" }).className).toContain("border-danger");
  });

  it("lends its look to links through buttonClass", () => {
    render(
      <a href="/x" className={buttonClass("secondary", "sm")}>
        查看
      </a>,
    );
    const link = screen.getByRole("link", { name: "查看" });
    expect(link.className).toContain("h-7");
    expect(link.className).toContain("border-line");
    expect(link.className).toContain("focus-visible:outline-accent");
    expect(buttonClass()).toContain("h-9");
  });
});
