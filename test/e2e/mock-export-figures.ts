import type { Page } from "@playwright/test";
import { contentExportRequestSchema, type ContentExportRequest } from "../../src/shared/dto/export.ts";
import type { FigureDto } from "../../src/shared/dto/figure.ts";
import { BILIBILI_TITLE } from "./mock-outputs.ts";

/** A live figure of `contentId` as the figures list returns it. */
export function mockFigure(contentId: string, index: number): FigureDto {
  return {
    id: `01J0000000000000000000FG${String(index).padStart(2, "0")}`,
    contentId,
    source: index % 2 === 0 ? "capture" : "upload",
    ...(index % 2 === 0 ? { capturedAtMs: 1000 * index } : {}),
    placement: { displayMs: 1000 * index, anchor: null, sortKey: 0 },
    widthRatio: 0.7,
    image: { width: 4, height: 3, bytes: 10, sha256: "a".repeat(64) },
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * Figures and figure exports for the export dialog spec, installed on top of the shared fake:
 * `GET /api/contents/:id/figures` lists `count` live figures, and an export asking for figures
 * answers with a zip named after the lecture. Every other export falls through to the shared
 * fake. `requests` logs every export body seen.
 */
export async function installFigureExports(page: Page, count: number): Promise<{ requests: ContentExportRequest[] }> {
  const requests: ContentExportRequest[] = [];
  await page.route("**/api/contents/*/figures", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const contentId = new URL(route.request().url()).pathname.split("/")[3] as string;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: Array.from({ length: count }, (_, index) => mockFigure(contentId, index + 1)), recentlyDeleted: [], limit: 100 }),
    });
  });
  await page.route("**/api/contents/*/export", async (route) => {
    const body = contentExportRequestSchema.parse(route.request().postDataJSON());
    requests.push(body);
    const figures = body.format === "markdown" ? body.sections.transcript?.figures === true : body.format === "txt" && body.figures === true;
    if (!figures) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${BILIBILI_TITLE}.zip`)}` },
      body: Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]),
    });
  });
  return { requests };
}
