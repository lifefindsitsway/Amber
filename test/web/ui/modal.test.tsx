import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Modal } from "../../../src/web/ui/modal.tsx";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Modal open={open} onOpenChange={setOpen} title="对话框">
        <button type="button" onClick={() => setOpen(false)}>
          取消
        </button>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("returns focus to the element that opened it when closed with Escape", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "对话框" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the menu's button when the dialog was opened from a menu item that is gone", async () => {
    function FromMenu() {
      const [menuOpen, setMenuOpen] = useState(true);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" aria-haspopup="menu" aria-controls="row-menu">
            更多操作
          </button>
          {menuOpen ? (
            <div role="menu" id="row-menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(true);
                  // Like a real menu, it goes away just after the dialog has taken the focus.
                  setTimeout(() => setMenuOpen(false), 0);
                }}
              >
                删除
              </button>
            </div>
          ) : null}
          <Modal open={open} onOpenChange={setOpen} title="对话框">
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
          </Modal>
        </>
      );
    }
    render(<FromMenu />);
    const item = screen.getByRole("menuitem", { name: "删除" });
    item.focus();
    fireEvent.click(item);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多操作" }));
  });

  it("returns focus to the opener when a button inside closes it", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("Modal layout", () => {
  it("keeps the single scrolling box of callers without a footer", () => {
    render(
      <Modal open onOpenChange={() => undefined} title="旧对话框" description="说明">
        <p data-testid="body">正文</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "旧对话框" });
    expect(dialog.className).toBe(
      "fixed top-[12vh] left-1/2 z-50 max-h-[76vh] w-[92vw] -translate-x-1/2 overflow-auto rounded-lg border border-line bg-surface p-5 shadow-xl max-w-lg",
    );
    expect(dialog.hasAttribute("data-sectioned")).toBe(false);
    expect(dialog.getAttribute("aria-describedby")).toBe("modal-description");
    // Header row, description, then the caller's content, all direct children of the dialog.
    const children = [...dialog.children];
    expect(children).toHaveLength(3);
    expect(children[0]?.className).toBe("mb-3 flex items-start justify-between gap-4");
    expect(children[1]?.id).toBe("modal-description");
    expect(children[1]?.className).toBe("mb-3 text-sm text-muted");
    expect(children[2]).toBe(screen.getByTestId("body"));
  });

  it("keeps the wide width for the boolean prop and accepts a size", () => {
    const { unmount } = render(
      <Modal open onOpenChange={() => undefined} title="宽" wide>
        <p>正文</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "宽" }).className).toContain("max-w-3xl");
    unmount();
    render(
      <Modal open onOpenChange={() => undefined} title="更宽" size="xl" testId="xl-dialog">
        <p>正文</p>
      </Modal>,
    );
    expect(screen.getByTestId("xl-dialog").className).toContain("max-w-5xl");
  });

  it("splits a dialog with a footer into a fixed header, a scrolling body and a fixed footer", () => {
    render(
      <Modal open onOpenChange={() => undefined} title="三段" description="说明文字" testId="sectioned" footer={<button type="button">确定</button>}>
        <p data-testid="body">正文</p>
      </Modal>,
    );
    const dialog = screen.getByTestId("sectioned");
    expect(dialog).toBe(screen.getByRole("dialog", { name: "三段" }));
    expect(dialog.className).toContain("flex-col");
    expect(dialog.className).toContain("dvh");
    const [header, body, footer] = [...dialog.children] as HTMLElement[];
    expect(dialog.children).toHaveLength(3);
    expect(header?.className).toContain("shrink-0");
    expect(header?.textContent).toContain("说明文字");
    expect(body?.className).toContain("min-h-0 flex-1 overflow-auto");
    expect(body?.contains(screen.getByTestId("body"))).toBe(true);
    expect(footer?.className).toContain("shrink-0");
    expect(footer?.className).toContain("justify-end");
    expect(footer?.className).toContain("border-t");
    expect(footer?.contains(screen.getByRole("button", { name: "确定" }))).toBe(true);
    // The description is wired by its own id, so two open dialogs never share one.
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)?.textContent).toBe("说明文字");
  });

  it("returns focus to the opener when a footer button closes it", async () => {
    function FooterHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开
          </button>
          <Modal
            open={open}
            onOpenChange={setOpen}
            title="带底栏"
            footer={
              <button type="button" onClick={() => setOpen(false)}>
                取消
              </button>
            }
          >
            <p>正文</p>
          </Modal>
        </>
      );
    }
    render(<FooterHarness />);
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});
