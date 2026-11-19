import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { FIGURE_UPLOAD_MAX_BYTES, FIGURES_PER_CONTENT_MAX } from "../../src/shared/defaults.ts";
import {
  figureCaptureRequestSchema,
  figureDtoSchema,
  figureListDtoSchema,
  figurePatchRequestSchema,
  figureUploadMetaSchema,
  type FigureCaptureRequest,
  type FigureDto,
  type FigurePlacement,
  type FigureUploadMeta,
} from "../../src/shared/dto/figure.ts";
import { errorResponseSchema } from "../../src/shared/errors.ts";

/**
 * The figures of the mock backend, kept per browser context so every page of a test sees the
 * same ones (two windows editing one figure). Tests seed figures with `seedFigure` before the
 * page loads; the routes answer like the server: versions checked on PATCH, deletion soft and
 * idempotent, the image served as WebP by the figure's fixture. Every body is parsed with the
 * shared schema, so the fake cannot drift from the contract.
 */

/** The two pictures a mock figure can show: a 16:9 test pattern and a tall bar chart. */
export const FIGURE_FIXTURES = {
  landscape: { file: "mock-figures-landscape.webp", width: 640, height: 360 },
  portrait: { file: "mock-figures-portrait.webp", width: 270, height: 480 },
} as const;
export type FigureFixture = keyof typeof FIGURE_FIXTURES;

const imageBytes = new Map<FigureFixture, Buffer>();
function fixtureBytes(fixture: FigureFixture): Buffer {
  let bytes = imageBytes.get(fixture);
  if (bytes === undefined) {
    bytes = readFileSync(new URL(FIGURE_FIXTURES[fixture].file, import.meta.url));
    imageBytes.set(fixture, bytes);
  }
  return bytes;
}

interface StoredFigure {
  dto: FigureDto;
  fixture: FigureFixture;
}

export interface MockFigures {
  /** Every figure, by id. */
  figures: Map<string, StoredFigure>;
  /** Bodies of the PATCH requests, refused ones included, with the figure they named. */
  patches: Array<{ figureId: string; body: unknown }>;
  deletions: string[];
  restorations: string[];
  /** Image requests by figure id. */
  imageRequests: string[];
  /** Answers the next PATCH with a server error. */
  failNextPatch: boolean;
  /** Holds every image response until released: a figure stays in its loading state meanwhile. */
  holdImages: Promise<void> | undefined;
  /** Bodies of the capture requests that reached the server. */
  captures: FigureCaptureRequest[];
  /** Uploads that reached the server: their meta and the first bytes and size of the file. */
  uploads: Array<{ meta: FigureUploadMeta; size: number }>;
  /** Holds every upload's answer until released, so a test can watch it under way and cancel it. */
  holdUploads: Promise<void> | undefined;
  /** Uploads whose request was aborted by the page while held. */
  abortedUploads: number;
  /** The start of the clip's last frame: a capture asked for a later time finds no frame (`past_end`), as with ffmpeg. */
  lastFrameMs: number;
  clock: number;
  next: number;
}

const states = new WeakMap<BrowserContext, MockFigures>();

/** The figures of this browser context. */
export function mockFigures(page: Page): MockFigures {
  const context = page.context();
  let state = states.get(context);
  if (state === undefined) {
    state = {
      figures: new Map(),
      patches: [],
      deletions: [],
      restorations: [],
      imageRequests: [],
      failNextPatch: false,
      holdImages: undefined,
      captures: [],
      uploads: [],
      holdUploads: undefined,
      abortedUploads: 0,
      // The e2e clip runs 130 s at 10 fps.
      lastFrameMs: 129_900,
      clock: 1_790_000_000_000,
      next: 0,
    };
    states.set(context, state);
  }
  return state;
}

export const mockFigureId = (n: number): string => `01J00000000000000000FIG${String(n).padStart(3, "0")}`;

/**
 * Adds a figure to a Content. `placement` defaults to placing it by `displayMs` (0) with no
 * anchor; a capture gets `capturedAtMs` (default: the display time).
 */
export function seedFigure(
  page: Page,
  input: {
    contentId: string;
    source?: FigureDto["source"];
    capturedAtMs?: number;
    placement?: Partial<FigurePlacement>;
    widthRatio?: number;
    caption?: string;
    fixture?: FigureFixture;
    deleted?: boolean;
  },
): FigureDto {
  const state = mockFigures(page);
  state.next += 1;
  const fixture = input.fixture ?? "landscape";
  const bytes = fixtureBytes(fixture);
  const source = input.source ?? "capture";
  const displayMs = input.placement?.displayMs ?? input.capturedAtMs ?? 0;
  const createdAt = state.clock + state.next;
  const dto = figureDtoSchema.parse({
    id: mockFigureId(state.next),
    contentId: input.contentId,
    source,
    ...(source === "capture" ? { capturedAtMs: input.capturedAtMs ?? displayMs } : {}),
    placement: { displayMs, anchor: input.placement?.anchor ?? null, sortKey: input.placement?.sortKey ?? 0 },
    widthRatio: input.widthRatio ?? 0.7,
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    image: { width: FIGURE_FIXTURES[fixture].width, height: FIGURE_FIXTURES[fixture].height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).update(String(state.next)).digest("hex") },
    version: 1,
    ...(input.deleted === true ? { deletedAt: createdAt } : {}),
    createdAt,
    updatedAt: createdAt,
  });
  state.figures.set(dto.id, { dto, fixture });
  return dto;
}

/** Changes a figure as another window would, bumping its version. */
export function changeFigureElsewhere(page: Page, figureId: string, change: Partial<Pick<FigureDto, "caption" | "widthRatio" | "placement">>): FigureDto {
  const stored = mockFigures(page).figures.get(figureId);
  if (stored === undefined) throw new Error(`no figure ${figureId}`);
  stored.dto = figureDtoSchema.parse({ ...stored.dto, ...change, version: stored.dto.version + 1, updatedAt: stored.dto.updatedAt + 1 });
  return stored.dto;
}

function errorBody(code: string, klass: string, userMessage: string, details?: Record<string, unknown>) {
  return errorResponseSchema.parse({ error: { class: klass, code, retryDisposition: "never", userMessage, ...(details === undefined ? {} : { details }) } });
}

/**
 * Serves uploads ahead of the mock backend, whose catch-all reads every non-GET body as JSON
 * and so cannot take a multipart one. Call after `installMockBackend`.
 */
export async function routeFigureUploads(page: Page): Promise<void> {
  await page.route(/\/api\/contents\/[^/]+\/figures\/upload$/, async (route) => {
    const request = route.request();
    if (!(await handleFigures(route, request, new URL(request.url())))) await route.fallback();
  });
}

/** The mock backend's figures routes; answers `false` for any request it does not serve. */
export async function handleFigures(route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).then(() => true);
  const list = /^\/api\/contents\/([^/]+)\/figures$/.exec(path);
  if (list !== null && method === "GET") {
    const state = mockFigures(request.frame().page());
    const all = [...state.figures.values()].map((stored) => stored.dto).filter((dto) => dto.contentId === list[1]);
    return json(
      figureListDtoSchema.parse({
        items: all.filter((dto) => dto.deletedAt === undefined),
        recentlyDeleted: all.filter((dto) => dto.deletedAt !== undefined).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
        limit: FIGURES_PER_CONTENT_MAX,
      }),
    );
  }
  const create = /^\/api\/contents\/([^/]+)\/figures\/(capture|upload)$/.exec(path);
  if (create !== null && method === "POST") return createFigure(route, request, create[1] as string, create[2] as "capture" | "upload");
  const one = /^\/api\/figures\/([^/]+)(\/image|\/restore)?$/.exec(path);
  if (one === null) return false;
  const state = mockFigures(request.frame().page());
  const figureId = one[1] as string;
  const stored = state.figures.get(figureId);
  if (stored === undefined) return json(errorBody("not_found", "not_found", ""), 404);
  const now = (): number => {
    state.clock += 1000;
    return state.clock;
  };
  if (one[2] === "/image" && method === "GET") {
    state.imageRequests.push(figureId);
    if (state.holdImages !== undefined) await state.holdImages;
    await route.fulfill({ status: 200, contentType: "image/webp", headers: { etag: `"${stored.dto.image.sha256}"`, "cache-control": "private, max-age=31536000, immutable" }, body: fixtureBytes(stored.fixture) }).catch(() => undefined);
    return true;
  }
  if (one[2] === "/restore" && method === "POST") {
    state.restorations.push(figureId);
    const { deletedAt: _gone, ...rest } = stored.dto;
    stored.dto = figureDtoSchema.parse({ ...rest, updatedAt: now() });
    return json(stored.dto);
  }
  if (one[2] === undefined && method === "DELETE") {
    state.deletions.push(figureId);
    if (stored.dto.deletedAt === undefined) stored.dto = figureDtoSchema.parse({ ...stored.dto, deletedAt: now() });
    return json(stored.dto);
  }
  if (one[2] === undefined && method === "PATCH") {
    const raw = request.postDataJSON() as unknown;
    state.patches.push({ figureId, body: raw });
    if (state.failNextPatch) {
      state.failNextPatch = false;
      return json(errorBody("internal", "internal", ""), 500);
    }
    const body = figurePatchRequestSchema.parse(raw);
    if (body.version !== stored.dto.version) {
      return json(errorBody("conflict.figure_changed", "conflict", "这张插图已在别处修改，已显示最新内容", { currentVersion: stored.dto.version }), 409);
    }
    const next: Record<string, unknown> = { ...stored.dto, version: stored.dto.version + 1, updatedAt: now() };
    if (body.caption !== undefined) {
      if (body.caption === null || body.caption.trim() === "") delete next["caption"];
      else next["caption"] = body.caption;
    }
    if (body.widthRatio !== undefined) next["widthRatio"] = body.widthRatio;
    if (body.placement !== undefined) next["placement"] = body.placement;
    stored.dto = figureDtoSchema.parse(next);
    return json(stored.dto);
  }
  return false;
}

/** The newest sort key in use plus one, so a figure placed by time goes after the others there. */
function nextSortKey(state: MockFigures, contentId: string): number {
  const keys = [...state.figures.values()].filter((stored) => stored.dto.contentId === contentId).map((stored) => stored.dto.placement.sortKey);
  return keys.length === 0 ? 0 : Math.max(...keys) + 1;
}

/** The parts of a multipart body, in order, with their names and raw bytes. */
function multipartParts(body: Buffer, contentType: string): Array<{ name: string; bytes: Buffer }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const marker = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ""}`);
  const parts: Array<{ name: string; bytes: Buffer }> = [];
  let at = body.indexOf(marker);
  while (at >= 0) {
    const start = at + marker.length;
    const next = body.indexOf(marker, start);
    if (next < 0) break;
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    parts.push({ name: /name="([^"]+)"/.exec(head)?.[1] ?? "", bytes: part.subarray(split + 4) });
    at = next;
  }
  return parts;
}

function isImageSignature(bytes: Buffer): boolean {
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const webp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return png || jpeg || webp;
}

/**
 * `POST /contents/:id/figures/capture` and `/upload`, as the server answers them: the cap
 * first, then a capture past the clip's last frame is `past_end`, an upload that is not a PNG,
 * JPEG or WebP by its bytes is `unsupported` and one over the upload limit `too_large`. Created
 * figures show the landscape fixture (an upload the portrait one).
 */
async function createFigure(route: Route, request: Request, contentId: string, kind: "capture" | "upload"): Promise<boolean> {
  const state = mockFigures(request.frame().page());
  const json = (body: unknown, status: number) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }).then(() => true);
  const held = [...state.figures.values()].filter((stored) => stored.dto.contentId === contentId).length;
  if (held >= FIGURES_PER_CONTENT_MAX) {
    return json(errorBody("invalid_request.figure_limit", "invalid_request", "", { limit: FIGURES_PER_CONTENT_MAX }), 400);
  }
  if (kind === "capture") {
    const body = figureCaptureRequestSchema.parse(request.postDataJSON());
    state.captures.push(body);
    if (body.atMs > state.lastFrameMs) return json(errorBody("invalid_request.figure_frame", "invalid_request", "", { reason: "past_end" }), 400);
    const placement = body.placement ?? { displayMs: body.atMs, anchor: null, sortKey: nextSortKey(state, contentId) };
    const dto = seedFigure(request.frame().page(), { contentId, source: "capture", capturedAtMs: body.atMs, placement, widthRatio: body.widthRatio ?? 0.7 });
    return json(dto, 201);
  }
  const parts = multipartParts(request.postDataBuffer() ?? Buffer.alloc(0), request.headers()["content-type"] ?? "");
  const metaPart = parts.find((part) => part.name === "meta");
  const filePart = parts.find((part) => part.name === "file");
  if (parts[0]?.name !== "meta" || metaPart === undefined || filePart === undefined) throw new Error("upload without meta first and a file");
  const meta = figureUploadMetaSchema.parse(JSON.parse(metaPart.bytes.toString("utf8")));
  state.uploads.push({ meta, size: filePart.bytes.length });
  if (state.holdUploads !== undefined) await state.holdUploads;
  if (filePart.bytes.length > FIGURE_UPLOAD_MAX_BYTES) return json(errorBody("invalid_request.figure_image", "invalid_request", "", { reason: "too_large" }), 400).catch(() => true);
  if (!isImageSignature(filePart.bytes)) return json(errorBody("invalid_request.figure_image", "invalid_request", "", { reason: "unsupported" }), 400).catch(() => true);
  const dto = seedFigure(request.frame().page(), { contentId, source: "upload", placement: meta.placement, widthRatio: meta.widthRatio ?? 0.7, fixture: "portrait" });
  return json(dto, 201).catch(() => {
    state.abortedUploads += 1;
    return true;
  });
}
