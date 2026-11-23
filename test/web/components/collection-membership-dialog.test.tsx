import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ContentDto } from "../../../src/shared/dto/content.ts";
import { CollectionMembershipDialog } from "../../../src/web/components/collection-membership-dialog.tsx";
import { collection, content } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

/** A server whose memberships follow the add / remove calls, as the real one does. */
function membershipServer(initial: ContentDto["collections"], collections = [collection("k1", "Test"), collection("k2", "进阶")]) {
  let memberships = [...initial];
  const all = [...collections];
  let nextItem = 1;
  const api = mockApi({
    "GET /api/contents/c1": () => ({ body: { ...content("c1", { title: "Demo", collections: memberships }), media: [] } }),
    "GET /api/collections": () => ({ body: { items: all } }),
    "POST /api/collections": (call) => {
      const created = collection("k3", (call.body as { name: string }).name);
      all.push(created);
      return { status: 201, body: { ...created, items: [] } };
    },
    "POST /api/collections/k1/items": () => join("k1"),
    "POST /api/collections/k2/items": () => join("k2"),
    "POST /api/collections/k3/items": () => join("k3"),
    "DELETE /api/collections/k1/items/i-k1": () => leave("i-k1"),
    "DELETE /api/collections/k2/items/i-k2": () => leave("i-k2"),
  });
  function join(collectionId: string) {
    const name = all.find((item) => item.id === collectionId)?.name ?? "";
    const itemId = collectionId === "k3" ? `i-new-${nextItem++}` : `i-${collectionId}`;
    memberships.push({ id: collectionId, name, itemId });
    return { body: { id: itemId, contentId: "c1", position: 0, addedAt: 1, processingStatus: "succeeded", source: { kind: "youtube" }, updatedAt: 1 } };
  }
  function leave(itemId: string) {
    memberships = memberships.filter((membership) => membership.itemId !== itemId);
    return { status: 204 };
  }
  return api;
}

function checkbox(name: string): HTMLInputElement {
  return within(screen.getByTestId("membership-list")).getByRole("checkbox", { name }) as HTMLInputElement;
}

describe("CollectionMembershipDialog", () => {
  it("ticks the current memberships, adds by contentId and allows several collections at once", async () => {
    const { calls } = membershipServer([{ id: "k1", name: "Test", itemId: "i-k1" }]);
    renderApp(<CollectionMembershipDialog contentId="c1" onOpenChange={() => undefined} />);
    expect(await screen.findByRole("dialog", { name: "管理合集" })).toBeTruthy();
    await waitFor(() => expect(checkbox("Test").checked).toBe(true));
    expect(checkbox("进阶").checked).toBe(false);

    fireEvent.click(checkbox("进阶"));
    // Locked until the refreshed detail shows the membership.
    expect(checkbox("进阶").disabled).toBe(true);
    await waitFor(() => expect(checkbox("进阶").checked).toBe(true));
    expect(checkbox("进阶").disabled).toBe(false);
    expect(checkbox("Test").checked).toBe(true);
    expect(calls.find((call) => call.method === "POST" && call.path === "/api/collections/k2/items")?.body).toEqual({ contentId: "c1" });
  });

  it("removes only the membership, by its item id", async () => {
    const { calls } = membershipServer([{ id: "k1", name: "Test", itemId: "i-k1" }]);
    renderApp(<CollectionMembershipDialog contentId="c1" onOpenChange={() => undefined} />);
    await waitFor(() => expect(checkbox("Test").checked).toBe(true));
    fireEvent.click(checkbox("Test"));
    await waitFor(() => expect(checkbox("Test").checked).toBe(false));
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/collections/k1/items/i-k1"]);
    expect(calls.some((call) => call.method === "DELETE" && call.path.startsWith("/api/contents"))).toBe(false);
  });

  it("creates a collection and joins it in one step", async () => {
    const { calls } = membershipServer([]);
    renderApp(<CollectionMembershipDialog contentId="c1" onOpenChange={() => undefined} />);
    await screen.findByTestId("membership-list");
    const create = screen.getByRole("button", { name: "新建并加入" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("新合集名称"), { target: { value: "  临时合集  " } });
    fireEvent.click(create);
    await waitFor(() => expect(checkbox("临时合集").checked).toBe(true));
    expect(calls.find((call) => call.method === "POST" && call.path === "/api/collections")?.body).toEqual({ name: "临时合集" });
    expect(calls.find((call) => call.method === "POST" && call.path === "/api/collections/k3/items")?.body).toEqual({ contentId: "c1" });
    expect((screen.getByLabelText("新合集名称") as HTMLInputElement).value).toBe("");
  });

  it("keeps the creation form in the footer, below a list that scrolls on its own, and locked until the lists load", async () => {
    membershipServer([]);
    renderApp(<CollectionMembershipDialog contentId="c1" onOpenChange={() => undefined} />);
    const dialog = await screen.findByTestId("collection-membership-dialog");
    const name = screen.getByLabelText("新合集名称") as HTMLInputElement;
    expect(dialog.querySelector("[data-modal-footer]")?.contains(name)).toBe(true);
    expect(name.disabled).toBe(true);
    const list = await screen.findByTestId("membership-list");
    expect(dialog.querySelector("[data-modal-body]")?.contains(list)).toBe(true);
    expect(name.disabled).toBe(false);
  });

  it("does not create on the Enter that picks an input-method candidate", async () => {
    const { calls } = membershipServer([]);
    renderApp(<CollectionMembershipDialog contentId="c1" onOpenChange={() => undefined} />);
    await screen.findByTestId("membership-list");
    const name = screen.getByLabelText("新合集名称");
    fireEvent.change(name, { target: { value: "临时合集" } });
    expect(fireEvent.keyDown(name, { key: "Enter", isComposing: true })).toBe(false);
    expect(calls.some((call) => call.method === "POST" && call.path === "/api/collections")).toBe(false);
  });

  it("offers only creation when there is no collection, and shows a refused change", async () => {
    mockApi({
      "GET /api/contents/c1": { body: { ...content("c1"), media: [] } },
      "GET /api/collections": { body: { items: [] } },
      "POST /api/collections": {
        status: 400,
        body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "请求参数有误：name" } },
      },
    });
    renderApp(<CollectionMembershipDialog contentId="c1" onOpenChange={() => undefined} />);
    expect(await screen.findByText("还没有合集，可以在下面新建一个。")).toBeTruthy();
    expect(screen.queryByTestId("membership-list")).toBeNull();
    fireEvent.change(screen.getByLabelText("新合集名称"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "新建并加入" }));
    expect(await screen.findByText(/请求参数有误/u)).toBeTruthy();
  });

  it("keeps a late failure for one Content out of the dialog opened since for another", async () => {
    mockApi({
      "GET /api/contents/c1": { body: { ...content("c1", { title: "Demo", collections: [] }), media: [] } },
      "GET /api/contents/c2": { body: { ...content("c2", { title: "Other", collections: [] }), media: [] } },
      "GET /api/collections": { body: { items: [collection("k1", "Test"), collection("k2", "进阶")] } },
    });
    // The join for c1 is held, then refused once the dialog shows c2.
    let release: (() => void) | undefined;
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "/api/collections/k1/items") {
        await new Promise<void>((resolve) => (release = resolve));
        return new Response(JSON.stringify({ error: { class: "conflict", code: "conflict", retryDisposition: "never", userMessage: "迟到的失败" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return original(input, init);
    });
    function Switcher() {
      const [contentId, setContentId] = useState<string | undefined>("c1");
      return (
        <>
          <button type="button" data-testid="close" onClick={() => setContentId(undefined)} />
          <button type="button" data-testid="open-c2" onClick={() => setContentId("c2")} />
          <CollectionMembershipDialog contentId={contentId} onOpenChange={(open) => (open ? undefined : setContentId(undefined))} />
        </>
      );
    }
    renderApp(<Switcher />);
    await waitFor(() => expect(checkbox("Test").disabled).toBe(false));
    fireEvent.click(checkbox("Test"));
    await waitFor(() => expect(release).toBeDefined());
    expect(checkbox("Test").disabled).toBe(true);
    fireEvent.click(screen.getByTestId("close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByTestId("open-c2"));
    await waitFor(() => expect(checkbox("Test").disabled).toBe(false));
    release?.();
    // Give the late answer time to land; the new dialog shows neither its error nor a lock.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText("迟到的失败")).toBeNull();
    expect(checkbox("Test").disabled).toBe(false);
    expect(checkbox("进阶").disabled).toBe(false);
  });
});
