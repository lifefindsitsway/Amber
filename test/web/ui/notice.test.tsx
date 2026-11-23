import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Banner, Callout, FieldError, FieldHint, InlineNote, TextAction, type NoticeTone } from "../../../src/web/ui/notice.tsx";

describe("FieldHint and FieldError", () => {
  it("describe a control by id, and the error is not a second live announcement", () => {
    render(
      <>
        <label htmlFor="name">名称</label>
        <input id="name" aria-invalid="true" aria-describedby="name-hint name-error" />
        <FieldHint id="name-hint" testId="hint">
          最多 40 个字
        </FieldHint>
        <FieldError id="name-error" testId="error">
          名称不能为空
        </FieldError>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "名称" });
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(["最多 40 个字", "名称不能为空"]);
    expect(screen.getByTestId("hint").className).toContain("text-note");
    expect(screen.getByTestId("hint").className).toContain("text-muted");
    expect(screen.getByTestId("error").className).toContain("text-danger");
    expect(screen.getByTestId("error").hasAttribute("role")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    // The icon is decoration; the text alone is the message.
    expect(screen.getByTestId("error").querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("InlineNote", () => {
  it("is quiet text with an optional inline action in the link colour", () => {
    const onClick = vi.fn();
    render(
      <InlineNote testId="note" action={<TextAction onClick={onClick}>去设置</TextAction>}>
        还没有配置模型
      </InlineNote>,
    );
    const note = screen.getByTestId("note");
    expect(note.hasAttribute("role")).toBe(false);
    expect(note.className).toContain("text-muted");
    expect(note.className).not.toContain("border");
    const action = screen.getByRole("button", { name: "去设置" });
    expect(action.className).toContain("text-link");
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Callout", () => {
  it.each<[NoticeTone, string]>([
    ["info", "bg-panel"],
    ["warn", "bg-warn-soft"],
    ["error", "bg-danger-soft"],
    ["success", "bg-ok-soft"],
  ])("draws the %s tone on its own ground, never the accent", (tone, ground) => {
    render(
      <Callout tone={tone} testId="callout" title="标题" actions={<button type="button">处理</button>}>
        正文
      </Callout>,
    );
    const callout = screen.getByTestId("callout");
    expect(callout.className).toContain(ground);
    expect(callout.className).not.toContain("accent");
    expect(callout.getAttribute("data-tone")).toBe(tone);
    expect(callout.textContent).toBe("标题正文处理");
    // A notice present from the start is not a live region.
    expect(callout.hasAttribute("role")).toBe(false);
    expect(callout.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is a status or an alert only when asked", () => {
    render(
      <>
        <Callout tone="success" announce="status" testId="status">
          已保存
        </Callout>
        <Callout tone="error" announce="alert" testId="alert">
          保存失败
        </Callout>
      </>,
    );
    expect(screen.getByRole("status")).toBe(screen.getByTestId("status"));
    expect(screen.getByRole("alert")).toBe(screen.getByTestId("alert"));
  });

  it("lets an explicit role and other attributes through", () => {
    render(
      <Callout tone="warn" role="group" aria-labelledby="label" data-variant="full" testId="group" density="compact">
        <p id="label">需要处理</p>
      </Callout>,
    );
    const group = screen.getByRole("group", { name: "需要处理" });
    expect(group).toBe(screen.getByTestId("group"));
    expect(group.getAttribute("data-variant")).toBe("full");
    expect(group.className).toContain("text-note");
  });
});

describe("Banner", () => {
  it("spans the page with the tone's ground and its actions at the end", () => {
    render(
      <Banner tone="warn" testId="banner" announce="status" actions={<button type="button">重新连接</button>}>
        后端不可用
      </Banner>,
    );
    const banner = screen.getByRole("status");
    expect(banner).toBe(screen.getByTestId("banner"));
    expect(banner.className).toContain("bg-warn-soft");
    expect(banner.className).toContain("border-b");
    expect(banner.lastElementChild?.contains(screen.getByRole("button", { name: "重新连接" }))).toBe(true);
  });
});
