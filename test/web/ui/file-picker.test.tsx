import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initI18n } from "../../../src/web/i18n.ts";
import { FilePicker } from "../../../src/web/ui/file-picker.tsx";

initI18n();

describe("FilePicker", () => {
  it("opens the dialog from its button only and reports the chosen file", () => {
    const onFile = vi.fn();
    render(
      <div>
        <span id="field">音视频文件</span>
        <FilePicker accept="audio/*" fileName={undefined} onFile={onFile} labelledBy="field" testId="picker" />
      </div>,
    );
    const input = screen.getByTestId("picker") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByText("未选择文件"));
    fireEvent.click(screen.getByText("音视频文件"));
    expect(click).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "音视频文件 选择文件" }));
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(["x"], "talk.mp4");
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("shows the chosen name and names an unlabelled picker by its label", () => {
    render(<FilePicker accept=".srt" fileName="talk.srt" onFile={() => undefined} label="字幕文件" />);
    expect(screen.getByText("talk.srt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "字幕文件 选择文件" })).toBeTruthy();
  });

  it("can stand as a compact named button without the file name, and reports the same file twice", () => {
    const onFile = vi.fn();
    render(<FilePicker accept=".txt" fileName={undefined} onFile={onFile} size="sm" hideName buttonLabel="选择 cookies.txt 文件" testId="picker" />);
    const button = screen.getByRole("button", { name: "选择 cookies.txt 文件" });
    expect(button.className).toContain("h-7");
    expect(button.tabIndex).toBe(0);
    expect(screen.queryByText("未选择文件")).toBeNull();
    const input = screen.getByTestId("picker") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    button.focus();
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(["x"], "cookies.txt");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledTimes(2);
    expect(input.value).toBe("");
  });
});

