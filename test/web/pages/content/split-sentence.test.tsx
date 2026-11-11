import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SPEAKER_SPLIT_MIN_MS } from "../../../../src/shared/defaults.ts";
import { CAPABILITIES } from "../../../../src/web/player/capabilities.ts";
import { PlayerController, PlayerControllerProvider } from "../../../../src/web/player/player-controller.tsx";
import { segment } from "../../../fixtures/web/content-data.ts";
import { editorRoutes, mockApi, puts, renderSpeakerEditor } from "../../../fixtures/web/speaker-editor.tsx";

/** Two sentences by two speakers: a long one to split and a short one after it. */
const TEXT = "前半句内容后半句内容";
function base() {
  return [segment("t1", 0, 0, 10_000, TEXT, { speakerId: "spk-a" }), segment("t2", 1, 10_000, 10_000 + SPEAKER_SPLIT_MIN_MS, "很短。", { speakerId: "spk-b" })];
}

/** Puts the caret in a sentence's input the way a click would, and tells the control. */
function placeCaret(input: HTMLElement, at: number): void {
  const field = input as HTMLTextAreaElement;
  field.focus();
  field.setSelectionRange(at, at);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

async function openSplit() {
  const input = await screen.findByDisplayValue(TEXT);
  fireEvent.focus(input);
  return input;
}

describe("splitting a sentence between two speakers", () => {
  it("estimates the time from the caret, names it, and gives both halves a speaker and the original's sources", async () => {
    const { calls } = mockApi(editorRoutes(base()));
    renderSpeakerEditor();
    const input = await openSplit();
    // No caret inside the text yet: nothing to cut at.
    expect((screen.getByTestId("split-button") as HTMLButtonElement).disabled).toBe(true);
    placeCaret(input, 5);
    expect(screen.getByTestId("split-source").textContent).toBe("估算");
    expect((screen.getByTestId("split-time") as HTMLInputElement).value).toBe("5000");
    fireEvent.click(screen.getByTestId("split-button"));
    await waitFor(() => expect(screen.getByDisplayValue("前半句内容")).toBeTruthy());
    expect(screen.getByDisplayValue("后半句内容")).toBeTruthy();
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    const [left, right, short] = puts(calls)[0]?.segments ?? [];
    expect(left).toMatchObject({ id: "t1", startMs: 0, endMs: 5_000, text: "前半句内容", speakerId: "spk-a", sourceSegmentIds: ["t1"] });
    expect(right).toMatchObject({ startMs: 5_000, endMs: 10_000, text: "后半句内容", speakerId: "spk-a", sourceSegmentIds: ["t1"] });
    expect(right?.["id"]).not.toBe("t1");
    expect(short).toMatchObject({ id: "t2" });
  });

  it("takes the playback position when it is inside the sentence, and lets the milliseconds be edited", async () => {
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.local, seek: () => undefined });
    controller.reportTime(3_000);
    const { calls } = mockApi(editorRoutes(base()));
    renderSpeakerEditor({ wrap: (children) => <PlayerControllerProvider controller={controller}>{children}</PlayerControllerProvider> });
    const input = await openSplit();
    placeCaret(input, 5);
    expect(screen.getByTestId("split-source").textContent).toBe("播放位置");
    expect((screen.getByTestId("split-time") as HTMLInputElement).value).toBe("3000");
    act(() => controller.reportTime(4_000));
    expect((screen.getByTestId("split-time") as HTMLInputElement).value).toBe("4000");
    fireEvent.change(screen.getByTestId("split-time"), { target: { value: "6500" } });
    expect(screen.getByTestId("split-source").textContent).toBe("手动");
    fireEvent.click(screen.getByTestId("split-button"));
    await waitFor(() => expect(puts(calls)).toHaveLength(1), { timeout: 3000 });
    expect(puts(calls)[0]?.segments.slice(0, 2).map((item) => [item["startMs"], item["endMs"]])).toEqual([
      [0, 6_500],
      [6_500, 10_000],
    ]);
  });

  it("ignores a playback position outside the sentence and refuses a time that leaves a half too short", async () => {
    const controller = new PlayerController();
    controller.attach({ capabilities: CAPABILITIES.local, seek: () => undefined });
    controller.reportTime(50_000);
    mockApi(editorRoutes(base()));
    renderSpeakerEditor({ wrap: (children) => <PlayerControllerProvider controller={controller}>{children}</PlayerControllerProvider> });
    const input = await openSplit();
    placeCaret(input, 5);
    expect(screen.getByTestId("split-source").textContent).toBe("估算");
    fireEvent.change(screen.getByTestId("split-time"), { target: { value: String(10_000 - SPEAKER_SPLIT_MIN_MS + 1) } });
    expect((screen.getByTestId("split-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(`每一半至少 ${SPEAKER_SPLIT_MIN_MS} 毫秒`)).toBeTruthy();
    expect(screen.getByTestId("split-time").getAttribute("aria-invalid")).toBe("true");
  });

  it("disables the action with an explanation on a sentence too short for two halves", async () => {
    mockApi(editorRoutes(base()));
    renderSpeakerEditor();
    const short = await screen.findByDisplayValue("很短。");
    fireEvent.focus(short);
    const button = screen.getByTestId("split-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("split-disabled").getAttribute("title")).toBe(`句子短于 ${SPEAKER_SPLIT_MIN_MS * 2} 毫秒，不能拆成两半；只能整句指定发言人`);
  });

  it("undoes a split as one step", async () => {
    mockApi(editorRoutes(base()));
    renderSpeakerEditor();
    const input = await openSplit();
    placeCaret(input, 5);
    fireEvent.click(screen.getByTestId("split-button"));
    await screen.findByDisplayValue("前半句内容");
    fireEvent.click(screen.getByTestId("editor-undo"));
    expect(await screen.findByDisplayValue(TEXT)).toBeTruthy();
    expect(screen.queryByDisplayValue("前半句内容")).toBeNull();
  });
});
