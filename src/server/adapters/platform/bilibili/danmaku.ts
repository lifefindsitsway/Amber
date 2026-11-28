import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { DANMAKU_FETCH_TIMEOUT_MS, DANMAKU_INFLATED_MAX_BYTES, DANMAKU_RESPONSE_MAX_BYTES } from "../../../../shared/defaults.ts";
import type { DanmakuItem, DanmakuMode } from "../../../../shared/dto/danmaku.ts";
import { capDanmakuItems, cleanDanmakuText } from "../../../domain/danmaku.ts";
import { amberError, isAmberError } from "../../../domain/errors.ts";
import type { OutboundHttpClient } from "../../../ports/outbound-http.ts";
import { platformGetBytes } from "../http.ts";

const DANMAKU_LIST = "https://api.bilibili.com/x/v1/dm/list.so";
const REFERER = { Referer: "https://www.bilibili.com/" };
/** Size of the slices the compressed body is fed to the inflater in, so an oversized output stops early. */
const INFLATE_SLICE_BYTES = 65536;

/** The danmaku type field: 1–3 scroll, 4 bottom, 5 top; reverse, positioned, code and other kinds are dropped. */
const MODES: ReadonlyMap<number, DanmakuMode> = new Map([
  [1, "scroll"],
  [2, "scroll"],
  [3, "scroll"],
  [4, "bottom"],
  [5, "top"],
]);
/** The ordinary pool; subtitle and special pools are not crowd danmaku. */
const NORMAL_POOL = 0;
/** Fields of `p`: seconds, type, font size, decimal RGB, send time, pool, sender hash, danmaku id, weight. */
const P_FIELDS = 9;
const WEIGHT_MAX = 10;
const UNSIGNED = /^\d{1,15}$/;
const SECONDS = /^\d{1,9}(?:\.\d{1,9})?$/;

function unreadable(why: string): Error {
  return amberError("source_html_error_page", `danmaku response ${why}`);
}

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g;
const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** The five predefined entities and character references; an invalid code point is dropped, an unknown entity stays literal. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(ENTITY, (_, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) {
      return NAMED[name] as string;
    }
    const code = decimal === undefined ? Number.parseInt(hex as string, 16) : Number.parseInt(decimal, 10);
    return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "" : String.fromCodePoint(code);
  });
}

function isNameEnd(code: number): boolean {
  // whitespace, "/", ">", "="
  return code <= 0x20 || code === 0x2f || code === 0x3e || code === 0x3d;
}

interface StartTag {
  name: string;
  attributes: Map<string, string>;
  selfClosing: boolean;
  /** Index just past the closing `>`. */
  end: number;
}

/** The start tag at `at` (which holds `<`); `undefined` when the document ends inside it. */
function readStartTag(xml: string, at: number): StartTag | undefined {
  let index = at + 1;
  while (index < xml.length && !isNameEnd(xml.charCodeAt(index))) index++;
  const name = xml.slice(at + 1, index);
  const attributes = new Map<string, string>();
  for (;;) {
    while (index < xml.length && xml.charCodeAt(index) <= 0x20) index++;
    if (index >= xml.length) {
      return undefined;
    }
    if (xml.startsWith("/>", index)) {
      return { name, attributes, selfClosing: true, end: index + 2 };
    }
    if (xml[index] === ">") {
      return { name, attributes, selfClosing: false, end: index + 1 };
    }
    const nameStart = index;
    while (index < xml.length && !isNameEnd(xml.charCodeAt(index))) index++;
    if (index === nameStart) {
      // A stray "/" or "=" with no name in front: step over it.
      index++;
      continue;
    }
    const attribute = xml.slice(nameStart, index);
    while (index < xml.length && xml.charCodeAt(index) <= 0x20) index++;
    if (xml[index] !== "=") {
      attributes.set(attribute, "");
      continue;
    }
    index++;
    while (index < xml.length && xml.charCodeAt(index) <= 0x20) index++;
    const quote = xml[index];
    let value: string;
    if (quote === '"' || quote === "'") {
      const close = xml.indexOf(quote, index + 1);
      if (close < 0) {
        return undefined;
      }
      value = xml.slice(index + 1, close);
      index = close + 1;
    } else {
      const valueStart = index;
      while (index < xml.length && xml.charCodeAt(index) > 0x20 && xml[index] !== ">") index++;
      value = xml.slice(valueStart, index);
    }
    if (!attributes.has(attribute)) {
      attributes.set(attribute, decodeEntities(value));
    }
  }
}

const CLOSE_D = /<\/d\s*>/g;

/**
 * The text of a `<d>` from `from` (just past its start tag) to its `</d>`: character data
 * with entities decoded, CDATA sections taken verbatim. Any other markup inside makes the
 * element unusable (`plain: false`); it then ends at the next `</d>`. `end` is past the
 * close tag, or the document's length when there is none.
 */
function readText(xml: string, from: number): { text: string; plain: boolean; closed: boolean; end: number } {
  let text = "";
  let index = from;
  for (;;) {
    const lt = xml.indexOf("<", index);
    if (lt < 0) {
      return { text, plain: false, closed: false, end: xml.length };
    }
    text += decodeEntities(xml.slice(index, lt));
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt + 9);
      if (close < 0) {
        return { text, plain: false, closed: false, end: xml.length };
      }
      text += xml.slice(lt + 9, close);
      index = close + 3;
      continue;
    }
    CLOSE_D.lastIndex = lt;
    const close = CLOSE_D.exec(xml);
    if (close === null) {
      return { text, plain: false, closed: false, end: xml.length };
    }
    if (close.index === lt) {
      return { text, plain: true, closed: true, end: lt + close[0].length };
    }
    return { text, plain: false, closed: true, end: close.index + close[0].length };
  }
}

/** Index just past `terminator` from `from`, or the document's length. */
function skipPast(xml: string, terminator: string, from: number): number {
  const found = xml.indexOf(terminator, from);
  return found < 0 ? xml.length : found + terminator.length;
}

/** One `<d>` as Amber keeps it; `"malformed"` when its `p` is not the known layout, `undefined` when it is dropped by rule. */
function itemOf(p: string | undefined, rawText: string): DanmakuItem | "malformed" | undefined {
  const fields = p?.split(",");
  if (fields === undefined || fields.length < P_FIELDS) {
    return "malformed";
  }
  const [seconds, type, , color, , pool, , , weight] = fields as [string, string, string, string, string, string, string, string, string];
  if (!SECONDS.test(seconds) || !UNSIGNED.test(type) || !UNSIGNED.test(color) || !UNSIGNED.test(pool) || !UNSIGNED.test(weight)) {
    return "malformed";
  }
  const rgb = Number(color);
  if (rgb > 0xffffff) {
    return "malformed";
  }
  const mode = MODES.get(Number(type));
  if (mode === undefined || Number(pool) !== NORMAL_POOL) {
    return undefined;
  }
  const text = cleanDanmakuText(rawText);
  if (text === undefined) {
    return undefined;
  }
  return { timeMs: Math.round(Number(seconds) * 1000), mode, color: rgb, weight: Math.min(Number(weight), WEIGHT_MAX), text };
}

/**
 * Reads bilibili's danmaku list XML with a scanner that knows only this document: elements
 * named `d` with a `p` attribute and text. Comments, CDATA, processing instructions and
 * declarations between elements are skipped; nothing is resolved or fetched (no DTD, no
 * external entities), and every text stays plain text. A document cut short loses only
 * the element it ends in. Items are in document order, before capping.
 *
 * `elements` counts the `d` elements seen, `recognized` those whose `p` had the known
 * layout (kept or dropped by rule), so a caller can tell a video without danmaku from a
 * format it does not understand.
 */
export function parseDanmakuXml(xml: string): { items: DanmakuItem[]; elements: number; recognized: number } {
  const items: DanmakuItem[] = [];
  let elements = 0;
  let recognized = 0;
  let index = 0;
  for (;;) {
    const lt = xml.indexOf("<", index);
    if (lt < 0) {
      break;
    }
    if (xml.startsWith("<!--", lt)) {
      index = skipPast(xml, "-->", lt + 4);
    } else if (xml.startsWith("<![CDATA[", lt)) {
      index = skipPast(xml, "]]>", lt + 9);
    } else if (xml.startsWith("<?", lt)) {
      index = skipPast(xml, "?>", lt + 2);
    } else if (xml.startsWith("<!", lt) || xml.startsWith("</", lt)) {
      index = skipPast(xml, ">", lt + 2);
    } else {
      const tag = readStartTag(xml, lt);
      if (tag === undefined) {
        break;
      }
      index = tag.end;
      if (tag.name !== "d") {
        continue;
      }
      elements += 1;
      let text = "";
      if (!tag.selfClosing) {
        const body = readText(xml, index);
        index = body.end;
        if (!body.closed || !body.plain) {
          continue;
        }
        text = body.text;
      }
      const item = itemOf(tag.attributes.get("p"), text);
      if (item === "malformed") {
        continue;
      }
      recognized += 1;
      if (item !== undefined) {
        items.push(item);
      }
    }
  }
  return { items, elements, recognized };
}

/**
 * Inflates a raw DEFLATE body (no zlib or gzip wrapper) as a stream, `maxBytes` of output
 * at most: the inflater is torn down at the chunk that crosses the limit, so a compression
 * bomb never expands past it. A truncated or corrupt stream is unreadable.
 */
export async function inflateRawCapped(compressed: Uint8Array, maxBytes: number): Promise<Buffer> {
  const output: Buffer[] = [];
  let total = 0;
  const slices = function* (): Generator<Uint8Array> {
    for (let offset = 0; offset < compressed.byteLength; offset += INFLATE_SLICE_BYTES) {
      yield compressed.subarray(offset, offset + INFLATE_SLICE_BYTES);
    }
  };
  // Remembered apart: tearing the pipeline down may surface the inflater's own error first.
  let overflow: Error | undefined;
  try {
    await pipeline(Readable.from(slices()), createInflateRaw(), async (inflated: AsyncIterable<Buffer>) => {
      for await (const chunk of inflated) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          overflow = unreadable(`inflates past ${maxBytes} bytes`);
          throw overflow;
        }
        output.push(chunk);
      }
    });
  } catch {
    throw overflow ?? unreadable("is not a raw deflate stream");
  }
  return Buffer.concat(output, total);
}

/**
 * The danmaku of one bilibili part in one anonymous request: no Cookie header is ever sent
 * and no login is consulted. The body (raw DEFLATE per `Content-Encoding: deflate`, or as
 * is under `identity`) is read within `DANMAKU_RESPONSE_MAX_BYTES` and inflated within
 * `DANMAKU_INFLATED_MAX_BYTES`. The platform's risk-control statuses are reported as the
 * platform being unreachable: a login would not be used, so asking for one would mislead.
 */
export async function fetchBilibiliDanmaku(
  http: OutboundHttpClient,
  cid: string,
  signal: AbortSignal,
  trustedHosts: readonly string[],
): Promise<{ items: DanmakuItem[]; truncated: boolean }> {
  if (!/^\d{1,20}$/.test(cid)) {
    throw new TypeError("not a bilibili part id");
  }
  let response: { headers: ReadonlyMap<string, string>; bytes: Uint8Array };
  try {
    response = await platformGetBytes(http, {
      url: `${DANMAKU_LIST}?oid=${cid}`,
      headers: REFERER,
      signal,
      timeoutMs: DANMAKU_FETCH_TIMEOUT_MS,
      maxBytes: DANMAKU_RESPONSE_MAX_BYTES,
      trustedHosts,
    });
  } catch (error) {
    if (isAmberError(error) && error.appError.class === "platform_blocked") {
      throw amberError("source_unreachable", error.message);
    }
    throw error;
  }
  const encoding = (response.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  let body: Uint8Array;
  if (encoding === "deflate") {
    body = await inflateRawCapped(response.bytes, DANMAKU_INFLATED_MAX_BYTES);
  } else if (encoding === "identity" || encoding === "") {
    body = response.bytes;
  } else {
    throw unreadable("has an unexpected content encoding");
  }
  const xml = new TextDecoder("utf-8").decode(body);
  if (!xml.trimStart().startsWith("<")) {
    throw unreadable("is not XML");
  }
  const parsed = parseDanmakuXml(xml);
  if (parsed.elements > 0 && parsed.recognized === 0) {
    throw unreadable("has danmaku in an unknown layout");
  }
  return capDanmakuItems(parsed.items);
}
