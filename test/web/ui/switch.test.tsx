import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "../../../src/web/ui/switch.tsx";

describe("Switch", () => {
  it("is a labelled switch that reports the new state", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange}>开关</Switch>);
    const toggle = screen.getByRole("switch", { name: "开关" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("is disabled with a reason it points at", () => {
    render(
      <>
        <Switch checked={false} disabled onChange={() => undefined} title="原因" describedBy="why">
          开关
        </Switch>
        <p id="why">原因</p>
      </>,
    );
    const toggle = screen.getByRole("switch", { name: "开关" }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-describedby")).toBe("why");
    expect(toggle.closest("label")?.title).toBe("原因");
  });
});
