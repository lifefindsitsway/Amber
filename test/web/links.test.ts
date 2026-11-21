import { describe, expect, it } from "vitest";
import { linesOf, linkPaste, parseLinkText, readCandidate, recognizeLink, type RecognizedLink } from "../../src/web/links.ts";
import {
  APP_SHARE,
  BV,
  LONG_SHARE,
  PART_THEN_TITLE,
  SHORT,
  UNSUPPORTED,
  VIDEO,
  VIDEO_2,
  WEB_SHARE,
  WEB_SHARE_LINK,
  YT_LIST,
  YT_VIDEO,
} from "../fixtures/platform/share-text.ts";

const urls = (links: readonly RecognizedLink[]): string[] => links.map((link) => link.url);

describe("recognizeLink", () => {
  it.each([
    ["https://www.bilibili.com/video/BV1CQt365EzW", { platform: "bilibili", kind: "video", partChosen: false }],
    ["https://www.bilibili.com/video/BV1CQt365EzW/?p=3", { platform: "bilibili", kind: "video", partChosen: true }],
    ["https://www.bilibili.com/video/BV1CQt365EzW?p=9999", { platform: "bilibili", kind: "video", partChosen: true }],
    ["https://space.bilibili.com/123/lists/456", { platform: "bilibili", kind: "collection" }],
    ["https://space.bilibili.com/123/lists/456?type=series", { platform: "bilibili", kind: "collection" }],
    ["https://space.bilibili.com/123/channel/collectiondetail?sid=456", { platform: "bilibili", kind: "collection" }],
    ["https://space.bilibili.com/123/channel/seriesdetail?sid=456", { platform: "bilibili", kind: "collection" }],
    ["https://b23.tv/abc123", { platform: "bilibili", kind: "shortlink" }],
    ["https://www.youtube.com/watch?v=UF8uR6Z6KLc", { platform: "youtube", kind: "video" }],
    ["https://www.youtube.com/watch?v=UF8uR6Z6KLc&list=PL1", { platform: "youtube", kind: "video" }],
    ["https://youtu.be/UF8uR6Z6KLc", { platform: "youtube", kind: "video" }],
    ["https://www.youtube.com/playlist?list=PL12345678", { platform: "youtube", kind: "collection" }],
  ])("accepts %s", (url, expected) => {
    expect(recognizeLink(url)).toMatchObject({ url, ...expected });
  });

  it.each([
    "https://example.com/watch?v=UF8uR6Z6KLc",
    "not a url",
    "ftp://youtu.be/UF8uR6Z6KLc",
    "https://www.bilibili.com/read/cv1",
    "https://www.youtube.com/watch?v=short",
    // Shapes the server refuses: a part that is not 1–9999, a trailing slash after a youtu.be id,
    // a playlist id outside 10–64 characters, a space without a list id.
    "https://www.bilibili.com/video/BV1CQt365EzW?p=0",
    "https://www.bilibili.com/video/BV1CQt365EzW?p=",
    "https://www.bilibili.com/video/BV1CQt365EzW?p=10000",
    "https://www.bilibili.com/video/BV1CQt365EzW?p=2x",
    "https://youtu.be/UF8uR6Z6KLc/",
    "https://www.youtube.com/playlist?list=PL1",
    `https://www.youtube.com/playlist?list=${"P".repeat(65)}`,
    "https://space.bilibili.com/123/channel/collectiondetail",
    "https://space.bilibili.com/123/channel/seriesdetail?sid=x",
    "https://space.bilibili.com/abc/lists/456",
  ])("rejects %s", (text) => {
    expect(recognizeLink(text)).toBeUndefined();
  });

  it("splits a pasted block into trimmed lines", () => {
    expect(linesOf("  https://youtu.be/UF8uR6Z6KLc \n\nhello\r\nhttps://b23.tv/x1\n")).toEqual(["https://youtu.be/UF8uR6Z6KLc", "hello", "https://b23.tv/x1"]);
  });
});

describe("parseLinkText extraction", () => {
  it.each([
    ["title, then link", WEB_SHARE, [WEB_SHARE_LINK]],
    ["link, then title", `${VIDEO} 【示例课程】`, [VIDEO]],
    ["a part link with the title right after its parameter", PART_THEN_TITLE, [`https://www.bilibili.com/video/${BV}?p=2`]],
    ["a full-width full stop after the link", `看这个：${VIDEO}。`, [VIDEO]],
    ["an ASCII full stop after the link", `See ${YT_VIDEO}.`, [YT_VIDEO]],
    ["parentheses around the link", `(${YT_VIDEO})`, [YT_VIDEO]],
    ["full-width parentheses around the link", `（${YT_VIDEO}）`, [YT_VIDEO]],
    ["brackets, angle brackets and quotes", `[${VIDEO}] <${VIDEO_2}> "${YT_VIDEO}"`, [VIDEO, VIDEO_2, YT_VIDEO]],
    ["punctuation piled up after a link", `${YT_VIDEO}?!).`, [YT_VIDEO]],
    ["two links on one line", `${VIDEO} ${YT_VIDEO}`, [VIDEO, YT_VIDEO]],
    ["two links glued together", `${VIDEO}${YT_VIDEO}`, [VIDEO, YT_VIDEO]],
    ["a glued http link", `${VIDEO}http://youtu.be/UF8uR6Z6KLc`, [VIDEO, "http://youtu.be/UF8uR6Z6KLc"]],
    ["the app's share with a short link", APP_SHARE, [SHORT]],
    ["an upper-case scheme", "HTTPS://WWW.YOUTUBE.COM/watch?v=UF8uR6Z6KLc", ["HTTPS://WWW.YOUTUBE.COM/watch?v=UF8uR6Z6KLc"]],
  ])("%s", (_name, text, expected) => {
    expect(urls(parseLinkText(text).links)).toEqual(expected);
  });

  it("reads a long multi-line share message mixing platforms, an unsupported link and chatter", () => {
    const parsed = parseLinkText(LONG_SHARE);
    expect(urls(parsed.links)).toEqual([WEB_SHARE_LINK, `${VIDEO_2}?p=3`, YT_VIDEO, YT_LIST]);
    expect(parsed.links.map((link) => [link.platform, link.kind])).toEqual([
      ["bilibili", "video"],
      ["bilibili", "video"],
      ["youtube", "video"],
      ["youtube", "collection"],
    ]);
    expect(parsed.unsupported).toEqual([UNSUPPORTED]);
    expect(parsed.all).toEqual([WEB_SHARE_LINK, `${VIDEO_2}?p=3`, YT_VIDEO, UNSUPPORTED, YT_LIST]);
    // The opening and closing remarks; the blank line is not counted.
    expect(parsed.ignoredLines).toBe(2);
    expect(parsed.otherText).toBe(true);
  });
});

describe("parseLinkText classification", () => {
  it("separates supported from unsupported links", () => {
    const parsed = parseLinkText(`${VIDEO}\n${UNSUPPORTED}\nhttps://www.bilibili.com/read/cv1`);
    expect(urls(parsed.links)).toEqual([VIDEO]);
    expect(parsed.unsupported).toEqual([UNSUPPORTED, "https://www.bilibili.com/read/cv1"]);
    expect(parsed).toMatchObject({ ignoredLines: 0, otherText: false });
  });

  it("finds no supported link among unsupported links only", () => {
    const parsed = parseLinkText(`${UNSUPPORTED}\nhttps://youtu.be/UF8uR6Z6KLc/`);
    expect(parsed.links).toEqual([]);
    expect(parsed.unsupported).toEqual([UNSUPPORTED, "https://youtu.be/UF8uR6Z6KLc/"]);
  });

  it("finds nothing in plain words, counting each non-blank line", () => {
    expect(parseLinkText("只是一段话\n\n  \n没有链接")).toEqual({ links: [], unsupported: [], all: [], ignoredLines: 2, otherText: true });
    expect(parseLinkText("")).toEqual({ links: [], unsupported: [], all: [], ignoredLines: 0, otherText: false });
  });

  it("counts a bare scheme as words, not as a link", () => {
    expect(parseLinkText("https:// 还没写完")).toMatchObject({ all: [], ignoredLines: 1 });
  });

  it("sees links alone, one per line or separated by spaces, as nothing else", () => {
    expect(parseLinkText(`  ${VIDEO}  \n\n${YT_VIDEO} ${SHORT}\n`).otherText).toBe(false);
    expect(parseLinkText(`${VIDEO}。`).otherText).toBe(true);
  });
});

describe("parseLinkText fidelity", () => {
  it("keeps one of exactly repeated links, in first-seen order", () => {
    const parsed = parseLinkText(`${YT_VIDEO}\n${VIDEO}\n【again】 ${YT_VIDEO}\n${UNSUPPORTED} ${UNSUPPORTED}`);
    expect(urls(parsed.links)).toEqual([YT_VIDEO, VIDEO]);
    expect(parsed.unsupported).toEqual([UNSUPPORTED]);
  });

  it("keeps parameters as written", () => {
    const watchInList = `${YT_VIDEO}&list=PLabcdefghij0123456789&index=3`;
    expect(urls(parseLinkText(`${watchInList}\n${YT_LIST}\n${WEB_SHARE_LINK}`).links)).toEqual([watchInList, YT_LIST, WEB_SHARE_LINK]);
  });

  it("keeps different parts of one video apart", () => {
    const parts = [1, 2, 3].map((part) => `https://www.bilibili.com/video/${BV}?p=${part}`);
    expect(urls(parseLinkText(parts.join("\n")).links)).toEqual(parts);
    // Same video with and without a part are different links, too: the server decides.
    expect(urls(parseLinkText(`${VIDEO}\n${VIDEO}?p=1`).links)).toEqual([VIDEO, `${VIDEO}?p=1`]);
  });
});

describe("readCandidate bounds", () => {
  it("tries a candidate at most nine times, however much punctuation trails it", () => {
    let calls = 0;
    const counting = (text: string): RecognizedLink | undefined => {
      calls += 1;
      return recognizeLink(text);
    };
    expect(readCandidate(`${UNSUPPORTED}${".".repeat(50)}`, counting)).toEqual({ text: `${UNSUPPORTED}${".".repeat(42)}` });
    expect(calls).toBe(9);
    calls = 0;
    expect(readCandidate(`${YT_VIDEO}${")".repeat(8)}`, counting).link?.url).toBe(YT_VIDEO);
    expect(calls).toBe(9);
    calls = 0;
    // Nine trailing characters are one too many to reach the link.
    expect(readCandidate(`${YT_VIDEO}${")".repeat(9)}`, counting).link).toBeUndefined();
    expect(calls).toBe(9);
    calls = 0;
    // Nothing to take off: one attempt.
    readCandidate(UNSUPPORTED, counting);
    expect(calls).toBe(1);
  });

  it("stays quick on large and hostile input", () => {
    const shares = Array.from({ length: 2_000 }, (_, index) => `【第 ${index} 讲】 https://www.bilibili.com/video/${BV}?p=${(index % 9_999) + 1}`).join("\n");
    const hostile = "https://".repeat(50_000);
    const punctuated = Array.from({ length: 2_000 }, (_, index) => `${UNSUPPORTED}/${index}${".".repeat(30)}`).join(" ");
    const started = performance.now();
    expect(parseLinkText(shares).links).toHaveLength(2_000);
    expect(parseLinkText(hostile).all).toEqual([]);
    expect(parseLinkText(punctuated).unsupported).toHaveLength(2_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("linkPaste", () => {
  it("turns a share text into its links alone, one per line, unsupported ones included", () => {
    expect(linkPaste(LONG_SHARE)).toEqual({ text: [WEB_SHARE_LINK, `${VIDEO_2}?p=3`, YT_VIDEO, UNSUPPORTED, YT_LIST].join("\n"), count: 5, tidied: true });
  });

  it("joins with the given separator for a single-line field", () => {
    expect(linkPaste(`${WEB_SHARE}\n${APP_SHARE}`, " ")).toEqual({ text: `${WEB_SHARE_LINK} ${SHORT}`, count: 2, tidied: true });
  });

  it("marks a plain list of links as not tidied", () => {
    expect(linkPaste(`${VIDEO}\n${YT_VIDEO}`)).toEqual({ text: `${VIDEO}\n${YT_VIDEO}`, count: 2, tidied: false });
  });

  it("leaves a paste without a supported link alone", () => {
    expect(linkPaste(`看这个 ${UNSUPPORTED}`)).toBeUndefined();
    expect(linkPaste("只是一段话")).toBeUndefined();
  });
});
