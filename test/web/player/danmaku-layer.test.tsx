import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { DANMAKU_PREFS_DEFAULT, DANMAKU_PREFS_KEY } from "../../../src/shared/danmaku-prefs.ts";
import type { ContentDetailDto } from "../../../src/shared/dto/content.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import { danmakuFontPx, useDanmakuExtension } from "../../../src/web/player/danmaku-layer.tsx";
import { DANMAKU_NARROW_PICTURE_PX } from "../../../src/web/player/danmaku-narrow.ts";
import { readDanmakuPrefs, writeDanmakuPrefs } from "../../../src/web/player/danmaku-prefs.ts";
import type { PlayerExtensionContext } from "../../../src/web/player/player-extensions.ts";
import { contentDetail } from "../../fixtures/web/content-data.ts";
import { mockApi } from "../../fixtures/web/render.tsx";

const context = (overrides: Partial<PlayerExtensionContext> = {}): PlayerExtensionContext => ({
  video: null,
  picture: { x: 0, y: 10, width: 640, height: 360 },
  audioOnly: false,
  fullscreen: false,
  playing: false,
  sourceId: "asset",
  container: null,
  onMenuOpenChange: () => undefined,
  ...overrides,
});

function wrapper(props: { children: ReactNode }) {
  return <ApiProvider client={new ApiClient({ baseUrl: "" }, "server")} queryClient={createQueryClient()}>{props.children}</ApiProvider>;
}

beforeEach(() => localStorage.clear());

describe("useDanmakuExtension", () => {
  it("offers nothing for a Content whose platform has no danmaku, and the same object while nothing changes", () => {
    const plain: ContentDetailDto = contentDetail({ id: "c1" });
    expect(renderHook(() => useDanmakuExtension(plain), { wrapper }).result.current).toBeUndefined();
    const withDanmaku = contentDetail({ id: "c2", danmaku: { fetchedAt: 1, count: 3 } });
    const { result, rerender } = renderHook((props: { content: ContentDetailDto }) => useDanmakuExtension(props.content), { wrapper, initialProps: { content: withDanmaku } });
    const first = result.current;
    rerender({ content: { ...withDanmaku } });
    expect(result.current).toBe(first);
    rerender({ content: { ...withDanmaku, danmaku: { fetchedAt: 2, count: 4 } } });
    expect(result.current).not.toBe(first);
  });

  it("shows the button and layer for a picture only, and draws nothing until danmaku are switched on", () => {
    mockApi({ "GET /api/contents/c2/danmaku": { body: { supported: true } } });
    const { result } = renderHook(() => useDanmakuExtension(contentDetail({ id: "c2", danmaku: {} })), { wrapper });
    const extension = result.current;
    expect(extension?.controls?.(context({ audioOnly: true }))).toBeNull();
    expect(extension?.pictureLayers?.(context({ audioOnly: true }))).toBeNull();
    const { rerender } = render(<>{extension?.pictureLayers?.(context())}{extension?.controls?.(context())}</>, { wrapper });
    expect(screen.getByRole("button", { name: "弹幕" })).toBeTruthy();
    expect(screen.queryByTestId("danmaku-layer")).toBeNull();
    writeDanmakuPrefs({ enabled: true, opacity: 0.5 });
    rerender(<>{extension?.pictureLayers?.(context())}</>);
    const layer = screen.getByTestId("danmaku-layer");
    // Over the picture rectangle only, decorative for assistive technology, at the chosen opacity.
    expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height, layer.style.opacity]).toEqual(["0px", "10px", "640px", "360px", "0.5"]);
    expect(layer.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a narrow picture", () => {
  it("moves the button into the settings menu as 「弹幕」 and opens the popover from the picture's corner", () => {
    mockApi({ "GET /api/contents/c3/danmaku": { body: { supported: true } } });
    const { result } = renderHook(() => useDanmakuExtension(contentDetail({ id: "c3", danmaku: {} })), { wrapper });
    const extension = result.current;
    const wide = context({ picture: { x: 0, y: 0, width: DANMAKU_NARROW_PICTURE_PX, height: 225 } });
    const narrow = context({ picture: { x: 0, y: 0, width: DANMAKU_NARROW_PICTURE_PX - 1, height: 224 } });
    // A picture not measured yet counts as wide.
    const unmeasured = context({ picture: { x: 0, y: 0, width: 0, height: 0 } });
    expect(extension?.settingsItems?.(wide)).toBeNull();
    expect(extension?.settingsItems?.(unmeasured)).toBeNull();
    expect(extension?.controls?.(unmeasured)).not.toBeNull();
    expect(extension?.controls?.(narrow)).toBeNull();
    expect(extension?.settingsItems?.(narrow)).not.toBeNull();
    expect(extension?.settingsItems?.(context({ audioOnly: true, picture: narrow.picture }))).toBeNull();
    render(<>{extension?.pictureLayers?.(narrow)}</>, { wrapper });
    expect(screen.queryByTestId("player-danmaku")).toBeNull();
    expect(screen.getByTestId("player-danmaku-anchor")).toBeTruthy();
  });
});

describe("danmaku preferences", () => {
  it("read damaged or out-of-range values as the defaults and clamp what is written", () => {
    localStorage.setItem(DANMAKU_PREFS_KEY, "{not json");
    expect(readDanmakuPrefs()).toEqual(DANMAKU_PREFS_DEFAULT);
    localStorage.setItem(DANMAKU_PREFS_KEY, JSON.stringify({ ...DANMAKU_PREFS_DEFAULT, density: 5 }));
    expect(readDanmakuPrefs()).toEqual(DANMAKU_PREFS_DEFAULT);
    writeDanmakuPrefs({ density: 0, fontScale: 9 });
    expect(readDanmakuPrefs()).toEqual({ ...DANMAKU_PREFS_DEFAULT, density: 0.1, fontScale: 2 });
  });

  it("size the text by the picture's height, within bounds, times the chosen size", () => {
    expect([danmakuFontPx(200, 1), danmakuFontPx(360, 1), danmakuFontPx(1080, 1), danmakuFontPx(360, 2)]).toEqual([14, 18, 28, 36]);
  });
});
