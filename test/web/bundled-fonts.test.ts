import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/web/api/client.ts";
import { bundledFontFamily, isBundledFontLoaded, loadBundledFont, resetBundledFonts } from "../../src/web/bundled-fonts.ts";
import { loadSubtitleFont, SUBTITLE_FONT_FAMILY } from "../../src/web/player/subtitle-font.ts";

/** A FontFace stand-in recording what was registered; jsdom has no font loading. */
function fakeFonts(options: { failLoad?: boolean } = {}) {
  const added: Array<{ family: string; size: number }> = [];
  class FakeFontFace {
    readonly family: string;
    readonly source: ArrayBuffer;
    constructor(family: string, source: ArrayBuffer) {
      this.family = family;
      this.source = source;
    }
    load(): Promise<this> {
      return options.failLoad === true ? Promise.reject(new Error("unusable font")) : Promise.resolve(this);
    }
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: FakeFontFace) => added.push({ family: face.family, size: face.source.byteLength }) } });
  return added;
}

/** Answers each font path with bytes of the type the path names, unless `fail` lists it. */
function fontServer(fail: Set<string> = new Set()) {
  const calls: Array<{ url: string; accept: string | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, accept: (init.headers as Record<string, string>)["accept"] });
    if (fail.has(url)) return new Response("missing", { status: 404 });
    const type = url.endsWith("/kai") ? "font/ttf" : "font/otf";
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": type } });
  });
  return calls;
}

const client = new ApiClient({ baseUrl: "" }, "local");

beforeEach(() => resetBundledFonts());
afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
});

describe("bundled fonts", () => {
  it("reads each face from its route with its type and registers it under its family, once per page", async () => {
    const added = fakeFonts();
    const calls = fontServer();
    expect(await Promise.all([loadBundledFont(client, "serif"), loadBundledFont(client, "serif"), loadBundledFont(client, "kai")])).toEqual([true, true, true]);
    expect(await loadBundledFont(client, "serif")).toBe(true);
    expect(calls).toEqual([
      { url: "/api/fonts/reader/serif", accept: "font/otf" },
      { url: "/api/fonts/reader/kai", accept: "font/ttf" },
    ]);
    expect(added).toEqual([
      { family: "Noto Serif SC", size: 3 },
      { family: "LXGW WenKai Lite", size: 3 },
    ]);
    expect([bundledFontFamily("sans"), bundledFontFamily("serif"), bundledFontFamily("kai")]).toEqual(["Noto Sans SC", "Noto Serif SC", "LXGW WenKai Lite"]);
  });

  it("shares the subtitle font as the sans face: one read serves both", async () => {
    const added = fakeFonts();
    const calls = fontServer();
    expect(isBundledFontLoaded("sans")).toBe(false);
    expect(await loadSubtitleFont(client)).toBe(true);
    expect(isBundledFontLoaded("sans")).toBe(true);
    expect(await loadBundledFont(client, "sans")).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["/api/fonts/subtitle"]);
    expect(added).toEqual([{ family: SUBTITLE_FONT_FAMILY, size: 3 }]);
  });

  it("forgets a failed read or an unusable font, so the next attempt tries again, without touching other faces", async () => {
    fakeFonts();
    const calls = fontServer(new Set(["/api/fonts/reader/kai"]));
    expect(await loadBundledFont(client, "kai")).toBe(false);
    expect(isBundledFontLoaded("kai")).toBe(false);
    expect(await loadBundledFont(client, "serif")).toBe(true);
    expect(await loadBundledFont(client, "kai")).toBe(false);
    expect(calls.map((call) => call.url)).toEqual(["/api/fonts/reader/kai", "/api/fonts/reader/serif", "/api/fonts/reader/kai"]);

    resetBundledFonts();
    fakeFonts({ failLoad: true });
    fontServer();
    expect(await loadBundledFont(client, "serif")).toBe(false);
    expect(isBundledFontLoaded("serif")).toBe(false);
  });

  it("reads nothing without a FontFace API", async () => {
    const calls = fontServer();
    vi.stubGlobal("FontFace", undefined);
    expect(await loadBundledFont(client, "kai")).toBe(false);
    expect(calls).toEqual([]);
  });
});
