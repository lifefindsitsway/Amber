import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupHeader } from "../../../../src/shared/backup.ts";
import type { BackupExportJobDto, RestoreApplyReport } from "../../../../src/shared/dto/backup.ts";
import { EVENT_RESTORE_PROGRESS, EVENT_SIDECAR_RESTARTED } from "../../../../src/web/desktop/bridge.ts";
import { UpdateController, UpdateProvider, type UpdateHandle } from "../../../../src/web/desktop/updater.ts";
import { BackupSection } from "../../../../src/web/pages/settings/backup-section.tsx";
import { fakeShell, pickedFile } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: async () => null }));
vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const ASSET = "01JBACKUPASSET000000000000";

const ESTIMATE = {
  database: { bytes: 2048 },
  originals: { count: 2, bytes: 4096, unreadable: [] as Array<{ assetId: string; displayName: string; reason: "missing" | "not_a_file" | "unreadable" }> },
  cache: { count: 1, bytes: 1024 },
};

function job(overrides: Partial<BackupExportJobDto>): BackupExportJobDto {
  return { jobId: "job-1", status: "running", phase: "originals", bytesDone: 10, bytesTotal: 100, filesDone: 1, filesTotal: 3, ...overrides };
}

const HEADER: BackupHeader = {
  formatVersion: 1,
  mode: "local",
  amberVersion: "0.1.0",
  schemaVersion: 18,
  createdAt: 1_800_000_000_000,
  encryption: "none",
  includes: { originals: true, cache: false },
  excludedOriginals: [],
  counts: { contents: 3, collections: 1, notes: 5, originals: 1, cache: 0 },
  sizes: { database: 1000, originals: 2000, cache: 0 },
  originals: [{ assetId: ASSET, archivePath: `originals/${ASSET}.mp4`, originalName: "lecture.mp4", sizeBytes: 2000, fingerprint: null }],
  cache: [],
  uiPreferences: {},
};

const RESTORED: RestoreApplyReport = {
  ok: true,
  database: "ok",
  restored: { contents: 3, collections: 1, notes: 5, originals: 1, cache: 0, missingOriginals: 0, profilesNeedingCredentials: 2 },
  originalsDir: "D:\\AmberMedia\\Amber-Restored-20261019-120000",
  preferences: {
    candidates: { "amber.player.volume": "0.5", "amber.notes.color.underline": "green", "amber.player.endBehavior": "spin" },
    dropped: [{ key: "evil.key", reason: "not_allowed" }],
  },
};

beforeEach(() => {
  localStorage.clear();
  fakeShell.desktop = true;
});

function render(routes: Parameters<typeof mockApi>[0], controller = new UpdateController()) {
  const api = mockApi({ "GET /api/version": { body: { version: "0.1.0", mode: "local" } }, ...routes });
  renderApp(
    <UpdateProvider controller={controller}>
      <BackupSection />
    </UpdateProvider>,
  );
  return api;
}

const FRESH = { "GET /api/backup/restore-readiness": { body: { fresh: true, nonEmpty: [], willReplace: ["appearance", "task_concurrency"] } } };

describe("BackupSection", () => {
  it("keeps backups to the desktop client; content packs are offered in both modes", async () => {
    fakeShell.desktop = false;
    render({ "GET /api/content-packs/active": { body: {} } });
    expect(await screen.findByRole("button", { name: "导入内容包" })).toBeTruthy();
    expect(screen.getByText("内容包")).toBeTruthy();
    expect(screen.queryByText("导出备份")).toBeNull();
    expect(screen.queryByText("从备份恢复")).toBeNull();
  });
});

describe("export", () => {
  it("estimates, warns about the content, and exports with the chosen file and the local preferences", async () => {
    localStorage.setItem("amber.player.volume", "0.5");
    localStorage.setItem("other.app", "x");
    fakeShell.pickBackupDestination.mockResolvedValue(pickedFile("D:\\backup.amberbackup", "backup_output"));
    let polls = 0;
    const { calls } = render({
      ...FRESH,
      "POST /api/backup/estimate": { body: ESTIMATE },
      "POST /api/backup/exports": { status: 202, body: { jobId: "job-1", preferencesDropped: [] } },
      "GET /api/backup/exports/job-1": () => {
        polls += 1;
        return {
          body:
            polls === 1
              ? job({})
              : job({ status: "succeeded", phase: "finalize", result: { sizeBytes: 7168, originals: 2, cache: 0, preferencesDropped: [{ key: "amber.player.volume", reason: "invalid_value" }] } }),
        };
      },
    });
    const estimate = await screen.findByTestId("backup-estimate");
    await waitFor(() => expect(estimate.textContent).toContain("本地原始音视频 2 个，4.0 KB"));
    expect(estimate.textContent).not.toContain("平台缓存视频");
    expect(screen.getByTestId("backup-notice").textContent).toContain("未加密");
    fireEvent.click(screen.getByTestId("backup-export-start"));
    await waitFor(() => expect(fakeShell.pickBackupDestination).toHaveBeenCalledTimes(1));
    expect(fakeShell.pickBackupDestination.mock.calls[0]?.[0]).toMatch(/^Amber-\d{8}-\d{4}\.amberbackup$/u);
    const post = await waitFor(() => {
      const found = calls.find((call: RecordedCall) => call.method === "POST" && call.path === "/api/backup/exports");
      expect(found).toBeDefined();
      return found as RecordedCall;
    });
    expect(post.body).toEqual({
      grant: expect.objectContaining({ purpose: "backup_output" }),
      includeOriginals: true,
      includeCache: false,
      excludeOriginals: [],
      uiPreferences: { "amber.player.volume": "0.5" },
    });
    const view = await screen.findByTestId("backup-export-job");
    expect(view.getAttribute("data-status")).toBe("running");
    await waitFor(() => expect(screen.getByTestId("backup-export-job").getAttribute("data-status")).toBe("succeeded"), { timeout: 3000 });
    expect(screen.getByTestId("backup-export-job").textContent).toContain("导出完成：7.0 KB");
    expect(screen.getByTestId("backup-dropped").textContent).toContain("amber.player.volume");
  });

  it("does nothing when the save dialog is cancelled", async () => {
    fakeShell.pickBackupDestination.mockResolvedValue(null);
    const { calls } = render({ ...FRESH, "POST /api/backup/estimate": { body: ESTIMATE } });
    await waitFor(() => expect((screen.getByTestId("backup-export-start") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("backup-export-start"));
    await waitFor(() => expect(fakeShell.pickBackupDestination).toHaveBeenCalled());
    expect(calls.some((call) => call.path === "/api/backup/exports")).toBe(false);
  });

  it("requires unreadable originals to be excluded explicitly and sends their ids", async () => {
    fakeShell.pickBackupDestination.mockResolvedValue(pickedFile("D:\\b.amberbackup", "backup_output"));
    const estimate = { ...ESTIMATE, originals: { ...ESTIMATE.originals, unreadable: [{ assetId: ASSET, displayName: "第 3 讲.mp4", reason: "missing" as const }] } };
    const { calls } = render({
      ...FRESH,
      "POST /api/backup/estimate": { body: estimate },
      "POST /api/backup/exports": { status: 202, body: { jobId: "job-1", preferencesDropped: [] } },
      "GET /api/backup/exports/job-1": { body: job({ status: "cancelled" }) },
    });
    const list = await screen.findByTestId("backup-unreadable");
    expect(list.textContent).toContain("第 3 讲.mp4 · 文件不存在");
    const start = screen.getByTestId("backup-export-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(within(list).getByTestId("backup-exclude-unreadable"));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(calls.find((call) => call.path === "/api/backup/exports")?.body).toMatchObject({ excludeOriginals: [ASSET] }));
  });

  it("shows why an export failed and which file changed, and can cancel a running one", async () => {
    fakeShell.pickBackupDestination.mockResolvedValue(pickedFile("D:\\b.amberbackup", "backup_output"));
    let cancelled = false;
    const { calls } = render({
      ...FRESH,
      "POST /api/backup/estimate": { body: ESTIMATE },
      "POST /api/backup/exports": { status: 202, body: { jobId: "job-1", preferencesDropped: [] } },
      "POST /api/backup/exports/job-1/cancel": () => {
        cancelled = true;
        return { status: 204 };
      },
      "GET /api/backup/exports/job-1": () => ({
        body: cancelled
          ? job({
              status: "failed",
              error: { class: "media_changed", code: "media_changed", retryDisposition: "never", userMessage: "文件内容与导入时不一致，请重新导入" },
              failedAsset: { assetId: ASSET, displayName: "第 3 讲.mp4" },
            })
          : job({}),
      }),
    });
    await waitFor(() => expect((screen.getByTestId("backup-export-start") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("backup-export-start"));
    fireEvent.click(await screen.findByTestId("backup-export-cancel"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/backup/exports/job-1/cancel")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("backup-export-job").getAttribute("data-status")).toBe("failed"), { timeout: 3000 });
    expect(screen.getByTestId("backup-export-job").textContent).toContain("出问题的文件：第 3 讲.mp4");
  });

  it("lists an original a failed export found changed, so the next export can exclude it", async () => {
    fakeShell.pickBackupDestination.mockResolvedValue(pickedFile("D:\\b.amberbackup", "backup_output"));
    let exports = 0;
    const { calls } = render({
      ...FRESH,
      "POST /api/backup/estimate": { body: ESTIMATE },
      "POST /api/backup/exports": () => ({ status: 202, body: { jobId: `job-${++exports}`, preferencesDropped: [] } }),
      "GET /api/backup/exports/job-1": {
        body: job({
          status: "failed",
          error: { class: "media_changed", code: "media_changed", retryDisposition: "never", userMessage: "文件内容与导入时不一致，请重新导入" },
          failedAsset: { assetId: ASSET, displayName: "第 3 讲.mp4" },
        }),
      },
      "GET /api/backup/exports/job-2": { body: job({ jobId: "job-2", status: "succeeded", result: { sizeBytes: 4096, originals: 1, cache: 0, preferencesDropped: [] } }) },
    });
    await waitFor(() => expect((screen.getByTestId("backup-export-start") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("backup-export-start"));
    const list = await screen.findByTestId("backup-unreadable");
    expect(list.textContent).toContain("第 3 讲.mp4 · 导入后已被修改");
    const start = screen.getByTestId("backup-export-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(within(list).getByTestId("backup-exclude-unreadable"));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/backup/exports").map((call) => call.body)).toMatchObject([{ excludeOriginals: [] }, { excludeOriginals: [ASSET] }]));
    await waitFor(() => expect(screen.getByTestId("backup-export-job").getAttribute("data-status")).toBe("succeeded"));
  });

  it("is unavailable while an update downloads", async () => {
    const pending: UpdateHandle = { version: "0.2.0", download: () => new Promise(() => undefined), install: async () => undefined };
    const controller = new UpdateController({
      check: async () => pending,
      requestMaintenance: async () => undefined,
      releaseMaintenance: async () => undefined,
      beginUpdateInstall: async () => undefined,
      endUpdateInstall: async () => undefined,
    });
    await controller.check({ manual: true });
    void controller.download();
    render({ ...FRESH, "POST /api/backup/estimate": { body: ESTIMATE } }, controller);
    await screen.findByText("本地原始音视频 2 个，4.0 KB");
    expect((screen.getByTestId("backup-export-start") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("restore-pick") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("restore", () => {
  it("is disabled on a device that already has data, naming what it holds", async () => {
    render({
      "POST /api/backup/estimate": { body: ESTIMATE },
      "GET /api/backup/restore-readiness": { body: { fresh: false, nonEmpty: ["content", "note", "provider_profile", "cache_root"], willReplace: [] } },
    });
    const box = await screen.findByTestId("restore-not-fresh");
    expect(box.textContent).toContain("当前 Amber 已包含使用数据。为避免覆盖现有内容，暂不支持直接导入另一份备份。");
    expect(box.textContent).toContain("如需更换备份，请先导出并妥善保存当前数据，再清空 Amber 的应用数据，重新安装后导入所需备份。");
    const help = screen.getByTestId("restore-clear-help");
    expect(help.textContent).toContain("如何清空应用数据？");
    expect(help.textContent).toContain("勾选「删除应用程序数据」");
    expect(help.textContent).toContain("无法撤销");
    expect(help.textContent).toContain("请先导出备份");
    expect(box.textContent).not.toContain("只能恢复一次");
    expect(box.textContent).toContain("内容与学习资料：内容、笔记");
    expect(box.textContent).toContain("模型与服务配置：AI 模型配置");
    expect(box.textContent).toContain("其他：自定义视频缓存位置");
    expect((screen.getByTestId("restore-pick") as HTMLButtonElement).disabled).toBe(true);
  });

  it("inspects, asks for the originals folder, confirms, restores and applies the whitelisted preferences", async () => {
    const archive = pickedFile("D:\\old.amberbackup", "restore_archive");
    const originals = pickedFile("D:\\AmberMedia\\Amber-Restored-20261019-120000", "restore_originals_dir");
    fakeShell.inspectBackup.mockResolvedValue({ archive, report: { ok: true, header: HEADER } });
    fakeShell.pickRestoreOriginalsDir.mockResolvedValue(originals);
    let answer: (report: RestoreApplyReport) => void = () => undefined;
    fakeShell.restoreBackup.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    render({ ...FRESH, "POST /api/backup/estimate": { body: ESTIMATE } });
    await waitFor(() => expect((screen.getByTestId("restore-pick") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("restore-pick"));
    const summary = await screen.findByTestId("restore-summary");
    expect(summary.textContent).toContain("待完整校验");
    expect(summary.textContent).toContain("内容 3 条 · 合集 1 个 · 笔记 5 条");
    expect(summary.textContent).toContain("包含本地原始音视频 1 个");
    const start = screen.getByTestId("restore-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("restore-pick-originals"));
    expect((await screen.findByTestId("restore-originals-dir")).textContent).toContain("Amber-Restored-20261019-120000");
    expect(fakeShell.pickRestoreOriginalsDir).toHaveBeenCalledWith(expect.stringMatching(/^\d{8}-\d{6}$/u));
    fireEvent.click(start);
    const confirm = await screen.findByTestId("restore-confirm");
    expect(confirm.textContent).toContain("外观");
    expect(confirm.textContent).toContain("任务并发");
    expect(confirm.textContent).toContain("API Key 不在备份中");
    expect(confirm.textContent).toContain("平台账号需要重新登录");
    fireEvent.click(screen.getByTestId("restore-confirm-start"));
    await screen.findByTestId("restore-overlay");
    await waitFor(() => expect(fakeShell.restoreBackup).toHaveBeenCalledWith(archive.grant, originals.grant));
    act(() => fakeShell.emit(EVENT_RESTORE_PROGRESS, { phase: "originals", done: 1, total: 2 }));
    expect(screen.getByTestId("restore-overlay").textContent).toContain("复制原始音视频 1 / 2");
    act(() => {
      fakeShell.emit(EVENT_SIDECAR_RESTARTED);
      answer(RESTORED);
    });
    const result = await screen.findByTestId("restore-result");
    expect(result.getAttribute("data-ok")).toBe("true");
    expect(result.textContent).toContain("2 个模型配置需要重新填写 API Key");
    expect(screen.queryByTestId("restore-overlay")).toBeNull();
    expect(localStorage.getItem("amber.player.volume")).toBe("0.5");
    expect(localStorage.getItem("amber.notes.color.underline")).toBe("green");
    expect(localStorage.getItem("amber.player.endBehavior")).toBeNull();
    expect(screen.getByTestId("restore-preferences").textContent).toBe("界面偏好：已应用 2 项，写入失败 0 项，丢弃 2 项。");
  });

  it("shows a failed restore and an invalid backup without changing anything", async () => {
    const archive = pickedFile("D:\\bad.amberbackup", "restore_archive");
    const invalid = { class: "backup_invalid" as const, code: "backup_invalid", retryDisposition: "never" as const, userMessage: "备份文件无效或已损坏，未做任何更改" };
    fakeShell.inspectBackup.mockResolvedValueOnce({ archive, report: { ok: false, error: invalid } });
    render({ ...FRESH, "POST /api/backup/estimate": { body: ESTIMATE } });
    await waitFor(() => expect((screen.getByTestId("restore-pick") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("restore-pick"));
    expect(await screen.findByText("备份文件无效或已损坏，未做任何更改")).toBeTruthy();
    expect(screen.queryByTestId("restore-summary")).toBeNull();

    fakeShell.inspectBackup.mockResolvedValueOnce({ archive, report: { ok: true, header: { ...HEADER, originals: [], counts: { ...HEADER.counts, originals: 0 } } } });
    fakeShell.restoreBackup.mockResolvedValue({ ok: false, error: invalid });
    fireEvent.click(screen.getByTestId("restore-pick"));
    fireEvent.click(await screen.findByTestId("restore-start"));
    fireEvent.click(await screen.findByTestId("restore-confirm-start"));
    const result = await screen.findByTestId("restore-result");
    expect(result.getAttribute("data-ok")).toBe("false");
    expect(result.textContent).toContain("恢复失败，原有数据未改动");
    expect(fakeShell.restoreBackup).toHaveBeenCalledWith(archive.grant, null);
  });

  it("reports the shell refusing to start a restore", async () => {
    fakeShell.inspectBackup.mockResolvedValue({ archive: pickedFile("D:\\a.amberbackup", "restore_archive"), report: { ok: true, header: { ...HEADER, originals: [] } } });
    fakeShell.restoreBackup.mockRejectedValue(new Error("an update install is under way"));
    render({ ...FRESH, "POST /api/backup/estimate": { body: ESTIMATE } });
    await waitFor(() => expect((screen.getByTestId("restore-pick") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("restore-pick"));
    fireEvent.click(await screen.findByTestId("restore-start"));
    fireEvent.click(await screen.findByTestId("restore-confirm-start"));
    expect((await screen.findByRole("alert")).textContent).toContain("an update install is under way");
  });
});
