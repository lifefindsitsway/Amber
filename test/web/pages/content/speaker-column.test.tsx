import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { segment } from "../../../fixtures/web/content-data.ts";
import { editorRoutes, mockApi, puts, renderSpeakerEditor, SPEAKER_A, SPEAKER_B, SPEAKER_C, talk } from "../../../fixtures/web/speaker-editor.tsx";

// Every render of a speaker column asks for its speaker's label, which makes renders countable.
const rendered = vi.hoisted(() => ({ labels: 0 }));
vi.mock("../../../../src/web/pages/content/speakers/speaker-data.ts", async (original) => {
  const actual = await original<typeof import("../../../../src/web/pages/content/speakers/speaker-data.ts")>();
  return {
    ...actual,
    speakerLabel: (...args: Parameters<typeof actual.speakerLabel>) => {
      rendered.labels += 1;
      return actual.speakerLabel(...args);
    },
  };
});

const leads = () => screen.getAllByTestId("speaker-lead");
const lastSaved = (calls: Parameters<typeof puts>[0]) => puts(calls).at(-1)?.segments.map((segment) => segment["speakerId"]);

async function ready() {
  await screen.findByDisplayValue("第1句内容。");
  await waitFor(() => expect(leads()).toHaveLength(6));
}

describe("the speaker column", () => {
  it("names the speaker on the first sentence of a run and mutes the follow-ups; unassigned shows a dashed avatar", async () => {
    const base = talk();
    base[5] = { ...base[5], speakerId: undefined } as never;
    mockApi(editorRoutes(base));
    renderSpeakerEditor();
    await ready();
    expect(screen.getAllByTestId("speaker-lead-name").map((node) => node.textContent)).toEqual(["陈明", "林雪", "未分配"]);
    // The full avatar leads a stretch; a follow-up is the lighter muted one, drawn without a photo lookup.
    const avatars = leads().map((lead) => within(lead).queryByTestId("speaker-avatar")?.getAttribute("data-kind") ?? null);
    expect(avatars).toEqual(["monogram", null, "monogram", null, null, "unassigned"]);
    // Follow-up sentences carry the same speaker without repeating the name.
    expect(leads()[1]?.getAttribute("aria-label")).toBe("发言人：陈明");
    expect(within(leads()[1] as HTMLElement).queryByTestId("speaker-lead-name")).toBeNull();
    // The muted follow-up still shows its speaker's letter at a readable size, with an edge on the page.
    const followUp = within(leads()[1] as HTMLElement).getByTestId("speaker-follow-up-avatar");
    expect(followUp.textContent).toBe("陈");
    expect(followUp.style.width).toBe("20px");
    expect(followUp.style.fontSize).toBe("10px");
    expect(followUp.style.boxShadow).toContain("inset");
  });

  it("keeps one speaker column in the tab order", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    await ready();
    expect(leads().filter((lead) => lead.tabIndex === 0)).toHaveLength(1);
  });

  it("opens a menu that states the scope: one sentence, a run, or the selection", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    await ready();
    fireEvent.keyDown(leads()[1] as HTMLElement, { key: "Enter" });
    expect((await screen.findByTestId("speaker-menu-scope")).textContent).toBe("本句");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("speaker-menu")).toBeNull());

    // Even the first sentence of a run starts with itself; the whole turn is asked for in the menu.
    fireEvent.keyDown(leads()[0] as HTMLElement, { key: "Enter" });
    expect((await screen.findByTestId("speaker-menu-scope")).textContent).toBe("本句");
    expect(screen.getByTestId("speaker-menu-scope-toggle").textContent).toBe("改整轮（2 句）");
    fireEvent.click(screen.getByTestId("speaker-menu-scope-toggle"));
    await waitFor(() => expect(screen.getByTestId("speaker-menu-scope").textContent).toBe("本轮 2 句"));
    expect(screen.getByTestId("speaker-menu-scope-toggle").textContent).toBe("只改本句");
  });

  it("assigns the run from the menu as one undoable step, numbering the speakers in use", async () => {
    const { calls } = mockApi(editorRoutes());
    renderSpeakerEditor();
    await ready();
    fireEvent.keyDown(leads()[2] as HTMLElement, { key: "Enter" });
    const menu = await screen.findByTestId("speaker-menu");
    expect(within(menu).getByTestId("speaker-menu-scope").textContent).toBe("本句");
    fireEvent.click(within(menu).getByTestId("speaker-menu-scope-toggle"));
    await waitFor(() => expect(within(menu).getByTestId("speaker-menu-scope").textContent).toBe("本轮 3 句"));
    // Only the speakers the draft uses are numbered; the unused one is behind 「更多发言人」.
    expect(within(menu).getByTestId(`speaker-menu-item-${SPEAKER_A.id}`).textContent).toContain("1");
    expect(within(menu).getByTestId(`speaker-menu-item-${SPEAKER_B.id}`).textContent).toContain("2");
    expect(within(menu).queryByTestId(`speaker-menu-item-${SPEAKER_C.id}`)).toBeNull();
    fireEvent.click(within(menu).getByTestId(`speaker-menu-item-${SPEAKER_A.id}`));
    await waitFor(() => expect(leads().map((lead) => lead.getAttribute("aria-label"))).toEqual(Array(6).fill("发言人：陈明")));
    await waitFor(() => expect(lastSaved(calls)).toEqual(Array(6).fill("spk-a")), { timeout: 3000 });
    fireEvent.click(screen.getByTestId("editor-undo"));
    await waitFor(() => expect(leads().map((lead) => lead.getAttribute("aria-label"))).toEqual(["发言人：陈明", "发言人：陈明", "发言人：林雪", "发言人：林雪", "发言人：林雪", "发言人：陈明"]));
    expect(screen.getByTestId("editor-undo").getAttribute("title") ?? "").toBeDefined();
  });

  it("assigns by digit keys only while focus is in the column, 0 unassigns, and 9 beyond the list does nothing", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    await ready();
    const lead = leads()[3] as HTMLElement;
    lead.focus();
    fireEvent.keyDown(lead, { key: "9" });
    expect(leads().map((item) => item.getAttribute("aria-label"))).toContain("发言人：林雪");
    // Mid-run: a single sentence (it does not start a run), so only this one changes.
    fireEvent.keyDown(lead, { key: "1" });
    await waitFor(() => expect(leads()[3]?.getAttribute("aria-label")).toBe("发言人：陈明"));
    expect(leads()[2]?.getAttribute("aria-label")).toBe("发言人：林雪");
    // Focus stays on the column the key was pressed in.
    expect(document.activeElement).toBe(leads()[3]);
    fireEvent.keyDown(leads()[3] as HTMLElement, { key: "0" });
    await waitFor(() => expect(leads()[3]?.getAttribute("aria-label")).toBe("发言人：未分配"));
    // A digit typed in the sentence's own text is text, not a command.
    const input = screen.getByDisplayValue("第1句内容。");
    fireEvent.keyDown(input, { key: "2" });
    expect(leads()[0]?.getAttribute("aria-label")).toBe("发言人：陈明");
  });

  it("extends the selection with Shift+arrows and Shift+click, and applies to the selection", async () => {
    const { calls } = mockApi(editorRoutes());
    renderSpeakerEditor();
    await ready();
    const first = leads()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("speaker-selection-bar").textContent).toContain("已选 3 句"));
    expect(leads().filter((lead) => lead.dataset["selected"] === "true")).toHaveLength(3);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp", shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("speaker-selection-bar").textContent).toContain("已选 2 句"));

    fireEvent.pointerDown(leads()[4] as HTMLElement, { button: 0, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("speaker-selection-bar").textContent).toContain("已选 5 句"));

    fireEvent.keyDown(leads()[4] as HTMLElement, { key: "Enter" });
    expect((await screen.findByTestId("speaker-menu-scope")).textContent).toBe("所选 5 句");
    fireEvent.click(screen.getByTestId("speaker-menu-unassign"));
    await waitFor(() => expect(lastSaved(calls)).toEqual([null, null, null, null, null, "spk-a"]), { timeout: 3000 });
  });

  it("drops the selection when the filter changes, so it never names sentences out of sight", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    await ready();
    const first = leads()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    await screen.findByTestId("speaker-selection-bar");
    fireEvent.keyDown(screen.getByTestId("speaker-filter"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("speaker-filter-speaker-spk-b"));
    await waitFor(() => expect(screen.queryByTestId("speaker-selection-bar")).toBeNull());
  });

  it("registers no global shortcut: digits outside the column leave the draft alone", async () => {
    mockApi(editorRoutes());
    renderSpeakerEditor();
    await ready();
    fireEvent.keyDown(document.body, { key: "0" });
    fireEvent.keyDown(window, { key: "1" });
    expect(leads().map((lead) => lead.getAttribute("aria-label"))).toEqual(["发言人：陈明", "发言人：陈明", "发言人：林雪", "发言人：林雪", "发言人：林雪", "发言人：陈明"]);
  });

  it("creates a new speaker and gives it to the scope", async () => {
    const { calls } = mockApi({
      ...editorRoutes(),
      "POST /api/contents/c1/speakers": { status: 201, body: { id: "spk-new", ordinal: 4, colorIndex: 3, used: false } },
    });
    renderSpeakerEditor();
    await ready();
    fireEvent.keyDown(leads()[5] as HTMLElement, { key: "Enter" });
    fireEvent.click(await screen.findByTestId("speaker-menu-new"));
    await waitFor(() => expect(leads()[5]?.getAttribute("aria-label")).toBe("发言人：发言人 4"));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/contents/c1/speakers"]);
    await waitFor(() => expect(lastSaved(calls)?.[5]).toBe("spk-new"), { timeout: 3000 });
  });

  it("clears the review mark of a sentence the user assigns", async () => {
    const draft = talk().map((segment) => ({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id], speakerId: "spk-a", speakerReview: segment.id === "t2" ? "needs_review" : "auto" }));
    const { calls } = mockApi({
      ...editorRoutes(),
      "GET /api/contents/c1/transcript/draft": { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version: 4, segments: draft, updatedAt: 1 } },
    });
    renderSpeakerEditor();
    await ready();
    expect(screen.getAllByTestId("speaker-lead-review")).toHaveLength(1);
    fireEvent.keyDown(leads()[1] as HTMLElement, { key: "2" });
    await waitFor(() => expect(screen.queryAllByTestId("speaker-lead-review")).toHaveLength(0));
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    const saved = puts(calls)[0]?.segments ?? [];
    expect(saved[1]).toMatchObject({ id: "t2", speakerId: "spk-b" });
    expect(saved[1]).not.toHaveProperty("speakerReview");
    // The untouched sentences keep their marks.
    expect(saved[0]).toMatchObject({ speakerReview: "auto" });
  });

  it("does not render the other columns again when a sentence's text is typed in a large draft", async () => {
    const base = Array.from({ length: 400 }, (_, i) => segment(`n${i}`, i, i * 1_000, i * 1_000 + 900, `第${i}句。`, { speakerId: i % 5 < 2 ? "spk-a" : "spk-b" }));
    mockApi(editorRoutes(base));
    renderSpeakerEditor();
    const input = await screen.findByDisplayValue("第7句。");
    await waitFor(() => expect(leads()).toHaveLength(400));
    const before = rendered.labels;
    expect(before).toBeGreaterThanOrEqual(400);
    for (const text of ["第7句。a", "第7句。ab", "第7句。abc"]) fireEvent.change(input, { target: { value: text } });
    expect(rendered.labels).toBe(before);
  });
});

/** Six sentences of one speaker; the second, third and fifth are waiting for review. */
function reviewDraft() {
  return {
    ...editorRoutes(),
    "GET /api/contents/c1/transcript/draft": {
      body: {
        id: "d1",
        contentId: "c1",
        baseRevisionId: "r1",
        version: 4,
        updatedAt: 1,
        segments: talk().map((item, index) => ({
          id: item.id,
          startMs: item.startMs,
          endMs: item.endMs,
          text: item.text,
          sourceSegmentIds: [item.id],
          speakerId: "spk-a",
          speakerReview: [1, 2, 4].includes(index) ? "needs_review" : "auto",
        })),
      },
    },
  };
}

async function reviewOnly() {
  await ready();
  fireEvent.click(screen.getByTestId("draft-review-count"));
  await waitFor(() => expect(leads()).toHaveLength(3));
}

describe("the speaker column under a filter", () => {
  it("applies a digit to the one sentence, leaving hidden sentences exactly as they were", async () => {
    const { calls } = mockApi(reviewDraft());
    renderSpeakerEditor();
    await reviewOnly();
    // The first sentence on screen is the first of a stretch, but a digit never means the turn.
    fireEvent.keyDown(leads()[0] as HTMLElement, { key: "2" });
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    const saved = puts(calls)[0]?.segments ?? [];
    expect(saved.map((item) => item["speakerId"])).toEqual(["spk-a", "spk-b", "spk-a", "spk-a", "spk-a", "spk-a"]);
    expect(saved.map((item) => item["speakerReview"])).toEqual(["auto", undefined, "needs_review", "auto", "needs_review", "auto"]);
  });

  it("offers the turn in the menu as the neighbours on screen only, and says how many", async () => {
    const { calls } = mockApi(reviewDraft());
    renderSpeakerEditor();
    await reviewOnly();
    fireEvent.keyDown(leads()[0] as HTMLElement, { key: "Enter" });
    // Sentences 2 and 3 are next to each other on screen; 5 is cut off from them by a hidden one.
    expect(await screen.findByTestId("speaker-menu-scope-toggle")).toBeTruthy();
    expect(screen.getByTestId("speaker-menu-scope-toggle").textContent).toBe("改整轮（2 句）");
    fireEvent.click(screen.getByTestId("speaker-menu-scope-toggle"));
    await waitFor(() => expect(screen.getByTestId("speaker-menu-scope").textContent).toBe("本轮 2 句"));
    fireEvent.click(screen.getByTestId(`speaker-menu-item-${SPEAKER_B.id}`));
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    const saved = puts(calls)[0]?.segments ?? [];
    expect(saved.map((item) => item["speakerId"])).toEqual(["spk-a", "spk-b", "spk-b", "spk-a", "spk-a", "spk-a"]);
    expect(saved.map((item) => item["speakerReview"])).toEqual(["auto", undefined, undefined, "auto", "needs_review", "auto"]);
  });

  it("names the first sentence of each stretch on screen", async () => {
    mockApi(reviewDraft());
    renderSpeakerEditor();
    await reviewOnly();
    // 2 and 3 are one stretch, 5 begins another after the hidden sentence.
    expect(screen.getAllByTestId("speaker-lead-name")).toHaveLength(2);
    expect(within(leads()[1] as HTMLElement).queryByTestId("speaker-lead-name")).toBeNull();
    expect(within(leads()[2] as HTMLElement).queryByTestId("speaker-lead-name")).not.toBeNull();
  });

  it("applies a selection only to the sentences on screen", async () => {
    const { calls } = mockApi(reviewDraft());
    renderSpeakerEditor();
    await reviewOnly();
    const first = leads()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("speaker-selection-bar").textContent).toContain("已选 3 句"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "0" });
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    const saved = puts(calls)[0]?.segments ?? [];
    expect(saved.map((item) => item["speakerId"])).toEqual(["spk-a", null, null, "spk-a", null, "spk-a"]);
    expect(saved.map((item) => item["speakerReview"])).toEqual(["auto", undefined, undefined, "auto", undefined, "auto"]);
  });
});
