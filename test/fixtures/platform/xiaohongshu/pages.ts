import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../../../src/server/ports/outbound-http.ts";

/**
 * Sanitized Xiaohongshu pages and doubles for the adapter tests. The pages keep the shape of
 * real ones (the embedded state, the scripts around it, `undefined` where the platform writes
 * it); every id, name, token, signature and media path is a placeholder.
 */

const DIR = join(import.meta.dirname, ".");

export const VIDEO_NOTE_ID = "64e0a1b2c3d4e5f600112233";
export const IMAGE_NOTE_ID = "64e0a1b2c3d4e5f600445566";
export const AUTHOR_ID = "5f00000000000000000000b2";
/** Synthetic access parameters; tests search errors for them. */
export const TOKEN = "xxxxTESTONLYtoken";
export const SOURCE = "xxxx_source";

/** A note link as the user pastes it, with or without the access parameters. */
export function noteLink(noteId: string, params: { token?: string; source?: string } = { token: TOKEN, source: SOURCE }): string {
  const search = new URLSearchParams();
  if (params.token !== undefined) search.set("xsec_token", params.token);
  if (params.source !== undefined) search.set("xsec_source", params.source);
  const query = search.toString();
  return `https://www.xiaohongshu.com/explore/${noteId}${query === "" ? "" : `?${query}`}`;
}

export function page(name: "mobile-video" | "mobile-image" | "desktop-video"): string {
  return readFileSync(join(DIR, `${name}.html`), "utf8");
}

/** The desktop home feed, whose embedded state says whether its viewer is logged in; no state at all when `loggedIn` is undefined. */
export function homePage(loggedIn: boolean | undefined): string {
  if (loggedIn === undefined) {
    return "<!doctype html><html><body><div id=\"app\"></div></body></html>";
  }
  const userInfo = loggedIn ? `{"userId":"${AUTHOR_ID}","redId":"xxxxred"}` : `{"userId":undefined,"redId":undefined}`;
  return `<!doctype html><html><body><script>window.__INITIAL_STATE__={"global":{"firstVisitUrl":undefined},"user":{"loggedIn":${loggedIn},"activated":${loggedIn},"userInfo":${userInfo}},"feed":{"feedsWrapper":undefined}}</script></body></html>`;
}

/** The page the platform answers with a redirect to its login page, the original URL nested encoded in the query. */
export function loginRedirect(from: string): FakeAnswer {
  return { status: 302, headers: { location: `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(from)}` }, body: "" };
}

export interface FakeAnswer {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type FakeHandler = (request: OutboundRequest) => FakeAnswer | Error | Promise<FakeAnswer | Error>;

/** An HTTP double answering text or bytes, recording every request; nothing leaves the machine. */
export class FakeHttp implements OutboundHttpClient {
  readonly requests: OutboundRequest[] = [];
  handler: FakeHandler;

  constructor(handler: FakeHandler) {
    this.handler = handler;
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    const answer = await this.handler(request);
    if (answer instanceof Error) {
      throw answer;
    }
    const bytes = typeof answer.body === "string" || answer.body === undefined ? new TextEncoder().encode(answer.body ?? "") : answer.body;
    return {
      status: answer.status ?? 200,
      headers: new Map(Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
      body: (async function* () {
        yield bytes;
      })(),
      text: async () => new TextDecoder().decode(bytes),
      destroy: () => undefined,
    };
  }

  hosts(): string[] {
    return this.requests.map((request) => new URL(request.url).hostname);
  }
}

/** A 206 answer to `request`'s `Range` header over `file`, as a CDN that supports ranges gives it. */
export function rangeAnswer(file: Uint8Array, request: OutboundRequest): FakeAnswer {
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers?.["Range"] ?? "");
  if (range === null) {
    return { status: 200, headers: { "content-length": String(file.byteLength) }, body: file };
  }
  const start = Number(range[1]);
  const end = Math.min(Number(range[2]), file.byteLength - 1);
  return {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end}/${file.byteLength}`, "content-length": String(end - start + 1) },
    body: file.subarray(start, end + 1),
  };
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

/** A version-0 `tkhd` with the given display size; `rotated` sets a quarter-turn matrix. */
function tkhd(width: number, height: number, rotated: boolean): Buffer {
  const payload = Buffer.alloc(84);
  const matrix = 40;
  if (rotated) {
    payload.writeInt32BE(0x10000, matrix + 4);
    payload.writeInt32BE(-0x10000, matrix + 12);
  } else {
    payload.writeInt32BE(0x10000, matrix);
    payload.writeInt32BE(0x10000, matrix + 16);
  }
  payload.writeInt32BE(0x40000000, matrix + 32);
  payload.writeUInt32BE(width * 0x10000, 76);
  payload.writeUInt32BE(height * 0x10000, 80);
  return box("tkhd", payload);
}

function hdlr(handler: string): Buffer {
  const payload = Buffer.alloc(25);
  payload.write(handler, 8, "latin1");
  return box("hdlr", payload);
}

function stsd(codec: string, width: number, height: number): Buffer {
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(1, 4);
  return box("stsd", head, box(codec, entry));
}

export interface Mp4Options {
  width: number;
  height: number;
  codec?: string;
  /** Write `moov` after `mdat`, as files not prepared for streaming do. */
  moovAtEnd?: boolean;
  mdatBytes?: number;
  rotated?: boolean;
}

/** A minimal MP4 with an audio track and a video track of the given size and codec. */
export function mp4File(options: Mp4Options): Buffer {
  const audio = box("trak", tkhd(0, 0, false), box("mdia", hdlr("soun"), box("minf", box("stbl", stsd("mp4a", 0, 0)))));
  const video = box(
    "trak",
    tkhd(options.rotated ? options.height : options.width, options.rotated ? options.width : options.height, options.rotated === true),
    box("mdia", hdlr("vide"), box("minf", box("stbl", stsd(options.codec ?? "avc1", options.width, options.height)))),
  );
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2avc1mp41", "latin1"));
  const moov = box("moov", box("mvhd", Buffer.alloc(100)), audio, video);
  const mdat = box("mdat", Buffer.alloc(options.mdatBytes ?? 1024));
  return options.moovAtEnd === true ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}
