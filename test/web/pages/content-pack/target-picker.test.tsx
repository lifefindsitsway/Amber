import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PackContentDiff, PackPreviewContent } from "../../../../src/shared/dto/content-pack.ts";
import { TargetPicker } from "../../../../src/web/pages/content-pack/target-picker.tsx";
import { content } from "../../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const DIFF: PackContentDiff = {
  revisions: [],
  speakers: [],
  figures: { new: 0, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 },
  notes: { new: 0, existing: 0, differs: 0, unplaceable: 0 },
  platformChapters: "none",
  media: [],
  overLimit: [],
};

const ITEM: PackPreviewContent = { key: "k1", title: "包里的第一讲", sourceKind: "local", durationMs: 60_000, match: "new", candidates: [], diff: DIFF };

describe("TargetPicker", () => {
  it("keeps the choose label while the comparison runs and says it compares beside that row's button", async () => {
    mockApi({
      "GET /api/contents": { body: { items: [content("a", { durationMs: 60_000 }), content("b", { durationMs: 60_000 })], total: 2 } },
      "POST /api/content-packs/imports/j1/compare": { body: { ...DIFF, targetContentId: "b" } },
    });
    // The comparison waits until released, so the busy state is seen.
    const base = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/compare")) await gate;
      return base(input, init);
    });
    const onPicked = vi.fn();
    renderApp(<TargetPicker open onClose={() => undefined} jobId="j1" item={ITEM} onPicked={onPicked} />);
    const rows = await screen.findAllByTestId("pack-target-option");
    const chosen = rows[1] as HTMLElement;
    const other = rows[0] as HTMLElement;
    expect(screen.queryByTestId("pack-target-comparing")).toBeNull();
    fireEvent.click(within(chosen).getByRole("button", { name: "合并到这一条 · 内容 b" }));
    const button = within(chosen).getByRole("button", { name: "合并到这一条 · 内容 b" });
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.textContent).toBe("合并到这一条");
    const status = within(chosen).getByTestId("pack-target-comparing");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("正在比较…");
    // Only the picked row says it; the other rows wait without a spinner.
    expect(within(other).queryByTestId("pack-target-comparing")).toBeNull();
    expect(within(other).getByRole("button", { name: "合并到这一条 · 内容 a" }).getAttribute("aria-busy")).toBeNull();
    release();
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
  });
});
