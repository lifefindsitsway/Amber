import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContentDetailDto } from "../../shared/dto/content.ts";
import type { DanmakuItem } from "../../shared/dto/danmaku.ts";
import { DanmakuClock } from "./danmaku-clock.ts";
import { useDanmakuSnapshot } from "./danmaku-data.ts";
import { thinByWeight } from "./danmaku-density.ts";
import { createDanmakuOpenState, DanmakuMenu, DanmakuSettingsItem, useReducedMotion, type DanmakuOpenState } from "./danmaku-menu.tsx";
import { useDanmakuPrefs } from "./danmaku-prefs.ts";
import type { DanmakuBand } from "./danmaku-scheduler.ts";
import { isNarrowPlayer } from "./danmaku-narrow.ts";
import { createDomSurface, createTextMeasure } from "./danmaku-surface.ts";
import type { PlayerExtensionContext, PlayerExtensions } from "./player-extensions.ts";

/** Danmaku text height as a share of the picture's height at size 100%, within the bounds below. */
const FONT_HEIGHT_RATIO = 0.05;
const FONT_MIN_PX = 14;
const FONT_MAX_PX = 28;
/** Lane pitch per font pixel, a comfortable line height. */
const LINE_HEIGHT_RATIO = 1.3;
/** Room kept clear above and below the subtitles. */
const SUBTITLE_MARGIN_PX = 4;

const NO_ITEMS: readonly DanmakuItem[] = [];

/** Closes the popover when the `<video>` player goes (another player, another page), so it does not reopen with it. */
function useCloseOnLeave(openState: DanmakuOpenState): void {
  useEffect(() => () => openState.set(false), [openState]);
}

/** The font size of danmaku on a picture `height` pixels tall at `scale`. */
export function danmakuFontPx(height: number, scale: number): number {
  return Math.round(Math.min(FONT_MAX_PX, Math.max(FONT_MIN_PX, height * FONT_HEIGHT_RATIO)) * scale);
}

const byTime = (items: readonly DanmakuItem[]): readonly DanmakuItem[] => {
  for (let index = 1; index < items.length; index += 1) {
    if ((items[index - 1] as DanmakuItem).timeMs > (items[index] as DanmakuItem).timeMs) return [...items].sort((a, b) => a.timeMs - b.timeMs);
  }
  return items;
};

/**
 * Keeps new danmaku clear of the subtitles where they really are: the subtitle block's box,
 * measured whenever the subtitles change, move or the picture does. Between two cues the last
 * box stays reserved, so items placed in a pause between sentences do not sit under the next
 * one; with subtitles off nothing is reserved.
 */
function useSubtitleAvoidance(clock: DanmakuClock | undefined, container: HTMLElement | null, layer: HTMLElement | null, picture: PlayerExtensionContext["picture"]): void {
  useEffect(() => {
    if (clock === undefined || container === null || layer === null) return undefined;
    let last: DanmakuBand | undefined;
    let overlay: Element | null = null;
    let block: Element | null = null;
    const overlayObserver = new MutationObserver(() => measure());
    const blockObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => measure());
    function measure(): void {
      const nextOverlay = container?.querySelector('[data-testid="subtitle-overlay"]') ?? null;
      if (nextOverlay !== overlay) {
        overlayObserver.disconnect();
        overlay = nextOverlay;
        if (overlay !== null) overlayObserver.observe(overlay, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] });
      }
      if (overlay === null) {
        last = undefined;
      } else {
        const nextBlock = overlay.querySelector('[data-testid="subtitle-block"]');
        if (nextBlock !== block) {
          if (block !== null) blockObserver?.unobserve(block);
          block = nextBlock;
          if (block !== null) blockObserver?.observe(block);
        }
        if (block !== null && layer !== null) {
          const box = block.getBoundingClientRect();
          const origin = layer.getBoundingClientRect();
          if (box.height > 0) last = { top: box.top - origin.top - SUBTITLE_MARGIN_PX, bottom: box.bottom - origin.top + SUBTITLE_MARGIN_PX };
        }
      }
      clock?.setAvoid(last);
    }
    // The overlay mounts and unmounts as subtitles are switched on and off.
    const rootObserver = new MutationObserver(() => measure());
    rootObserver.observe(container, { childList: true });
    measure();
    return () => {
      rootObserver.disconnect();
      overlayObserver.disconnect();
      blockObserver?.disconnect();
    };
  }, [clock, container, layer, picture.x, picture.y, picture.width, picture.height]);
}

/**
 * The danmaku over the picture, under the subtitles. Nothing is drawn while danmaku are off
 * or the file has no picture. The clock follows `context.video`, so a new quality's element
 * takes over where the old one stood; a fetched snapshot or another density swaps the list
 * without clearing what is on screen; a new size, font size or motion setting lays the screen
 * out again for the current time.
 */
function DanmakuLayer(props: { contentId: string; context: PlayerExtensionContext; openState: DanmakuOpenState }) {
  const { context } = props;
  useCloseOnLeave(props.openState);
  const [prefs] = useDanmakuPrefs();
  const snapshot = useDanmakuSnapshot(props.contentId, prefs.enabled);
  const reducedMotion = useReducedMotion();
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [clock, setClock] = useState<DanmakuClock | undefined>(undefined);
  const stored = snapshot.data?.snapshot?.items ?? NO_ITEMS;
  const items = useMemo(() => thinByWeight(byTime(stored), prefs.density), [stored, prefs.density]);
  const { width, height } = context.picture;
  const fontPx = danmakuFontPx(height, prefs.fontScale);

  useLayoutEffect(() => {
    if (layer === null) return undefined;
    const created = new DanmakuClock(createDomSurface(layer));
    setClock(created);
    return () => {
      created.dispose();
      setClock(undefined);
    };
  }, [layer]);

  useLayoutEffect(() => {
    if (clock === undefined || layer === null) return;
    const family = getComputedStyle(layer).fontFamily;
    clock.setStage(
      width > 0 && height > 0 ? { width, height, laneHeight: Math.round(fontPx * LINE_HEIGHT_RATIO), gap: fontPx } : undefined,
      createTextMeasure(`600 ${fontPx}px ${family === "" ? "sans-serif" : family}`, fontPx),
    );
  }, [clock, layer, width, height, fontPx]);

  useLayoutEffect(() => {
    clock?.setStaticOnly(reducedMotion);
  }, [clock, reducedMotion]);

  useLayoutEffect(() => {
    clock?.setItems(items);
  }, [clock, items]);

  // Bound last, so the first layout already has its stage and items.
  useLayoutEffect(() => {
    clock?.bind(context.video);
  }, [clock, context.video]);

  useSubtitleAvoidance(clock, context.container, layer, context.picture);

  if (!prefs.enabled) return null;
  return (
    <div
      ref={setLayer}
      aria-hidden="true"
      className="pointer-events-none absolute overflow-hidden leading-none font-semibold select-none"
      style={{ left: context.picture.x, top: context.picture.y, width, height, opacity: prefs.opacity, fontSize: fontPx, lineHeight: `${Math.round(fontPx * LINE_HEIGHT_RATIO)}px`, contain: "strict" }}
      data-testid="danmaku-layer"
    />
  );
}

/**
 * The danmaku button and layer for the `<video>` player, when the Content's platform offers
 * danmaku; `undefined` otherwise. Both stay away from a file without a picture. A narrow
 * picture (DANMAKU_NARROW_PICTURE_PX) moves the button into the settings menu as 「弹幕」,
 * which opens the same popover from the picture's corner. The result is the same object while
 * the Content and its danmaku summary are unchanged.
 */
export function useDanmakuExtension(content: ContentDetailDto): PlayerExtensions | undefined {
  const contentId = content.id;
  const supported = content.danmaku !== undefined;
  const fetchedAt = content.danmaku?.fetchedAt;
  const count = content.danmaku?.count;
  const openState = useMemo(() => createDanmakuOpenState(), [contentId]);
  return useMemo(() => {
    if (!supported) return undefined;
    const summary = { ...(fetchedAt === undefined ? {} : { fetchedAt }), ...(count === undefined ? {} : { count }) };
    const menu = (context: PlayerExtensionContext, anchored: boolean) => (
      <DanmakuMenu
        contentId={contentId}
        summary={summary}
        container={context.container}
        onOpenChange={context.onMenuOpenChange}
        openState={openState}
        {...(anchored ? { anchor: context.picture } : {})}
      />
    );
    return {
      pictureLayers: (context) =>
        context.audioOnly ? null : (
          <>
            <DanmakuLayer contentId={contentId} context={context} openState={openState} />
            {isNarrowPlayer(context.picture) ? menu(context, true) : null}
          </>
        ),
      controls: (context) =>
        context.audioOnly || isNarrowPlayer(context.picture) ? null : (
          <span className="flex" data-control="danmaku">
            {menu(context, false)}
          </span>
        ),
      settingsItems: (context) => (context.audioOnly || !isNarrowPlayer(context.picture) ? null : <DanmakuSettingsItem openState={openState} />),
    } satisfies PlayerExtensions;
  }, [contentId, supported, fetchedAt, count, openState]);
}
