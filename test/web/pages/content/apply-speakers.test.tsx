import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SpeakerDto } from "../../../../src/shared/dto/speaker.ts";
import { revision, segment } from "../../../fixtures/web/content-data.ts";
import { editorRoutes, mockApi, puts, renderSpeakerEditor, SPEAKER_A, SPEAKER_B } from "../../../fixtures/web/speaker-editor.tsx";

const X1: SpeakerDto = { id: "spk-x1", ordinal: 3, colorIndex: 2, used: true };
const X2: SpeakerDto = { id: "spk-x2", ordinal: 4, colorIndex: 3, used: true };

/** The current version: five sentences, A A B B B. */
function target() {
  return ["spk-a", "spk-a", "spk-b", "spk-b", "spk-b"].map((speakerId, index) => segment(`d${index + 1}`, index, index * 4_000, index * 4_000 + 4_000, `第${index + 1}句正文。`, { speakerId }));
}

/** A newer recognition: x1 x2, then both inside d3, then x2 over d4, nobody over d5. */
function recognition() {
  const piece = (id: string, startMs: number, endMs: number, speakerId: string) => segment(id, 0, startMs, endMs, id, { speakerId, revisionId: "r2" });
  return [piece("x-1", 0, 4_000, "spk-x1"), piece("x-2", 4_000, 8_000, "spk-x2"), piece("x-3", 8_000, 10_000, "spk-x1"), piece("x-4", 10_000, 12_000, "spk-x2"), piece("x-5", 12_000, 16_000, "spk-x2")];
}

function routes(source = recognition()) {
  return {
    ...editorRoutes(target(), [SPEAKER_A, SPEAKER_B, X1, X2]),
    "GET /api/contents/c1/transcript/revisions": {
      body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), revision("r2", { kind: "asr", createdAt: 5_000 })] },
    },
    "GET /api/transcript/revisions/r2/segments": { body: { revision: revision("r2", { kind: "asr" }), items: source } },
  };
}

const leadNames = () => screen.getAllByTestId("speaker-lead").map((lead) => lead.getAttribute("aria-label"));

async function openDialog() {
  await screen.findByDisplayValue("第1句正文。");
  fireEvent.click(screen.getByTestId("speaker-panel-toggle"));
  fireEvent.click(await screen.findByTestId("speaker-panel-apply"));
  return screen.findByTestId("apply-speakers");
}

describe("applying speakers from another transcript", () => {
  it("previews the match, maps identities, writes one undoable batch and filters to what needs review", async () => {
    const { calls } = mockApi(routes());
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getAllByTestId("apply-mapping-row")).toHaveLength(2));
    expect((within(dialog).getByTestId("apply-source") as HTMLSelectElement).value).toBe("r2");
    // x1 stands for the existing A, x2 stays a speaker of its own.
    const maps = within(dialog).getAllByTestId("apply-map") as HTMLSelectElement[];
    expect(Array.from(maps[1]?.options ?? []).map((option) => option.textContent)).toEqual(["作为新发言人", "陈明", "林雪", "不指定（未分配）"]);
    fireEvent.change(maps[0] as HTMLSelectElement, { target: { value: "spk-a" } });
    // d1 and d2 auto (x1 → A, x2 → X2), d3 split between x1 and x2 → review, d4 auto (X2), d5 nobody.
    expect(within(dialog).getByTestId("apply-summary").textContent).toBe("自动匹配 3 · 需确认 1 · 未分配 1");
    expect(within(dialog).queryByTestId("apply-low-coverage")).toBeNull();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    fireEvent.click(within(dialog).getByTestId("apply-confirm"));
    await waitFor(() => expect(screen.queryByTestId("apply-speakers")).toBeNull());
    expect(screen.getByTestId("apply-result").textContent).toContain("自动匹配 3 · 需确认 1 · 未分配 1");
    // Filtered to 需确认: only the sentence waiting for confirmation is shown, none is dropped.
    expect(screen.getByTestId("speaker-filter-bar").textContent).toContain("1 / 5");
    expect(screen.getAllByTestId("speaker-lead")).toHaveLength(1);
    expect(screen.getByTestId("draft-review-count").textContent).toBe("需确认 1");

    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    expect(puts(calls)[0]?.segments.map((item) => [item["speakerId"], item["speakerReview"] ?? null])).toEqual([
      ["spk-a", "auto"],
      ["spk-x2", "auto"],
      ["spk-a", "needs_review"],
      ["spk-x2", "auto"],
      [null, null],
    ]);
    // Texts and timing are untouched.
    expect(puts(calls)[0]?.segments.map((item) => item["text"])).toEqual(target().map((item) => item.text));

    // One undo takes the whole application back, and the filters with it.
    fireEvent.click(screen.getByTestId("editor-undo"));
    await waitFor(() => expect(screen.queryByTestId("speaker-filter-bar")).toBeNull());
    expect(screen.queryByTestId("apply-result")).toBeNull();
    expect(leadNames()).toEqual(["发言人：陈明", "发言人：陈明", "发言人：林雪", "发言人：林雪", "发言人：林雪"]);
  });

  it("warns when the two timelines hardly overlap", async () => {
    mockApi(routes([segment("x-1", 0, 0, 1_000, "x", { speakerId: "spk-x1", revisionId: "r2" })]));
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByTestId("apply-low-coverage")).toBeTruthy());
    expect(within(dialog).getByTestId("apply-low-coverage").textContent).toContain("20%");
  });

  it("opens on mount with the given source preselected", async () => {
    mockApi(routes());
    renderSpeakerEditor({ applySpeakersFrom: "r2" });
    const dialog = await screen.findByTestId("apply-speakers");
    await waitFor(() => expect((within(dialog).getByTestId("apply-source") as HTMLSelectElement).value).toBe("r2"));
    expect(within(dialog).getByTestId("apply-summary")).toBeTruthy();
  });

  it("says so when the chosen transcript has no speakers, and when there is no other transcript", async () => {
    mockApi({
      ...routes(),
      "GET /api/transcript/revisions/r2/segments": { body: { revision: revision("r2", { kind: "asr" }), items: [segment("x-1", 0, 0, 1_000, "x", { revisionId: "r2" })] } },
    });
    renderSpeakerEditor();
    const dialog = await openDialog();
    expect(await within(dialog).findByTestId("apply-no-speakers")).toBeTruthy();
    expect((within(dialog).getByTestId("apply-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers nothing when the draft's own version is the only one", async () => {
    mockApi({ ...routes(), "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1")] } } });
    renderSpeakerEditor();
    const dialog = await openDialog();
    expect(await within(dialog).findByTestId("apply-none")).toBeTruthy();
    expect((within(dialog).getByTestId("apply-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the versions from their metadata and reads the sentences of the chosen one only", async () => {
    const quiet = revision("r3", { kind: "asr", createdAt: 4_000, generation: { kind: "asr", diarization: { status: "off" } } });
    const found = revision("r4", { kind: "asr", createdAt: 3_000, generation: { kind: "asr", diarization: { status: "applied" } } });
    const plain = revision("r5", { kind: "asr", createdAt: 9_000 });
    const { calls } = mockApi({
      ...routes(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), revision("r2", { kind: "asr", createdAt: 5_000 }), quiet, found, plain] } },
      "GET /api/transcript/revisions/r4/segments": { body: { revision: found, items: recognition() } },
    });
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getAllByTestId("apply-mapping-row")).toHaveLength(2));
    const options = Array.from((within(dialog).getByTestId("apply-source") as HTMLSelectElement).options);
    // The recognition that found speakers leads; the one that found none is not offered.
    expect(options.map((option) => option.value)).toEqual(["r4", "r5", "r2"]);
    expect(options[0]?.textContent).toContain("识别了发言人");
    const segmentReads = () => calls.filter((call) => call.path.includes("/segments") && call.path.startsWith("/api/transcript/revisions/r")).map((call) => call.path.split("/")[4]);
    expect(segmentReads().filter((id) => id !== "r1")).toEqual(["r4"]);
    fireEvent.change(within(dialog).getByTestId("apply-source"), { target: { value: "r2" } });
    await waitFor(() => expect(segmentReads().filter((id) => id !== "r1")).toEqual(["r4", "r2"]));
  });

  it("states what the draft holds when every source speaker is mapped to nobody", async () => {
    const { calls } = mockApi(routes());
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getAllByTestId("apply-map")).toHaveLength(2));
    for (const select of within(dialog).getAllByTestId("apply-map")) fireEvent.change(select, { target: { value: "" } });
    expect(within(dialog).getByTestId("apply-summary").textContent).toBe("自动匹配 0 · 需确认 0 · 未分配 5");
    fireEvent.click(within(dialog).getByTestId("apply-confirm"));
    await waitFor(() => expect(screen.queryByTestId("apply-speakers")).toBeNull());
    expect(screen.getByTestId("apply-result").textContent).toContain("自动匹配 0 · 需确认 0 · 未分配 5");
    // Nothing needs confirming, so the draft is not filtered.
    expect(screen.queryByTestId("speaker-filter-bar")).toBeNull();
    expect(screen.queryByTestId("draft-review-count")).toBeNull();
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    expect(puts(calls)[0]?.segments.map((item) => [item["speakerId"], item["speakerReview"] ?? null])).toEqual(Array(5).fill([null, null]));
  });

  it("splits a sentence at the recognized change, giving the right half the next speaker", async () => {
    const { calls } = mockApi(routes());
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getAllByTestId("apply-map")).toHaveLength(2));
    fireEvent.change(within(dialog).getAllByTestId("apply-map")[0] as HTMLSelectElement, { target: { value: "spk-a" } });
    fireEvent.click(within(dialog).getByTestId("apply-confirm"));
    const input = (await screen.findByDisplayValue("第3句正文。")) as HTMLTextAreaElement;
    fireEvent.focus(input);
    input.setSelectionRange(3, 3);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.getByTestId("split-source").textContent).toBe("依据识别");
    expect((screen.getByTestId("split-time") as HTMLInputElement).value).toBe("10000");
    fireEvent.click(screen.getByTestId("split-button"));
    await waitFor(() => expect(puts(calls).at(-1)?.segments).toHaveLength(6), { timeout: 3000 });
    const saved = puts(calls).at(-1)?.segments ?? [];
    expect(saved[2]).toMatchObject({ speakerId: "spk-a", endMs: 10_000, sourceSegmentIds: ["d3"] });
    expect(saved[3]).toMatchObject({ speakerId: "spk-x2", startMs: 10_000, endMs: 12_000, sourceSegmentIds: ["d3"] });
    // Neither speaker was picked in the split itself, so both halves still wait for confirmation.
    expect(saved[2]).toMatchObject({ speakerReview: "needs_review" });
    expect(saved[3]).toMatchObject({ speakerReview: "needs_review" });
  });

  it("clears the review mark of only the half whose speaker is chosen in the split", async () => {
    const { calls } = mockApi(routes());
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getAllByTestId("apply-map")).toHaveLength(2));
    fireEvent.change(within(dialog).getAllByTestId("apply-map")[0] as HTMLSelectElement, { target: { value: "spk-a" } });
    fireEvent.click(within(dialog).getByTestId("apply-confirm"));
    const input = (await screen.findByDisplayValue("第3句正文。")) as HTMLTextAreaElement;
    fireEvent.focus(input);
    input.setSelectionRange(3, 3);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.change(screen.getByTestId("split-speaker-right"), { target: { value: "spk-b" } });
    fireEvent.click(screen.getByTestId("split-button"));
    await waitFor(() => expect(puts(calls).at(-1)?.segments).toHaveLength(6), { timeout: 3000 });
    const saved = puts(calls).at(-1)?.segments ?? [];
    expect(saved[2]).toMatchObject({ speakerId: "spk-a", speakerReview: "needs_review" });
    expect(saved[3]).toMatchObject({ speakerId: "spk-b" });
    expect(saved[3]).not.toHaveProperty("speakerReview");
  });

  it("filters to what the application changed, and to one speaker", async () => {
    mockApi(routes());
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getAllByTestId("apply-map")).toHaveLength(2));
    fireEvent.change(within(dialog).getAllByTestId("apply-map")[0] as HTMLSelectElement, { target: { value: "spk-a" } });
    fireEvent.click(within(dialog).getByTestId("apply-confirm"));
    await screen.findByTestId("apply-result");
    fireEvent.keyDown(screen.getByTestId("speaker-filter"), { key: "Enter" });
    const menu = await screen.findByTestId("speaker-filter-menu");
    // d2 (B→X2 would be A→X2), d3 (B→A), d4 (B→X2) and d5 (B→nobody) changed; d1 stayed.
    expect(within(menu).getByTestId("speaker-filter-changed").textContent).toContain("4");
    fireEvent.click(within(menu).getByTestId("speaker-filter-changed"));
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")).toHaveLength(4));
    fireEvent.click(screen.getByTestId("speaker-filter-clear"));
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead")).toHaveLength(5));
  });

  it("does not keep offering the recognizer's change point after the editor is reopened", async () => {
    let stored: unknown;
    let version = 1;
    const { calls } = mockApi({
      ...routes(),
      "GET /api/contents/c1/transcript/draft": () => (stored === undefined ? { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } } : { body: { id: "d1", contentId: "c1", baseRevisionId: "r1", version, segments: stored, updatedAt: 1 } }),
      "PUT /api/contents/c1/transcript/draft": (call) => {
        stored = (call.body as { segments: unknown }).segments;
        version += 1;
        return { body: { id: "d1", contentId: "c1", ...(call.body as object), version, updatedAt: 1 } };
      },
    });
    renderSpeakerEditor();
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getAllByTestId("apply-map")).toHaveLength(2));
    fireEvent.click(within(dialog).getByTestId("apply-confirm"));
    const caretIn = async () => {
      const input = (await screen.findByDisplayValue("第3句正文。")) as HTMLTextAreaElement;
      fireEvent.focus(input);
      input.setSelectionRange(3, 3);
      act(() => {
        document.dispatchEvent(new Event("selectionchange"));
      });
    };
    await caretIn();
    expect(screen.getByTestId("split-source").textContent).toBe("依据识别");
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    cleanup();
    renderSpeakerEditor();
    // The review mark survived the reload; the change point, kept in memory only, did not.
    await waitFor(() => expect(screen.getAllByTestId("speaker-lead-review")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("draft-review-count"));
    await caretIn();
    expect(screen.getByTestId("split-source").textContent).toBe("估算");
  });
});
