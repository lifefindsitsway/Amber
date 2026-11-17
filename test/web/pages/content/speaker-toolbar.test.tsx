import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SPEAKER_PANEL_UNUSED_VISIBLE } from "../../../../src/shared/defaults.ts";
import type { SpeakerDto } from "../../../../src/shared/dto/speaker.ts";
import { SpeakerPanel, type SpeakerUndoGuard } from "../../../../src/web/pages/content/speaker-toolbar.tsx";
import { segment } from "../../../fixtures/web/content-data.ts";
import { renderApp } from "../../../fixtures/web/render.tsx";
import { mockApi, puts, renderSpeakerEditor, SPEAKER_A, SPEAKER_B } from "../../../fixtures/web/speaker-editor.tsx";
import { creations, deletions, MANAGED, managedRoutes, SPEAKER_IN_USE } from "../../../fixtures/web/speaker-management.ts";

const names = () => screen.getAllByTestId("speaker-lead").map((lead) => lead.getAttribute("aria-label"));

/** The panel alone, over the managed speakers (the third one unused); `open` presses its toggle. */
function renderPanel(options: { undoGuard?: SpeakerUndoGuard; openSignal?: number; open?: boolean }) {
  let setSignal: (signal: number) => void = () => undefined;
  function Harness() {
    const [signal, set] = useState(options.openSignal);
    setSignal = set;
    return panel(signal);
  }
  const panel = (signal: number | undefined) => (
    <SpeakerPanel
      contentId="c1"
      segments={[]}
      resolved={[]}
      current={MANAGED.slice(0, 2)}
      others={MANAGED.slice(2)}
      disabled={false}
      columnShown
      onStartLabeling={() => undefined}
      onMerge={() => undefined}
      onApply={() => undefined}
      {...(options.undoGuard === undefined ? {} : { undoGuard: options.undoGuard })}
      {...(signal === undefined ? {} : { openSignal: signal })}
    />
  );
  renderApp(<Harness />);
  if (options.open !== false) fireEvent.click(screen.getByTestId("speaker-panel-toggle"));
  return { signal: (value: number) => act(() => setSignal(value)) };
}

async function openPanel() {
  await screen.findByDisplayValue("第1句内容。");
  fireEvent.click(screen.getByTestId("speaker-panel-toggle"));
  return screen.findByTestId("speaker-panel");
}

describe("the speaker panel", () => {
  it("lists the speakers in use and the unused ones in two counted groups, with no standing note", async () => {
    mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    expect(within(panel).getByRole("heading", { name: "发言人" })).toBeTruthy();
    expect(within(panel).getByText("本稿已使用 · 2")).toBeTruthy();
    expect(within(panel).getByText("本稿未使用 · 1")).toBeTruthy();
    const used = within(within(panel).getByTestId("speaker-panel-used")).getAllByTestId("speaker-panel-row");
    expect(used.map((row) => row.textContent)).toEqual([expect.stringContaining("陈明"), expect.stringContaining("林雪")]);
    expect(used[0]?.textContent).toContain("3 句 · 约占 50% 时长");
    // Speakers with sentences in the draft can be merged but never deleted.
    expect(within(used[0] as HTMLElement).getByTestId("speaker-panel-merge")).toBeTruthy();
    expect(within(panel).getByTestId("speaker-panel-used").querySelector('[data-testid="speaker-panel-delete"]')).toBeNull();
    const unused = within(within(panel).getByTestId("speaker-panel-unused")).getAllByTestId("speaker-panel-row");
    expect(unused[0]?.textContent).toContain("发言人 3");
    expect(unused[0]?.textContent).toContain("尚未分配句子");
    expect(within(unused[0] as HTMLElement).getByRole("button", { name: "删除发言人：发言人 3" })).toBeTruthy();
    expect(panel.textContent).not.toContain("AI 总结与对话暂不读取发言人");
    expect(screen.getByTestId("speaker-panel-toggle").textContent).toContain("2");
  });

  it("names the full name of a long one on hover while the row truncates it", async () => {
    const long = "一位名字非常非常非常非常非常非常非常长的嘉宾老师";
    mockApi(managedRoutes({ speakers: [...MANAGED.slice(0, 2), { ...(MANAGED[2] as SpeakerDto), name: long }] }).routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    const name = within(within(panel).getByTestId("speaker-panel-unused")).getByTestId("speaker-panel-name");
    expect(name.getAttribute("title")).toBe(long);
    expect(name.className).toContain("truncate");
  });

  it("explains, instead of offering deletion, a speaker only earlier versions refer to", async () => {
    mockApi(managedRoutes({ speakers: [...MANAGED.slice(0, 2), { ...(MANAGED[2] as SpeakerDto), used: true, referenced: true }] }).routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    const row = within(within(panel).getByTestId("speaker-panel-unused")).getByTestId("speaker-panel-row");
    expect(row.textContent).toContain("历史字幕版本仍在引用，无法删除");
    expect(within(row).queryByTestId("speaker-panel-delete")).toBeNull();
    // Still editable.
    expect(within(row).getByTestId("speaker-panel-edit")).toBeTruthy();
  });

  it("opens with the focus on 「新增」 and creates a named speaker on Enter, as confirmed", async () => {
    const { calls } = mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    const add = within(panel).getByTestId("speaker-panel-add");
    await waitFor(() => expect(document.activeElement).toBe(add));
    expect(add.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(add);
    const input = await within(panel).findByTestId("speaker-panel-add-input");
    expect(document.activeElement).toBe(input);
    expect(within(panel).getByText("留空则显示为「发言人 4」；填写的姓名视为已确认")).toBeTruthy();
    fireEvent.change(input, { target: { value: "  王教授 " } });
    // Enter that ends an input method's composition is not a submission.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(creations(calls)).toEqual([]);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(creations(calls)).toEqual([{ name: "王教授", nameConfirmed: true }]));
    await waitFor(() => expect(within(panel).getByText("本稿未使用 · 2")).toBeTruthy());
    expect(within(panel).queryByTestId("speaker-panel-add-input")).toBeNull();
    expect(within(panel).getByTestId("speaker-panel-status").textContent).toBe("已新增「王教授」");
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it("creates an unnamed speaker from a blank name with the button, once however often it is pressed", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { calls } = mockApi(managedRoutes().routes);
    // The first creation waits until released, so the form is seen while it is pending.
    const fetchStub = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if ((init.method ?? "GET") === "POST" && String(input) === "/api/contents/c1/speakers") await held;
      return fetchStub(input, init);
    });
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-panel-add"));
    const confirm = await within(panel).findByTestId("speaker-panel-add-confirm");
    fireEvent.click(confirm);
    await waitFor(() => expect((within(panel).getByTestId("speaker-panel-add-confirm") as HTMLButtonElement).disabled).toBe(true));
    expect(within(panel).getByTestId("speaker-panel-add-confirm").textContent).toContain("添加中");
    fireEvent.keyDown(within(panel).getByTestId("speaker-panel-add-input"), { key: "Enter" });
    release();
    await waitFor(() => expect(within(panel).getByText("本稿未使用 · 2")).toBeTruthy());
    expect(creations(calls)).toEqual([{}]);
    expect(within(panel).getByTestId("speaker-panel-status").textContent).toBe("已新增「发言人 4」");
  });

  it("creates nothing on Esc or when the field loses the focus", async () => {
    const { calls } = mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-panel-add"));
    const input = await within(panel).findByTestId("speaker-panel-add-input");
    fireEvent.change(input, { target: { value: "王教授" } });
    fireEvent.blur(input);
    expect(within(panel).getByTestId("speaker-panel-add-input")).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(within(panel).queryByTestId("speaker-panel-add-input")).toBeNull());
    // Esc closed the form, not the panel.
    expect(screen.getByTestId("speaker-panel")).toBe(panel);
    expect(creations(calls)).toEqual([]);
  });

  it("shows a failed creation under the field and keeps what was typed", async () => {
    const { routes } = managedRoutes();
    mockApi({ ...routes, "POST /api/contents/c1/speakers": { status: 400, body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "发言人已达上限" } } } });
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-panel-add"));
    const input = await within(panel).findByTestId("speaker-panel-add-input");
    fireEvent.change(input, { target: { value: "王教授" } });
    fireEvent.click(within(panel).getByTestId("speaker-panel-add-confirm"));
    expect((await within(panel).findByTestId("speaker-panel-add-error")).textContent).toContain("发言人已达上限");
    expect((within(panel).getByTestId("speaker-panel-add-input") as HTMLInputElement).value).toBe("王教授");
  });

  it("folds unused speakers beyond the visible number and unfolds on request", async () => {
    const extra = Array.from({ length: SPEAKER_PANEL_UNUSED_VISIBLE + 2 }, (_, index): SpeakerDto => ({ id: `spk-x${index}`, ordinal: 10 + index, colorIndex: 0, used: false, referenced: false }));
    mockApi(managedRoutes({ speakers: [...MANAGED.slice(0, 2), ...extra] }).routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    const list = () => within(within(panel).getByTestId("speaker-panel-unused")).getAllByTestId("speaker-panel-row");
    expect(within(panel).getByText(`本稿未使用 · ${extra.length}`)).toBeTruthy();
    expect(list()).toHaveLength(SPEAKER_PANEL_UNUSED_VISIBLE);
    const more = within(panel).getByTestId("speaker-panel-more");
    expect(more.textContent).toBe("再显示 2 位");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(list()).toHaveLength(extra.length);
    expect(more.textContent).toBe("收起");
  });

  it("deletes an unused speaker after an inline confirmation naming it, and says so", async () => {
    const { calls } = mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    const trash = within(panel).getByTestId("speaker-panel-delete");
    fireEvent.click(trash);
    const confirm = within(panel).getByTestId("speaker-panel-delete-confirm");
    expect(confirm.textContent).toContain("删除「发言人 3」？");
    expect(within(confirm).queryByTestId("speaker-panel-delete-undo")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(confirm).getByTestId("speaker-panel-delete-cancel")));
    // Cancelling gives the focus back to the trash button and deletes nothing.
    fireEvent.click(within(confirm).getByTestId("speaker-panel-delete-cancel"));
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByTestId("speaker-panel-delete")));
    expect(deletions(calls)).toEqual([]);
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete"));
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete-confirm-button"));
    await waitFor(() => expect(within(panel).queryByTestId("speaker-panel-unused")).toBeNull());
    expect(deletions(calls)).toEqual(["spk-c"]);
    expect(within(panel).getByTestId("speaker-panel-status").textContent).toBe("已删除「发言人 3」");
    // The list is read again after the deletion.
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.path === "/api/contents/c1/speakers").length).toBeGreaterThan(1));
  });

  it("warns when the undo history involves the speaker, and clears that history once deleted", async () => {
    const guard = { mentions: vi.fn((id: string) => id === "spk-c"), drop: vi.fn() };
    mockApi(managedRoutes().routes);
    renderPanel({ undoGuard: guard });
    const panel = await screen.findByTestId("speaker-panel");
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete"));
    expect(within(panel).getByTestId("speaker-panel-delete-undo").textContent).toBe("此前涉及 TA 的修改将不能撤销");
    expect(guard.drop).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete-confirm-button"));
    await waitFor(() => expect(guard.drop).toHaveBeenCalledWith("spk-c"));
  });

  it("explains a deletion the server refuses because something refers to the speaker, and reads the list again", async () => {
    const { calls } = mockApi(managedRoutes({ deleteReply: () => SPEAKER_IN_USE }).routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    const before = calls.filter((call) => call.method === "GET" && call.path === "/api/contents/c1/speakers").length;
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete"));
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete-confirm-button"));
    expect((await within(panel).findByTestId("speaker-panel-in-use")).textContent).toBe("TA 刚被某个版本或草稿引用，无法删除；名单已刷新");
    expect(within(panel).queryByTestId("speaker-panel-delete-confirm")).toBeNull();
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.path === "/api/contents/c1/speakers").length).toBeGreaterThan(before));
  });

  it("drops a speaker that is already gone from the list without an error", async () => {
    const { routes, list } = managedRoutes();
    mockApi(routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    list.splice(2, 1);
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete"));
    fireEvent.click(within(panel).getByTestId("speaker-panel-delete-confirm-button"));
    await waitFor(() => expect(within(panel).queryByTestId("speaker-panel-unused")).toBeNull());
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("opens when the open signal changes to a new value, not with the value it mounts with", async () => {
    mockApi(managedRoutes().routes);
    const { signal } = renderPanel({ openSignal: 3, open: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("speaker-panel")).toBeNull();
    signal(4);
    const panel = await screen.findByTestId("speaker-panel");
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByTestId("speaker-panel-add")));
  });

  it("edits a speaker in a popover", async () => {
    mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.click(within(panel).getAllByTestId("speaker-panel-edit")[0] as HTMLElement);
    expect(await screen.findByTestId("speaker-edit-form")).toBeTruthy();
    expect((screen.getByTestId("speaker-name-input") as HTMLInputElement).value).toBe("陈明");
  });

  it("merges one speaker into another in the draft only, and undoes it", async () => {
    const { calls } = mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.keyDown(within(panel).getAllByTestId("speaker-panel-merge")[1] as HTMLElement, { key: "Enter" });
    const menu = await screen.findByTestId("speaker-merge-menu");
    expect(within(menu).getByTestId(`speaker-merge-to-${SPEAKER_A.id}`)).toBeTruthy();
    expect(within(menu).queryByTestId(`speaker-merge-to-${SPEAKER_B.id}`)).toBeNull();
    fireEvent.click(within(menu).getByTestId(`speaker-merge-to-${SPEAKER_A.id}`));
    await waitFor(() => expect(names()).toEqual(Array(6).fill("发言人：陈明")));
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    expect(puts(calls)[0]?.segments.map((item) => item["speakerId"])).toEqual(Array(6).fill("spk-a"));
    // The speaker itself is untouched: nothing was sent to the speakers API.
    expect(calls.filter((call) => call.path.includes("/speakers") && call.method !== "GET")).toEqual([]);
    expect(screen.getByTestId("editor-undo").getAttribute("aria-label")).toBe("撤销：合并发言人");
    fireEvent.click(screen.getByTestId("editor-undo"));
    await waitFor(() => expect(names()).toEqual(["发言人：陈明", "发言人：陈明", "发言人：林雪", "发言人：林雪", "发言人：林雪", "发言人：陈明"]));
  });

  it("offers the way into applying speakers", async () => {
    mockApi({ ...managedRoutes().routes, "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [] } } });
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-panel-apply"));
    expect(await screen.findByTestId("apply-speakers")).toBeTruthy();
  });
});

describe("the filter", () => {
  it("shows one speaker's sentences with counts and clears back to all", async () => {
    mockApi(managedRoutes().routes);
    renderSpeakerEditor();
    await screen.findByDisplayValue("第1句内容。");
    fireEvent.keyDown(screen.getByTestId("speaker-filter"), { key: "Enter" });
    const menu = await screen.findByTestId("speaker-filter-menu");
    expect(within(menu).getByTestId("speaker-filter-all").textContent).toContain("6");
    expect(within(menu).getByTestId("speaker-filter-speaker-spk-b").textContent).toContain("3");
    // Nothing waits for review and nobody is unassigned: those entries are off.
    expect(within(menu).getByTestId("speaker-filter-review").getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).queryByTestId("speaker-filter-changed")).toBeNull();
    fireEvent.click(within(menu).getByTestId("speaker-filter-speaker-spk-b"));
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")).toHaveLength(3));
    expect(screen.getByTestId("speaker-filter-bar").textContent).toContain("林雪");
    // The state is written on the button, not only coloured or pressed.
    expect(screen.getByTestId("speaker-filter").textContent).toBe("筛选：林雪3");
    expect(screen.getByTestId("speaker-filter").hasAttribute("aria-pressed")).toBe(false);
    fireEvent.click(screen.getByTestId("speaker-filter-clear"));
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")).toHaveLength(6));
  });

  it("leaves the filter and the column out for a Content nobody was ever assigned in, until the user starts labelling", async () => {
    const plain = [segment("p1", 0, 0, 4_000, "没有发言人。"), segment("p2", 1, 4_000, 8_000, "也没有。")];
    const { calls } = mockApi(managedRoutes({ base: plain, speakers: [] }).routes);
    renderSpeakerEditor();
    await screen.findByDisplayValue("没有发言人。");
    expect(screen.queryByTestId("speaker-filter")).toBeNull();
    expect(screen.queryByTestId("speaker-lead")).toBeNull();
    fireEvent.click(screen.getByTestId("speaker-panel-toggle"));
    fireEvent.click(await screen.findByTestId("speaker-panel-start"));
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")).toHaveLength(2));
    expect(screen.getAllByTestId("speaker-lead-name")[0]?.textContent).toBe("未分配");
    // Starting changes nothing in the draft.
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
