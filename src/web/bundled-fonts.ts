import { SUBTITLE_FONT_MAX_BYTES } from "../shared/defaults.ts";
import type { ReaderFontFace } from "../shared/reader-typography.ts";
import type { ApiClient } from "./api/client.ts";

/**
 * The fonts Amber ships, read through the API and registered with the document from memory.
 * The page's CSP allows no font source, so a `url()` font face would never load; a FontFace
 * built from the fetched bytes involves no font request at all. `sans` is the subtitle font,
 * which is also the reading view's 黑体.
 */
export type BundledFontFace = "sans" | ReaderFontFace;

interface BundledFontSource {
  /** The family the face registers as; style sheets name it. */
  family: string;
  path: string;
  mime: string;
}

const SOURCES: Readonly<Record<BundledFontFace, BundledFontSource>> = {
  sans: { family: "Noto Sans SC", path: "/api/fonts/subtitle", mime: "font/otf" },
  serif: { family: "Noto Serif SC", path: "/api/fonts/reader/serif", mime: "font/otf" },
  kai: { family: "LXGW WenKai Lite", path: "/api/fonts/reader/kai", mime: "font/ttf" },
};

/** The family a bundled face registers as. */
export function bundledFontFamily(face: BundledFontFace): string {
  return SOURCES[face].family;
}

const loading = new Map<BundledFontFace, Promise<boolean>>();
const loaded = new Set<BundledFontFace>();

/**
 * Fetches a bundled face and registers it with the document, once per page. Concurrent
 * callers share one attempt. Resolves false when the font cannot be had — no FontFace API,
 * a failed or refused download, bytes the browser cannot use — and forgets that failure, so
 * the next attempt tries again.
 */
export function loadBundledFont(client: ApiClient, face: BundledFontFace): Promise<boolean> {
  const pending = loading.get(face);
  if (pending !== undefined) return pending;
  const source = SOURCES[face];
  const attempt = (async () => {
    const FontFaceClass = globalThis.FontFace as typeof FontFace | undefined;
    const fonts = typeof document === "undefined" ? undefined : (document.fonts as FontFaceSet | undefined);
    if (FontFaceClass === undefined || fonts === undefined) return false;
    const buffer = await client.bytes(source.path, { accept: source.mime, maxBytes: SUBTITLE_FONT_MAX_BYTES });
    const font = new FontFaceClass(source.family, buffer);
    await font.load();
    fonts.add(font);
    return true;
  })().catch(() => false);
  const settled = attempt.then((ok) => {
    if (ok) loaded.add(face);
    else if (loading.get(face) === settled) loading.delete(face);
    return ok;
  });
  loading.set(face, settled);
  return settled;
}

/** Whether a face is already registered, so a view can switch to it without waiting a turn. */
export function isBundledFontLoaded(face: BundledFontFace): boolean {
  return loaded.has(face);
}

/** Forgets every loaded face; tests use it between cases. */
export function resetBundledFonts(): void {
  loading.clear();
  loaded.clear();
}
