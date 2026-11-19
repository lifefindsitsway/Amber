import multipart from "@fastify/multipart";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIGURE_UPLOAD_MAX_BYTES, FIGURES_PER_CONTENT_MAX } from "../../../../src/shared/defaults.ts";
import { figureDtoSchema, figureListDtoSchema } from "../../../../src/shared/dto/figure.ts";
import { FfmpegMediaIngest } from "../../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";
import { registerFigureRoutes } from "../../../../src/server/api/routes/figures.ts";
import { FigureService } from "../../../../src/server/application/figures.ts";
import { childProcessEnv } from "../../../../src/server/ports/process-runner.ts";
import { patternPng } from "../../../fixtures/media/figure-images.ts";
import { multipartBody } from "../../../fixtures/media/multipart.ts";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { toolsBinDir } from "../../../fixtures/tools.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

let png: Buffer;
beforeAll(() => {
  png = readFileSync(patternPng(tempDataDir("amber-figure-route-"), 48, 32));
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const figures = new FigureService({
    repository: h.repository,
    ingest: new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env) }),
    media: h.media,
    files: h.media.data,
    newId: h.newId,
  });
  const { app } = await h.app({
    extraRoutes: (instance) => {
      void instance.register(multipart, { throwFileSizeLimit: false });
      registerFigureRoutes(instance, { figures });
    },
  });
  return { h, app, contentId: createLocalContent(h) };
}

const meta = JSON.stringify({ placement: { displayMs: 1200, anchor: null, sortKey: 0 }, widthRatio: 0.4 });

describe("figure routes", () => {
  it("uploads (201), lists, serves the image with a strong cache and 304, patches, deletes and restores", async () => {
    const { app, contentId } = await setup();
    const body = multipartBody([{ name: "meta", data: meta }, { name: "file", filename: "shot.png", data: png }]);
    const created = await app.inject({ method: "POST", url: `/api/contents/${contentId}/figures/upload`, headers: { ...auth, "content-type": body.contentType }, payload: body.stream() });
    expect(created.statusCode).toBe(201);
    const figure = figureDtoSchema.parse(created.json());
    expect(figure).toMatchObject({ source: "upload", widthRatio: 0.4, placement: { displayMs: 1200 }, image: { width: 48, height: 32 } });

    const list = await app.inject({ method: "GET", url: `/api/contents/${contentId}/figures`, headers: auth });
    expect(figureListDtoSchema.parse(list.json())).toMatchObject({ items: [{ id: figure.id }], recentlyDeleted: [], limit: FIGURES_PER_CONTENT_MAX });

    const image = await app.inject({ method: "GET", url: `/api/figures/${figure.id}/image`, headers: auth });
    expect(image.statusCode).toBe(200);
    expect(image.headers).toMatchObject({
      "content-type": "image/webp",
      etag: `"${figure.image.sha256}"`,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    expect(image.rawPayload.length).toBe(figure.image.bytes);
    const again = await app.inject({ method: "GET", url: `/api/figures/${figure.id}/image`, headers: { ...auth, "if-none-match": `"${figure.image.sha256}"` } });
    expect([again.statusCode, again.rawPayload.length]).toEqual([304, 0]);

    const patched = await app.inject({ method: "PATCH", url: `/api/figures/${figure.id}`, headers: auth, payload: { version: 1, caption: "图注" } });
    expect(patched.json()).toMatchObject({ version: 2, caption: "图注" });
    const stale = await app.inject({ method: "PATCH", url: `/api/figures/${figure.id}`, headers: auth, payload: { version: 1, caption: "x" } });
    expect([stale.statusCode, stale.json().error]).toEqual([409, expect.objectContaining({ code: "conflict.figure_changed", details: { currentVersion: 2 } })]);

    const deleted = await app.inject({ method: "DELETE", url: `/api/figures/${figure.id}`, headers: auth });
    expect(deleted.json()).toMatchObject({ version: 3, deletedAt: expect.any(Number) });
    expect((await app.inject({ method: "DELETE", url: `/api/figures/${figure.id}`, headers: auth })).json()).toEqual(deleted.json());
    const restored = await app.inject({ method: "POST", url: `/api/figures/${figure.id}/restore`, headers: auth });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().deletedAt).toBeUndefined();
  });

  // Over a real socket the request's own `close` fires as soon as its body is read; only the
  // response's marks a client that went away. In-process injection does not show the difference.
  it("keeps working on an upload over a real connection after its body was read", async () => {
    const { app, contentId } = await setup();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("not listening");
    const form = new FormData();
    form.append("meta", meta);
    form.append("file", new Blob([new Uint8Array(png)]), "shot.png");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/contents/${contentId}/figures/upload`, { method: "POST", headers: auth, body: form });
    expect(response.status).toBe(201);
    expect(figureDtoSchema.parse(await response.json()).image).toMatchObject({ width: 48, height: 32 });
  });

  it("refuses an image over the upload limit with figure_image too_large", async () => {
    const { app, contentId } = await setup();
    const body = multipartBody([{ name: "meta", data: meta }, { name: "file", filename: "big.png", data: Buffer.concat([png, Buffer.alloc(FIGURE_UPLOAD_MAX_BYTES)]) }]);
    const response = await app.inject({ method: "POST", url: `/api/contents/${contentId}/figures/upload`, headers: { ...auth, "content-type": body.contentType }, payload: body.stream() });
    expect([response.statusCode, response.json().error]).toEqual([400, expect.objectContaining({ code: "invalid_request.figure_image", details: { reason: "too_large" } })]);
  });

  it("answers 404 to another user before reading the upload", async () => {
    const { app, contentId } = await setup();
    const body = multipartBody([{ name: "meta", data: meta }, { name: "file", filename: "shot.png", data: png }]);
    const response = await app.inject({ method: "POST", url: `/api/contents/${contentId}/figures/upload`, headers: { ...bob, "content-type": body.contentType }, payload: body.stream() });
    expect([response.statusCode, response.json().error.class]).toEqual([404, "not_found"]);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/figures`, headers: bob })).statusCode).toBe(404);
  });
});
