import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => false), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: tauri.isTauri, invoke: tauri.invoke }));

const { localTimeStamp, markDesktopShell, pickPackDestination, pickPackOriginalsDir, pickPackSource } = await import(
  "../../../src/web/desktop/bridge.ts"
);

afterEach(() => {
  delete document.documentElement.dataset.shell;
});

describe("markDesktopShell", () => {
  it("marks the document in the desktop window", async () => {
    tauri.isTauri.mockReturnValue(true);
    await markDesktopShell();
    expect(document.documentElement.dataset.shell).toBe("desktop");
  });

  it("leaves a browser tab unmarked", async () => {
    tauri.isTauri.mockReturnValue(false);
    await markDesktopShell();
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});

describe("localTimeStamp", () => {
  it("formats local time as yyyyMMdd-HHmmss, zero-padded", () => {
    expect(localTimeStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
    expect(localTimeStamp(new Date(2026, 9, 19, 23, 59, 58))).toBe("20261019-235958");
  });
});

describe("content pack dialogs", () => {
  const picked = {
    path: "D:\\资料\\第 1 讲.amberpack",
    grant: { path: "D:\\资料\\第 1 讲.amberpack", purpose: "pack_output" as const, expiresAt: 1, sig: "s" },
  };

  afterEach(() => {
    tauri.invoke.mockReset();
  });

  it("passes the suggested name to the save dialog command", async () => {
    tauri.invoke.mockResolvedValue(picked);
    await expect(pickPackDestination("第 1 讲.amberpack")).resolves.toEqual(picked);
    expect(tauri.invoke).toHaveBeenCalledWith("pick_pack_destination", { suggestedName: "第 1 讲.amberpack" });
  });

  it("opens the pack dialog without arguments and names the originals directory with the local stamp", async () => {
    tauri.invoke.mockResolvedValue(null);
    await expect(pickPackSource()).resolves.toBeNull();
    await expect(pickPackOriginalsDir("20261118-090000")).resolves.toBeNull();
    expect(tauri.invoke.mock.calls).toEqual([
      ["pick_pack_source", undefined],
      ["pick_pack_originals_dir", { localStamp: "20261118-090000" }],
    ]);
  });

  it("passes a shell refusal through", async () => {
    tauri.invoke.mockRejectedValue("the originals directory must lie outside the data directory");
    await expect(pickPackOriginalsDir("20261118-090000")).rejects.toBe("the originals directory must lie outside the data directory");
  });
});
