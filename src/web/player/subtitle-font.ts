import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { bundledFontFamily, loadBundledFont, resetBundledFonts } from "../bundled-fonts.ts";

/** The family the bundled font registers as; exports render with the same font. */
export const SUBTITLE_FONT_FAMILY = bundledFontFamily("sans");
/** The overlay's font stack: the bundled font, then whatever the system offers. */
export const SUBTITLE_FONT_STACK = `"${SUBTITLE_FONT_FAMILY}", sans-serif`;

/**
 * Fetches the bundled subtitle font and registers it with the document, once per page.
 * Resolves false when the font cannot be had and forgets that failure, so the next attempt
 * tries again. The reading view's 黑体 is the same face and shares the one load.
 */
export function loadSubtitleFont(client: ApiClient): Promise<boolean> {
  return loadBundledFont(client, "sans");
}

/** Forgets the loaded font; tests use it between cases. */
export function resetSubtitleFont(): void {
  resetBundledFonts();
}

/**
 * Whether the overlay previews with a fallback font: false until `enabled` first turns true
 * (the font is only fetched once subtitles are switched on), then true if loading failed.
 */
export function useSubtitleFontFallback(enabled: boolean): boolean {
  const client = useApi();
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void loadSubtitleFont(client).then((ok) => {
      if (live) setFallback(!ok);
    });
    return () => {
      live = false;
    };
  }, [enabled, client]);
  return fallback;
}
