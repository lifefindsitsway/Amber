import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ContentPackExportPlanDto, ExportPlanContent } from "../../../../src/shared/dto/content-pack.ts";
import { ExportPackDialog } from "../../../../src/web/pages/content-pack/export-dialog.tsx";
import { fakeShell, pickedFile } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: async () => null }));
vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const revision = (id: string, extra: object = {}) => ({
  id,
  kind: "asr",
  language: "zh",
  timingFidelity: "segment_only",
  generation: { kind: "asr", modelId: "paraformer" },
  segmentCount: 10,
  createdAt: 1_790_000_000_000,
  primary: false,
  archived: false,
  currentTranslation: false,
  anchoredFigures: 0,
  notes: 0,
  ...extra,
});

function content(id: string, title: string, extra: Partial<ExportPlanContent> = {}): ExportPlanContent {
  return {
    contentId: id,
    title,
    sourceKind: "bilibili",
    durationMs: 600_000,
    revisions: [revision(`${id}-asr`, { primary: true, notes: 2 }) as ExportPlanContent["revisions"][number]],
    figures: 4,
    notes: 2,
    speakers: 0,
    platformChapters: false,
    media: [{ assetId: `${id}-v`, kind: "original", mimeType: "video/mp4", sizeBytes: 1024 * 1024 * 1024 }],
    ...extra,
  };
}

/** The route the app is on, to see where a link went. */
function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.hash}`}</p>;
}

/** The dialog as a page holds it: open until it asks to close. */
function Host(props: { request: { contentIds: string[] } }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <ExportPackDialog open={open} onClose={() => setOpen(false)} request={props.request} />
      <Where />
    </>
  );
}

const PLAN: ContentPackExportPlanDto = {
  contents: [
    content("c1", "第一讲"),
    content("c2", "第二讲", { media: [{ assetId: "c2-a", kind: "cache", mimeType: "audio/mp4", sizeBytes: 1024, quality: "音频" }] }),
    content("c3", "跑着任务的", { blocked: "busy", busyTaskId: "t1" }),
  ],
  collections: [{ collectionId: "k1", name: "课程", memberCount: 20, contentIds: ["c1", "c2"] }],
};

function routes(mode: "server" | "local", extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/version": { body: { version: "0.7.3", mode } },
    "GET /api/content-packs/active": { body: {} },
    "POST /api/content-packs/export-plan": { body: PLAN },
    "GET /api/tasks/t1": { body: { id: "t1", contentId: "c3", kind: "translate", statusProjection: "running", createdAt: 0, stageRuns: [], workUnits: [], eventSeq: 0 } },
    "POST /api/content-packs/exports": { status: 202, body: { jobId: "job1" } },
    ...extra,
  });
}

function open(mode: "server" | "local" = "server", request: { contentIds: string[]; collectionId?: string } = { contentIds: ["c1", "c2", "c3"] }) {
  return renderApp(<ExportPackDialog open onClose={() => undefined} request={request} />, { mode });
}

describe("ExportPackDialog", () => {
  it("shows one card per Content, only the first open, a blocked one with the task that keeps it", async () => {
    routes("server");
    open();
    const cards = await screen.findAllByTestId("pack-export-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0] as HTMLElement).getByTestId("pack-export-card-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(within(cards[1] as HTMLElement).getByTestId("pack-export-card-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(within(cards[1] as HTMLElement).getByTestId("pack-export-card-summary").textContent).toBe("字幕 1 版 · 插图 4 张");
    expect(within(cards[0] as HTMLElement).getByTestId("pack-export-card-summary").textContent).toBe("字幕 1 版 · 插图 4 张 · 视频 1.0 GB");
    expect(await within(cards[2] as HTMLElement).findByText("「翻译」任务还没有结束，结束或取消后才能导出这一条。")).toBeTruthy();
    expect(screen.getByText("本次带 2 / 共 20 条")).toBeTruthy();
  });

  it("names what 「应用到全部」 carries over and applies it", async () => {
    routes("server");
    open();
    const first = (await screen.findAllByTestId("pack-export-card"))[0] as HTMLElement;
    fireEvent.click(within(first).getByTestId("pack-notes"));
    expect(within(first).getByText(/把这一条的选择套用到另外 1 条：字幕稿带当前版本、带插图与备注、带笔记、带原始文件/)).toBeTruthy();
    fireEvent.click(within(first).getByTestId("pack-apply-all"));
    const second = screen.getAllByTestId("pack-export-card")[1] as HTMLElement;
    expect(within(second).getByTestId("pack-export-card-summary").textContent).toBe("字幕 1 版 · 插图 4 张 · 笔记 2 条");
  });

  it("asks for at least a transcript or a file on a local Content before going on", async () => {
    routes("server", { "POST /api/content-packs/export-plan": { body: { contents: [content("c1", "本地的", { sourceKind: "local" })], collections: [] } } });
    open("server", { contentIds: ["c1"] });
    const card = await screen.findByTestId("pack-export-card");
    fireEvent.click(within(card).getByTestId("pack-transcripts-none"));
    fireEvent.click(within(card).getAllByRole("checkbox").find((box) => box.closest("[data-testid=pack-media]") !== null) as HTMLElement);
    expect(within(card).getByTestId("pack-hint-nothing")).toBeTruthy();
    expect((screen.getByTestId("pack-export-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms with the checks, the size and the warning, then starts a server-mode job and offers the download", async () => {
    const api = routes("server", {
      "GET /api/content-packs/exports/job1": {
        body: {
          jobId: "job1",
          status: "succeeded",
          phase: "finalize",
          bytesDone: 10,
          bytesTotal: 10,
          result: { fileName: "课程.amberpack", sizeBytes: 2048, contents: 2, downloadPath: "/api/content-packs/exports/job1/file", expiresAt: Date.now() + 3_600_000 },
        },
      },
    });
    open("server", { contentIds: ["c1", "c2", "c3"], collectionId: "k1" });
    fireEvent.click(await screen.findByTestId("pack-export-next"));
    const confirm = await screen.findByTestId("pack-export-confirm");
    expect(within(confirm).getByText("内容包未加密，包含你的文字与媒体。请只把它存放、传送到你信任的地方。")).toBeTruthy();
    expect(within(confirm).getByText("不导出：「跑着任务的」")).toBeTruthy();
    expect(within(confirm).getByText("合集：「课程」")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pack-export-start"));
    const link = await screen.findByTestId("pack-export-download");
    expect(link.getAttribute("href")).toBe("/api/content-packs/exports/job1/file");
    expect(link.textContent).toContain("课程.amberpack");
    const body = api.calls.find((call) => call.method === "POST" && call.path === "/api/content-packs/exports")?.body as { selection: { contents: Array<{ contentId: string }>; collectionIds: string[] }; grant?: unknown };
    expect(body.selection.contents.map((item) => item.contentId)).toEqual(["c1", "c2"]);
    expect(body.selection.collectionIds).toEqual(["k1"]);
    expect(body.grant).toBeUndefined();
  });

  it("in the desktop client saves where the user picks, and starts nothing when the dialog is cancelled", async () => {
    fakeShell.desktop = true;
    const api = routes("local", {
      "POST /api/content-packs/export-plan": { body: { contents: [content("c1", "第一讲")], collections: [] } },
      "GET /api/content-packs/exports/job1": { body: { jobId: "job1", status: "succeeded", phase: "finalize", bytesDone: 1, bytesTotal: 1, result: { fileName: "第一讲.amberpack", sizeBytes: 1, contents: 1 } } },
    });
    fakeShell.pickPackDestination.mockResolvedValueOnce(null);
    open("local", { contentIds: ["c1"] });
    fireEvent.click(await screen.findByTestId("pack-export-next"));
    fireEvent.click(await screen.findByRole("button", { name: "选择保存位置并导出" }));
    expect(await screen.findByText("没有选择保存位置，尚未开始导出。")).toBeTruthy();
    expect(api.calls.some((call) => call.path === "/api/content-packs/exports")).toBe(false);
    expect(fakeShell.pickPackDestination.mock.calls[0]?.[0]).toMatch(/^第一讲 \d{8}-\d{4}\.amberpack$/);

    fakeShell.pickPackDestination.mockResolvedValueOnce(pickedFile("D:/第一讲.amberpack", "pack_output"));
    fireEvent.click(screen.getByRole("button", { name: "选择保存位置并导出" }));
    expect((await screen.findByTestId("pack-export-saved")).textContent).toBe("已保存为 第一讲.amberpack");
    const body = api.calls.find((call) => call.path === "/api/content-packs/exports")?.body as { grant: { purpose: string } };
    expect(body.grant.purpose).toBe("pack_output");
  });

  it("follows a job already running for the user instead of planning a new one", async () => {
    const api = routes("server", {
      "GET /api/content-packs/active": { body: { exportJobId: "job9" } },
      "GET /api/content-packs/exports/job9": { body: { jobId: "job9", status: "running", phase: "media", bytesDone: 512, bytesTotal: 1024 } },
      "POST /api/content-packs/exports/job9/cancel": { body: { jobId: "job9", status: "cancelled", phase: "media", bytesDone: 512, bytesTotal: 1024 } },
    });
    open();
    const job = await screen.findByTestId("pack-export-job");
    expect(job.getAttribute("data-status")).toBe("running");
    expect(within(job).getByText("正在导出 · 复制音视频文件")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pack-export-cancel"));
    await waitFor(() => expect(screen.getByTestId("pack-export-job").getAttribute("data-status")).toBe("cancelled"));
    expect(api.calls.some((call) => call.path === "/api/content-packs/export-plan")).toBe(false);
  });

  it("after a pack that left covers out, says what the other device will show and leads to saving the covers here", async () => {
    routes("server", {
      "GET /api/content-packs/active": { body: { exportJobId: "job7" } },
      "GET /api/content-packs/exports/job7": {
        body: { jobId: "job7", status: "succeeded", phase: "finalize", bytesDone: 1, bytesTotal: 1, result: { fileName: "课程.amberpack", sizeBytes: 2048, contents: 3, coversLeftOut: 2 } },
      },
    });
    renderApp(<Host request={{ contentIds: ["c1"] }} />, { mode: "server", route: "/library" });
    const note = await screen.findByTestId("pack-export-covers-left-out");
    expect(note.textContent).toBe(
      "2 条内容没有带上封面，导入后会显示原平台的封面（地址失效时不显示）。这个文件不会自动更新；先把封面保存到本机，再导出一次就能带上。保存封面到本机",
    );
    const link = within(note).getByRole("link", { name: "保存封面到本机" });
    expect(link.getAttribute("href")).toBe("/settings/storage#covers");
    fireEvent.click(link);
    expect(screen.getByTestId("where").textContent).toBe("/settings/storage#covers");
    await waitFor(() => expect(screen.queryByTestId("pack-export-job")).toBeNull());
  });

  it("says nothing about covers when every cover that could travel did, or the server did not say", async () => {
    for (const coversLeftOut of [0, undefined]) {
      routes("server", {
        "GET /api/content-packs/active": { body: { exportJobId: "job8" } },
        "GET /api/content-packs/exports/job8": {
          body: { jobId: "job8", status: "succeeded", phase: "finalize", bytesDone: 1, bytesTotal: 1, result: { fileName: "课程.amberpack", sizeBytes: 2048, contents: 1, ...(coversLeftOut === undefined ? {} : { coversLeftOut }) } },
        },
      });
      const view = open("server", { contentIds: ["c1"] });
      expect((await screen.findByTestId("pack-export-job")).getAttribute("data-status")).toBe("succeeded");
      expect(screen.queryByTestId("pack-export-covers-left-out")).toBeNull();
      expect(screen.queryByRole("link", { name: "保存封面到本机" })).toBeNull();
      view.unmount();
    }
  });
});
