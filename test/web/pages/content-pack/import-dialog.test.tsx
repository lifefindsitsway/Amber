import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContentPackImportJobDto, ContentPackPreviewDto, PackContentDiff, PackPreviewContent } from "../../../../src/shared/dto/content-pack.ts";
import { ImportPackDialog } from "../../../../src/web/pages/content-pack/import-dialog.tsx";
import { fakeShell, pickedFile } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp, type RecordedCall } from "../../../fixtures/web/render.tsx";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: async () => null }));
vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

function diff(extra: Partial<PackContentDiff> = {}): PackContentDiff {
  return {
    revisions: [{ key: "r1", kind: "corrected", originalKind: "corrected", language: "zh", segmentCount: 5, createdAt: 1_790_000_000_000, archived: false, state: "new", standalone: false, becomesCurrentTranslation: false }],
    speakers: [],
    figures: { new: 3, existing: 0, differs: 0, placedByTime: 0, deletedHere: 0 },
    notes: { new: 0, existing: 0, differs: 0, unplaceable: 0 },
    platformChapters: "none",
    media: [{ key: "m1", kind: "original", displayName: "lecture.mp4", sizeBytes: 2048, state: "new" }],
    overLimit: [],
    ...extra,
  };
}

const candidate = (contentId: string, title: string, durationMs = 60_000) => ({ contentId, title, durationMs, reason: "origin" as const, trashed: false });

function item(key: string, extra: Partial<PackPreviewContent> = {}): PackPreviewContent {
  return { key, title: `包里的 ${key}`, sourceKind: "local", durationMs: 60_000, match: "new", candidates: [], diff: diff(), ...extra };
}

const PREVIEW: ContentPackPreviewDto = {
  pack: { formatVersion: 1, createdAt: 1_790_000_000_000, amberVersion: "0.7.3", sizeBytes: 4096, mediaBytes: 2048 },
  contents: [
    item("new"),
    item("same", { match: "same", candidates: [candidate("x", "本机的第二讲")], diff: diff({ targetContentId: "x", figures: { new: 0, existing: 1, differs: 2, placedByTime: 0, deletedHere: 0 }, media: [] }) }),
    item("two", { match: "same", candidates: [candidate("a", "候选甲"), candidate("b", "候选乙")] }),
    item("trash", { match: "trashed", candidates: [{ ...candidate("t", "在回收站的"), trashed: true }] }),
    item("over", { diff: diff({ overLimit: [{ category: "figures", over: 3, limit: 100 }], media: [] }) }),
  ],
  collections: [{ key: "k", name: "课程", contentKeys: ["new", "same"], match: "same_name", candidates: [{ collectionId: "col", name: "课程", memberCount: 4 }] }],
};

/** A job; `preview: undefined` leaves the preview out. */
const job = (extra: Omit<Partial<ContentPackImportJobDto>, "preview"> & { preview?: ContentPackPreviewDto | undefined } = {}): ContentPackImportJobDto => {
  const { preview = "preview" in extra ? undefined : PREVIEW, ...rest } = extra;
  return {
    jobId: "j1",
    status: "awaiting_decisions",
    phase: "preview",
    bytesDone: 0,
    bytesTotal: 0,
    expiresAt: Date.now() + 3_600_000,
    ...rest,
    ...(preview === undefined ? {} : { preview }),
  };
};

function routes(mode: "server" | "local", jobReply: () => ContentPackImportJobDto, extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/version": { body: { version: "0.7.3", mode } },
    "GET /api/content-packs/active": { body: { importJobId: "j1" } },
    "GET /api/content-packs/imports/j1": () => ({ body: jobReply() }),
    ...extra,
  });
}

function rowOf(key: string): HTMLElement {
  return screen.getAllByTestId("pack-import-row").find((row) => row.dataset["key"] === key) as HTMLElement;
}

describe("ImportPackDialog preview", () => {
  it("leads with one conclusion per Content and opens details only where something needs the user", async () => {
    routes("server", () => job());
    renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "server" });
    await screen.findByTestId("pack-import-preview");
    expect(within(rowOf("new")).getByTestId("pack-import-conclusion").textContent).toBe("本机没有 · 将新建");
    expect(within(rowOf("new")).getByTestId("pack-import-changes").textContent).toBe("新增字幕 1 份 · 新增插图 3 张 · 新增音视频 1 个");
    expect(within(rowOf("new")).queryByTestId("pack-import-details")).toBeNull();
    expect(within(rowOf("same")).getByTestId("pack-import-conclusion").textContent).toBe("匹配到《本机的第二讲》· 合并资料");
    // Differing figures open the row and offer the pack's version, off by default.
    const adopt = within(rowOf("same")).getByTestId("pack-import-adopt-toggle") as HTMLInputElement;
    expect(adopt.checked).toBe(false);
    expect(within(rowOf("same")).getByText("采用包里的（插图 2 张）")).toBeTruthy();
    expect(within(rowOf("two")).getByTestId("pack-import-conclusion").textContent).toBe("本机有 2 条可能对应的内容 · 需要你选择");
    expect(within(rowOf("two")).getByTestId("pack-import-candidates")).toBeTruthy();
    expect(within(rowOf("trash")).getByTestId("pack-import-conclusion").textContent).toContain("本机对应的内容在回收站中 · 先恢复或彻底删除");
    expect((within(rowOf("trash")).getByTestId("pack-import-action") as HTMLSelectElement).disabled).toBe(true);
    expect(within(rowOf("over")).getByTestId("pack-import-over-figures").textContent).toContain("超出上限 3 张");
    expect(screen.queryByText(/[0-9A-Z]{20,}/)).toBeNull();
  });

  it("says platform source links may carry access parameters, only when the pack holds a platform Content", async () => {
    routes("server", () => job({ preview: { ...PREVIEW, contents: [item("note", { sourceKind: "xiaohongshu" }), item("file")] } }));
    const view = renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "server" });
    await screen.findByTestId("pack-import-preview");
    expect(screen.getByTestId("pack-import-source-links").textContent).toBe("平台内容的来源链接按包里的原样导入，可能带有平台的访问参数（例如小红书链接里的访问令牌）。");
    view.unmount();

    routes("server", () => job());
    renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "server" });
    await screen.findByTestId("pack-import-preview");
    expect(screen.queryByTestId("pack-import-source-links")).toBeNull();
  });

  it("blocks 「开始导入」 until a target is chosen and the over-limit category is unticked, then sends the decisions", async () => {
    let state = job();
    const commits: RecordedCall[] = [];
    routes("server", () => state, {
      "POST /api/content-packs/imports/j1/compare": { body: diff({ targetContentId: "b", media: [] }) },
      "POST /api/content-packs/imports/j1/commit": (call) => {
        commits.push(call);
        state = job({ status: "importing", phase: "read", bytesTotal: 10, bytesDone: 2, preview: undefined });
        return { status: 202, body: state };
      },
    });
    renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "server" });
    await screen.findByTestId("pack-import-preview");
    const start = screen.getByTestId("pack-import-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("还有 1 条需要你选择对应的内容。")).toBeTruthy();
    fireEvent.click(within(rowOf("two")).getByLabelText(/候选乙/));
    await waitFor(() => expect(within(rowOf("two")).getByTestId("pack-import-conclusion").textContent).toBe("匹配到《候选乙》· 合并资料"));
    expect(start.disabled).toBe(true);
    fireEvent.click(within(rowOf("over")).getByTestId("pack-import-category-figures"));
    await waitFor(() => expect(start.disabled).toBe(false));

    // Making a carried transcript current asks once more.
    fireEvent.click(within(rowOf("same")).getByTestId("pack-import-set-primary"));
    fireEvent.click(await screen.findByTestId("pack-import-confirm-primary-ok"));
    // A same-named collection is new by default; the user joins it.
    fireEvent.change(screen.getByTestId("pack-import-collection-action"), { target: { value: "join:col" } });

    fireEvent.click(start);
    await screen.findByTestId("pack-import-progress");
    const body = commits[0]?.body as { contents: Array<Record<string, unknown>>; collections: unknown[] };
    expect(body.contents.map((entry) => [entry["key"], entry["action"]])).toEqual([
      ["new", "import"],
      ["same", "merge"],
      ["two", "merge"],
      ["trash", "skip"],
      ["over", "import"],
    ]);
    expect(body.contents[1]).toMatchObject({ targetContentId: "x", setPrimaryRevisionKey: "r1", adoptPack: false });
    expect(body.contents[2]).toMatchObject({ targetContentId: "b" });
    expect(body.contents[4]).toMatchObject({ figures: false });
    expect(body.collections).toEqual([{ key: "k", action: "join", targetCollectionId: "col" }]);
  });

  it("keeps a candidate that needs comparing ticked from the click on, while the comparison runs", async () => {
    routes("server", () => job(), { "POST /api/content-packs/imports/j1/compare": { body: diff({ targetContentId: "b", media: [] }) } });
    renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "server" });
    await screen.findByTestId("pack-import-preview");
    const radio = within(rowOf("two")).getByLabelText(/候选乙/) as HTMLInputElement;
    fireEvent.click(radio);
    // Checked at once, not only after the comparison's pending state reaches React on a later tick.
    expect(radio.checked).toBe(true);
    expect((within(rowOf("two")).getByLabelText(/候选甲/) as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(within(rowOf("two")).getByTestId("pack-import-conclusion").textContent).toBe("匹配到《候选乙》· 合并资料"));
    expect(radio.checked).toBe(true);
  });

  it("asks for the originals directory only when 「开始导入」 is pressed in the desktop client", async () => {
    fakeShell.desktop = true;
    const single = { ...PREVIEW, contents: [item("new")], collections: [] };
    const commits: RecordedCall[] = [];
    routes("local", () => job({ preview: single }), {
      "POST /api/content-packs/imports/j1/commit": (call) => {
        commits.push(call);
        return { status: 202, body: job({ status: "importing", phase: "read", preview: undefined }) };
      },
    });
    renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "local" });
    await screen.findByTestId("pack-import-preview");
    expect(fakeShell.pickPackOriginalsDir).not.toHaveBeenCalled();
    fakeShell.pickPackOriginalsDir.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByTestId("pack-import-start"));
    expect(await screen.findByText("没有选择原始文件的存放位置，尚未开始导入。")).toBeTruthy();
    expect(commits).toHaveLength(0);
    fakeShell.pickPackOriginalsDir.mockResolvedValueOnce(pickedFile("D:/Amber-Imported-20261118-103000", "pack_originals_dir"));
    fireEvent.click(screen.getByTestId("pack-import-start"));
    await waitFor(() => expect(commits).toHaveLength(1));
    expect((commits[0]?.body as { originalsDir: { purpose: string } }).originalsDir.purpose).toBe("pack_originals_dir");
    expect(fakeShell.pickPackOriginalsDir.mock.calls[1]?.[0]).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe("ImportPackDialog results", () => {
  const finished = (collection: "failed" | "created") =>
    job({
      status: "finished",
      phase: "collections",
      preview: undefined,
      result: {
        contents: [
          { key: "a", title: "新的一讲", status: "imported", contentId: "c-new", added: { revisions: 2, speakers: 1, figures: 3, notes: 0, media: 1 }, updated: { figures: 0, notes: 0 }, conflicts: { revisions: 0, figures: 0, notes: 0, media: 0 }, placedByTime: 1 },
          { key: "b", title: "合并的", status: "merged", contentId: "c-old", added: { revisions: 1, speakers: 0, figures: 0, notes: 0, media: 0 }, updated: { figures: 1, notes: 0 }, conflicts: { revisions: 1, figures: 0, notes: 0, media: 0 }, placedByTime: 0 },
        ],
        collections: [
          collection === "failed"
            ? { key: "k", name: "课程", status: "failed", added: 0, error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "写入合集失败" } }
            : { key: "k", name: "课程", status: "created", collectionId: "col", added: 2 },
        ],
      },
    });

  it("lists every Content with a link and the collections apart; a failed collection is never 「导入完成」 and can be retried", async () => {
    let state = finished("failed");
    routes("server", () => state, {
      "POST /api/content-packs/imports/j1/retry-collections": () => {
        state = finished("created");
        return { status: 202, body: state };
      },
    });
    renderApp(<ImportPackDialog open onClose={() => undefined} resumeJobId="j1" />, { mode: "server" });
    const result = await screen.findByTestId("pack-import-result");
    expect(result.dataset["allOk"]).toBe("false");
    expect(screen.getByTestId("pack-import-result-title").textContent).toBe("部分内容没有导入成功");
    expect(screen.getAllByRole("link", { name: "打开" }).map((link) => link.getAttribute("href"))).toEqual(["/contents/c-new", "/contents/c-old"]);
    expect(screen.getByText("已新建 · 新增：字幕 2 份、发言人 1 位、插图 3 张、音视频 1 个")).toBeTruthy();
    expect(screen.getByText("冲突未导入：字幕 1 份")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pack-import-retry-collections"));
    await waitFor(() => expect(screen.getByTestId("pack-import-result-title").textContent).toBe("导入完成"));
    expect(screen.queryByTestId("pack-import-retry-collections")).toBeNull();
  });

  it("says a preview ran out instead of showing it", async () => {
    routes("server", () => job({ status: "cancelled", expiresAt: Date.now() - 1, preview: undefined }));
    renderApp(<ImportPackDialog open onClose={() => undefined} resumeJobId="j1" />, { mode: "server" });
    expect((await screen.findByTestId("pack-import-cancelled")).textContent).toContain("预览已过期，暂存的文件已清理。请重新选择内容包。");
  });
});

describe("collectionStatusText", () => {
  it("tells a collection with nothing to add from one the user left alone", async () => {
    const { collectionStatusText } = await import("../../../../src/web/pages/content-pack/import-dialog.tsx");
    const i18next = (await import("i18next")).default;
    const { zhCN } = await import("../../../../src/shared/i18n/zh-CN/index.ts");
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
    const t = i18n.t.bind(i18n);
    const base = { key: "k", name: "课程", added: 0 };
    expect(collectionStatusText({ ...base, status: "skipped" }, "join", t)).toBe("没有可加入的内容");
    expect(collectionStatusText({ ...base, status: "skipped" }, "skip", t)).toBe("未处理");
    expect(collectionStatusText({ ...base, status: "skipped" }, undefined, t)).toBe("未处理");
    expect(collectionStatusText({ ...base, status: "joined" }, "join", t)).toBe("已在合集中，无新增");
    expect(collectionStatusText({ ...base, status: "joined", added: 2 }, "join", t)).toBe("已加入，新增 2 条");
  });
});

describe("ImportPackDialog details the server added", () => {
  const pack = { formatVersion: 1, createdAt: 1_790_000_000_000, amberVersion: "0.7.3", sizeBytes: 4096, mediaBytes: 0 };
  const at = (day: number, hour: number, minute: number): number => new Date(2026, 10, day, hour, minute).getTime();

  it("names the local revision a carried one reads the same as, and both sides' latest changes as a hint", async () => {
    const merged = item("m", {
      match: "same",
      candidates: [candidate("x", "本机的讲座")],
      diff: diff({
        targetContentId: "x",
        revisions: [
          {
            key: "r9",
            kind: "corrected",
            originalKind: "corrected",
            language: "zh",
            segmentCount: 5,
            createdAt: at(17, 9, 0),
            archived: false,
            state: "new",
            standalone: false,
            becomesCurrentTranslation: false,
            sameTextAs: "local-rev",
            sameTextAsRevision: { kind: "corrected", language: "zh", createdAt: at(18, 10, 2), modelName: "deepseek-flash" },
          },
        ],
        notes: { new: 0, existing: 0, differs: 2, unplaceable: 0, differsUpdatedAt: { here: at(18, 10, 2), pack: at(17, 21, 30) } },
        media: [],
      }),
    });
    routes("server", () => job({ preview: { pack, contents: [merged], collections: [] } }));
    renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "server" });
    await screen.findByTestId("pack-import-preview");
    // Differing notes open the row by themselves.
    expect(within(rowOf("m")).getByTestId("pack-import-same-text").textContent).toBe("与本机《校对稿 · deepseek-flash · 11-18 10:02》文字和时间都相同，仍作为独立版本导入");
    const times = within(rowOf("m")).getByTestId("pack-import-adopt-times");
    expect(times.textContent).toContain("笔记最近修改：本机 11-18 10:02 · 包里 11-17 21:30");
    expect(times.textContent).toContain("两台设备的时钟未必一致，仅供参考。");
  });

  it("asks for each of two rows that match one local Content, and stops two rows merging into one", async () => {
    const shared = (key: string, title: string) => item(key, { title, match: "same_media", candidates: [{ ...candidate("x", "本机录屏"), reason: "fingerprint" as const }], diff: diff({ media: [] }) });
    routes("server", () => job({ preview: { pack, contents: [shared("a", "录屏甲"), shared("b", "录屏乙")], collections: [] } }), {
      "POST /api/content-packs/imports/j1/compare": { body: diff({ targetContentId: "x", media: [] }) },
    });
    renderApp(<ImportPackDialog open onClose={() => undefined} />, { mode: "server" });
    await screen.findByTestId("pack-import-preview");
    for (const key of ["a", "b"]) {
      expect(within(rowOf(key)).getByTestId("pack-import-conclusion").textContent).toBe("与《本机录屏》匹配，包里还有别的内容也匹配到它 · 需要你选择");
      expect((within(rowOf(key)).getByTestId("pack-import-action") as HTMLSelectElement).value).toBe("");
    }
    expect(within(rowOf("a")).getByTestId("pack-import-shared").textContent).toBe("「录屏乙」和这一条都与本机《本机录屏》匹配，请分别决定。");
    const start = screen.getByTestId("pack-import-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("还有 2 条需要你选择对应的内容。")).toBeTruthy();

    fireEvent.click(within(rowOf("a")).getByLabelText(/本机录屏/));
    await waitFor(() => expect(within(rowOf("a")).getByTestId("pack-import-conclusion").textContent).toBe("音视频与《本机录屏》相同 · 合并资料"));
    fireEvent.click(within(rowOf("b")).getByLabelText(/本机录屏/));
    await waitFor(() => expect(within(rowOf("b")).getByTestId("pack-import-same-target")).toBeTruthy());
    expect(within(rowOf("b")).getByTestId("pack-import-same-target").textContent).toBe("「录屏甲」也要合并到《本机录屏》。一次导入里，一条本机内容只能合并一条，请改选其中一条。");
    expect(within(rowOf("a")).getByTestId("pack-import-same-target")).toBeTruthy();
    expect(start.disabled).toBe(true);
    expect(screen.getByText("有 2 条内容要合并到同一条本机内容，请改选。")).toBeTruthy();

    fireEvent.change(within(rowOf("b")).getByTestId("pack-import-action"), { target: { value: "import" } });
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(within(rowOf("a")).queryByTestId("pack-import-same-target")).toBeNull();
  });
});
