import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_TIMEOUT_MS } from "../../../src/shared/defaults.ts";
import type { AppError } from "../../../src/shared/errors.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { EVENT_SIDECAR_RESTARTED } from "../../../src/web/desktop/bridge.ts";
import { DesktopIntegration } from "../../../src/web/desktop/desktop-integration.tsx";
import { AUTO_CHECK_KEY, UpdateController, type UpdateDownloadEvent, type UpdateHandle, type UpdaterDeps } from "../../../src/web/desktop/updater.ts";
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

/** An update whose download reports 100 bytes in two chunks; `log` records the calls in order. */
function fakeUpdate(version: string, log: string[], options: { body?: string; downloadFails?: boolean; installFails?: boolean } = {}): UpdateHandle {
  return {
    version,
    ...(options.body === undefined ? {} : { body: options.body }),
    download: vi.fn(async (onEvent?: (event: UpdateDownloadEvent) => void) => {
      log.push("download");
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      if (options.downloadFails === true) throw new Error("connection reset");
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
      onEvent?.({ event: "Finished" });
    }),
    install: vi.fn(async () => {
      log.push("install");
      if (options.installFails === true) throw new Error("signature mismatch");
    }),
    close: vi.fn(async () => undefined),
  };
}

function fakeDeps(found: () => Promise<UpdateHandle | null>, log: string[] = []) {
  const deps = {
    check: vi.fn(async (_options: { timeout: number }) => {
      log.push("check");
      return found();
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
    const update = fakeUpdate("0.2.0", log);
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
    expect(update.download).not.toHaveBeenCalled();
    await controller.download();
    expect(controller.getState()).toMatchObject({ status: "ready_to_install", progress: { downloaded: 100, total: 100 } });
    await controller.install();
    expect(seen).toEqual(["idle", "checking", "available", "downloading", "ready_to_install", "installing"]);
    // Maintenance admission, then the shell, then the installer; the app has no way to relaunch itself.
    expect(log).toEqual(["check", "download", "maintenance", "begin", "install"]);
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
    finish(null);
    await first;
    expect(controller.getState().status).toBe("up_to_date");
  });

  it("「稍后」 hides the same version for this process only; a manual check still shows it; another version prompts", async () => {
    let version = "0.2.0";
    const controller = new UpdateController(fakeDeps(async () => fakeUpdate(version, [])));
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
    first.updateController.configure(fakeDeps(async () => fakeUpdate("0.2.0", [])));
    await first.updateController.autoCheck();
    first.updateController.later();
    expect(first.updateController.getState().prompt).toBe(false);

    vi.resetModules();
    const restarted = await import("../../../src/web/desktop/updater.ts");
    expect(restarted.updateController).not.toBe(first.updateController);
    const deps = fakeDeps(async () => fakeUpdate("0.2.0", []));
    restarted.updateController.configure(deps);
    await restarted.updateController.autoCheck();
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(restarted.updateController.getState()).toMatchObject({ status: "available", version: "0.2.0", prompt: true });
  });

  it("keeps the download and lists the reasons when the maintenance admission is refused, without installing", async () => {
    const log: string[] = [];
    const update = fakeUpdate("0.2.0", log);
    const deps = fakeDeps(async () => update, log);
    deps.requestMaintenance.mockRejectedValueOnce(conflict("conflict.tasks_unfinished"));
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    await controller.install();
    expect(controller.getState()).toMatchObject({ status: "ready_to_install", blocked: ["conflict.tasks_unfinished"] });
    expect(update.install).not.toHaveBeenCalled();
    expect(deps.beginUpdateInstall).not.toHaveBeenCalled();
    controller.dismissBlocked();
    await controller.install();
    expect(log.slice(-3)).toEqual(["maintenance", "begin", "install"]);
  });

  it("releases the maintenance state and the shell registration when installing fails, and can retry", async () => {
    const log: string[] = [];
    const update = fakeUpdate("0.2.0", log, { installFails: true });
    const deps = fakeDeps(async () => update, log);
    const controller = new UpdateController(deps);
    await controller.autoCheck();
    await controller.download();
    await controller.install();
    expect(controller.getState()).toMatchObject({ status: "failed", error: { step: "install", message: "signature mismatch" } });
    expect(log).toEqual(["check", "download", "maintenance", "begin", "install", "end", "release"]);
    await controller.retry();
    expect(log.slice(-5)).toEqual(["maintenance", "begin", "install", "end", "release"]);
  });

  it("does not install while backup work runs", async () => {
    const deps = fakeDeps(async () => fakeUpdate("0.2.0", []));
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

  it("fails a download with its reason and retries it", async () => {
    const log: string[] = [];
    const update = fakeUpdate("0.2.0", log);
    vi.mocked(update.download).mockRejectedValueOnce(new Error("connection reset"));
    const controller = new UpdateController(fakeDeps(async () => update));
    await controller.autoCheck();
    await controller.download();
    expect(controller.getState()).toMatchObject({ status: "failed", error: { step: "download", message: "connection reset" } });
    await controller.retry();
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(controller.getState().status).toBe("ready_to_install");
  });

  it("keeps a failed automatic check silent and not postponed", async () => {
    let fail = true;
    const controller = new UpdateController(
      fakeDeps(async () => {
        if (fail) throw new Error("offline");
        return fakeUpdate("0.2.0", []);
      }),
    );
    await controller.autoCheck();
    expect(controller.getState()).toMatchObject({ status: "failed", prompt: false, error: { step: "check", message: "offline" } });
    fail = false;
    await controller.check({ manual: false });
    expect(controller.getState()).toMatchObject({ status: "available", prompt: true });
  });
});

describe("default dependencies", () => {
  it("asks the sidecar for maintenance and releases it after a failed install", async () => {
    const log: string[] = [];
    tauri.check.mockResolvedValue(fakeUpdate("0.2.0", log, { installFails: true }));
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
  });

  it("turns a refused admission into the blocked reasons", async () => {
    tauri.check.mockResolvedValue(fakeUpdate("0.2.0", []));
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
    const update = fakeUpdate("0.2.0", log, { body: "修复 <b>若干</b> 问题" });
    const controller = new UpdateController(fakeDeps(async () => update, log));
    setup(controller);
    const card = await screen.findByTestId("update-prompt");
    expect(card.textContent).toContain("发现新版本");
    expect(screen.getByTestId("update-version").textContent).toBe("v0.2.0");
    expect(screen.getByTestId("update-notes").textContent).toBe("修复 <b>若干</b> 问题");
    expect(card.querySelector("b")).toBeNull();
    expect(screen.getByTestId("update-backup-first").getAttribute("href")).toBe("/settings/backup");
    expect(update.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("update-download"));
    fireEvent.click(await screen.findByTestId("update-install"));
    await waitFor(() => expect(log).toEqual(["check", "download", "maintenance", "begin", "install"]));
  });

  it("lays the notes out as an opening paragraph and titled sections, with no Markdown marks left", async () => {
    const update = fakeUpdate("0.3.0", [], { body: "本次更新重点。\n\n### 新增\n\n- 一项 **重点**\n- [链接](https://example.com)\n\n修复\n• 三项" });
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
    const controller = new UpdateController(fakeDeps(async () => fakeUpdate("0.2.0", [])));
    setup(controller);
    await screen.findByTestId("update-prompt");
    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
  });

  it("explains a refused admission and lets the user wait or give up", async () => {
    const log: string[] = [];
    const update = fakeUpdate("0.2.0", log);
    const deps = fakeDeps(async () => update, log);
    deps.requestMaintenance.mockRejectedValue(conflict("conflict.tasks_unfinished"));
    const controller = new UpdateController(deps);
    setup(controller);
    fireEvent.click(await screen.findByTestId("update-download"));
    fireEvent.click(await screen.findByTestId("update-install"));
    const reasons = await screen.findByTestId("update-blocked-reasons");
    expect(reasons.textContent).toContain("有未完成的任务");
    expect(update.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "等待" }));
    await waitFor(() => expect(screen.queryByTestId("update-blocked-reasons")).toBeNull());
    expect(screen.getByTestId("update-install")).toBeTruthy();
    fireEvent.click(screen.getByTestId("update-install"));
    await screen.findByTestId("update-blocked-reasons");
    fireEvent.click(screen.getByRole("button", { name: "放弃安装" }));
    await waitFor(() => expect(screen.queryByTestId("update-prompt")).toBeNull());
  });

  it("shows a failed install with its reason and a retry", async () => {
    const controller = new UpdateController(fakeDeps(async () => fakeUpdate("0.2.0", [], { installFails: true })));
    setup(controller);
    fireEvent.click(await screen.findByTestId("update-download"));
    fireEvent.click(await screen.findByTestId("update-install"));
    expect((await screen.findByRole("alert")).textContent).toContain("更新失败：signature mismatch");
    expect(screen.getByTestId("update-manual-download").getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases");
    expect(screen.getByTestId("update-retry")).toBeTruthy();
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
      if (fail) throw new Error("offline");
      return null;
    });
    const controller = new UpdateController(deps);
    setup(controller);
    const area = await screen.findByTestId("about-update");
    fireEvent.click(within(area).getByTestId("about-update-check"));
    expect((await within(area).findByTestId("about-update-status")).textContent).toBe("检查失败：offline");
    expect(within(area).getByTestId("about-update-manual").getAttribute("href")).toBe("https://github.com/lifefindsitsway/Amber/releases");
    fail = false;
    fireEvent.click(within(area).getByTestId("about-update-check"));
    await waitFor(() => expect(within(area).getByTestId("about-update-status").textContent).toBe("已是最新版本"));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
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
