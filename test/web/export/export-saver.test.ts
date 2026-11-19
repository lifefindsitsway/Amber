import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { browserDownloadSaver, exportSaver, tauriDialogSaver } from "../../../src/web/export/export-saver.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";

const dialog = vi.hoisted(() => ({ save: vi.fn<(options: unknown) => Promise<string | null>>() }));
const fs = vi.hoisted(() => ({ writeFile: vi.fn<(path: string, data: Uint8Array) => Promise<void>>() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialog.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: fs.writeFile }));
vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

afterEach(() => {
  vi.restoreAllMocks();
  dialog.save.mockReset();
  fs.writeFile.mockReset();
});

describe("browserDownloadSaver", () => {
  it("downloads the blob under the file's name and releases the object URL", async () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:mock");
    const revoke = vi.fn();
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });
    const blob = new Blob(["# 第一讲"]);
    // Outside the desktop client the environment saver is the browser download.
    // The download is named by the file; that is the name the confirmation shows.
    await expect(exportSaver().save({ filename: "第一讲.md", blob })).resolves.toBe("第一讲.md");
    expect(create).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: "blob:mock", download: "第一讲.md" }]);
    expect(document.querySelector("a[download]")).toBeNull();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:mock");
    vi.useRealTimers();
    expect(dialog.save).not.toHaveBeenCalled();
    expect(browserDownloadSaver).not.toBe(tauriDialogSaver);
  });
});

describe("tauriDialogSaver", () => {
  it("writes the bytes where the native save dialog points, filtered by the file's extension", async () => {
    fakeShell.desktop = true;
    dialog.save.mockResolvedValue("C:\\Users\\me\\第一讲.srt");
    fs.writeFile.mockResolvedValue(undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    await exportSaver().save({ filename: "第一讲.srt", blob: new Blob(["1\n"]) });
    expect(dialog.save).toHaveBeenCalledWith({ defaultPath: "第一讲.srt", filters: [{ name: "SRT", extensions: ["srt"] }] });
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = fs.writeFile.mock.calls[0] ?? [];
    expect(path).toBe("C:\\Users\\me\\第一讲.srt");
    expect(new TextDecoder().decode(data)).toBe("1\n");
    expect(click).not.toHaveBeenCalled();
  });

  it("saves a figure zip as bytes and reports the name the user gave it in the dialog", async () => {
    fakeShell.desktop = true;
    dialog.save.mockResolvedValue("D:\\笔记\\第一讲（图文）.zip");
    fs.writeFile.mockResolvedValue(undefined);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    await expect(exportSaver().save({ filename: "第一讲.zip", blob: new Blob([bytes]) })).resolves.toBe("第一讲（图文）.zip");
    expect(dialog.save).toHaveBeenCalledWith({ defaultPath: "第一讲.zip", filters: [{ name: "ZIP", extensions: ["zip"] }] });
    expect(Array.from(fs.writeFile.mock.calls[0]?.[1] ?? [])).toEqual(Array.from(bytes));
    dialog.save.mockResolvedValue("/home/me/第一讲.zip");
    await expect(tauriDialogSaver.save({ filename: "第一讲.zip", blob: new Blob([bytes]) })).resolves.toBe("第一讲.zip");
  });

  it("treats a cancelled dialog as nothing to do", async () => {
    dialog.save.mockResolvedValue(null);
    await expect(tauriDialogSaver.save({ filename: "notes", blob: new Blob(["x"]) })).resolves.toBeUndefined();
    expect(dialog.save).toHaveBeenCalledWith({ defaultPath: "notes" });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
