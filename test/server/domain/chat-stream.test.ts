import { describe, expect, it } from "vitest";
import { ChatStreamAssembler, type ChatAnswerEvent } from "../../../src/server/domain/chat-stream.ts";
import { transcriptAliasTable } from "../../../src/server/domain/citations.ts";
import type { TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { WebSource } from "../../../src/server/domain/web-search.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";

const seg = (n: number) => `01J00000000000000000000${String(n).padStart(3, "0")}` as SegmentId;
const segments: TranscriptSegment[] = Array.from({ length: 15 }, (_, ordinal) => ({
  id: seg(ordinal + 1),
  revisionId: "r1",
  ordinal,
  startMs: ordinal * 1000,
  endMs: ordinal * 1000 + 900,
  text: `第 ${ordinal + 1} 句`,
  sourceSegmentIds: [],
}));
const table = transcriptAliasTable("r1", segments);
const startMs = (id: string) => segments.find((segment) => segment.id === id)?.startMs ?? -1;

function run(deltas: readonly string[], webSources: readonly WebSource[] = []) {
  const assembler = new ChatStreamAssembler(table, startMs, webSources);
  const events: ChatAnswerEvent[] = [];
  for (const delta of deltas) {
    events.push(...assembler.push(delta));
  }
  const finished = assembler.finish();
  events.push(...finished.events);
  const streamed = events.flatMap((event) => (event.type === "answer.delta" ? [event.delta] : [])).join("");
  return { events, streamed, answer: finished.answer };
}

describe("ChatStreamAssembler", () => {
  it("holds an alias split across deltas and emits only its canonical form", () => {
    const { events, streamed, answer } = run(["答案 [[s1", "2]] 结束"]);
    expect(streamed).toBe(`答案 [[seg:${seg(12)}]] 结束`);
    expect(events.some((event) => event.type === "answer.delta" && /\[\[s\d/.test(event.delta))).toBe(false);
    expect(answer.text).toBe(streamed);
    expect(answer.citations).toEqual([{ transcriptRevisionId: "r1", segmentId: seg(12) }]);
    const citation = events.find((event) => event.type === "citation");
    expect(citation).toEqual({ type: "citation", citation: { transcriptRevisionId: "r1", segmentId: seg(12) }, startMs: 11_000 });
  });

  it("splits at every boundary of an alias without leaking raw markers", () => {
    const text = "甲[[s3]]乙[[s3]]丙";
    for (let cut = 1; cut < text.length; cut += 1) {
      const { streamed, events } = run([text.slice(0, cut), text.slice(cut)]);
      expect(streamed).toBe(`甲[[seg:${seg(3)}]]乙[[seg:${seg(3)}]]丙`);
      expect(events.filter((event) => event.type === "citation")).toHaveLength(1);
    }
  });

  it("marks aliases the request never showed as unresolved and does not cite them", () => {
    const { streamed, answer } = run(["见 [[s99]] 与 [[s0]]"]);
    expect(streamed).toBe("见 [[unresolved:s99]] 与 [[unresolved:s0]]");
    expect(answer.citations).toEqual([]);
  });

  it("never streams the control section, even when it is split across deltas, and parses the suggestions", () => {
    const { streamed, answer } = run(["回答 [[s1]]。\n<<<sugg", "estions>>>\n- 追问一\n- 追问二\n", "- 追问三\n- 追问四\n<<<end>>>"]);
    expect(streamed).toBe(`回答 [[seg:${seg(1)}]]。`);
    expect(answer.text).toBe(streamed);
    expect(answer.suggestions).toEqual(["追问一", "追问二", "追问三"]);
  });

  it("drops an unreadable control section without showing it", () => {
    const { streamed, answer } = run(["回答\n<<<suggestions>>>\n- 只有开头"]);
    expect(streamed).toBe("回答");
    expect(answer.suggestions).toBeUndefined();
  });

  it("passes through brackets and angle brackets that start no marker", () => {
    const { streamed } = run(["a < b, [注] 与 [[x]] 以及 [[s"]);
    expect(streamed).toBe("a < b, [注] 与 [[x]] 以及 [[s");
  });

  it("reports the canonical text streamed so far for an answer that ends early", () => {
    const assembler = new ChatStreamAssembler(table, startMs);
    assembler.push("部分回答 [[s2]] 还有");
    assembler.push(" [[s");
    expect(assembler.partial()).toEqual({ text: `部分回答 [[seg:${seg(2)}]] 还有`, citations: [{ transcriptRevisionId: "r1", segmentId: seg(2) }] });
  });
});

describe("ChatStreamAssembler with one bracket missing", () => {
  it("resolves [[s1]][s2]] split at every boundary into two canonical markers", () => {
    const text = "甲[[s1]][s2]]乙";
    for (let cut = 1; cut < text.length; cut += 1) {
      const { streamed, events } = run([text.slice(0, cut), text.slice(cut)]);
      expect(streamed).toBe(`甲[[seg:${seg(1)}]][[seg:${seg(2)}]]乙`);
      expect(events.filter((event) => event.type === "citation")).toHaveLength(2);
    }
  });

  it("waits for a possible closing bracket, then takes [[s3] before other text as an alias", () => {
    expect(run(["见 [[s3]", "]。"]).streamed).toBe(`见 [[seg:${seg(3)}]]。`);
    expect(run(["见 [[s3]", "中文"]).streamed).toBe(`见 [[seg:${seg(3)}]]中文`);
    expect(run(["结尾 [[s3]"]).streamed).toBe(`结尾 [[seg:${seg(3)}]]`);
  });

  it("streams [s4] with one bracket on each side as plain text", () => {
    const { streamed, answer } = run(["列表 [s4", "] 第四项"]);
    expect(streamed).toBe("列表 [s4] 第四项");
    expect(answer.citations).toEqual([]);
  });
});

const source = (id: string, index: number): WebSource => ({ id, index, url: `https://s${index}.example.com/`, title: `S${index}`, excerpt: "e", fetchedAt: 1 });

describe("ChatStreamAssembler web aliases", () => {
  const first = [source("01JWEBFIRST0000000000000001", 1)];
  const second = [source("01JWEBSECOND000000000000001", 1), source("01JWEBSECOND000000000000002", 2)];

  it("resolves [[w<n>]] to this answer's own n-th source, whatever another answer's #1 was", () => {
    expect(run(["版本是 2.11 [[w1]]。"], first).answer.text).toBe("版本是 2.11 [[web:01JWEBFIRST0000000000000001]]。");
    const { streamed, answer } = run(["版本是 2.11 [[w1]]。"], second);
    expect(streamed).toBe("版本是 2.11 [[web:01JWEBSECOND000000000000001]]。");
    expect(answer.citations).toEqual([]);
  });

  it("passes a [[web:<id>]] the model copied from an earlier answer through unchanged", () => {
    const { streamed } = run(["照抄 [[web:01JWEBFIRST0000000000000001]] 与 [[w2]]"], second);
    expect(streamed).toBe("照抄 [[web:01JWEBFIRST0000000000000001]] 与 [[web:01JWEBSECOND000000000000002]]");
  });

  it("holds a web alias split across deltas, also next to sentence aliases", () => {
    const { events, streamed, answer } = run(["见 [[", "w", "2", "]", "] 与 [[s", "3]][[w", "1]]"], second);
    expect(streamed).toBe(`见 [[web:01JWEBSECOND000000000000002]] 与 [[seg:${seg(3)}]][[web:01JWEBSECOND000000000000001]]`);
    expect(events.some((event) => event.type === "answer.delta" && /\[\[w\d|\[\[s\d/.test(event.delta))).toBe(false);
    expect(answer.citations).toEqual([{ transcriptRevisionId: "r1", segmentId: seg(3) }]);
  });

  it("marks an alias past this answer's sources unresolved, as without any source", () => {
    expect(run(["[[w3]] 和 [[w0]]"], second).streamed).toBe("[[unresolved:w3]] 和 [[unresolved:w0]]");
    expect(run(["[[w1]]"]).streamed).toBe("[[unresolved:w1]]");
    expect(run(["结尾 [[w2]"], second).streamed).toBe("结尾 [[web:01JWEBSECOND000000000000002]]");
  });
});
