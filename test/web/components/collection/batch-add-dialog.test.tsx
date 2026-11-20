import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BatchAddDialog } from "../../../../src/web/components/collection/batch-add-dialog.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { baseRoutes, provider, SETTINGS } from "../../../fixtures/web/shell-data.ts";
import { providerWithoutWindow, windowRoutes } from "../../../fixtures/web/context-window.ts";

const VIDEO = "https://www.youtube.com/watch?v=UF8uR6Z6KLc";

function routes(defaultModelId: string) {
  const windows = windowRoutes([provider("p1", "主力", ["m1"]), providerWithoutWindow("p2", "备用", ["bare"])]);
  const defaultModelRef = defaultModelId === "m1" ? { providerProfileId: "p1", modelId: "m1" } : { providerProfileId: "p2", modelId: defaultModelId };
  const api = mockApi({
    ...baseRoutes(),
    ...windows.routes,
    "GET /api/settings": { body: { ...SETTINGS, defaultModelRef } },
    "POST /api/contents/import": { status: 202, body: { importBatchId: "b1", taskIds: ["t1"], contentIds: ["c1"] } },
  });
  return { calls: api.calls, overrides: windows.overrides };
}

describe("BatchAddDialog model readiness", () => {
  it("holds the import while the default model has no window, and adds once it is filled in", async () => {
    const { calls, overrides } = routes("bare");
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.change(screen.getByRole("textbox", { name: "批量添加到合集" }), { target: { value: VIDEO } });
    const notice = await screen.findByTestId("batch-add-context-window");
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "添加" });
    expect(add.disabled).toBe(true);
    // A dialog keeps to the field and 「保存」: the common sizes are input suggestions.
    expect(notice.dataset["variant"]).toBe("minimal");
    expect(within(notice).queryByRole("group", { name: "常用值" })).toBeNull();
    expect(within(notice).queryByTestId("batch-add-context-window-settings")).toBeNull();
    fireEvent.keyDown(within(notice).getByLabelText("上下文窗口"), { key: "ArrowDown" });
    expect(within(screen.getByRole("listbox", { name: "常用值" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["32K", "64K", "128K", "200K", "256K", "1M"]);
    fireEvent.change(within(notice).getByLabelText("上下文窗口"), { target: { value: "128000" } });
    fireEvent.click(within(notice).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByTestId("batch-add-context-window")).toBeNull());
    expect(overrides[0]?.path).toBe("/api/providers/p2/models/bare/override");
    expect(add.disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(add));
    fireEvent.click(add);
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/contents/import")).toBe(true));
  });

  it("asks nothing when the default model has its window", async () => {
    routes("m1");
    renderApp(<BatchAddDialog open onOpenChange={() => undefined} collectionId="col1" />);
    fireEvent.change(screen.getByRole("textbox", { name: "批量添加到合集" }), { target: { value: VIDEO } });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "添加" }).disabled).toBe(false));
    expect(screen.queryByTestId("batch-add-context-window")).toBeNull();
  });
});
