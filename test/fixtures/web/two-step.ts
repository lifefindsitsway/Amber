import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { TWO_STEP_GUARD_MS } from "../../../src/shared/defaults.ts";

let skipped = 0;

/**
 * Moves the clock two-step buttons read past the guard after an arming press. The clock keeps
 * running, only ahead: fake timers would stall the queries and mutations page tests wait on,
 * and a frozen clock would stall React's scheduler.
 */
export function passTwoStepGuard(): void {
  skipped += TWO_STEP_GUARD_MS + 1;
  if (vi.isMockFunction(performance.now)) return;
  const real = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => real() + skipped);
}

/** Arms a two-step button, waits out its guard and confirms: the full deliberate two presses. */
export function confirmTwoStep(button: HTMLElement | (() => HTMLElement)): void {
  const get = typeof button === "function" ? button : () => button;
  fireEvent.click(get());
  passTwoStepGuard();
  fireEvent.click(get());
}
