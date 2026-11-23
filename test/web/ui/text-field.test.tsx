import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TextArea, TextInput } from "../../../src/web/ui/text-field.tsx";

describe("TextInput", () => {
  it("passes the ref, value, handlers and attributes through", () => {
    const ref = createRef<HTMLInputElement>();
    function Controlled() {
      const [value, setValue] = useState("");
      return <TextInput ref={ref} aria-label="名称" value={value} onChange={(event) => setValue(event.target.value)} data-testid="name" placeholder="输入名称" size="md" className="w-40" />;
    }
    render(<Controlled />);
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "名称" });
    expect(ref.current).toBe(input);
    expect(screen.getByTestId("name")).toBe(input);
    expect(input.type).toBe("text");
    expect(input.placeholder).toBe("输入名称");
    expect(input.className).toContain("h-8");
    expect(input.className).toMatch(/ w-40$/);
    fireEvent.change(input, { target: { value: "新名字" } });
    expect(input.value).toBe("新名字");
    expect(input.hasAttribute("size")).toBe(false);
  });

  it("marks an invalid value with aria-invalid", () => {
    render(<TextInput aria-label="名称" invalid aria-describedby="name-error" />);
    const input = screen.getByRole("textbox", { name: "名称" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("name-error");
  });

  it("leaves the caller's onKeyDown untouched, composing Enter included", () => {
    const onKeyDown = vi.fn();
    render(<TextInput aria-label="名称" onKeyDown={onKeyDown} />);
    const input = screen.getByRole("textbox", { name: "名称" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(2);
  });

  it("runs onEnter for a plain Enter but not for the Enter that picks an input method candidate", () => {
    const onEnter = vi.fn();
    const onKeyDown = vi.fn();
    render(<TextInput aria-label="名称" onEnter={onEnter} onKeyDown={onKeyDown} />);
    const input = screen.getByRole("textbox", { name: "名称" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "a" });
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onKeyDown).toHaveBeenCalledTimes(4);
  });

  it("skips onEnter when onKeyDown already handled the key", () => {
    const onEnter = vi.fn();
    render(<TextInput aria-label="名称" onEnter={onEnter} onKeyDown={(event) => event.preventDefault()} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "名称" }), { key: "Enter" });
    expect(onEnter).not.toHaveBeenCalled();
  });
});

describe("TextArea", () => {
  it("passes the ref, rows and attributes through and marks invalid", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea ref={ref} aria-label="说明" rows={4} invalid defaultValue="原文" data-testid="note" />);
    const area = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "说明" });
    expect(ref.current).toBe(area);
    expect(screen.getByTestId("note")).toBe(area);
    expect(area.rows).toBe(4);
    expect(area.value).toBe("原文");
    expect(area.getAttribute("aria-invalid")).toBe("true");
  });
});
