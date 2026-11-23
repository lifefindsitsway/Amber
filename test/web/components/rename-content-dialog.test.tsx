import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LIST_PAGE_SIZE_DEFAULT } from "../../../src/shared/defaults.ts";
import { RenameContentDialog } from "../../../src/web/components/rename-content-dialog.tsx";
import { useNoteGroups } from "../../../src/web/notes/queries.ts";
import { content } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const detail = (overrides = {}) => ({ ...content("c1", { title: "平台标题", ...overrides }), media: [] });

describe("RenameContentDialog", () => {
  it("prefills the shown title, sends the trimmed new one and closes; no restore without a rename", async () => {
    const onOpenChange = vi.fn();
    const { calls } = mockApi({ "GET /api/contents/c1": { body: detail() }, "PATCH /api/contents/c1": { body: content("c1", { title: "新标题", customTitle: "新标题" }) } });
    renderApp(<RenameContentDialog contentId="c1" onOpenChange={onOpenChange} />);
    const input = (await screen.findByLabelText("标题")) as HTMLInputElement;
    expect(input.value).toBe("平台标题");
    expect(screen.queryByRole("button", { name: "恢复原标题" })).toBeNull();
    fireEvent.change(input, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: " 新标题 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ title: "新标题" });
  });

  it("refreshes the note groups after a rename, since they show the Content's title", async () => {
    const onOpenChange = vi.fn();
    const { calls } = mockApi({
      "GET /api/contents/c1": { body: detail() },
      "PATCH /api/contents/c1": { body: content("c1", { title: "新标题", customTitle: "新标题" }) },
      "GET /api/notes/groups": { body: { items: [{ contentId: "c1", title: "平台标题", count: 1, latestAt: 1 }], total: 1 } },
    });
    const groupReads = () => calls.filter((call) => call.path.startsWith("/api/notes/groups")).length;
    renderApp(
      <>
        <NoteGroupsProbe />
        <RenameContentDialog contentId="c1" onOpenChange={onOpenChange} />
      </>,
    );
    await waitFor(() => expect(groupReads()).toBe(1));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "新标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(groupReads()).toBe(2);
  });

  it("marks an emptied title as the field's error and saves on Enter, but not on the Enter that picks an input-method candidate", async () => {
    const onOpenChange = vi.fn();
    const { calls } = mockApi({ "GET /api/contents/c1": { body: detail() }, "PATCH /api/contents/c1": { body: content("c1", { title: "新标题", customTitle: "新标题" }) } });
    renderApp(<RenameContentDialog contentId="c1" onOpenChange={onOpenChange} />);
    const input = (await screen.findByLabelText("标题")) as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByTestId("rename-content-error")).toBeNull();

    fireEvent.change(input, { target: { value: "  " } });
    const error = screen.getByTestId("rename-content-error");
    expect(error.textContent).toBe("标题不能为空");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    fireEvent.change(input, { target: { value: "新标题" } });
    expect(screen.queryByTestId("rename-content-error")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{ title: "新标题" }]);
  });

  it("keeps the dialog open with the reason when the rename is refused", async () => {
    const onOpenChange = vi.fn();
    mockApi({
      "GET /api/contents/c1": { body: detail({ customTitle: "平台标题" }) },
      "PATCH /api/contents/c1": { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "内容不存在" } } },
    });
    renderApp(<RenameContentDialog contentId="c1" onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复原标题" }));
    expect(await screen.findByText("内容不存在")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

/** Keeps the note groups mounted, so an invalidation shows up as a refetch. */
function NoteGroupsProbe() {
  useNoteGroups({ page: 1, pageSize: LIST_PAGE_SIZE_DEFAULT });
  return null;
}
