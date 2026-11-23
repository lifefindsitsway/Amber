import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LinkRecognition, recognitionSummary } from "../../../src/web/components/link-scope-hint.tsx";
import { parseLinkText } from "../../../src/web/links.ts";
import { SHORT, UNSUPPORTED, VIDEO_2, YT_LIST, YT_VIDEO } from "../../fixtures/platform/share-text.ts";

const VIDEO = "https://www.bilibili.com/video/BV1xx411c7mD";
const LIST = "https://space.bilibili.com/12345/lists/678?type=season";

function line(text: string, pasted?: number): string | null {
  render(<LinkRecognition parsed={parseLinkText(text)} pasted={pasted} id="recognition" onPreview={() => undefined} />);
  const shown = screen.queryByTestId("link-recognition")?.textContent ?? null;
  cleanup();
  return shown;
}

describe("recognitionSummary", () => {
  it("says nothing for an empty box or one plain link", () => {
    expect(recognitionSummary(parseLinkText(""), undefined)).toEqual({ collections: 0 });
    expect(recognitionSummary(parseLinkText(VIDEO), undefined)).toEqual({ collections: 0 });
  });

  it("says nothing for words or unsupported links alone, which go to the server as written", () => {
    expect(recognitionSummary(parseLinkText(`${UNSUPPORTED}\n看这个`), undefined)).toEqual({ collections: 0 });
  });

  it("picks the first half by what was pasted, then collections, then several links", () => {
    expect(recognitionSummary(parseLinkText(`${VIDEO}\n${YT_LIST}`), 2).lead).toEqual({ key: "pasted", count: 2 });
    expect(recognitionSummary(parseLinkText(`${VIDEO}\n${YT_LIST}\n${LIST}`), undefined).lead).toEqual({ key: "collections", count: 2 });
    expect(recognitionSummary(parseLinkText(`${VIDEO}\n${YT_VIDEO}`), undefined).lead).toEqual({ key: "batch", count: 2 });
  });

  it("names one link only when something else is in the box", () => {
    expect(recognitionSummary(parseLinkText(`${VIDEO}\n一行字`), undefined)).toEqual({ lead: { key: "links", count: 1 }, rest: { key: "lines", count: 1 }, collections: 0 });
    expect(recognitionSummary(parseLinkText(`${VIDEO}。`), undefined).rest).toEqual({ key: "text", count: 0 });
    expect(recognitionSummary(parseLinkText(`${VIDEO}\n${UNSUPPORTED}\n一行字`), undefined).rest).toEqual({ key: "unsupported", count: 1 });
  });
});

describe("LinkRecognition", () => {
  it("shows every case of the one line under the box", () => {
    expect(line("")).toBeNull();
    expect(line(VIDEO)).toBeNull();
    expect(line(`${VIDEO}\n${YT_VIDEO}\n${SHORT}`)).toBe("已识别 3 条链接，将作为一批导入");
    expect(line(`${VIDEO}\n${YT_LIST}`)).toBe("已识别 1 个合集，开始处理前可以挑选内容并安排顺序·预览合集");
    expect(line(`${VIDEO}\n${YT_VIDEO}\n${UNSUPPORTED}\n${UNSUPPORTED}/2\n一行`)).toBe("已识别 2 条链接，将作为一批导入，另有 2 条不支持、不会提交·查看");
    expect(line(`${VIDEO}\n一行`)).toBe("已识别 1 条链接，另有 1 行文字不会提交");
    expect(line(`【标题】 ${VIDEO}`)).toBe("已识别 1 条链接，链接以外的文字不会提交");
    expect(line(`${VIDEO}\n${VIDEO_2}`, 2)).toBe("已从分享内容中提取 2 条链接");
  });

  it("combines a pasted share text holding a collection and an unsupported link into one line", () => {
    expect(line(`${VIDEO}\n${YT_LIST}\n${UNSUPPORTED}`, 3)).toBe("已从分享内容中提取 3 条链接，另有 1 条不支持、不会提交·查看·预览合集");
  });

  it("lists at most twenty links left out in place and counts the rest, with the lines holding no link", () => {
    const others = Array.from({ length: 23 }, (_, index) => `https://example.com/item-${index}`);
    render(<LinkRecognition parsed={parseLinkText([VIDEO, ...others, "一行说明"].join("\n"))} pasted={undefined} id="recognition" />);
    expect(screen.getByTestId("link-recognition-text").textContent).toBe("已识别 1 条链接，另有 23 条不支持、不会提交");
    const toggle = screen.getByTestId("link-recognition-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const details = screen.getByTestId("link-recognition-details");
    expect(toggle.getAttribute("aria-controls")).toBe(details.id);
    expect(details.querySelectorAll("li")).toHaveLength(20);
    expect(details.textContent).toContain("https://example.com/item-19");
    expect(details.textContent).not.toContain("https://example.com/item-20");
    expect(details.textContent).toContain("还有 3 条未列出");
    expect(details.textContent).toContain("另有 1 行文字不含链接，也不会提交");
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByTestId("link-recognition-details")).toBeNull();
  });

  it("offers no list when only words were left out, and no preview without a handler", () => {
    render(<LinkRecognition parsed={parseLinkText(`【标题】 ${YT_LIST}`)} pasted={undefined} id="recognition" />);
    expect(screen.queryByTestId("link-recognition-toggle")).toBeNull();
    expect(screen.queryByTestId("link-recognition-preview")).toBeNull();
  });

  it("opens the preview from 「预览合集」 and names the sentence for the box", () => {
    const onPreview = vi.fn();
    render(<LinkRecognition parsed={parseLinkText(YT_LIST)} pasted={undefined} id="recognition" onPreview={onPreview} />);
    expect(document.getElementById("recognition")?.textContent).toBe("已识别 1 个合集，开始处理前可以挑选内容并安排顺序");
    fireEvent.click(screen.getByRole("button", { name: "预览合集" }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
});
