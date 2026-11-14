import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SubtitleInspectResponse } from "../../../../src/shared/dto/subtitle-import.ts";
import type { AppError } from "../../../../src/shared/errors.ts";
import { buildSubtitleImportOptions } from "../../../../src/web/pages/content/subtitle-import-choice.ts";
import type { SubtitlePreviewState } from "../../../../src/web/pages/content/subtitle-import-data.ts";
import { SubtitleImportPreview, useSubtitleImportChoice } from "../../../../src/web/pages/content/subtitle-import-preview.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { packagePreview, prefixPreview, srtPreview, target } from "../../../fixtures/web/subtitle-preview.ts";

const SPEAKER = { colorIndex: 0, used: true } as const;

/** The preview with its choice held as the hosts hold it, and the options that choice builds. */
function Harness(props: { state: SubtitlePreviewState; originalLanguage?: string; onRefresh?: () => void }) {
  const preview = props.state.status === "ready" ? props.state.preview : undefined;
  const [choice, setChoice] = useSubtitleImportChoice(preview);
  return (
    <>
      <SubtitleImportPreview state={props.state} choice={choice} onChoice={setChoice} onRefresh={props.onRefresh ?? (() => undefined)} originalLanguage={props.originalLanguage} contentId="c1" />
      <output data-testid="options">{preview === undefined || choice === undefined ? "" : JSON.stringify(buildSubtitleImportOptions(preview, choice))}</output>
    </>
  );
}

function show(preview: SubtitleInspectResponse, originalLanguage = "zh-CN") {
  const { calls } = mockApi({});
  renderApp(<Harness state={{ status: "ready", preview }} originalLanguage={originalLanguage} />);
  return { calls, options: () => JSON.parse(screen.getByTestId("options").textContent ?? "{}") as Record<string, unknown> };
}

describe("subtitle preview of a package", () => {
  it("shows three numbers and one line of what is restored, without choosing names", () => {
    show(packagePreview());
    const panel = screen.getByTestId("subtitle-preview");
    expect(within(panel).getByRole("heading", { level: 3 }).textContent).toContain("Amber 字幕包");
    expect(screen.getByTestId("subtitle-preview-summary").textContent).toContain("原文：简体中文");
    expect(screen.getByTestId("subtitle-preview-summary").textContent).toContain("由 Amber 0.7.0 导出");
    expect(screen.getByTestId("subtitle-preview-package-sentences").textContent).toBe("句数2,888");
    expect(screen.getByTestId("subtitle-preview-package-speakers").textContent).toBe("发言人2");
    expect(screen.getByTestId("subtitle-preview-package-translations").textContent).toBe("译文语言英语");
    expect(within(panel).getByText(/还原逐句时间/)).toBeTruthy();
    expect(within(panel).queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByTestId("subtitle-preview-translation")).toBeNull();
    // The scope line already says what a package leaves behind.
    expect(screen.queryByTestId("subtitle-preview-limits")).toBeNull();
  });

  it("names a styled ASS whose restore data held as such", () => {
    show(packagePreview({ format: "ass" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("带样式 ASS · 含还原数据");
  });
});

describe("subtitle preview of an SRT with leading names", () => {
  it("lists the candidates with their counts, preselected as the preview says", () => {
    show(prefixPreview());
    const boxes = screen.getAllByTestId("subtitle-preview-candidate") as HTMLInputElement[];
    expect(boxes.map((box) => [box.dataset["key"], box.checked])).toEqual([
      ["张三", true],
      ["李四", true],
      ["注意", false],
    ]);
    expect(boxes[0]?.closest("label")?.textContent).toBe("张三4 句");
    expect(screen.getByTestId("subtitle-preview-stats").textContent).toBe("有标注 7 句 · 沿用（推断）3 句 · 未分配 0 句");
  });

  it("recounts locally for another rule or another set of names, without asking the server", () => {
    const { calls, options } = show(prefixPreview());
    const inherit = screen.getByTestId("subtitle-preview-unlabeled-inherit") as HTMLInputElement;
    expect(inherit.checked).toBe(true);
    expect(inherit.closest("label")?.textContent).toBe("只在换人时标了名字：归上一位");
    fireEvent.click(screen.getByTestId("subtitle-preview-unlabeled-unassigned"));
    expect(screen.getByTestId("subtitle-preview-stats").textContent).toBe("有标注 7 句 · 沿用（推断）0 句 · 未分配 3 句");
    fireEvent.click(screen.getByTestId("subtitle-preview-unlabeled-inherit"));
    fireEvent.click(screen.getAllByTestId("subtitle-preview-candidate")[0] as HTMLElement);
    expect(screen.getByTestId("subtitle-preview-stats").textContent).toBe("有标注 3 句 · 沿用（推断）3 句 · 未分配 4 句");
    expect(options()).toMatchObject({ speakers: { prefixNames: ["李四"], unlabeled: "inherit" } });
    expect(calls).toHaveLength(0);
  });

  it("drops the unlabeled rule while no name is chosen", () => {
    show(prefixPreview());
    for (const box of screen.getAllByTestId("subtitle-preview-candidate") as HTMLInputElement[]) {
      if (box.checked) fireEvent.click(box);
    }
    expect(screen.queryByTestId("subtitle-preview-unlabeled-inherit")).toBeNull();
    expect(screen.getByTestId("subtitle-preview-stats").textContent).toBe("有标注 0 句 · 沿用（推断）0 句 · 未分配 10 句");
  });

  it("keeps the differences of the format behind a disclosure", () => {
    show(prefixPreview());
    const limits = screen.getByTestId("subtitle-preview-limits");
    expect(limits.tagName).toBe("DETAILS");
    expect(within(limits).getByText("导入后会有的差异（2）")).toBeTruthy();
    expect(within(limits).getByText("标准格式不保存发言人身份，同名的不同发言人会合为一人")).toBeTruthy();
  });
});

describe("subtitle preview of explicit speakers", () => {
  it("shows the speakers a VTT names, read-only, and how many cues stay unassigned", () => {
    show(
      srtPreview({
        format: "vtt",
        speakers: {
          source: "explicit",
          candidates: [
            { key: "Ann", label: "Ann", count: 6, preselected: true },
            { key: "Bob", label: "Bob", count: 3, preselected: true },
          ],
          sequence: [
            [0, 6],
            [1, 3],
            [-1, 1],
          ],
        },
        limits: ["multi_voice"],
      }),
    );
    expect(screen.getAllByTestId("subtitle-preview-speaker").map((item) => item.textContent)).toEqual(["Ann6 句", "Bob3 句"]);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("另有 1 句没有标注，保持未分配")).toBeTruthy();
  });
});

describe("subtitle preview of translations", () => {
  const bilingual = srtPreview({
    bilingual: {
      source: "lines",
      count: 9,
      samples: [
        { original: "你好", translation: "Hello" },
        { original: "再见", translation: "Goodbye" },
        { original: "第三组", translation: "Third" },
      ],
    },
  });

  it("appears only when the file has translations", () => {
    show(srtPreview());
    expect(screen.queryByTestId("subtitle-preview-translation")).toBeNull();
  });

  it("shows two real pairs read as original and translation, and starts with 「不导入译文」 for SRT lines", () => {
    const { options } = show(bilingual);
    const samples = screen.getByTestId("subtitle-preview-samples");
    expect(samples.getAttribute("aria-label")).toBe("配对示例");
    expect(within(samples).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["原文：你好译文：Hello", "原文：再见译文：Goodbye"]);
    const select = screen.getByTestId("subtitle-preview-translation-language") as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("不导入译文");
    // The subtitle's own language is not offered for its translation.
    expect([...select.options].map((option) => option.textContent)).not.toContain("简体中文");
    expect([...select.options].map((option) => option.textContent)).not.toContain("繁体中文");
    expect(options()).not.toHaveProperty("translationLanguage");
    fireEvent.change(select, { target: { value: "en" } });
    expect(options()).toMatchObject({ translationLanguage: "en" });
  });

  it("asks for a language for an ASS translation style before anything is chosen", () => {
    show(srtPreview({ format: "ass", bilingual: { source: "style", count: 4, samples: [] } }));
    const select = screen.getByTestId("subtitle-preview-translation-language") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByTestId("subtitle-preview-translation-pick").textContent).toBe("请选择译文语言，或选「不导入译文」");
    fireEvent.change(select, { target: { value: "\u0000skip" } });
    expect(screen.queryByTestId("subtitle-preview-translation-pick")).toBeNull();
  });
});

describe("subtitle preview notices", () => {
  it("puts skipped cues, a time range off the media and altered restore data first", () => {
    show(
      srtPreview({
        format: "ass",
        droppedCues: { count: 3, samples: ["00:00:05,000 --> 00:00:04,000"] },
        limits: ["restore_data_mismatch", "centisecond_timing"],
        target: target({ durationMs: 3_600_000, coverageWarning: true }),
      }),
    );
    const notices = screen.getByTestId("subtitle-preview-notices");
    expect(notices.compareDocumentPosition(screen.getByRole("heading", { level: 3 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...notices.querySelectorAll("[data-notice]")].map((item) => (item as HTMLElement).dataset["notice"])).toEqual(["mismatch", "coverage", "dropped"]);
    expect(within(notices).getByText("文件被修改过，按普通 ASS 导入")).toBeTruthy();
    expect(notices.textContent).toContain("字幕时间（0:00 – 1:02）与媒体时长 1:00:00 不符");
    expect(notices.textContent).toContain("跳过了 3 条无效字幕");
    expect(notices.textContent).toContain("如：00:00:05,000 --> 00:00:04,000");
    // Worded once, at the top.
    expect(within(screen.getByTestId("subtitle-preview-limits")).queryByText(/还原数据/)).toBeNull();
  });
});

describe("subtitle preview into an existing Content", () => {
  const zhang = { ...SPEAKER, id: "sp1", ordinal: 1, name: "张三" };
  const zhangToo = { ...SPEAKER, id: "sp3", ordinal: 3, name: "张三", used: false };

  it("offers one row per same-named speaker, each existing one listed, creating by default", () => {
    const { options } = show(prefixPreview({ target: target({ speakers: [zhang, { ...SPEAKER, id: "sp2", ordinal: 2, name: "王五" }, zhangToo] }) }));
    const rows = screen.getAllByTestId("subtitle-preview-identity");
    expect(rows.map((row) => row.dataset["key"])).toEqual(["张三"]);
    const row = rows[0] as HTMLElement;
    expect(within(row).getByRole("group").textContent).toContain("文件中的「张三」· 4 句");
    expect((within(row).getByTestId("subtitle-preview-identity-create") as HTMLInputElement).checked).toBe(true);
    const reuse = within(row).getAllByTestId("subtitle-preview-identity-reuse") as HTMLInputElement[];
    // Each with the speaker's avatar (here the monogram 「张」), ordinal and whether it is in use.
    expect(reuse.map((input) => input.closest("label")?.textContent)).toEqual(["沿用现有张张三序号 1 · 已在稿中使用", "沿用现有张张三序号 3 · 未被引用"]);
    expect(options()).not.toHaveProperty("identities");
    fireEvent.click(reuse[1] as HTMLElement);
    expect(options()).toMatchObject({ identities: [{ key: "张三", speakerId: "sp3" }], expectedState: { speakers: [{ id: "sp3", name: "张三" }] } });
  });

  it("checks 「导入后设为当前版本」 by default and says when a current translation is replaced", () => {
    const { options } = show(packagePreview({ target: target({ currentTranslations: { en: "t1" } }) }));
    const box = screen.getByTestId("subtitle-preview-set-current") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByTestId("subtitle-preview-current-note").textContent).toBe("导入的译文会设为当前，现有译文保留在历史中");
    fireEvent.click(box);
    expect(screen.getByTestId("subtitle-preview-current-note").textContent).toBe("只新增版本，当前稿与译文不变");
    expect(options()).toMatchObject({ setCurrent: false, expectedState: { primaryRevisionId: "r1", currentTranslations: { en: "t1" } } });
  });

  it("explains when the Content has no room for the new speakers", () => {
    show(prefixPreview({ target: target({ speakerRoom: 1, speakers: [zhang] }) }));
    expect(screen.getByTestId("subtitle-preview-capacity").textContent).toBe("需要新建 2 位发言人，但只剩 1 个名额。请少选几个名字，或改为沿用现有发言人。");
    fireEvent.click(screen.getAllByTestId("subtitle-preview-identity-reuse")[0] as HTMLElement);
    expect(screen.queryByTestId("subtitle-preview-capacity")).toBeNull();
  });
});

describe("subtitle preview states", () => {
  const failure = (code: string): AppError => ({ class: code.split(".")[0] as AppError["class"], code, retryDisposition: "never", userMessage: "" });

  it("says it is reading the file", () => {
    mockApi({});
    renderApp(<Harness state={{ status: "loading" }} />);
    expect(screen.getByTestId("subtitle-preview-loading").textContent).toBe("正在读取字幕…");
  });

  it("gives the reason of a failure, a fresh preview, and the plain import where it can succeed", () => {
    mockApi({});
    const onRefresh = vi.fn();
    renderApp(<Harness state={{ status: "failed", error: failure("not_found") }} onRefresh={onRefresh} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByTestId("subtitle-preview-retry"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("仍可按普通字幕导入：只导入时间和正文，不识别发言人与译文")).toBeTruthy();
  });

  it("offers no plain import for a package from a newer Amber, which would fail the same way", () => {
    mockApi({});
    renderApp(<Harness state={{ status: "failed", error: { ...failure("invalid_request.subtitle_newer"), userMessage: "这个字幕包来自更新版本的 Amber，请升级后再导入" } }} />);
    expect(screen.getByRole("alert").textContent).toContain("这个字幕包来自更新版本的 Amber");
    expect(screen.queryByText(/仍可按普通字幕导入/)).toBeNull();
  });
});
