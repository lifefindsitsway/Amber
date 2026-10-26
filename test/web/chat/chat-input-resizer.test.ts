import { describe, expect, it } from "vitest";
import { draggedHeight } from "../../../src/web/chat/chat-input-resizer.tsx";

describe("draggedHeight", () => {
  it("grows when the top edge moves up and shrinks when it moves down, never below zero", () => {
    expect(draggedHeight(80, 500, 420)).toBe(160);
    expect(draggedHeight(80, 500, 530)).toBe(50);
    expect(draggedHeight(80, 500, 700)).toBe(0);
  });
});
