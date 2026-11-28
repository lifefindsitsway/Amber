import { randomBytes } from "node:crypto";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BilibiliAdapter } from "../../../../../src/server/adapters/platform/bilibili/index.ts";
import { fetchBilibiliDanmaku, inflateRawCapped, parseDanmakuXml } from "../../../../../src/server/adapters/platform/bilibili/danmaku.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { OutboundHttpError, type OutboundHttpClient, type OutboundRequest, type OutboundResponse } from "../../../../../src/server/ports/outbound-http.ts";
import {
  DANMAKU_FETCH_TIMEOUT_MS,
  DANMAKU_INFLATED_MAX_BYTES,
  DANMAKU_ITEMS_MAX,
  DANMAKU_RESPONSE_MAX_BYTES,
  DANMAKU_TEXT_MAX_CHARS,
} from "../../../../../src/shared/defaults.ts";
import { danmakuItemSchema } from "../../../../../src/shared/dto/danmaku.ts";
import { scriptedYtDlp, signal } from "../../../../fixtures/platform/scripted-io.ts";

const TRUSTED = ["api.bilibili.com", "hdslb.com"] as const;

/** A `p` attribute in the platform's nine-field layout; hash and id are synthetic. */
function p(seconds: string, mode: number, options: { color?: number; pool?: number; weight?: number | string } = {}): string {
  return [seconds, mode, 25, options.color ?? 16777215, 1700000000, options.pool ?? 0, "a1b2c3d4", "123456789012345678", options.weight ?? 5].join(",");
}

function doc(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.example</chatserver><chatid>1</chatid>${body}</i>`;
}

interface FakeAnswer {
  status?: number;
  headers?: Record<string, string>;
  chunks: Uint8Array[];
}

/** An OutboundHttpClient that answers with binary chunks and records how far the body was read. */
class BinaryHttp implements OutboundHttpClient {
  readonly requests: OutboundRequest[] = [];
  chunksRead = 0;
  bodyClosed = false;
  destroyed = 0;
  private readonly answer: (request: OutboundRequest) => FakeAnswer | Error;

  constructor(answer: (request: OutboundRequest) => FakeAnswer | Error) {
    this.answer = answer;
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    const answer = this.answer(request);
    if (answer instanceof Error) {
      throw answer;
    }
    const self = this;
    const body = (async function* (): AsyncIterable<Uint8Array> {
      try {
        for (const chunk of answer.chunks) {
          self.chunksRead += 1;
          yield chunk;
        }
      } finally {
        self.bodyClosed = true;
      }
    })();
    return {
      status: answer.status ?? 200,
      headers: new Map(Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
      body,
      text: async () => Buffer.concat(answer.chunks).toString("utf8"),
      destroy: () => {
        self.destroyed += 1;
      },
    };
  }
}

const deflated = (xml: string): FakeAnswer => ({ headers: { "Content-Encoding": "deflate" }, chunks: [deflateRawSync(Buffer.from(xml, "utf8"))] });

async function failure(promise: Promise<unknown>): Promise<{ class: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return { class: error.appError.class, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

function expectValid(items: unknown[]): void {
  for (const item of items) danmakuItemSchema.parse(item);
}

describe("parseDanmakuXml", () => {
  it("reads time, mode, color, weight and text of each <d>, in document order", () => {
    const parsed = parseDanmakuXml(
      doc(`<d p="${p("12.345", 1, { color: 16711680, weight: 7 })}">第一条</d><d p="${p("3", 5)}">顶部</d><d p='${p("0.5", 4, { weight: 10 })}'>底部</d>`),
    );
    expect(parsed).toEqual({
      elements: 3,
      recognized: 3,
      items: [
        { timeMs: 12345, mode: "scroll", color: 0xff0000, weight: 7, text: "第一条" },
        { timeMs: 3000, mode: "top", color: 0xffffff, weight: 5, text: "顶部" },
        { timeMs: 500, mode: "bottom", color: 0xffffff, weight: 10, text: "底部" },
      ],
    });
  });

  it("maps modes 1–3 to scroll, 4 to bottom, 5 to top and drops every other mode", () => {
    const modes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const parsed = parseDanmakuXml(doc(modes.map((mode) => `<d p="${p(String(mode), mode)}">m${mode}</d>`).join("")));
    expect(parsed.items.map((item) => [item.text, item.mode])).toEqual([
      ["m1", "scroll"],
      ["m2", "scroll"],
      ["m3", "scroll"],
      ["m4", "bottom"],
      ["m5", "top"],
    ]);
    expect(parsed.recognized).toBe(modes.length);
  });

  it("keeps only the normal pool and stores no sender hash or danmaku id", () => {
    const parsed = parseDanmakuXml(doc(`<d p="${p("1", 1, { pool: 1 })}">字幕池</d><d p="${p("2", 1, { pool: 2 })}">特殊</d><d p="${p("3", 1)}">普通</d>`));
    expect(parsed.items.map((item) => item.text)).toEqual(["普通"]);
    expect(JSON.stringify(parsed.items)).not.toMatch(/a1b2c3d4|123456789012345678/);
    expect(Object.keys(parsed.items[0] ?? {}).sort()).toEqual(["color", "mode", "text", "timeMs", "weight"]);
  });

  it("decodes entities and character references, takes CDATA verbatim and keeps markup as text", () => {
    const parsed = parseDanmakuXml(
      doc(
        [
          `<d p="${p("1", 1)}">&lt;b&gt;粗&lt;/b&gt; &amp;amp; &quot;q&quot; &apos;a&apos;</d>`,
          `<d p="${p("2", 1)}">&#21704;&#x54C8; &unknown; &#0; &#xD800; &#1114112;</d>`,
          `<d p="${p("3", 1)}"><![CDATA[<script>alert("x")</script> &lt;]]></d>`,
          `<d p="${p("4", 1)}">a<![CDATA[</d>]]>b</d>`,
        ].join(""),
      ),
    );
    expect(parsed.items.map((item) => item.text)).toEqual([
      '<b>粗</b> &amp; "q" \'a\'',
      "哈哈 &unknown;",
      '<script>alert("x")</script> &lt;',
      "a</d>b",
    ]);
  });

  it("reads attributes in any order and quoting, with entities, and ignores unknown ones", () => {
    const parsed = parseDanmakuXml(doc(`<d  x="1"  p = "${p("1", 1)}" y='>' z >one</d><d p=${p("2", 5)}>two</d><d p="1&#44;1&#44;25&#44;0&#44;0&#44;0&#44;h&#44;i&#44;3">three</d>`));
    expect(parsed.items.map((item) => [item.text, item.timeMs])).toEqual([
      ["one", 1000],
      ["two", 2000],
      ["three", 1000],
    ]);
  });

  it("cleans text: control and invisible characters go, length is capped, empty items are dropped", () => {
    const long = "长".repeat(DANMAKU_TEXT_MAX_CHARS * 3);
    const parsed = parseDanmakuXml(doc(`<d p="${p("1", 1)}">a&#7;b\u202Ec</d><d p="${p("2", 1)}">${long}</d><d p="${p("3", 1)}">  \u200B </d><d p="${p("4", 1)}"></d><d p="${p("5", 1)}"/>`));
    expect(parsed.items.map((item) => item.text)).toEqual(["abc", "长".repeat(DANMAKU_TEXT_MAX_CHARS)]);
    expect(parsed).toMatchObject({ elements: 5, recognized: 5 });
  });

  it("counts malformed `p` layouts apart from items dropped by rule", () => {
    const bad = ["", "1,1,25", "x,1,25,0,0,0,h,i,5", "1,1,25,-1,0,0,h,i,5", "1,1,25,16777216,0,0,h,i,5", "-1,1,25,0,0,0,h,i,5", "1e3,1,25,0,0,0,h,i,5", "1,1,25,0,0,0,h,i,"];
    const parsed = parseDanmakuXml(doc(bad.map((value) => `<d p="${value}">x</d>`).join("") + `<d>no p</d>`));
    expect(parsed).toEqual({ items: [], elements: bad.length + 1, recognized: 0 });
  });

  it("caps weights at 10 and accepts weight 0", () => {
    const parsed = parseDanmakuXml(doc(`<d p="${p("1", 1, { weight: 0 })}">a</d><d p="${p("1", 1, { weight: 99 })}">b</d>`));
    expect(parsed.items.map((item) => item.weight)).toEqual([0, 10]);
  });

  it("skips comments, declarations, processing instructions and other elements, and drops a <d> with nested markup", () => {
    const parsed = parseDanmakuXml(
      `<!DOCTYPE i [<!ENTITY x SYSTEM "file:///etc/passwd">]><i><!-- <d p="${p("1", 1)}">comment</d> --><?pi <d p="${p("1", 1)}">pi</d> ?>` +
        `<![CDATA[<d p="${p("1", 1)}">cdata</d>]]><dd p="${p("1", 1)}">other</dd><d p="${p("2", 1)}">a<b>bold</b></d>` +
        `<d p="${p("3", 1)}">outer<d p="${p("4", 1)}">inner</d>tail</d><d p="${p("5", 1)}">&x; kept</d></i>`,
    );
    expect(parsed.items.map((item) => item.text)).toEqual(["&x; kept"]);
    expect(parsed.elements).toBe(3);
  });

  it("survives a document cut anywhere, losing at most the element it ends in", () => {
    const xml = doc(Array.from({ length: 20 }, (_, index) => `<d p="${p(String(index), 1)}">n${index}&amp;<![CDATA[c]]></d>`).join(""));
    const whole = parseDanmakuXml(xml).items;
    expect(whole).toHaveLength(20);
    for (let cut = 0; cut <= xml.length; cut++) {
      const parsed = parseDanmakuXml(xml.slice(0, cut));
      expectValid(parsed.items);
      expect(whole.slice(0, parsed.items.length)).toEqual(parsed.items);
      // Every element closed before the cut is read in full.
      const closed = xml.slice(0, cut).split("</d>").length - 1;
      expect(parsed.items.length).toBe(closed);
    }
  });

  it("never throws and only yields schema-valid items on random input (fuzz)", () => {
    const alphabet = ['<', '>', '/', 'd', ' ', 'p', '=', '"', "'", '&', '#', ';', ',', '1', '5', '.', '!', '[', ']', '-', '?', 'C', 'D', 'A', 'T', '\u0000', '\u202E', '中', '\uD83D'];
    let seed = 0x2545f491;
    const random = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const valid = `<d p="${p("1", 1)}">ok</d>`;
    for (let round = 0; round < 2000; round++) {
      let text = "";
      const length = Math.floor(random() * 200);
      for (let index = 0; index < length; index++) {
        text += random() < 0.05 ? valid : (alphabet[Math.floor(random() * alphabet.length)] as string);
      }
      const parsed = parseDanmakuXml(text);
      expectValid(parsed.items);
      expect(parsed.recognized).toBeLessThanOrEqual(parsed.elements);
      expect(parsed.items.length).toBeLessThanOrEqual(parsed.recognized);
    }
    for (let round = 0; round < 50; round++) {
      const parsed = parseDanmakuXml(new TextDecoder().decode(randomBytes(4096)));
      expectValid(parsed.items);
    }
  });

  it("handles deep nesting and a very large document in linear time", () => {
    const nested = "<d>".repeat(100000) + "x" + "</d>".repeat(100000);
    expect(parseDanmakuXml(nested).items).toEqual([]);
    const many = doc(`<d p="${p("1.5", 1)}">弹幕</d>`.repeat(200000));
    const started = performance.now();
    const parsed = parseDanmakuXml(many);
    expect(parsed.items).toHaveLength(200000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("inflateRawCapped", () => {
  it("inflates raw deflate and refuses a zlib or gzip wrapper or a cut stream", async () => {
    const xml = Buffer.from(doc("<d>x</d>"));
    expect((await inflateRawCapped(deflateRawSync(xml), 1 << 20)).equals(xml)).toBe(true);
    for (const bad of [deflateSync(xml), gzipSync(xml), deflateRawSync(xml).subarray(0, 10), randomBytes(64)]) {
      expect((await failure(inflateRawCapped(bad, 1 << 20))).class).toBe("source_html_error_page");
    }
  });

  it("stops a compression bomb at the output limit", async () => {
    const bomb = deflateRawSync(Buffer.alloc(DANMAKU_INFLATED_MAX_BYTES + 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(DANMAKU_RESPONSE_MAX_BYTES);
    expect(await failure(inflateRawCapped(bomb, DANMAKU_INFLATED_MAX_BYTES))).toEqual({ class: "source_html_error_page", message: expect.stringContaining("inflates past") });
    expect((await inflateRawCapped(deflateRawSync(Buffer.alloc(4096)), 4096)).byteLength).toBe(4096);
    expect((await failure(inflateRawCapped(deflateRawSync(Buffer.alloc(4097)), 4096))).class).toBe("source_html_error_page");
  });
});

describe("fetchBilibiliDanmaku", () => {
  it("sends one anonymous GET to the danmaku list of the cid, with the danmaku timeout and no cookie", async () => {
    const http = new BinaryHttp(() => deflated(doc(`<d p="${p("2", 1)}">b</d><d p="${p("1", 5)}">a</d>`)));
    const answer = await fetchBilibiliDanmaku(http, "123456", signal(), TRUSTED);
    expect(answer).toEqual({
      items: [
        { timeMs: 1000, mode: "top", color: 0xffffff, weight: 5, text: "a" },
        { timeMs: 2000, mode: "scroll", color: 0xffffff, weight: 5, text: "b" },
      ],
      truncated: false,
    });
    expect(http.requests).toHaveLength(1);
    const [request] = http.requests as [OutboundRequest];
    expect(request.url).toBe("https://api.bilibili.com/x/v1/dm/list.so?oid=123456");
    expect(request.method).toBe("GET");
    expect(request.timeoutMs).toBe(DANMAKU_FETCH_TIMEOUT_MS);
    expect(request.trustedHosts).toEqual(TRUSTED);
    expect(Object.keys(request.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(request.body).toBeUndefined();
  });

  it("refuses a part id that is not a number before sending anything", async () => {
    const http = new BinaryHttp(() => deflated(doc("")));
    await expect(fetchBilibiliDanmaku(http, "1&oid=2", signal(), TRUSTED)).rejects.toBeInstanceOf(TypeError);
    expect(http.requests).toEqual([]);
  });

  it("answers an empty list for a video without danmaku, and an uncompressed body is read as is", async () => {
    expect(await fetchBilibiliDanmaku(new BinaryHttp(() => deflated(doc(""))), "1", signal(), TRUSTED)).toEqual({ items: [], truncated: false });
    const plain = new BinaryHttp(() => ({ chunks: [Buffer.from(doc(`<d p="${p("1", 1)}">x</d>`))] }));
    expect((await fetchBilibiliDanmaku(plain, "1", signal(), TRUSTED)).items).toHaveLength(1);
  });

  it("caps the item count, dropping the lowest weights, and says so", async () => {
    const body = Array.from({ length: DANMAKU_ITEMS_MAX + 10 }, (_, index) => `<d p="${p(String(index), 1, { weight: index < 10 ? 1 : 5 })}">x</d>`).join("");
    const answer = await fetchBilibiliDanmaku(new BinaryHttp(() => deflated(doc(body))), "1", signal(), TRUSTED);
    expect(answer.truncated).toBe(true);
    expect(answer.items).toHaveLength(DANMAKU_ITEMS_MAX);
    expect(answer.items.every((item) => item.weight === 5)).toBe(true);
  });

  it("fails as unreadable on a bomb, a foreign encoding, a non-XML body or an unknown layout", async () => {
    const bomb = { headers: { "content-encoding": "deflate" }, chunks: [deflateRawSync(Buffer.alloc(DANMAKU_INFLATED_MAX_BYTES + 1))] };
    const cases: FakeAnswer[] = [
      bomb,
      { headers: { "content-encoding": "gzip" }, chunks: [gzipSync(Buffer.from(doc("")))] },
      deflated('{"code":-404,"message":"not found"}'),
      deflated(doc(`<d p="1,2,3">changed layout</d>`)),
      { headers: { "content-encoding": "deflate" }, chunks: [randomBytes(1000)] },
    ];
    for (const answer of cases) {
      expect((await failure(fetchBilibiliDanmaku(new BinaryHttp(() => answer), "1", signal(), TRUSTED))).class).toBe("source_html_error_page");
    }
  });

  it("stops reading a response past the size limit", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    const http = new BinaryHttp(() => ({ headers: { "content-encoding": "deflate" }, chunks: Array.from({ length: 64 }, () => chunk) }));
    expect((await failure(fetchBilibiliDanmaku(http, "1", signal(), TRUSTED))).message).toContain(`exceeded ${DANMAKU_RESPONSE_MAX_BYTES}`);
    expect(http.chunksRead).toBe(DANMAKU_RESPONSE_MAX_BYTES / chunk.byteLength + 1);
    expect(http.bodyClosed).toBe(true);
    const declared = new BinaryHttp(() => ({ headers: { "content-length": String(DANMAKU_RESPONSE_MAX_BYTES + 1) }, chunks: [Buffer.alloc(10), Buffer.alloc(10)] }));
    expect((await failure(fetchBilibiliDanmaku(declared, "1", signal(), TRUSTED))).class).toBe("source_html_error_page");
    // A declared length over the cap is refused before a single byte is read.
    expect(declared.chunksRead).toBe(0);
    expect(declared.destroyed).toBe(1);
  });

  it("reports risk control and HTTP errors as the platform being unreachable, never as needing a login", async () => {
    for (const status of [412, 429, 403, 404, 500]) {
      expect((await failure(fetchBilibiliDanmaku(new BinaryHttp(() => ({ status, chunks: [Buffer.from("<html>")] })), "1", signal(), TRUSTED))).class, String(status)).toBe("source_unreachable");
    }
    const network = new BinaryHttp(() => new OutboundHttpError("before_send", "timeout"));
    expect((await failure(fetchBilibiliDanmaku(network, "1", signal(), TRUSTED))).class).toBe("source_unreachable");
    const aborted = new BinaryHttp(() => new OutboundHttpError("after_send", "aborted"));
    await expect(fetchBilibiliDanmaku(aborted, "1", signal(), TRUSTED)).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("BilibiliAdapter.fetchDanmaku", () => {
  it("asks for the Content's cid without touching yt-dlp or a login", async () => {
    const { ytDlp, runner } = scriptedYtDlp();
    const http = new BinaryHttp(() => deflated(doc(`<d p="${p("1", 1)}">x</d>`)));
    const adapter = new BilibiliAdapter({ ytDlp, http });
    expect((await adapter.fetchDanmaku({ platformContentId: "BV1xx411c7mD", platformPartId: "1002" }, signal())).items).toHaveLength(1);
    expect(http.requests.map((request) => request.url)).toEqual(["https://api.bilibili.com/x/v1/dm/list.so?oid=1002"]);
    expect(http.requests[0]?.trustedHosts).toEqual(adapter.trustedHosts);
    expect(Object.keys(http.requests[0]?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    expect(runner.specs).toEqual([]);
    expect(adapter.fetchDanmaku.length).toBe(2);
    await expect(adapter.fetchDanmaku({ platformContentId: "BV1xx411c7mD" }, signal())).rejects.toBeInstanceOf(TypeError);
  });
});
