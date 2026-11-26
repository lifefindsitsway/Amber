import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_TIMEOUT_MS } from "../../../src/shared/defaults.ts";
import type { AppError } from "../../../src/shared/errors.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { EVENT_SIDECAR_RESTARTED } from "../../../src/web/desktop/bridge.ts";
import { DesktopIntegration } from "../../../src/web/desktop/desktop-integration.tsx";
import { AUTO_CHECK_KEY, UpdateController, type UpdateDownloadEvent, type UpdateHandle, type UpdaterDeps, type UpdateState } from "../../../src/web/desktop/updater.ts";
import { AboutDialog } from "../../../src/web/shell/about-dialog.tsx";
import { UpdateProvider } from "../../../src/web/desktop/updater.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const tauri = vi.hoisted(() => ({
  check: vi.fn<(options?: unknown) => Promise<unknown>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string) => (command === "sidecar_endpoint" ? { endpoint: "http://127.0.0.1:5555", token: "new-token" } : null),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: tauri.check }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauri.openUrl }));
vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

function conflict(code: string): ApiError {
  const error: AppError = { class: "conflict", code, retryDisposition: "never", userMessage: "" };
  return new ApiError(409, error);
}

function fakeUpdate(version: string, options: { body?: string } = {}): UpdateHandle {
  return { version, rid: 7, ...(options.body === undefined ? {} : { body: options.body }), close: vi.fn(async () => undefined) };
}

/** Reports 100 bytes in two chunks, like the shell's download. */
async function downloadAll(onEvent: (event: UpdateDownloadEvent) => void): Promise<void> {
  onEvent({ event: "Started", data: { contentLength: 100 } });
  onEvent({ event: "Progress", data: { chunkLength: 40 } });
  onEvent({ event: "Progress", data: { chunkLength: 60 } });
  onEvent({ event: "Finished" });
}

/** The shell's structured download failure. */
function shellFailure(kind: string, extra: { status?: number; attempts?: number; detail?: string } = {}) {
  return { kind, attempts: 0, detail: "boom", ...extra };
}

/** Dependencies whose download reports 100 bytes; `log` records the calls in order. */
function fakeDeps(found: () => Promise<UpdateHandle | null>, log: string[] = [], options: { installFails?: unknown } = {}) {
  const deps = {
    check: vi.fn(async (_options: { timeout: number }) => {
      log.push("check");
      return found();
    }),
    download: vi.fn(async (_update: UpdateHandle, onEvent: (event: UpdateDownloadEvent) => void) => {
      log.push("download");
      await downloadAll(onEvent);
    }),
    install: vi.fn(async (_update: UpdateHandle) => {
      log.push("install");
      if (options.installFails !== undefined) throw options.installFails;
    }),
    requestMaintenance: vi.fn(async () => {
      log.push("maintenance");
    }),
    releaseMaintenance: vi.fn(async () => {
      log.push("release");
    }),
    beginUpdateInstall: vi.fn(async () => {
      log.push("begin");
    }),
    endUpdateInstall: vi.fn(async () => {
      log.push("end");
    }),
  } satisfies UpdaterDeps;
  return deps;
}

beforeEach(() => {
  localStorage.clear();
  fakeShell.desktop = true;
  for (const mock of Object.values(tauri)) mock.mockReset();
  tauri.check.mockResolvedValue(null);
  tauri.openUrl.mockResolvedValue(undefined);
});

describe("UpdateController", () => {
  it("walks idle → checking → available → downloading → ready_to_install → installing", async () => {
    const log: string[] = [];
    const update = fakeUpdate("0.2.0");
    const deps = fakeDeps(async () => update, log);
    const controller = new UpdateController(deps);
    const seen: string[] = [controller.getState().status];
    controller.subscribe(() => {
      const status = controller.getState().status;
      if (seen.at(-1) !== status) seen.push(status);
    });
    await controller.autoCheck();
    expect(deps.check).toHaveBeenCalledWith({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    expect(controller.getState()).toMatchObject({ status: "available", version: "0.2.0", prompt: true });
    expect(deps.download).not.toHaveBeenCalled();
    await controller.download();
    expect(controller.getState()).toMatchObject({ status: "ready_to_install", progress: { downloaded: 100, total: 100 } });
    await controller.install();
    expect(seen).toEqual(["idle", "checking", "available", "downloading", "ready_to_install", "installing"]);
    // Maintenance admission, then the shell, then the installer; the app has no way to relaunch itself.
    expect(log).toEqual(["check", "download", "maintenance", "begin", "install"]);
    expect(deps.download.mock.calls[0]?.[0]).toBe(update);
    expect(deps.install).toHaveBeenCalledWith(update);
  });

  it("follows the shell's download events: resumed bytes, chunks, reconnects", async () => {
    const seen: Array<UpdateState["progress"]> = [];
    let finish: () => void = () => undefined;
    let emit: (event: UpdateDownloadEvent) => void = () => undefined;
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.download.mockImplementation(async (_update, onEvent) => {
      emit = onEvent;
      await new Promise<void>((resolve) => (finish = resolve));
    });
    const controller = new UpdateController(deps);
    controller.subscribe(() => seen.push(controller.getState().progress));
    await controller.check({ manual: true });
    const running = controller.download();
    await waitFor(() => expect(deps.download).toHaveBeenCalled());
    const progress = () => controller.getState().progress;
    emit({ event: "Started", data: { contentLength: 1000 } });
    expect(progress()).toEqual({ downloaded: 0, total: 1000 });
    emit({ event: "Resumed", data: { downloaded: 400 } });
    expect(progress()).toEqual({ downloaded: 400, total: 1000 });
    emit({ event: "Progress", data: { chunkLength: 100 } });
    expect(progress()).toEqual({ downloaded: 500, total: 1000 });
    emit({ event: "Retrying", data: { attempt: 2, delayMs: 2000 } });
    // A reconnect keeps the bar where it was.
    expect(progress()).toEqual({ downloaded: 500, total: 1000, retrying: { attempt: 2 } });
    emit({ event: "Resumed", data: { downloaded: 500 } });
    expect(progress()).toEqual({ downloaded: 500, total: 1000, retrying: { attempt: 2 } });
    emit({ event: "Progress", data: { chunkLength: 50 } });
    expect(progress()).toEqual({ downloaded: 550, total: 1000 });
    // Only a server that made the download start over sends it back to zero.
    emit({ event: "Resumed", data: { downloaded: 0 } });
    expect(progress()).toEqual({ downloaded: 0, total: 1000 });
    emit({ event: "Progress", data: { chunkLength: 1000 } });
    emit({ event: "Finished" });
    finish();
    await running;
    expect(controller.getState()).toMatchObject({ status: "ready_to_install", progress: { downloaded: 1000, total: 1000 } });
    const downloaded = seen.flatMap((entry) => (entry === undefined ? [] : [entry.downloaded]));
    expect(downloaded).toEqual([0, 0, 400, 500, 500, 500, 550, 0, 1000, 1000, 1000]);
  });

  it("reports up_to_date when the feed has nothing newer", async () => {
    const controller = new UpdateController(fakeDeps(async () => null));
    await controller.check({ manual: true });
    expect(controller.getState()).toMatchObject({ status: "up_to_date", prompt: false, manual: true });
  });

  it("checks automatically once per process and not at all when switched off", async () => {
    const deps = fakeDeps(async () => null);
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.autoCheck();
    expect(deps.check).toHaveBeenCalledTimes(1);

    localStorage.setItem(AUTO_CHECK_KEY, "0");
    const off = fakeDeps(async () => null);
    await new UpdateController(off).autoCheck();
    expect(off.check).not.toHaveBeenCalled();
  });

  it("runs an automatic check asked for before the dependencies arrived once they do", async () => {
    const controller = new UpdateController();
    await controller.autoCheck();
    const deps = fakeDeps(async () => null);
    controller.configure(deps);
    await waitFor(() => expect(controller.getState().status).toBe("up_to_date"));
    controller.configure(deps);
    expect(deps.check).toHaveBeenCalledTimes(1);
  });

  it("never runs two steps at once", async () => {
    let finish: (value: UpdateHandle | null) => void = () => undefined;
    const deps = fakeDeps(() => new Promise((resolve) => (finish = resolve)));
    const controller = new UpdateController(deps);
    const first = controller.check({ manual: true });
    await controller.check({ manual: true });
    await controller.download();
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(deps.download).not.toHaveBeenCalled();
    finish(null);
    await first;
    expect(controller.getState().status).toBe("up_to_date");
  });

  it("「稍后」 hides the same version for this process only; a manual check still shows it; another version prompts", async () => {
    let version = "0.2.0";
    const controller = new UpdateController(fakeDeps(async () => fakeUpdate(version)));
    await controller.autoCheck();
    controller.later();
    expect(controller.getState()).toMatchObject({ status: "available", prompt: false });
    await controller.check({ manual: true });
    expect(controller.getState()).toMatchObject({ status: "available", version: "0.2.0", prompt: false, manual: true });
    await controller.check({ manual: false });
    expect(controller.getState().prompt).toBe(false);
    version = "0.3.0";
    await controller.check({ manual: false });
    expect(controller.getState()).toMatchObject({ version: "0.3.0", prompt: true });
  });

  it("asks again after a restart (a fresh module) even for a postponed version", async () => {
    const first = await import("../../../src/web/desktop/updater.ts");
    first.updateController.configure(fakeDeps(async () => fakeUpdate("0.2.0")));
    await first.updateController.autoCheck();
    first.updateController.later();
    expect(first.updateController.getState().prompt).toBe(false);

    vi.resetModules();
    const restarted = await import("../../../src/web/desktop/updater.ts");
    expect(restarted.updateController).not.toBe(first.updateController);
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    restarted.updateController.configure(deps);
    await restarted.updateController.autoCheck();
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(restarted.updateController.getState()).toMatchObject({ status: "available", version: "0.2.0", prompt: true });
  });

  it("keeps the download and lists the reasons when the maintenance admission is refused, without installing", async () => {
    const log: string[] = [];
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"), log);
    deps.requestMaintenance.mockRejectedValueOnce(conflict("conflict.tasks_unfinished"));
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    await controller.install();
    expect(controller.getState()).toMatchObject({ status: "ready_to_install", blocked: ["conflict.tasks_unfinished"] });
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.beginUpdateInstall).not.toHaveBeenCalled();
    controller.dismissBlocked();
    await controller.install();
    expect(log.slice(-3)).toEqual(["maintenance", "begin", "install"]);
  });

  it("releases the maintenance state and the shell registration when installing fails, and can retry", async () => {
    const log: string[] = [];
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"), log, { installFails: "failed to run the installer" });
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    await controller.install();
    expect(controller.getState()).toMatchObject({ status: "failed", error: { step: "install", kind: "other", detail: "failed to run the installer" } });
    expect(log).toEqual(["check", "download", "maintenance", "begin", "install", "end", "release"]);
    await controller.retry();
    expect(log.slice(-5)).toEqual(["maintenance", "begin", "install", "end", "release"]);
  });

  it("tells a full disk from other install failures", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"), [], { installFails: "failed to write the installer: There is not enough space on the disk. (os error 112)" });
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    await controller.install();
    expect(controller.getState().error).toMatchObject({ step: "install", kind: "disk" });
  });

  it("keeps the sidecar's code and explanation when it refuses maintenance for another reason", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.requestMaintenance.mockRejectedValueOnce(new ApiError(500, { class: "internal", code: "internal.unexpected", retryDisposition: "safe", userMessage: "后端出了点问题" }));
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    await controller.install();
    expect(controller.getState().error).toEqual({ step: "install", kind: "other", detail: "internal.unexpected", code: "internal.unexpected", userMessage: "后端出了点问题" });
    expect(deps.beginUpdateInstall).not.toHaveBeenCalled();
  });

  it("does not install while backup work runs", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    controller.setBackupBusy("export", true);
    await controller.install();
    expect(deps.requestMaintenance).not.toHaveBeenCalled();
    controller.setBackupBusy("export", false);
    await controller.install();
    expect(deps.requestMaintenance).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["interrupted", { attempts: 5 }, { kind: "interrupted", attempts: 5 }],
    ["unreachable", { attempts: 0 }, { kind: "unreachable", attempts: 0 }],
    ["server", { status: 503, attempts: 1 }, { kind: "server", status: 503, attempts: 1 }],
    ["integrity", {}, { kind: "integrity", attempts: 0 }],
    ["busy", {}, { kind: "other", attempts: 0 }],
    ["other", {}, { kind: "other", attempts: 0 }],
  ] as const)("fails a download the shell gave up on as %s, with how far it got", async (kind, extra, expected) => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.download.mockImplementationOnce(async (_update, onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 200 } });
      onEvent({ event: "Progress", data: { chunkLength: 120 } });
      onEvent({ event: "Retrying", data: { attempt: 5, delayMs: 16000 } });
      throw shellFailure(kind, { ...extra, detail: "error decoding response body: https://objects.example/file?X-Sig=secret" });
    });
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    expect(controller.getState()).toMatchObject({ status: "failed", progress: { downloaded: 120, total: 200 } });
    expect(controller.getState().progress?.retrying).toBeUndefined();
    expect(controller.getState().error).toEqual({
      step: "download",
      ...expected,
      detail: "error decoding response body: https://objects.example/file",
      progress: { downloaded: 120, total: 200 },
    });
  });

  it("retries a failed download by asking the shell again, which continues from the kept bytes", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.download.mockImplementationOnce(async (_update, onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      throw shellFailure("interrupted", { attempts: 5 });
    });
    deps.download.mockImplementationOnce(async (_update, onEvent) => {
      onEvent({ event: "Resumed", data: { downloaded: 40 } });
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
      onEvent({ event: "Finished" });
    });
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    expect(controller.getState().error).toMatchObject({ step: "download", kind: "interrupted", progress: { downloaded: 40, total: 100 } });
    await controller.retry();
    expect(deps.download).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ status: "ready_to_install", progress: { downloaded: 100, total: 100 } });
    expect(controller.getState().error).toBeUndefined();
  });

  it("keeps a failed automatic check silent and not postponed", async () => {
    let fail = true;
    const controller = new UpdateController(
      fakeDeps(async () => {
        if (fail) throw "error sending request for url (https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json?x=1)";
        return fakeUpdate("0.2.0");
      }),
    );
    await controller.autoCheck();
    expect(controller.getState()).toMatchObject({
      status: "failed",
      prompt: false,
      error: { step: "check", kind: "unreachable", detail: "error sending request for url (https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json)" },
    });
    fail = false;
    await controller.check({ manual: false });
    expect(controller.getState()).toMatchObject({ status: "available", prompt: true });
  });
});

describe("default dependencies", () => {
  it("downloads and installs through the shell's commands by the update's resource id", async () => {
    tauri.check.mockResolvedValue(fakeUpdate("0.2.0"));
    fakeShell.updateDownload.mockImplementation(async (_rid, onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 10 } });
      onEvent({ event: "Progress", data: { chunkLength: 10 } });
      onEvent({ event: "Finished" });
    });
    fakeShell.updateInstall.mockResolvedValue(undefined);
    fakeShell.beginUpdateInstall.mockResolvedValue(undefined);
    mockApi({ "POST /api/system/maintenance": { body: { until: Date.now() + 1000 } } });
    const controller = new UpdateController();
    renderApp(
      <UpdateProvider controller={controller}>
        <span />
      </UpdateProvider>,
    );
    await waitFor(() => expect(controller.isConfigured()).toBe(true));
    await controller.autoCheck();
    await controller.download();
    expect(fakeShell.updateDownload).toHaveBeenCalledWith(7, expect.any(Function));
    expect(controller.getState()).toMatchObject({ status: "ready_to_install", progress: { downloaded: 10, total: 10 } });
    await controller.install();
    expect(fakeShell.updateInstall).toHaveBeenCalledWith(7);
  });

  it("asks the sidecar for maintenance and releases it after a failed install", async () => {
    tauri.check.mockResolvedValue(fakeUpdate("0.2.0"));
    fakeShell.updateDownload.mockResolvedValue(undefined);
    fakeShell.updateInstall.mockRejectedValue("failed to run the installer");
    fakeShell.beginUpdateInstall.mockResolvedValue(undefined);
    fakeShell.endUpdateInstall.mockResolvedValue(undefined);
    const { calls } = mockApi({
      "POST /api/system/maintenance": { body: { until: Date.now() + 1000 } },
      "DELETE /api/system/maintenance": { status: 204 },
    });
    const controller = new UpdateController();
    renderApp(
      <UpdateProvider controller={controller}>
        <span />
      </UpdateProvider>,
    );
    await waitFor(() => expect(controller.isConfigured()).toBe(true));
    await controller.autoCheck();
    expect(tauri.check).toHaveBeenCalledWith({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    await controller.download();
    await controller.install();
    const maintenance = calls.filter((call) => call.path === "/api/system/maintenance");
    expect(maintenance.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    expect(maintenance[0]?.body).toEqual({ reason: "update_install" });
    expect(fakeShell.beginUpdateInstall).toHaveBeenCalledTimes(1);
    expect(fakeShell.endUpdateInstall).toHaveBeenCalledTimes(1);
    expect(controller.getState().error).toMatchObject({ step: "install", kind: "other", detail: "failed to run the installer" });
  });

  it("turns a refused admission into the blocked reasons", async () => {
    tauri.check.mockResolvedValue(fakeUpdate("0.2.0"));
    fakeShell.updateDownload.mockResolvedValue(undefined);
    mockApi({
      "POST /api/system/maintenance": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.chat_inflight", retryDisposition: "never", userMessage: "" } },
      },
    });
    const controller = new UpdateController();
    renderApp(
      <UpdateProvider controller={controller}>
        <span />
      </UpdateProvider>,
    );
    await waitFor(() => expect(controller.isConfigured()).toBe(true));
    await controller.autoCheck();
    await controller.download();
    await controller.install();
    expect(controller.getState().blocked).toEqual(["conflict.chat_inflight"]);
    expect(fakeShell.beginUpdateInstall).not.toHaveBeenCalled();
  });
});

describe("update card", () => {
  function setup(controller: UpdateController) {
    mockApi({ "GET /api/version": { body: { version: "0.1.0", mode: "local" } } });
    return renderApp(<DesktopIntegration updateController={controller} />);
  }

  it("offers a found update with text-only notes and downloads only on request", async () => {
    const log: string[] = [];
    const deps = fakeDeps(async () => fakeUpdate("0.2.0", { body: "修复 <b>若干</b> 问题" }), log);
    const controller = new UpdateController(deps);
    setup(controller);
    const card = await screen.findByTestId("update-prompt");
    expect(card.textContent).toContain("发现新版本");
    expect(screen.getByTestId("update-version").textContent).toBe("v0.2.0");
    expect(screen.getByTestId("update-notes").textContent).toBe("修复 <b>若干</b> 问题");
    expect(card.querySelector("b")).toBeNull();
    expect(screen.getByTestId("update-backup-first").getAttribute("href")).toBe("/settings/backup");
    expect(deps.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("update-download"));
    fireEvent.click(await screen.findByTestId("update-install"));
    await waitFor(() => expect(log).toEqual(["check", "download", "maintenance", "begin", "install"]));
  });

  it("lays the notes out as an opening paragraph and titled sections, with no Markdown marks left", async () => {
    const update = fakeUpdate("0.3.0", { body: "本次更新重点。\n\n### 新增\n\n- 一项 **重点**\n- [链接](https://example.com)\n\n修复\n• 三项" });
    setup(new UpdateController(fakeDeps(async () => update, [])));
    const notes = await screen.findByTestId("update-notes");
    expect(notes.getAttribute("aria-label")).toBe("更新说明");
    expect(notes.querySelector("p")?.textContent).toBe("本次更新重点。");
    const sections = screen.getAllByTestId("update-notes-section");
    expect(sections.map((section) => section.querySelector("h3")?.textContent)).toEqual(["新增", "修复"]);
    expect(Array.from(sections[0]?.querySelectorAll("li") ?? [], (item) => item.textContent)).toEqual(["一项 重点", "[链接](https://example.com)"]);
    expect(notes.textContent).not.toMatch(/###|\*\*|^- /mu);
    expect(notes.querySelector("a")).toBeNull();
  });

  it("checks once across remounts and sidecar restarts", async () => {
    const deps = fakeDeps(async () => null);
    const controller = new UpdateController(deps);
    const first = setup(controller);
    await waitFor(() => expect(deps.check).toHaveBeenCalledTimes(1));
    first.unmount();
    setup(controller);
    await waitFor(() => expect(fakeShell.listeners.get(EVENT_SIDECAR_RESTARTED)?.size).toBe(1));
    act(() => fakeShell.emit(EVENT_SIDECAR_RESTARTED));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.check).toHaveBeenCalledTimes(1);
  });

  it("hides the card with 「稍后」", async () => {
    const controller = new UpdateController(fakeDeps(async () => fakeUpdate("0.2.0")));
    setup(controller);
    await screen.findByTestId("update-prompt");
    fireEvent.click(screen.getByTestId("update-later"));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("explains a refused admission and lets the user wait or give up", async () => {
    const log: string[] = [];
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"), log);
    deps.requestMaintenance.mockRejectedValue(conflict("conflict.tasks_unfinished"));
    const controller = new UpdateController(deps);
    setup(controller);
    fireEvent.click(await screen.findByTestId("update-download"));
    fireEvent.click(await screen.findByTestId("update-install"));
    const reasons = await screen.findByTestId("update-blocked-reasons");
    expect(reasons.textContent).toContain("有未完成的任务");
    expect(deps.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "等待" }));
    await waitFor(() => expect(screen.queryByTestId("update-blocked-reasons")).toBeNull());
    expect(screen.getByTestId("update-install")).toBeTruthy();
    fireEvent.click(screen.getByTestId("update-install"));
    await screen.findByTestId("update-blocked-reasons");
    fireEvent.click(screen.getByRole("button", { name: "放弃安装" }));
    await waitFor(() => expect(screen.queryByTestId("update-prompt")).toBeNull());
  });

  it("shows the size while downloading and a reconnect under the bar without resetting it", async () => {
    const MB = 1024 * 1024;
    let emit: (event: UpdateDownloadEvent) => void = () => undefined;
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.download.mockImplementation(async (_update, onEvent) => {
      emit = onEvent;
      await new Promise(() => undefined);
    });
    setup(new UpdateController(deps));
    fireEvent.click(await screen.findByTestId("update-download"));
    await waitFor(() => expect(deps.download).toHaveBeenCalled());
    act(() => {
      emit({ event: "Started", data: { contentLength: 190 * MB } });
      emit({ event: "Progress", data: { chunkLength: 120 * MB } });
    });
    const line = screen.getByTestId("update-progress");
    expect(line.textContent).toBe("正在下载 63%（120.0 MB / 190.0 MB）");
    expect(screen.queryByTestId("update-retrying")).toBeNull();
    act(() => emit({ event: "Retrying", data: { attempt: 2, delayMs: 2000 } }));
    expect(screen.getByTestId("update-retrying").textContent).toBe("网络中断，正在接着下载（第 2 次）");
    expect(screen.getByTestId("update-retrying").parentElement?.getAttribute("aria-live")).toBe("polite");
    expect((line.querySelector("progress") as HTMLProgressElement).value).toBe(120 * MB);
    act(() => emit({ event: "Progress", data: { chunkLength: MB } }));
    expect(screen.queryByTestId("update-retrying")).toBeNull();
  });

  it("explains a failed download, offers retry and 「稍后」, and 「稍后」 closes the card", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.download.mockImplementationOnce(async (_update, onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      throw shellFailure("interrupted", { attempts: 5, detail: "error decoding response body" });
    });
    const controller = new UpdateController(deps);
    setup(controller);
    fireEvent.click(await screen.findByTestId("update-download"));
    const failure = await screen.findByTestId("update-failure");
    expect(failure.getAttribute("role")).toBe("alert");
    expect(failure.textContent).toContain("下载没能完成");
    expect(failure.textContent).toContain("已自动重连 5 次，下载到 40%（40 B / 100 B）");
    expect(screen.getByTestId("update-browser-download").getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases/tag/v0.2.0");
    expect(screen.queryByTestId("update-manual-download")).toBeNull();
    // One primary action; retry asks the shell again.
    expect(screen.getByTestId("update-retry")).toBeTruthy();
    fireEvent.click(screen.getByTestId("update-retry"));
    await screen.findByTestId("update-install");
    expect(deps.download).toHaveBeenCalledTimes(2);
  });

  it("closes a failed card with 「稍后」", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.download.mockRejectedValueOnce(shellFailure("unreachable"));
    const controller = new UpdateController(deps);
    setup(controller);
    fireEvent.click(await screen.findByTestId("update-download"));
    await screen.findByTestId("update-failure");
    fireEvent.click(screen.getByTestId("update-later"));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
    expect(controller.getState().status).toBe("failed");
  });

  it("shows a failed install with its explanation and a retry", async () => {
    const controller = new UpdateController(fakeDeps(async () => fakeUpdate("0.2.0"), [], { installFails: "failed to run the installer" }));
    setup(controller);
    fireEvent.click(await screen.findByTestId("update-download"));
    fireEvent.click(await screen.findByTestId("update-install"));
    const failure = await screen.findByTestId("update-failure");
    expect(failure.textContent).toContain("安装失败");
    expect(screen.getByTestId("update-failure-detail").textContent).toBe("failed to run the installer");
    expect(screen.getByTestId("update-retry")).toBeTruthy();
    expect(screen.getByTestId("update-later")).toBeTruthy();
  });

  it("stays silent when the automatic check fails", async () => {
    const deps = fakeDeps(async () => {
      throw new Error("offline");
    });
    setup(new UpdateController(deps));
    await waitFor(() => expect(deps.check).toHaveBeenCalled());
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });
});

describe("about dialog update area", () => {
  function setup(controller: UpdateController) {
    mockApi({ "GET /api/version": { body: { version: "0.1.0", mode: "local" } } });
    return renderApp(
      <UpdateProvider controller={controller}>
        <AboutDialog open onOpenChange={() => undefined} />
      </UpdateProvider>,
    );
  }

  it("shows a manual check's result there, not as the card, with the fallback download page", async () => {
    let fail = true;
    const deps = fakeDeps(async () => {
      if (fail) throw "Could not fetch a valid release JSON from the remote";
      return null;
    });
    const controller = new UpdateController(deps);
    setup(controller);
    const area = await screen.findByTestId("about-update");
    fireEvent.click(within(area).getByTestId("about-update-check"));
    const failure = await within(area).findByTestId("update-failure");
    expect(failure.textContent).toContain("连不上 GitHub");
    expect(within(area).getByTestId("update-browser-download").getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases");
    expect(within(area).getByTestId("about-update-manual").getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases");
    // A failed check is repeated with the check button itself.
    expect(within(area).queryByTestId("about-update-retry")).toBeNull();
    fail = false;
    fireEvent.click(within(area).getByTestId("about-update-check"));
    await waitFor(() => expect(within(area).getByTestId("about-update-status").textContent).toBe("已是最新版本"));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("explains a failed download with the same notice and keeps its retry", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0"));
    deps.download.mockRejectedValueOnce(shellFailure("integrity"));
    const controller = new UpdateController(deps);
    setup(controller);
    await controller.check({ manual: true });
    const area = await screen.findByTestId("about-update");
    fireEvent.click(await within(area).findByTestId("about-update-download"));
    expect((await within(area).findByTestId("update-failure")).textContent).toContain("安装包校验未通过");
    expect(within(area).getByTestId("update-browser-download").getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases/tag/v0.2.0");
    fireEvent.click(within(area).getByTestId("about-update-retry"));
    await within(area).findByTestId("about-update-install");
    expect(deps.download).toHaveBeenCalledTimes(2);
  });

  it("switches the automatic check off and on", async () => {
    setup(new UpdateController(fakeDeps(async () => null)));
    const toggle = (await screen.findByTestId("about-update-auto")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(localStorage.getItem(AUTO_CHECK_KEY)).toBe("0");
    fireEvent.click(toggle);
    expect(localStorage.getItem(AUTO_CHECK_KEY)).toBe("1");
  });

  it("has no update area outside the desktop client but still links the source", async () => {
    fakeShell.desktop = false;
    mockApi({ "GET /api/version": { body: { version: "0.1.0", mode: "server" } } });
    renderApp(<AboutDialog open onOpenChange={() => undefined} />, { mode: "server" });
    expect((await screen.findByTestId("about-source")).getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber");
    expect(screen.queryByTestId("about-update")).toBeNull();
  });
});
