import { describe, expect, it } from "vitest";
import { initialStateOf, loggedInOf, notePageDetail } from "../../../../../src/server/adapters/platform/xiaohongshu/page.ts";
import { PLATFORM_TITLE_MAX_CHARS } from "../../../../../src/shared/defaults.ts";
import { AUTHOR_ID, homePage, IMAGE_NOTE_ID, page, VIDEO_NOTE_ID } from "../../../../fixtures/platform/xiaohongshu/pages.ts";

const MOBILE = page("mobile-video");
const DESKTOP = page("desktop-video");

/** The same page with its note's title replaced (the title is unique in each fixture). */
function withTitle(html: string, title: string): string {
  return html.replace('"title":"周末在家做一碗番茄牛腩面"', `"title":${JSON.stringify(title)}`);
}

describe("initialStateOf", () => {
  it("parses the embedded state, turning only the bare undefined into null", () => {
    const html = '<script>window.__INITIAL_STATE__={"a":undefined,"b":"undefined","c":[undefined],"undefinedKey":"x\\"undefined"}</script>';
    expect(initialStateOf(html)).toEqual({ a: null, b: "undefined", c: [null], undefinedKey: 'x"undefined' });
  });

  it("reads only the literal: scripts and undefined around it change nothing", () => {
    const decorated = MOBILE.replace(
      "<script>window.__INITIAL_STATE__=",
      '<script>var before = undefined; window.y = "{";</script><script>window.__INITIAL_STATE__=',
    ).replace("</body>", "<script>window.after = undefined; throw new Error(undefined)</script></body>");
    expect(initialStateOf(decorated)).toEqual(initialStateOf(MOBILE));
    expect(notePageDetail(decorated, "mobile", VIDEO_NOTE_ID)).toEqual(notePageDetail(MOBILE, "mobile", VIDEO_NOTE_ID));
  });

  it("ignores the marker quoted inside an attribute", () => {
    // The fixture's og:title quotes the marker; the state still comes from the script.
    expect(MOBILE).toContain('content="周末在家做一碗番茄牛腩面 window.__INITIAL_STATE__=');
    expect(initialStateOf(MOBILE)).toHaveProperty("noteData");
  });

  it("gives nothing for a page without state, a truncated literal or one that is not JSON", () => {
    expect(initialStateOf("<html><body>login</body></html>")).toBeUndefined();
    expect(initialStateOf('<script>window.__INITIAL_STATE__={"a":1</script>')).toBeUndefined();
    expect(initialStateOf("<script>window.__INITIAL_STATE__={a:1}</script>")).toBeUndefined();
    expect(initialStateOf("<script>window.__INITIAL_STATE__=loadState()</script>")).toBeUndefined();
  });
});

describe("notePageDetail", () => {
  it("reads the same note from the mobile and the desktop page", () => {
    const mobile = notePageDetail(MOBILE, "mobile", VIDEO_NOTE_ID);
    const desktop = notePageDetail(DESKTOP, "desktop", VIDEO_NOTE_ID);
    const expected = {
      noteId: VIDEO_NOTE_ID,
      type: "video",
      title: "周末在家做一碗番茄牛腩面",
      description: { state: "found", text: "牛腩提前焯水，番茄炒出沙。\n小火炖一个半小时 #番茄牛腩 #家常菜" },
      publishedAt: 1794830642000,
      channelId: AUTHOR_ID,
      channelTitle: "厨房里的小王",
    };
    expect(mobile).toMatchObject(expected);
    expect(desktop).toMatchObject(expected);
    expect(mobile?.durationMs).toBe(284867);
    expect(desktop?.durationMs).toBe(284866);
    expect(mobile?.coverUrl).toMatch(/^https:\/\/sns-webpic-qc\.xhscdn\.com\/.+h5_1080jpg$/);
    expect(desktop?.coverUrl).toMatch(/^https:\/\/sns-webpic-qc\.xhscdn\.com\/.+webp_mw_1$/);
  });

  it("keeps only H.264 MP4 streams, over https, main address first", () => {
    const mobile = notePageDetail(MOBILE, "mobile", VIDEO_NOTE_ID);
    expect(mobile?.streams).toEqual([
      {
        urls: [
          "https://sns-video-v3.xhscdn.com/stream/1/110/259/xxxxstream_259.mp4?sign=xxxxsign&t=xxxx",
          "https://sns-bak-v1.xhscdn.com/stream/1/110/259/xxxxstream_259.mp4",
          "https://sns-bak-v6.xhscdn.com/stream/1/110/259/xxxxstream_259.mp4",
        ],
        sizeBytes: 7790374,
        width: 720,
        height: 960,
        durationMs: 284867,
      },
    ]);
    expect(notePageDetail(DESKTOP, "desktop", VIDEO_NOTE_ID)?.streams.map((stream) => stream.sizeBytes)).toEqual([9919338]);
  });

  it("names the untranscoded upload only where the page has its key", () => {
    expect(notePageDetail(MOBILE, "mobile", VIDEO_NOTE_ID)?.originalUrl).toBe("https://sns-video-bd.xhscdn.com/pre_post/xxxxoriginkey000000000000000000000000000000");
    expect(notePageDetail(DESKTOP, "desktop", VIDEO_NOTE_ID)?.originalUrl).toBeUndefined();
    const odd = MOBILE.replace('"originVideoKey":"pre_post/', '"originVideoKey":"../evil.example/');
    expect(notePageDetail(odd, "mobile", VIDEO_NOTE_ID)?.originalUrl).toBeUndefined();
  });

  it("drops stream addresses off the media domain, including look-alike hosts", () => {
    const html = MOBILE.replace("http://sns-video-v3.xhscdn.com/stream/1/110/259", "http://sns-video-v3.evilxhscdn.com/stream/1/110/259").replace(
      "http://sns-bak-v1.xhscdn.com/stream/1/110/259",
      "http://sns-bak-v1.xhscdn.com.evil.example/stream/1/110/259",
    );
    expect(notePageDetail(html, "mobile", VIDEO_NOTE_ID)?.streams[0]?.urls).toEqual(["https://sns-bak-v6.xhscdn.com/stream/1/110/259/xxxxstream_259.mp4"]);
  });

  it("reads an image note as type normal without streams", () => {
    expect(notePageDetail(page("mobile-image"), "mobile", IMAGE_NOTE_ID)).toMatchObject({ type: "normal", streams: [], title: "秋天的十张照片" });
  });

  it("caps a long title at a grapheme boundary and titles an untitled note from its text", () => {
    const family = "👨‍👩‍👧";
    const long = `${"标".repeat(PLATFORM_TITLE_MAX_CHARS - 2)}${family}尾`;
    const title = notePageDetail(withTitle(MOBILE, long), "mobile", VIDEO_NOTE_ID)?.title ?? "";
    expect(title).toBe("标".repeat(PLATFORM_TITLE_MAX_CHARS - 2));
    expect(notePageDetail(withTitle(MOBILE, "  第一行\n第二行\u0007 "), "mobile", VIDEO_NOTE_ID)?.title).toBe("第一行 第二行");
    expect(notePageDetail(withTitle(MOBILE, ""), "mobile", VIDEO_NOTE_ID)?.title).toBe("牛腩提前焯水，番茄炒出沙。");
  });

  it("gives nothing when the state is missing, the note is another one or a used field does not validate", () => {
    expect(notePageDetail("<html></html>", "mobile", VIDEO_NOTE_ID)).toBeUndefined();
    expect(notePageDetail(MOBILE, "desktop", VIDEO_NOTE_ID)).toBeUndefined();
    expect(notePageDetail(DESKTOP, "mobile", VIDEO_NOTE_ID)).toBeUndefined();
    expect(notePageDetail(MOBILE, "mobile", IMAGE_NOTE_ID)).toBeUndefined();
    expect(notePageDetail(MOBILE.replace('"type":"video"', '"type":7'), "mobile", VIDEO_NOTE_ID)).toBeUndefined();
    expect(notePageDetail(MOBILE.replace('"time":1794830642000,"noteId"', '"time":"yesterday","noteId"'), "mobile", VIDEO_NOTE_ID)).toBeUndefined();
  });
});

describe("loggedInOf", () => {
  it("reads whether the viewer is logged in, and nothing from a page that does not say", () => {
    expect(loggedInOf(homePage(true))).toBe(true);
    expect(loggedInOf(homePage(false))).toBe(false);
    expect(loggedInOf(DESKTOP)).toBe(false);
    expect(loggedInOf(homePage(undefined))).toBeUndefined();
    expect(loggedInOf(MOBILE)).toBeUndefined();
  });
});
