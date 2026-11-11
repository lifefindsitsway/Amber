import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { segment } from "../../../fixtures/web/content-data.ts";
import { editorRoutes, mockApi, puts, renderSpeakerEditor, SPEAKER_A, SPEAKER_B, SPEAKER_C } from "../../../fixtures/web/speaker-editor.tsx";

const names = () => screen.getAllByTestId("speaker-lead").map((lead) => lead.getAttribute("aria-label"));

async function openPanel() {
  await screen.findByDisplayValue("第1句内容。");
  fireEvent.click(screen.getByTestId("speaker-panel-toggle"));
  return screen.findByTestId("speaker-panel");
}

describe("the speaker panel", () => {
  it("lists the speakers in use with sentences and share of speaking time, and the standing note", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    const panel = await openPanel();
    const rows = within(panel).getAllByTestId("speaker-panel-row");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("陈明"), expect.stringContaining("林雪")]);
    expect(rows[0]?.textContent).toContain("3 句 · 约占 50% 时长");
    expect(within(panel).getByTestId("speaker-panel-note").textContent).toBe("AI 总结与对话暂不读取发言人");
    expect(screen.getByTestId("speaker-panel-toggle").textContent).toContain("2");
  });

  it("folds the unused speakers away until asked", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    const panel = await openPanel();
    expect(within(panel).queryByTestId("speaker-panel-others")).toBeNull();
    const toggle = within(panel).getByTestId("speaker-panel-others-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const others = within(panel).getByTestId("speaker-panel-others");
    expect(within(others).getAllByTestId("speaker-panel-row")).toHaveLength(1);
    expect(others.textContent).toContain(`发言人 ${SPEAKER_C.ordinal}`);
  });

  it("edits a speaker in a popover", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.click(within(panel).getAllByTestId("speaker-panel-edit")[0] as HTMLElement);
    expect(await screen.findByTestId("speaker-edit-form")).toBeTruthy();
    expect((screen.getByTestId("speaker-name-input") as HTMLInputElement).value).toBe("陈明");
  });

  it("merges one speaker into another in the draft only, and undoes it", async () => {
    const { calls } = mockApi(editorRoutes());
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
    mockApi({ ...editorRoutes(), "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [] } } });
    renderSpeakerEditor();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("speaker-panel-apply"));
    expect(await screen.findByTestId("apply-speakers")).toBeTruthy();
  });
});

describe("the filter", () => {
  it("shows one speaker's sentences with counts and clears back to all", async () => {
    mockApi(editorRoutes());
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
    const { calls } = mockApi({ ...editorRoutes(plain), "GET /api/contents/c1/speakers": { body: { items: [] } } });
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
