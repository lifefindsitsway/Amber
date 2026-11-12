import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { readerCustomFontSchema, type ReaderFont, type ReaderTypography } from "../../../shared/reader-typography.ts";
import type { ApiClient } from "../../api/client.ts";
import { isBundledFontLoaded, loadBundledFont, type BundledFontFace } from "../../bundled-fonts.ts";

/**
 * The font of the reading body. The default is no font setting at all: the element holding
 * the body gets neither the attribute nor the property below, so the text is drawn exactly as
 * it was before fonts could be chosen. Any other font is named on that element and the style
 * sheet applies it to the sentence text only (see `READER_TEXT_ATTRIBUTE`).
 */

/** The choices of the font group, in display order; `default` stands for no `font` at all. */
export const READER_FONT_CHOICES = ["default", "sans", "serif", "kai", "custom"] as const;
export type ReaderFontChoice = (typeof READER_FONT_CHOICES)[number];

/** Names the applied font on the element holding the reading body; the style sheet keys off it. */
export const READER_FONT_ATTRIBUTE = "data-reader-font";
/** Marks the paragraphs whose sentences take the reading font; times and names inside keep the UI font. */
export const READER_TEXT_ATTRIBUTE = "data-reader-text";
/** The custom property carrying the user's font name, set through the CSSOM. */
export const READER_CUSTOM_FONT_PROPERTY = "--reader-custom-font";

/** The bundled face a font is drawn with, if it is one Amber ships. */
export function bundledFaceOf(font: ReaderFont | undefined): BundledFontFace | undefined {
  return font === "sans" || font === "serif" || font === "kai" ? font : undefined;
}

export interface AppliedReaderFont {
  /** The font the body is drawn with now; undefined for the default. */
  font: ReaderFont | undefined;
  /** Differs whenever the drawn font differs, so a layout key can include it. */
  key: string;
  /** To spread on the element holding the reading body. */
  hostProps: { [READER_FONT_ATTRIBUTE]?: ReaderFont; style?: CSSProperties };
  /** The stored bundled face could not be loaded; the body stays in the default font. */
  failed: boolean;
  /** The stored bundled face is being read; the body stays in the default font meanwhile. */
  loading: boolean;
  /** Reads the stored bundled face again after a failure. */
  retry: () => void;
}

export interface AppliedReaderFontOptions {
  /**
   * Called right before a stored face that was read in the background is drawn, so the view
   * can note what it shows first; the switch is committed right after it returns, with no
   * other render in between.
   */
  onBeforeApply?: () => void;
}

/**
 * The font the reading body is drawn with for the stored choice. A bundled face is fetched
 * when it is chosen and not yet registered (a choice restored from storage, a new page); until
 * it is ready, or if it cannot be had, the body stays in the default font rather than flashing
 * a fallback. The default reads nothing. A custom name only applies once one is stored.
 */
export function useAppliedReaderFont(
  typography: Pick<ReaderTypography, "font" | "customFont">,
  client: ApiClient,
  options: AppliedReaderFontOptions = {},
): AppliedReaderFont {
  const face = bundledFaceOf(typography.font);
  const beforeApply = useRef(options.onBeforeApply);
  beforeApply.current = options.onBeforeApply;
  // The face whose load settled last and how; a newly registered face is picked up on the next render.
  const [settled, setSettled] = useState<{ face: BundledFontFace; ok: boolean } | undefined>(undefined);
  // Bumped by `retry`: picking the stored face again changes no stored value, so nothing else would re-read it.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setSettled(undefined);
    setAttempt((count) => count + 1);
  }, []);
  useEffect(() => {
    if (face === undefined || isBundledFontLoaded(face)) return undefined;
    // A failure from an earlier read of this face says nothing about the read starting now.
    setSettled((previous) => (previous?.face === face ? undefined : previous));
    let live = true;
    void loadBundledFont(client, face).then((ok) => {
      if (!live) return;
      if (!ok) {
        setSettled({ face, ok });
        return;
      }
      // The face is drawn by the render this update causes, which resizes the rows. Committing it
      // synchronously keeps any unrelated render from landing between the note and the switch.
      beforeApply.current?.();
      flushSync(() => setSettled({ face, ok }));
    });
    return () => {
      live = false;
    };
  }, [face, client, attempt]);
  const ready = face !== undefined && isBundledFontLoaded(face);
  const failed = face !== undefined && !ready && settled?.face === face && !settled.ok;
  const loading = face !== undefined && !ready && !failed;
  const custom = typography.font === "custom" && readerCustomFontSchema.safeParse(typography.customFont).success ? typography.customFont : undefined;
  return useMemo<AppliedReaderFont>(() => {
    if (face !== undefined && ready) return { font: face, key: face, hostProps: { [READER_FONT_ATTRIBUTE]: face }, failed: false, loading: false, retry };
    if (custom !== undefined) {
      // The name is quoted so it is always a family name, never a keyword like `serif`. The schema
      // keeps quotes, backslashes and other value-ending characters out, and React writes custom
      // properties with `style.setProperty`, so the name never becomes style sheet text.
      const style = { [READER_CUSTOM_FONT_PROPERTY]: `"${custom}"` } as CSSProperties;
      return { font: "custom", key: `custom:${custom}`, hostProps: { [READER_FONT_ATTRIBUTE]: "custom", style }, failed: false, loading: false, retry };
    }
    return { font: undefined, key: "default", hostProps: {}, failed, loading, retry };
  }, [face, ready, custom, failed, loading, retry]);
}

/**
 * Wide and narrow glyphs, CJK among them, so a substitute font almost always changes the box.
 * The CJK glyphs (永和九年) are given by code point: they are measured, never shown, and so
 * are not copy for the i18n resources.
 */
const PROBE_TEXT = `mmmmmmmmmmlli WwQq 0123 ${String.fromCodePoint(0x6c38, 0x548c, 0x4e5d, 0x5e74)}`;
const GENERIC_FAMILIES = ["monospace", "serif", "sans-serif"] as const;

/**
 * Whether a font of this name seems installed: text set in it, falling back to a generic
 * family, measures differently from the generic family alone. A heuristic for a hint only — a
 * font metrically identical to all three generic families reads as missing, and nothing is
 * ever refused because of it.
 */
export function isLocalFontAvailable(name: string): boolean {
  if (typeof document === "undefined" || document.body === null || !readerCustomFontSchema.safeParse(name).success) return false;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.textContent = PROBE_TEXT;
  Object.assign(probe.style, { position: "absolute", left: "-10000px", top: "-10000px", visibility: "hidden", whiteSpace: "nowrap", fontSize: "72px", lineHeight: "normal" });
  document.body.append(probe);
  try {
    return GENERIC_FAMILIES.some((generic) => {
      probe.style.setProperty("font-family", generic);
      const width = probe.offsetWidth;
      const height = probe.offsetHeight;
      probe.style.setProperty("font-family", `"${name}", ${generic}`);
      return probe.offsetWidth !== width || probe.offsetHeight !== height;
    });
  } finally {
    probe.remove();
  }
}
