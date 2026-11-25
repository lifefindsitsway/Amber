import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOAST_DISMISS_MS, TRASH_RETENTION_DAYS } from "../../../../src/shared/defaults.ts";
import type { CollectionDeletePlanDto } from "../../../../src/shared/dto/collection.ts";
import { DeleteCollectionDialog } from "../../../../src/web/components/collection/delete-collection-dialog.tsx";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

const PLAN_PATH = "/api/collections/k1/delete-plan";
const DELETE_PATH = "/api/collections/k1/delete";

function plan(overrides: Partial<CollectionDeletePlanDto> = {}): CollectionDeletePlanDto {
  return {
    memberCount: 7,
    exclusiveContentIds: ["c1", "c2", "c3", "c4", "c5"],
    sharedCount: 2,
    trashedMemberCount: 0,
    exclusiveWithTasksCount: 3,
    collectionTaskCount: 0,
    blocked: [],
    ...overrides,
  };
}

const conflict = (code: string, details?: Record<string, unknown>) => ({
  status: 409,
  body: { error: { class: "conflict", code, retryDisposition: "never", userMessage: "", ...(details === undefined ? {} : { details }) } },
});

function Harness() {
  const [open, setOpen] = useState(true);
  const location = useLocation();
  return (
    <>
      <p data-testid="location">{location.pathname}</p>
      <DeleteCollectionDialog collection={open ? { id: "k1", name: "Stanford CS193T" } : undefined} onOpenChange={setOpen} />
    </>
  );
}

function render(route = "/library") {
  return renderApp(<Harness />, { route });
}

const dialog = () => screen.getByTestId("delete-collection-dialog");
const confirmButton = () => screen.getByTestId("delete-collection-confirm") as HTMLButtonElement;
const deletes = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.path === DELETE_PATH);
const planReads = (calls: RecordedCall[]) => calls.filter((call) => call.method === "GET" && call.path === PLAN_PATH).length;
const radio = (name: RegExp | string) => within(dialog()).getByRole("radio", { name }) as HTMLInputElement;

async function opened(): Promise<void> {
  await waitFor(() => expect(confirmButton().disabled).toBe(false));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DeleteCollectionDialog", () => {
  it("offers deleting the collection with the members found nowhere else first, counting shared and busy ones", async () => {
    mockApi({ [`GET ${PLAN_PATH}`]: { body: plan() } });
    render();
    expect(await screen.findByRole("dialog", { name: "删除合集「Stanford CS193T」？" })).toBeTruthy();
    await opened();
    const withContents = radio("删除合集和其中的 5 项内容");
    expect(withContents.checked).toBe(true);
    expect(radio("只删除合集").checked).toBe(false);
    const card = screen.getByTestId("delete-collection-choice-exclusive");
    expect(card.textContent).toContain(`内容移入回收站，${TRASH_RETENTION_DAYS} 天内可恢复。`);
    expect(card.textContent).toContain("另有 2 项还在其它合集里，会保留。");
    expect(card.textContent).toContain("其中 3 项有未结束的任务，会先取消。");
    expect(screen.getByTestId("delete-collection-choice-keep").textContent).toContain("7 项内容都保留在「全部内容」里。");
    expect(screen.getByTestId("delete-collection-irreversible").textContent).toBe("合集本身、合集归纳与合集术语表删除后无法恢复；从回收站恢复的内容不会回到这个合集。");
    expect(screen.getByTestId("delete-collection-task-note")).toBeTruthy();
    expect(confirmButton().textContent).toBe("取消任务并删除合集和 5 项内容");
    expect(confirmButton().className).toContain("bg-danger");
    // The wording never talks of "exclusive" contents.
    expect(dialog().textContent).not.toContain("专属");
  });

  it("leaves out the shared and busy lines at zero and sends the members it saw", async () => {
    const { calls } = mockApi({
      [`GET ${PLAN_PATH}`]: { body: plan({ exclusiveContentIds: ["c1", "c2"], sharedCount: 0, exclusiveWithTasksCount: 0 }) },
      [`POST ${DELETE_PATH}`]: { body: { trashedIds: ["c1", "c2"], cancelledTaskCount: 0 } },
    });
    render();
    await opened();
    const card = screen.getByTestId("delete-collection-choice-exclusive");
    expect(card.textContent).not.toContain("其它合集");
    expect(card.textContent).not.toContain("未结束的任务");
    expect(screen.queryByTestId("delete-collection-task-note")).toBeNull();
    expect(confirmButton().textContent).toBe("删除合集和 2 项内容");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [sent] = deletes(calls);
    expect(sent?.body).toEqual({ contents: "exclusive", cancelTasks: false, expectedContentIds: ["c1", "c2"] });
    expect(sent?.headers["idempotency-key"]).toMatch(/.+/u);
  });

  it("deletes only the collection when the second card is chosen; the button says so", async () => {
    const { calls } = mockApi({
      [`GET ${PLAN_PATH}`]: { body: plan() },
      [`POST ${DELETE_PATH}`]: { body: { trashedIds: [], cancelledTaskCount: 0 } },
    });
    render();
    await opened();
    fireEvent.click(radio("只删除合集"));
    expect(radio("只删除合集").checked).toBe(true);
    expect(confirmButton().textContent).toBe("删除合集");
    // Keeping the members makes their Tasks irrelevant; the note about cancelling goes.
    expect(screen.queryByTestId("delete-collection-task-note")).toBeNull();
    expect(screen.getByTestId("delete-collection-irreversible").textContent).toBe("合集本身、合集归纳与合集术语表删除后无法恢复。");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes(calls)[0]?.body).toEqual({ contents: "keep", cancelTasks: false });
  });

  it("falls back to a plain confirmation when every member is in another collection too", async () => {
    const { calls } = mockApi({
      [`GET ${PLAN_PATH}`]: { body: plan({ memberCount: 3, exclusiveContentIds: [], sharedCount: 3, exclusiveWithTasksCount: 0 }) },
      [`POST ${DELETE_PATH}`]: { body: { trashedIds: [], cancelledTaskCount: 0 } },
    });
    render();
    await opened();
    expect(within(dialog()).queryAllByRole("radio")).toEqual([]);
    expect(dialog().textContent).toContain("只删除合集本身，其中的内容仍保留在「全部内容」里。");
    expect(screen.queryByTestId("delete-collection-task-note")).toBeNull();
    expect(confirmButton().textContent).toBe("删除合集");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes(calls)[0]?.body).toEqual({ contents: "keep", cancelTasks: false });
  });

  it("still says the collection's own summary is running in the plain confirmation, and cancels it", async () => {
    const { calls } = mockApi({
      [`GET ${PLAN_PATH}`]: { body: plan({ memberCount: 1, exclusiveContentIds: [], sharedCount: 1, exclusiveWithTasksCount: 0, collectionTaskCount: 1 }) },
      [`POST ${DELETE_PATH}`]: { body: { trashedIds: [], cancelledTaskCount: 1 } },
    });
    render();
    await opened();
    expect(screen.getByTestId("delete-collection-task-note").textContent).toContain("这个合集的归纳正在进行，删除前会先取消。");
    expect(confirmButton().textContent).toBe("取消任务并删除合集");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes(calls)[0]?.body).toEqual({ contents: "keep", cancelTasks: true });
  });

  it("mentions trashed members in the plain confirmation: restoring them does not bring them back here", async () => {
    mockApi({ [`GET ${PLAN_PATH}`]: { body: plan({ memberCount: 0, exclusiveContentIds: [], sharedCount: 0, trashedMemberCount: 2, exclusiveWithTasksCount: 0 }) } });
    render();
    await opened();
    expect(screen.getByTestId("delete-collection-irreversible").textContent).toContain("从回收站恢复的内容不会回到这个合集");
  });

  it("disables deleting the members while another collection's summary froze some, and says which", async () => {
    const { calls } = mockApi({
      [`GET ${PLAN_PATH}`]: {
        body: plan({ exclusiveWithTasksCount: 0, blocked: [{ contentId: "c2", title: "第二讲", collections: [{ id: "k9", name: "进阶" }] }] }),
      },
      [`POST ${DELETE_PATH}`]: { body: { trashedIds: [], cancelledTaskCount: 0 } },
    });
    render();
    await opened();
    expect(radio("删除合集和其中的 5 项内容").disabled).toBe(true);
    expect(radio("删除合集和其中的 5 项内容").checked).toBe(false);
    expect(radio("只删除合集").checked).toBe(true);
    const note = screen.getByTestId("delete-collection-blocked");
    expect(note.textContent).toBe("其中 1 项正在被合集「进阶」的归纳使用，归纳结束前只能删除合集本身。");
    expect(radio("删除合集和其中的 5 项内容").getAttribute("aria-describedby")).toContain(note.id);
    expect(confirmButton().textContent).toBe("删除合集");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes(calls)[0]?.body).toEqual({ contents: "keep", cancelTasks: false });
  });

  it("stays open when the members changed after Tasks were cancelled, says what happened and reads the plan again", async () => {
    let reads = 0;
    const { calls } = mockApi({
      [`GET ${PLAN_PATH}`]: () => {
        reads += 1;
        return { body: reads === 1 ? plan() : plan({ exclusiveContentIds: ["c1", "c2", "c3", "c4"], exclusiveWithTasksCount: 0 }) };
      },
      [`POST ${DELETE_PATH}`]: conflict("conflict.collection_members_changed", { cancelledTaskCount: 3 }),
    });
    render();
    await opened();
    fireEvent.click(confirmButton());
    const notice = await screen.findByTestId("delete-collection-members-changed");
    expect(notice.textContent).toBe("合集和内容都没有删除，但已取消 3 个任务。删除范围有变化，请重新确认");
    expect(notice.getAttribute("role")).toBe("alert");
    await waitFor(() => expect(confirmButton().textContent).toBe("删除合集和 4 项内容"));
    expect(planReads(calls)).toBe(2);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/library");
  });

  it("reuses the Idempotency-Key when retrying after a network failure, and starts a new one after an answer", async () => {
    let attempt = 0;
    const { calls } = mockApi({
      [`GET ${PLAN_PATH}`]: { body: plan() },
      [`POST ${DELETE_PATH}`]: () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("network down");
        if (attempt === 2) return conflict("conflict.tasks_unfinished");
        return { body: { trashedIds: ["c1", "c2", "c3", "c4", "c5"], cancelledTaskCount: 3 } };
      },
    });
    render();
    await opened();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deletes(calls)).toHaveLength(1));
    await opened();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deletes(calls)).toHaveLength(2));
    await opened();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [first, retry, after] = deletes(calls).map((call) => call.headers["idempotency-key"]);
    expect(retry).toBe(first);
    expect(after).not.toBe(first);
    expect(deletes(calls).map((call) => call.body)).toEqual(Array.from({ length: 3 }, () => ({ contents: "exclusive", cancelTasks: true, expectedContentIds: ["c1", "c2", "c3", "c4", "c5"] })));
  });

  it("reports the result in a toast that leaves on its own, with a way to the trash", async () => {
    mockApi({
      [`GET ${PLAN_PATH}`]: { body: plan() },
      [`POST ${DELETE_PATH}`]: { body: { trashedIds: ["c1", "c2", "c3", "c4", "c5"], cancelledTaskCount: 3 } },
    });
    render();
    await opened();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    fireEvent.click(confirmButton());
    const toast = await screen.findByTestId("toast");
    expect(toast.textContent).toContain("已删除合集「Stanford CS193T」，5 项内容移入回收站；已取消 3 个任务");
    fireEvent.click(within(toast).getByTestId("toast-action"));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/trash"));
  });

  it("lets the result toast go after the standard delay", async () => {
    mockApi({
      [`GET ${PLAN_PATH}`]: { body: plan() },
      [`POST ${DELETE_PATH}`]: { body: { trashedIds: ["c1"], cancelledTaskCount: 0 } },
    });
    render();
    await opened();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    fireEvent.click(confirmButton());
    await screen.findByTestId("toast");
    await act(async () => void (await vi.advanceTimersByTimeAsync(TOAST_DISMISS_MS + 1)));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("leaves the collection's page once it is gone", async () => {
    mockApi({ [`GET ${PLAN_PATH}`]: { body: plan() }, [`POST ${DELETE_PATH}`]: { body: { trashedIds: ["c1"], cancelledTaskCount: 0 } } });
    render("/collections/k1");
    await opened();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/collections"));
  });

  it("leaves a content page whose Content went to the trash with the collection", async () => {
    mockApi({ [`GET ${PLAN_PATH}`]: { body: plan() }, [`POST ${DELETE_PATH}`]: { body: { trashedIds: ["c1", "c2"], cancelledTaskCount: 0 } } });
    render("/contents/c2");
    await opened();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/library"));
  });

  it("shows a failed plan with a retry, and no confirm until it is read", async () => {
    let reads = 0;
    mockApi({
      [`GET ${PLAN_PATH}`]: () => {
        reads += 1;
        return reads === 1 ? { status: 500, body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "读取失败" } } } : { body: plan() };
      },
    });
    render();
    expect((await screen.findByTestId("delete-collection-plan-error")).textContent).toContain("读取失败");
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(screen.getByTestId("delete-collection-plan-retry"));
    await opened();
    expect(confirmButton().textContent).toBe("取消任务并删除合集和 5 项内容");
  });
});
