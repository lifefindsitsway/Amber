import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TWO_STEP_GUARD_MS } from "../../../src/shared/defaults.ts";
import { Modal } from "../../../src/web/ui/modal.tsx";
import { TwoStepButton } from "../../../src/web/ui/two-step-button.tsx";

let clock = 0;
const advance = (ms: number): void => {
  clock += ms;
};

beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

function setup(extra: Partial<Parameters<typeof TwoStepButton>[0]> = {}) {
  const onConfirm = vi.fn();
  const onArmedChange = vi.fn();
  const props = { label: "放弃草稿", confirmLabel: "确认放弃草稿", onConfirm, onArmedChange, "data-testid": "two-step", ...extra };
  const view = render(<TwoStepButton {...props} />);
  const button = screen.getByTestId("two-step");
  return { ...view, props, button, onConfirm, onArmedChange };
}

const isArmed = (button: HTMLElement): boolean => button.hasAttribute("data-armed");

describe("TwoStepButton", () => {
  it("arms on the first press: filled destructive look, the confirm label as its name, nothing run", () => {
    const { button, onConfirm, onArmedChange } = setup();
    expect(screen.getByRole("button", { name: "放弃草稿" })).toBe(button);
    expect(button.className).toContain("border-line");
    fireEvent.click(button);
    expect(isArmed(button)).toBe(true);
    expect(button.className).toContain("bg-danger");
    // The unarmed look is bordered, so the armed one keeps a border and with it the width.
    expect(button.className).toContain("border-danger");
    expect(screen.getByRole("button", { name: "确认放弃草稿" })).toBe(button);
    expect(onArmedChange.mock.calls).toEqual([[true]]);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores presses within the guard, as a double click or a key repeat would give", () => {
    const { button, onConfirm, onArmedChange } = setup();
    fireEvent.click(button);
    fireEvent.click(button);
    advance(TWO_STEP_GUARD_MS - 1);
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(isArmed(button)).toBe(true);
    expect(onArmedChange.mock.calls).toEqual([[true]]);
  });

  it("ignores the clicks of a held key, armed or not, even after the guard", () => {
    const { button, onConfirm } = setup();
    // Not armed: the repeated keydown's click does not arm.
    expect(fireEvent.keyDown(button, { key: "Enter", repeat: true })).toBe(false);
    fireEvent.click(button);
    expect(isArmed(button)).toBe(false);
    fireEvent.keyUp(button, { key: "Enter" });

    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(isArmed(button)).toBe(true);
    advance(TWO_STEP_GUARD_MS + 1);
    expect(fireEvent.keyDown(button, { key: "Enter", repeat: true })).toBe(false);
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(isArmed(button)).toBe(true);

    // Releasing the key and pressing again is a deliberate second press.
    fireEvent.keyUp(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("after the guard, a press disarms and confirms; while the action runs the button is busy and cannot be pressed", () => {
    const { button, props, rerender, onConfirm, onArmedChange } = setup();
    fireEvent.click(button);
    advance(TWO_STEP_GUARD_MS);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onArmedChange.mock.calls).toEqual([[true], [false]]);
    expect(isArmed(button)).toBe(false);

    rerender(<TwoStepButton {...props} loading />);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("button-spinner")).toBeTruthy();
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("after a failed action it is unarmed, and trying again takes both presses again", () => {
    const { button, props, rerender, onConfirm } = setup();
    fireEvent.click(button);
    advance(TWO_STEP_GUARD_MS);
    fireEvent.click(button);
    rerender(<TwoStepButton {...props} loading />);
    // The request failed: loading ends.
    rerender(<TwoStepButton {...props} loading={false} />);
    expect(isArmed(button)).toBe(false);
    expect(screen.getByRole("button", { name: "放弃草稿" })).toBe(button);
    fireEvent.click(button);
    expect(isArmed(button)).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disarms on blur", () => {
    const { button, onArmedChange } = setup();
    fireEvent.click(button);
    fireEvent.blur(button);
    expect(isArmed(button)).toBe(false);
    expect(onArmedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("disarms when disabled", () => {
    const { button, props, rerender, onArmedChange, onConfirm } = setup();
    fireEvent.click(button);
    rerender(<TwoStepButton {...props} disabled />);
    expect(isArmed(button)).toBe(false);
    expect(onArmedChange.mock.calls).toEqual([[true], [false]]);
    rerender(<TwoStepButton {...props} disabled={false} />);
    advance(TWO_STEP_GUARD_MS);
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(isArmed(button)).toBe(true);
  });

  it("disarms when the reset key changes, and only then", () => {
    const { button, props, rerender, onArmedChange } = setup({ resetKey: "a" });
    fireEvent.click(button);
    rerender(<TwoStepButton {...props} resetKey="a" />);
    expect(isArmed(button)).toBe(true);
    rerender(<TwoStepButton {...props} resetKey="a b" />);
    expect(isArmed(button)).toBe(false);
    expect(onArmedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("Esc on the armed button only disarms it; unarmed, Esc is left alone", () => {
    const { button, onConfirm } = setup();
    const outer = vi.fn();
    document.addEventListener("keydown", outer, true);
    try {
      button.focus();
      expect(fireEvent.keyDown(button, { key: "Escape" })).toBe(true);
      expect(outer).toHaveBeenCalledTimes(1);

      fireEvent.click(button);
      expect(fireEvent.keyDown(button, { key: "Escape" })).toBe(false);
      expect(isArmed(button)).toBe(false);
      expect(outer).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();

      fireEvent.keyDown(button, { key: "Escape" });
      expect(outer).toHaveBeenCalledTimes(2);
    } finally {
      document.removeEventListener("keydown", outer, true);
    }
  });

  it("inside a dialog, Esc on the armed button disarms it and leaves the dialog open; the next Esc closes the dialog", async () => {
    function InDialog() {
      const [open, setOpen] = useState(true);
      return (
        <Modal open={open} onOpenChange={setOpen} title="对话框">
          <TwoStepButton label="清除价格" confirmLabel="确认清除价格" onConfirm={() => undefined} data-testid="two-step" />
        </Modal>
      );
    }
    render(<InDialog />);
    const dialog = await screen.findByRole("dialog", { name: "对话框" });
    const button = screen.getByTestId("two-step");
    act(() => button.focus());
    fireEvent.click(button);
    expect(isArmed(button)).toBe(true);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(isArmed(button)).toBe(false);
    expect(screen.getByRole("dialog", { name: "对话框" })).toBe(dialog);
    fireEvent.keyDown(button, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lays both labels in one grid cell, the hidden one invisible and aria-hidden, so its width never changes", () => {
    const { button } = setup({ icon: <svg data-testid="icon" /> });
    const cell = button.querySelector(".grid");
    expect(cell).not.toBeNull();
    const [label, confirm] = Array.from(cell?.children ?? []);
    for (const item of [label, confirm]) expect(item?.className).toContain("col-start-1 row-start-1");
    expect(confirm?.className).toContain("invisible");
    expect(confirm?.getAttribute("aria-hidden")).toBe("true");
    expect(label?.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getByTestId("icon")).toBeTruthy();

    fireEvent.click(button);
    expect(label?.className).toContain("invisible");
    expect(label?.getAttribute("aria-hidden")).toBe("true");
    expect(confirm?.className).not.toContain("invisible");
    expect(confirm?.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getByTestId("icon")).toBeTruthy();
  });

  it("removes its Esc listener when unmounted while armed", () => {
    const removed = vi.spyOn(window, "removeEventListener");
    const { button, unmount, onConfirm } = setup();
    fireEvent.click(button);
    unmount();
    expect(removed.mock.calls.some(([type, , options]) => type === "keydown" && options === true)).toBe(true);
    const outer = vi.fn();
    document.addEventListener("keydown", outer, true);
    try {
      expect(() => fireEvent.keyDown(document.body, { key: "Escape" })).not.toThrow();
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", outer, true);
    }
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
