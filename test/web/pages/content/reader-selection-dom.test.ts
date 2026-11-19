import { afterEach, describe, expect, it } from "vitest";
import { domFromPoint, mountedRowKeys, pointFromDom, rowKeyAt } from "../../../../src/web/pages/content/reader-selection-dom.ts";
import type { ReaderPoint } from "../../../../src/web/pages/content/reader-selection.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const $ = (selector: string): HTMLElement => document.querySelector(selector) as HTMLElement;
const text = (selector: string): Text => $(selector).firstChild as Text;

/**
 * A chapter heading with its play button, a turn's first paragraph (avatar, name, time, two
 * sentences with a separator between them, one split by a search mark and a note run), a gap bar
 * and a paragraph that follows inside the same turn. `x` holds a second list beside it.
 */
const READER = `
<div id="list"><div id="box">
<div data-row-key="chapter:0" id="r0"><div><h3 id="title" data-reader-part="title">开场白</h3><span><button data-reader-meta=""><svg></svg></button></span></div></div>
<div data-row-key="k1" id="r1"><div id="turn"><div data-reader-meta=""><button><span id="avatar">林</span><span id="name" data-reader-part="speaker">林老师</span></button></div><div><p id="p1"><button id="time" data-reading-time data-reader-part="time">0:00</button><span id="a" data-segment-id="s1">先看<mark id="mark">召回</mark><span id="run" data-note-ids="n1">😀的</span>做法。</span> <span id="b" data-segment-id="s2">Then rerank.</span></p></div></div></div>
<div data-row-key="gap:s3" id="r2"><div><button id="gap" data-reader-part="gap">略过 11 秒</button></div></div>
<div data-row-key="k4" id="r3"><p id="p2"><button data-reading-time data-reader-part="time">0:30</button><span id="c" data-segment-id="s4">最后生成。</span></p></div>
</div></div>
<div id="other"><div data-row-key="k1"><span data-segment-id="s1">别处的一句。</span></div></div>`;

function mount(): HTMLElement {
  document.body.innerHTML = READER;
  return $("#list");
}

describe("pointFromDom", () => {
  it("reads a point inside a part as that part and its text offset", () => {
    const list = mount();
    expect(pointFromDom(list, text("#title"), 2)).toEqual({ rowKey: "chapter:0", part: "title", offset: 2 });
    expect(pointFromDom(list, text("#name"), 1)).toEqual({ rowKey: "k1", part: "speaker", offset: 1 });
    expect(pointFromDom(list, text("#time"), 4)).toEqual({ rowKey: "k1", part: "time", offset: 4 });
    expect(pointFromDom(list, text("#gap"), 3)).toEqual({ rowKey: "gap:s3", part: "gap", offset: 3 });
    expect(pointFromDom(list, text("#b"), 5)).toEqual({ rowKey: "k1", part: "sentence", segmentId: "s2", offset: 5 });
  });

  it("measures a sentence split by a search mark and a note run as its plain text, in UTF-16 units", () => {
    const list = mount();
    expect(pointFromDom(list, text("#mark"), 1)).toEqual({ rowKey: "k1", part: "sentence", segmentId: "s1", offset: 3 });
    // 😀 is two units: after it, inside the note run.
    expect(pointFromDom(list, text("#run"), 2)).toEqual({ rowKey: "k1", part: "sentence", segmentId: "s1", offset: 6 });
    expect(pointFromDom(list, $("#a").lastChild as Text, 3)).toEqual({ rowKey: "k1", part: "sentence", segmentId: "s1", offset: 10 });
    // On the sentence element itself, between its children.
    expect(pointFromDom(list, $("#a"), 2)).toEqual({ rowKey: "k1", part: "sentence", segmentId: "s1", offset: 4 });
  });

  it("reads a point between parts as the start of the next part", () => {
    const list = mount();
    const separator = $("#a").nextSibling as Text;
    expect(separator.data).toBe(" ");
    const startOfB: ReaderPoint = { rowKey: "k1", part: "sentence", segmentId: "s2", offset: 0 };
    expect(pointFromDom(list, separator, 0)).toEqual(startOfB);
    expect(pointFromDom(list, separator, 1)).toEqual(startOfB);
    // The avatar is not part of the name.
    expect(pointFromDom(list, text("#avatar"), 1)).toEqual({ rowKey: "k1", part: "speaker", offset: 0 });
    // On the paragraph, before its time button.
    expect(pointFromDom(list, $("#p1"), 0)).toEqual({ rowKey: "k1", part: "time", offset: 0 });
    // On the row itself, as the browser leaves a point when the nodes under it are replaced.
    expect(pointFromDom(list, $("#r1"), 0)).toEqual({ rowKey: "k1", part: "speaker", offset: 0 });
  });

  it("reads a point after a row's last part as the end of that part", () => {
    const list = mount();
    expect(pointFromDom(list, $("#p1"), $("#p1").childNodes.length)).toEqual({ rowKey: "k1", part: "sentence", segmentId: "s2", offset: 12 });
    expect(pointFromDom(list, $("#r1"), 1)).toEqual({ rowKey: "k1", part: "sentence", segmentId: "s2", offset: 12 });
    // After the title only the play button follows.
    expect(pointFromDom(list, $("#title").parentElement as HTMLElement, 2)).toEqual({ rowKey: "chapter:0", part: "title", offset: 3 });
  });

  it("reads a point between rows as the start of the next mounted row, and the end of the last one after it", () => {
    const list = mount();
    const box = $("#box");
    const rowAt = (id: string): number => Array.from(box.childNodes).indexOf($(id));
    expect(pointFromDom(list, box, rowAt("#r2"))).toEqual({ rowKey: "gap:s3", part: "gap", offset: 0 });
    expect(pointFromDom(list, box, rowAt("#r0"))).toEqual({ rowKey: "chapter:0", part: "title", offset: 0 });
    expect(pointFromDom(list, box, box.childNodes.length)).toEqual({ rowKey: "k4", part: "sentence", segmentId: "s4", offset: 5 });
    expect(pointFromDom(list, list, 0)).toEqual({ rowKey: "chapter:0", part: "title", offset: 0 });
  });

  it("answers nothing outside the list or while it has no rows", () => {
    const list = mount();
    expect(pointFromDom(list, text("#other span"), 1)).toBeUndefined();
    expect(pointFromDom(list, document.body, 0)).toBeUndefined();
    $("#box").innerHTML = "";
    expect(pointFromDom(list, $("#box"), 0)).toBeUndefined();
  });
});

describe("domFromPoint", () => {
  const points: ReaderPoint[] = [
    { rowKey: "chapter:0", part: "title", offset: 0 },
    { rowKey: "chapter:0", part: "title", offset: 3 },
    { rowKey: "k1", part: "speaker", offset: 2 },
    { rowKey: "k1", part: "time", offset: 1 },
    { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 0 },
    { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 2 },
    { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 3 },
    { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 4 },
    { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 6 },
    { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 10 },
    { rowKey: "k1", part: "sentence", segmentId: "s2", offset: 12 },
    { rowKey: "gap:s3", part: "gap", offset: 4 },
    { rowKey: "k4", part: "sentence", segmentId: "s4", offset: 5 },
  ];

  it("finds a text position that reads back as the same point", () => {
    const list = mount();
    for (const point of points) {
      const found = domFromPoint(list, point);
      expect(found, JSON.stringify(point)).toBeDefined();
      if (found === undefined) continue;
      expect(found.node.nodeType).toBe(Node.TEXT_NODE);
      expect(pointFromDom(list, found.node, found.offset)).toEqual(point);
    }
  });

  it("selects the same text a selection between two points had", () => {
    const list = mount();
    const from = domFromPoint(list, { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 2 });
    const to = domFromPoint(list, { rowKey: "k1", part: "sentence", segmentId: "s2", offset: 4 });
    const range = document.createRange();
    range.setStart((from as { node: Node }).node, (from as { offset: number }).offset);
    range.setEnd((to as { node: Node }).node, (to as { offset: number }).offset);
    expect(range.toString()).toBe("召回😀的做法。 Then");
  });

  it("takes an offset past the text as its end", () => {
    const list = mount();
    const found = domFromPoint(list, { rowKey: "k4", part: "sentence", segmentId: "s4", offset: 99 });
    expect(found).toEqual({ node: text("#c"), offset: 5 });
  });

  it("answers nothing for a row that is not mounted or a part the row no longer shows", () => {
    const list = mount();
    expect(domFromPoint(list, { rowKey: "k9", part: "time", offset: 0 })).toBeUndefined();
    expect(domFromPoint(list, { rowKey: "k4", part: "speaker", offset: 0 })).toBeUndefined();
    expect(domFromPoint(list, { rowKey: "k4", part: "sentence", segmentId: "s1", offset: 0 })).toBeUndefined();
    // A row of the same key in another list is not this list's.
    $("#r1").remove();
    expect(domFromPoint(list, { rowKey: "k1", part: "sentence", segmentId: "s1", offset: 0 })).toBeUndefined();
  });

  it("points at the part itself when it has no text", () => {
    const list = mount();
    $("#c").textContent = "";
    expect(domFromPoint(list, { rowKey: "k4", part: "sentence", segmentId: "s4", offset: 0 })).toEqual({ node: $("#c"), offset: 0 });
  });
});

describe("rows of the list", () => {
  it("names the row a node sits in, and only for this list", () => {
    const list = mount();
    expect(rowKeyAt(list, text("#mark"))).toBe("k1");
    expect(rowKeyAt(list, $("#box"))).toBeUndefined();
    expect(rowKeyAt(list, text("#other span"))).toBeUndefined();
  });

  it("lists the keys of the mounted rows", () => {
    const list = mount();
    expect([...mountedRowKeys(list)]).toEqual(["chapter:0", "k1", "gap:s3", "k4"]);
  });
});

describe("figure rows", () => {
  /** Two paragraphs with a figure between them; the figure's caption is text the selection never takes. */
  const WITH_FIGURE = `
<div id="list">
<div data-row-key="k1" id="r1"><p><span id="a" data-segment-id="s1">第一段。</span></p></div>
<div data-row-key="figure:f1" data-figure-row="" id="fig"><figure><figcaption id="cap">图注文字</figcaption></figure></div>
<div data-row-key="k2" id="r2"><p><span id="b" data-segment-id="s2">第二段。</span></p></div>
</div>`;

  it("reads a point on a figure as the start of the text row after it", () => {
    document.body.innerHTML = WITH_FIGURE;
    const list = $("#list");
    expect(pointFromDom(list, text("#cap"), 2)).toEqual({ rowKey: "k2", part: "sentence", segmentId: "s2", offset: 0 });
    expect(rowKeyAt(list, text("#cap"))).toBeUndefined();
  });

  it("leaves figure rows out of the mounted text rows", () => {
    document.body.innerHTML = WITH_FIGURE;
    expect(mountedRowKeys($("#list"))).toEqual(new Set(["k1", "k2"]));
  });
});
