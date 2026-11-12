import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { READER_FONT_FACES, type ReaderFontFace } from "../../../shared/reader-typography.ts";
import { amberError } from "../../domain/errors.ts";
import { principalOf } from "../auth.ts";

/** File name of the bundled subtitle font in the fonts directory beside `AMBER_BIN_DIR`; the fixed ASS styles name this font. */
export const SUBTITLE_FONT_FILE = "NotoSansSC-Regular.otf";

/**
 * The reading fonts in the same directory, by the face the reading view asks for. Each is the
 * upstream file as published, so its format (and with it the served type) is the upstream one.
 */
export const READER_FONT_FILES: Readonly<Record<ReaderFontFace, { file: string; mimeType: string }>> = {
  serif: { file: "NotoSerifSC-Regular.otf", mimeType: "font/otf" },
  kai: { file: "LXGWWenKaiLite-Regular.ttf", mimeType: "font/ttf" },
};

/**
 * A font file Amber ships. Its SHA-256 is computed once per file version (size and
 * modification time) and reused: it is the route's ETag (and, for the subtitle font, part of
 * a styled export's input digest), and the file only changes when the runtime assets are replaced.
 */
export class BundledFont {
  readonly path: string;
  readonly mimeType: string;
  private cached: { key: string; sha256: Promise<string> } | undefined;

  constructor(path: string, mimeType: string) {
    this.path = path;
    this.mimeType = mimeType;
  }

  /** Size and hex SHA-256 of the font; `not_found` when the file is missing. */
  async describe(): Promise<{ sizeBytes: number; sha256: string }> {
    const info = await stat(this.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        throw amberError("not_found", `the bundled font ${basename(this.path)} is missing`);
      }
      throw error;
    });
    const key = `${info.size}:${info.mtimeMs}`;
    if (this.cached?.key !== key) {
      const sha256 = hashFile(this.path);
      const entry = { key, sha256 };
      this.cached = entry;
      sha256.catch(() => {
        if (this.cached === entry) {
          this.cached = undefined;
        }
      });
    }
    return { sizeBytes: info.size, sha256: await this.cached.sha256 };
  }

  /** `sha256:<hex>`, the digest format of every other file Amber records. */
  async digest(): Promise<string> {
    return `sha256:${(await this.describe()).sha256}`;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Whether an `If-None-Match` header names `etag` (or is `*`); weak and strong forms compare alike. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//u, "") === etag;
  });
}

/** The bundled subtitle font, an OpenType file. */
export class BundledSubtitleFont extends BundledFont {
  constructor(path: string) {
    super(path, "font/otf");
  }
}

export type BundledReaderFonts = Readonly<Record<ReaderFontFace, BundledFont>>;

/** The reading fonts in `fontsDir`, the directory that also holds the subtitle font. */
export function bundledReaderFonts(fontsDir: string): BundledReaderFonts {
  const entry = (face: ReaderFontFace): BundledFont => new BundledFont(join(fontsDir, READER_FONT_FILES[face].file), READER_FONT_FILES[face].mimeType);
  return { serif: entry("serif"), kai: entry("kai") };
}

/**
 * Sends a font with its digest as ETag. `no-cache` lets the WebView keep the bytes and
 * revalidate cheaply, so a replaced font is picked up after an update.
 */
async function sendFont(request: FastifyRequest, reply: FastifyReply, font: BundledFont): Promise<FastifyReply> {
  const { sizeBytes, sha256 } = await font.describe();
  const etag = `"${sha256}"`;
  reply.header("etag", etag).header("cache-control", "private, no-cache");
  if (matches(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }
  return reply.code(200).header("content-type", font.mimeType).header("content-length", String(sizeBytes)).send(createReadStream(font.path));
}

function isReaderFontFace(value: string): value is ReaderFontFace {
  return (READER_FONT_FACES as readonly string[]).includes(value);
}

/**
 * `GET /api/fonts/subtitle` (both modes): the bundled subtitle font, so the player overlay
 * draws with the font the export uses. `GET /api/fonts/reader/:face` (both modes): the other
 * fonts the reading view offers; its sans face is the subtitle font, read from that route.
 */
export function registerFontRoutes(app: FastifyInstance, deps: { font: BundledSubtitleFont; readerFonts?: BundledReaderFonts }): void {
  app.get("/api/fonts/subtitle", async (request, reply) => {
    principalOf(request);
    return sendFont(request, reply, deps.font);
  });
  const readerFonts = deps.readerFonts;
  if (readerFonts === undefined) return;
  app.get<{ Params: { face: string } }>("/api/fonts/reader/:face", async (request, reply) => {
    principalOf(request);
    const { face } = request.params;
    if (!isReaderFontFace(face)) {
      throw amberError("invalid_request", "unknown reading font face");
    }
    return sendFont(request, reply, readerFonts[face]);
  });
}
