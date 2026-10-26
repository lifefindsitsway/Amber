import { describe, expect, it } from "vitest";
import type { WebSourceDto } from "../../../src/shared/dto/chat.ts";
import { answerPlainText, citedWebSources, plainText } from "../../../src/web/components/plain-text.ts";

const source = (id: string, index: number, title: string): WebSourceDto => ({ id, index, url: `https://news.example/${id}`, title, excerpt: "", fetchedAt: 1 });
const SOURCES = [source("w1", 1, "第一篇"), source("w2", 2, "第二篇"), source("w3", 3, "第三篇")];

describe("plainText", () => {
  it("turns citations into timestamps and drops unresolved markers", () => {
    expect(plainText("甲 [[seg:s1]] 乙 [[unresolved:s9]]", (id) => (id === "s1" ? 75_000 : undefined))).toBe("甲 [1:15] 乙 ");
  });

  it("drops a citation whose time is not known", () => {
    expect(plainText("甲[[seg:s2]]", () => undefined)).toBe("甲");
  });

  it("turns web citations into their source numbers and drops unknown ones", () => {
    const indexOf = (id: string) => SOURCES.find((item) => item.id === id)?.index;
    expect(plainText("甲[[web:w2]]乙[[web:other]]", () => undefined, indexOf)).toBe("甲[2]乙");
    // Without sources every web marker goes.
    expect(plainText("甲[[web:w2]]", () => undefined)).toBe("甲");
  });
});

describe("answerPlainText", () => {
  it("appends the cited sources in number order, leaving out sources never cited", () => {
    const text = answerPlainText("据报道[[web:w3]]，另见[[web:w1]]，视频里在 [[seg:s1]]。", (id) => (id === "s1" ? 75_000 : undefined), SOURCES, "来源：");
    expect(text).toBe("据报道[3]，另见[1]，视频里在 [1:15]。\n\n来源：\n[1] 第一篇 https://news.example/w1\n[3] 第三篇 https://news.example/w3");
    expect(citedWebSources("[[web:w2]][[web:w2]]", SOURCES).map((item) => item.id)).toEqual(["w2"]);
  });

  it("adds no list when no web page is cited", () => {
    expect(answerPlainText("只有视频 [[seg:s1]]", () => 1_000, SOURCES, "来源：")).toBe("只有视频 [0:01]");
  });
});
