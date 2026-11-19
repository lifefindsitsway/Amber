import i18next from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIGURE_UPLOAD_MAX_BYTES, FIGURES_PER_CONTENT_MAX } from "../../../../src/shared/defaults.ts";
import type { AppError } from "../../../../src/shared/errors.ts";
import { ApiError } from "../../../../src/web/api/client.ts";
import {
  checkFigureFile,
  figureInsertErrorText,
  figureInsertStatus,
  figuresAtLimit,
  freezeInsert,
  insertTarget,
  isSupportedImageSignature,
} from "../../../../src/web/pages/content/figure-insert.ts";
import { targetAfter } from "../../../fixtures/web/figure-insert.tsx";

const t = i18next.t.bind(i18next);
const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

afterEach(() => figureInsertStatus.clear());

describe("isSupportedImageSignature / checkFigureFile", () => {
  it("knows PNG, JPEG and WebP by their first bytes, and nothing else", () => {
    expect(isSupportedImageSignature(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
    expect(isSupportedImageSignature(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(isSupportedImageSignature(bytes(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")))).toBe(true);
    expect(isSupportedImageSignature(bytes(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")))).toBe(false);
    expect(isSupportedImageSignature(bytes(...ascii("GIF89a")))).toBe(false);
    expect(isSupportedImageSignature(bytes())).toBe(false);
  });

  it("refuses by size before reading, and by bytes rather than by name or type", async () => {
    expect(await checkFigureFile(new File([bytes(0xff, 0xd8, 0xff)], "x.txt", { type: "text/plain" }))).toBeUndefined();
    expect(await checkFigureFile(new File(["hello"], "x.png", { type: "image/png" }))).toBe("unsupported");
    expect(await checkFigureFile(new File([], "empty.png", { type: "image/png" }))).toBe("unsupported");
    expect(await checkFigureFile(new File([new Uint8Array(FIGURE_UPLOAD_MAX_BYTES + 1)], "big.png"))).toBe("too_large");
  });
});

describe("figuresAtLimit", () => {
  it("counts the recently deleted ones too", () => {
    const list = (live: number, deleted: number) => ({ items: Array(live).fill({}), recentlyDeleted: Array(deleted).fill({}), limit: FIGURES_PER_CONTENT_MAX }) as never;
    expect(figuresAtLimit(undefined)).toBe(false);
    expect(figuresAtLimit(list(FIGURES_PER_CONTENT_MAX - 2, 1))).toBe(false);
    expect(figuresAtLimit(list(FIGURES_PER_CONTENT_MAX - 2, 2))).toBe(true);
  });
});

const apiError = (error: Partial<AppError>): ApiError => new ApiError(400, { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "", ...error });

describe("figureInsertErrorText", () => {
  it("says each capture failure in words", () => {
    expect(figureInsertErrorText(apiError({ code: "invalid_request.figure_frame", details: { reason: "past_end" } }), t)).toBe("已到片尾，没有可截取的画面，往前一点再试");
    expect(figureInsertErrorText(apiError({ code: "invalid_request.figure_frame", details: { reason: "no_video" } }), t)).toBe("这个文件没有画面，无法截图");
    expect(figureInsertErrorText(apiError({ code: "invalid_request.figure_frame", details: { reason: "failed" } }), t)).toBe("截取画面失败，请重试");
    expect(figureInsertErrorText(apiError({ class: "media_missing", code: "media_missing" }), t)).toBe("找不到视频文件，无法截图");
  });

  it("says each image refusal, the cap and a purged figure in words", () => {
    expect(figureInsertErrorText(apiError({ code: "invalid_request.figure_image", details: { reason: "corrupt" } }), t)).toBe("图片已损坏，无法读取");
    expect(figureInsertErrorText(apiError({ code: "invalid_request.figure_image", details: { reason: "too_large" } }), t)).toBe("图片超过 20 MB，无法插入");
    expect(figureInsertErrorText(apiError({ code: "invalid_request.figure_limit", details: { limit: 100 } }), t)).toBe("插图已达 100 张上限（最近删除的也计在内）");
    expect(figureInsertErrorText(apiError({ class: "not_found", code: "not_found.figure_purged" }), t)).toBe("这张插图已超过保留期，无法恢复");
  });

  it("falls back to the server's own words, then the class's", () => {
    expect(figureInsertErrorText(apiError({ class: "internal", code: "internal", userMessage: "服务内部错误" }), t)).toBe("服务内部错误");
    expect(figureInsertErrorText(new Error("x"), t)).toBe("操作失败，请重试");
  });
});

describe("freezeInsert / insertTarget", () => {
  it("takes the paragraph and the frame once, at the call", () => {
    const api = { captureTarget: vi.fn(() => targetAfter("s2", 20_000)), targetForTime: vi.fn((atMs: number) => targetAfter("t", atMs)) };
    const frozen = freezeInsert(api, () => ({ assetId: "A", atMs: 7_000 }));
    expect(frozen).toEqual({ target: targetAfter("s2", 20_000), frame: { assetId: "A", atMs: 7_000, target: targetAfter("t", 7_000) } });
    expect(freezeInsert(undefined, () => ({ assetId: "A", atMs: 7_000 }))).toEqual({ target: undefined, frame: undefined });
    expect(freezeInsert(api, undefined).frame).toBeUndefined();
  });

  it("falls back to the opening paragraph when nothing marks one", () => {
    const api = { captureTarget: () => undefined, targetForTime: (atMs: number) => targetAfter("first", atMs) };
    expect(insertTarget(api)).toEqual(targetAfter("first", 0));
  });
});

describe("figureInsertStatus", () => {
  const start = (kind: "upload" | "paste" | "capture", contentId = "c1", cancel?: () => void) =>
    figureInsertStatus.start({ contentId, origin: "reader", kind, ...(cancel === undefined ? {} : { cancel }) });
  const phases = (contentId = "c1") => figureInsertStatus.list(contentId, "reader").map((entry) => `${entry.kind}:${entry.phase}`);

  it("keeps two inserts at once apart: each shows, each keeps its own cancel, neither outcome stands in for the other", () => {
    const cancelUpload = vi.fn();
    const upload = start("upload", "c1", cancelUpload);
    const paste = start("paste", "c1", vi.fn());
    expect(phases()).toEqual(["upload:pending", "paste:pending"]);
    const [first] = figureInsertStatus.list("c1", "reader");
    expect(first?.phase === "pending" ? first.cancel : undefined).toBe(cancelUpload);
    // The first one fails: the second is still under way.
    figureInsertStatus.finish(upload, { phase: "failed", message: "坏了" });
    expect(phases()).toEqual(["upload:failed", "paste:pending"]);
    figureInsertStatus.finish(paste, { phase: "done" });
    expect(phases()).toEqual(["upload:failed", "paste:done"]);
    figureInsertStatus.dismiss(upload.id);
    expect(phases()).toEqual(["paste:done"]);
  });

  it("shows each Content only its own: a late failure of another Content takes nothing away", () => {
    const left = start("upload", "A");
    start("upload", "B");
    figureInsertStatus.finish(left, { phase: "failed", message: "A 的失败" });
    expect(phases("B")).toEqual(["upload:pending"]);
    expect(figureInsertStatus.pending("B", "reader")).toBe(true);
    expect(figureInsertStatus.pending("B", "player")).toBe(false);
  });

  it("cancels what is under way when cleared, and an answer arriving after that says nothing", () => {
    const cancel = vi.fn();
    const upload = start("upload", "c1", cancel);
    const capture = start("capture");
    figureInsertStatus.clear();
    expect(cancel).toHaveBeenCalledTimes(1);
    figureInsertStatus.finish(upload, { phase: "cancelled" });
    figureInsertStatus.finish(capture, { phase: "failed", message: "迟到的失败" });
    expect(figureInsertStatus.snapshot()).toEqual([]);
  });
});
