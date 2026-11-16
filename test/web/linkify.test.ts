import { describe, expect, it } from "vitest";
import { linkify, type TextPart } from "../../src/web/linkify.ts";

const links = (text: string): string[] => linkify(text).flatMap((part) => (part.kind === "link" ? [part.text] : []));
const joined = (parts: TextPart[]): string => parts.map((part) => part.text).join("");

describe("linkify", () => {
  it.each([
    "",
    "没有链接的简介",
    "https://example.com",
    "看这里 https://example.com/a?b=1#c。",
    "(https://example.com/wiki/Foo_(bar))",
    "https://zh.wikipedia.org/wiki/北京 和 https://example.com了解更多",
    "javascript:alert(1) mailto:a@b.c ftp://x.org",
    "第一行\n\nhttps://a.com/x\r\n第三行 https://b.com。\n",
    "https://",
    "http://:80 https://[::1]:8080/p https://%zz",
    "مرحبا https://example.com/ar مرحبا",
    "😀https://example.com/😀",
  ])("joins its parts back to the input: %j", (text) => {
    expect(joined(linkify(text))).toBe(text);
  });

  it("returns no parts for empty text and one text part without links", () => {
    expect(linkify("")).toEqual([]);
    expect(linkify("只有文字")).toEqual([{ kind: "text", text: "只有文字" }]);
  });

  it("splits text around a link and keeps the href http(s)", () => {
    expect(linkify("见 https://example.com/a 结束")).toEqual([
      { kind: "text", text: "见 " },
      { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: " 结束" },
    ]);
  });

  it.each([
    ["https://example.com/a.", "https://example.com/a"],
    ["https://example.com/a,", "https://example.com/a"],
    ["https://example.com/a;", "https://example.com/a"],
    ["https://example.com/a:", "https://example.com/a"],
    ["https://example.com/a!", "https://example.com/a"],
    ["https://example.com/a?", "https://example.com/a"],
    ["'https://example.com/a'", "https://example.com/a"],
    ['"https://example.com/a"', "https://example.com/a"],
    ["https://example.com/a?!.", "https://example.com/a"],
    ["https://example.com/a?q=1.", "https://example.com/a?q=1"],
  ])("drops trailing ASCII punctuation: %s", (text, link) => {
    expect(links(text)).toEqual([link]);
  });

  it.each([
    ["https://example.com/a，下一句", "https://example.com/a"],
    ["https://example.com/a。", "https://example.com/a"],
    ["https://example.com/a；", "https://example.com/a"],
    ["https://example.com/a：", "https://example.com/a"],
    ["https://example.com/a！", "https://example.com/a"],
    ["https://example.com/a？", "https://example.com/a"],
    ["https://example.com/a、", "https://example.com/a"],
    ["「https://example.com/a」", "https://example.com/a"],
    ["『https://example.com/a』", "https://example.com/a"],
    ["（https://example.com/a）", "https://example.com/a"],
    ["【https://example.com/a】", "https://example.com/a"],
    ["《https://example.com/a》", "https://example.com/a"],
  ])("ends the link at non-ASCII punctuation: %s", (text, link) => {
    expect(links(text)).toEqual([link]);
  });

  it("keeps brackets balanced inside the URL and drops a closing one outside", () => {
    expect(links("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(links("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(links("(see https://example.com/a)")).toEqual(["https://example.com/a"]);
    expect(links("[https://example.com/a]")).toEqual(["https://example.com/a"]);
    expect(links("https://example.com/a[1]")).toEqual(["https://example.com/a[1]"]);
    expect(links("{https://example.com/a}")).toEqual(["https://example.com/a"]);
    expect(links("(https://example.com/a).")).toEqual(["https://example.com/a"]);
  });

  it("links percent-encoded URLs as written", () => {
    const url = "https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC";
    expect(linkify(`${url}。`)[0]).toEqual({ kind: "link", text: url, href: url });
  });

  it("leaves a URL with non-ASCII characters in its path as text", () => {
    const text = "https://zh.wikipedia.org/wiki/北京";
    expect(linkify(text)).toEqual([{ kind: "text", text }]);
    expect(links("参考 https://example.com/search?q=北京 结束")).toEqual([]);
  });

  it("links only the bare host when Chinese text follows it directly", () => {
    expect(linkify("https://example.com了解更多")).toEqual([
      { kind: "link", text: "https://example.com", href: "https://example.com/" },
      { kind: "text", text: "了解更多" },
    ]);
  });

  it.each(["javascript:alert(1)", "mailto:someone@example.com", "ftp://example.com/file", "data:text/html,hi", "file:///etc/passwd", "xhttps://example.com", "https://", "http://"])(
    "never links %s",
    (text) => {
      expect(links(text)).toEqual([]);
    },
  );

  it("links two URLs in one line", () => {
    expect(links("A https://a.example.com/1 和 B http://b.example.com/2。")).toEqual(["https://a.example.com/1", "http://b.example.com/2"]);
  });

  it("links URLs at the very start and end", () => {
    const parts = linkify("https://a.com/start 中间 https://b.com/end");
    expect(parts[0]).toMatchObject({ kind: "link", text: "https://a.com/start" });
    expect(parts.at(-1)).toMatchObject({ kind: "link", text: "https://b.com/end" });
  });

  it("finds links across lines without swallowing the line breaks", () => {
    const text = "第一行 https://a.com/x\nhttps://b.com/y\n\n最后";
    expect(links(text)).toEqual(["https://a.com/x", "https://b.com/y"]);
    expect(joined(linkify(text))).toBe(text);
  });

  it("accepts an upper-case scheme and normalizes the href", () => {
    expect(linkify("HTTPS://Example.COM/A")).toEqual([{ kind: "link", text: "HTTPS://Example.COM/A", href: "https://example.com/A" }]);
  });
});
