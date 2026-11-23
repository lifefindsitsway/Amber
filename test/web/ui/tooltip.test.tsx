import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipProvider } from "../../../src/web/ui/tooltip.tsx";

describe("Tooltip", () => {
  it("opens on hover after a short delay, as a tooltip styled like the app's popovers", async () => {
    render(
      <TooltipProvider>
        <Tooltip content="details" testId="tip">
          <span>number</span>
        </Tooltip>
      </TooltipProvider>,
    );
    fireEvent.pointerMove(screen.getByText("number"));
    // Not at once: sweeping the pointer across a table must not flash a tooltip per row.
    expect(screen.queryByTestId("tip")).toBeNull();
    const tip = await screen.findByTestId("tip");
    expect(screen.getByRole("tooltip").textContent).toBe("details");
    for (const part of ["bg-surface", "border-line", "shadow-lg", "text-xs"]) expect(tip.className).toContain(part);
    fireEvent.pointerLeave(screen.getByText("number"));
    await waitFor(() => expect(screen.queryByTestId("tip")).toBeNull());
  });

  it("never lets a click on its content reach the clickable row it belongs to", async () => {
    const onRow = vi.fn();
    render(
      <TooltipProvider>
        <div onClick={onRow} onPointerDown={onRow} onMouseDown={onRow}>
          <Tooltip content={<b>inside</b>} open testId="tip">
            <span>cell</span>
          </Tooltip>
        </div>
      </TooltipProvider>,
    );
    const tip = await screen.findByTestId("tip");
    fireEvent.pointerDown(screen.getByText("inside"));
    fireEvent.mouseDown(screen.getByText("inside"));
    fireEvent.click(screen.getByText("inside"));
    expect(tip.contains(screen.getByText("inside"))).toBe(true);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("can be opened from elsewhere and closes with Escape, telling its owner", async () => {
    function Owner() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onFocus={() => setOpen(true)}>
            control
          </button>
          <Tooltip content="details" open={open} onOpenChange={setOpen} testId="tip">
            <span>cell</span>
          </Tooltip>
        </>
      );
    }
    render(
      <TooltipProvider>
        <Owner />
      </TooltipProvider>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "control" }));
    expect(await screen.findByTestId("tip")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("tip")).toBeNull());
  });

  it("does not open when focus is handed back right after Escape or a click, but does on Tab", async () => {
    render(
      <TooltipProvider>
        <Tooltip content="restored" testId="tip">
          <button type="button">trigger</button>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "trigger" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.focus(trigger);
    fireEvent.blur(trigger);
    fireEvent.pointerDown(document.body);
    fireEvent.focus(trigger);
    fireEvent.blur(trigger);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("tip")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focus(trigger);
    expect(await screen.findByTestId("tip")).toBeTruthy();
  });

  it("still works outside the app's provider", async () => {
    render(
      <Tooltip content="alone" open testId="tip">
        <span>cell</span>
      </Tooltip>,
    );
    expect((await screen.findByTestId("tip")).textContent).toBe("alone");
  });
});
