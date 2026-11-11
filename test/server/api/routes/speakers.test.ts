import { afterEach, describe, expect, it } from "vitest";
import { SPEAKER_AVATAR_MAX_BYTES, SPEAKER_AVATAR_MAX_PX, SPEAKER_NAME_MAX_GRAPHEMES, SPEAKERS_PER_CONTENT_MAX } from "../../../../src/shared/defaults.ts";
import { speakerDtoSchema, speakerListDtoSchema, speakerSuggestionListDtoSchema } from "../../../../src/shared/dto/speaker.ts";
import { SpeakerService } from "../../../../src/server/application/speakers.ts";
import { registerSpeakerRoutes, SPEAKER_PATCH_BODY_LIMIT_BYTES } from "../../../../src/server/api/routes/speakers.ts";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const speakers = new SpeakerService({ repository: h.repository, newId: h.newId });
  const { app } = await h.app({ extraRoutes: (instance) => registerSpeakerRoutes(instance, { speakers }) });
  return { h, app, contentId: createLocalContent(h) };
}

const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const IEND = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
/** A PNG of the given size without pixel data, padded between the header and the closing IEND chunk to `total` bytes. */
function png(width = 64, height = 64, total = 0): Buffer {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0];
  const bytes = Buffer.alloc(Math.max(total, header.length + IEND.length));
  bytes.set(header);
  bytes.set(IEND, bytes.length - IEND.length);
  return bytes;
}
const be16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const le16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const le24 = (value: number): number[] => [...le16(value), (value >> 16) & 0xff];
const le32 = (value: number): number[] => [...le16(value), ...le16(value >>> 16)];
const ascii = (value: string): number[] => Array.from(value, (character) => character.charCodeAt(0));
/** A JPEG of the given size with no image data: SOI, the frame header, an empty scan and EOI. */
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, ...be16(11), 8, ...be16(height), ...be16(width), 1, 1, 0x11, 0, 0xff, 0xda, ...be16(8), 1, 1, 0, 0, 63, 0, 0xff, 0xd9]);
}
/** An extended WebP of the given canvas size. */
function webp(width: number, height: number): Buffer {
  const payload = [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const body = [...ascii("WEBP"), ...ascii("VP8X"), ...le32(payload.length), ...payload];
  return Buffer.from([...ascii("RIFF"), ...le32(body.length), ...body]);
}
const upload = (bytes: Buffer, mime = "image/png") => ({ avatar: { data: bytes.toString("base64"), mime } });

describe("speaker routes", () => {
  it("creates (201), lists in ordinal order and patches a speaker", async () => {
    const { app, contentId } = await setup();
    const url = `/api/contents/${contentId}/speakers`;
    expect((await app.inject({ method: "GET", url, headers: auth })).json()).toEqual({ items: [] });
    const created = await app.inject({ method: "POST", url, headers: auth, payload: { name: "  Ann  " } });
    expect(created.statusCode).toBe(201);
    const ann = speakerDtoSchema.parse(created.json());
    expect(ann).toMatchObject({ ordinal: 1, name: "Ann", used: false });
    const second = speakerDtoSchema.parse((await app.inject({ method: "POST", url, headers: auth, payload: {} })).json());
    const patched = await app.inject({ method: "PATCH", url: `${url}/${ann.id}`, headers: auth, payload: { name: null, colorIndex: 4 } });
    expect(patched.statusCode).toBe(200);
    expect(speakerDtoSchema.parse(patched.json())).toMatchObject({ id: ann.id, colorIndex: 4 });
    expect("name" in patched.json()).toBe(false);
    expect(speakerListDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json()).items.map((item) => item.id)).toEqual([ann.id, second.id]);
  });

  it("validates bodies: unknown fields, a bad color, mixed copy and edit, a missing speaker", async () => {
    const { app, contentId } = await setup();
    const url = `/api/contents/${contentId}/speakers`;
    const { id } = speakerDtoSchema.parse((await app.inject({ method: "POST", url, headers: auth, payload: {} })).json());
    const status = async (method: "POST" | "PATCH", target: string, payload: unknown) => (await app.inject({ method, url: target, headers: auth, payload: payload as object })).statusCode;
    expect(await status("POST", url, { nope: 1 })).toBe(400);
    expect(await status("POST", url, { colorIndex: 99 })).toBe(400);
    expect(await status("PATCH", `${url}/${id}`, { colorIndex: -1 })).toBe(400);
    expect(await status("PATCH", `${url}/${id}`, { name: "x", copyFrom: { contentId, speakerId: id } })).toBe(400);
    expect(await status("PATCH", `${url}/${id}`, { avatar: { data: "###", mime: "image/png" } })).toBe(400);
    expect(await status("PATCH", `${url}/${id}`, { avatar: { data: png().toString("base64"), mime: "image/svg+xml" } })).toBe(400);
    expect(await status("PATCH", `${url}/missing`, { name: "x" })).toBe(404);
    expect(await status("POST", url, { name: "y".repeat(SPEAKER_NAME_MAX_GRAPHEMES + 1) })).toBe(400);
  });

  it("refuses a speaker past the limit with 400", async () => {
    const { h, app, contentId } = await setup();
    h.repository.withTransaction((scope) => scope.speakers.insert(LOCAL.userId, contentId, Array.from({ length: SPEAKERS_PER_CONTENT_MAX }, () => ({ id: h.newId() })), 1));
    const response = await app.inject({ method: "POST", url: `/api/contents/${contentId}/speakers`, headers: auth, payload: {} });
    expect([response.statusCode, response.json().error.class]).toEqual([400, "invalid_request"]);
  });

  it("serves a photo as stored, with a version-keyed ETag, no-cache and a 304 on revalidation", async () => {
    const { app, contentId } = await setup();
    const url = `/api/contents/${contentId}/speakers`;
    const { id } = speakerDtoSchema.parse((await app.inject({ method: "POST", url, headers: auth, payload: {} })).json());
    const avatarUrl = `${url}/${id}/avatar`;
    expect((await app.inject({ method: "GET", url: avatarUrl, headers: auth })).statusCode).toBe(404);

    const photo = png(40, 30, 200);
    const patched = await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: auth, payload: upload(photo, "image/webp") });
    expect(speakerDtoSchema.parse(patched.json()).avatarVersion).toBe(1);
    const served = await app.inject({ method: "GET", url: avatarUrl, headers: auth });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["cache-control"]).toBe("private, no-cache");
    expect(served.rawPayload.equals(photo)).toBe(true);
    const etag = served.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]+"$/u);
    expect(served.headers["x-content-type-options"]).toBe("nosniff");

    const revalidated = await app.inject({ method: "GET", url: avatarUrl, headers: { ...auth, "if-none-match": etag } });
    expect([revalidated.statusCode, revalidated.body, revalidated.headers.etag]).toEqual([304, "", etag]);
    expect((await app.inject({ method: "GET", url: avatarUrl, headers: { ...auth, "if-none-match": `W/${etag}` } })).statusCode).toBe(304);
    expect((await app.inject({ method: "GET", url: avatarUrl, headers: { ...auth, "if-none-match": '"other"' } })).statusCode).toBe(200);

    // A new photo changes the tag; removing it makes the URL 404.
    await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: auth, payload: upload(png(41, 30, 200)) });
    const next = await app.inject({ method: "GET", url: avatarUrl, headers: { ...auth, "if-none-match": etag } });
    expect([next.statusCode, next.headers.etag === etag]).toEqual([200, false]);
    await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: auth, payload: { avatar: null } });
    expect((await app.inject({ method: "GET", url: avatarUrl, headers: auth })).statusCode).toBe(404);
  });

  it("stores JPEG and WebP photos by their own type, whatever the client declares", async () => {
    const { app, contentId } = await setup();
    const url = `/api/contents/${contentId}/speakers`;
    const { id } = speakerDtoSchema.parse((await app.inject({ method: "POST", url, headers: auth, payload: {} })).json());
    const cases: Array<[Buffer, string]> = [[jpeg(120, 80), "image/jpeg"], [webp(SPEAKER_AVATAR_MAX_PX, 64), "image/webp"], [png(30, 30), "image/png"]];
    for (const [bytes, mime] of cases) {
      const declared = mime === "image/png" ? "image/webp" : "image/png";
      const patched = await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: auth, payload: upload(bytes, declared) });
      expect([mime, patched.statusCode]).toEqual([mime, 200]);
      const served = await app.inject({ method: "GET", url: `${url}/${id}/avatar`, headers: auth });
      expect([served.headers["content-type"], served.rawPayload.equals(bytes)]).toEqual([mime, true]);
    }
  });

  it("derives the photo's ETag from its bytes too, so the same version with other bytes never revalidates", async () => {
    const { h, app, contentId } = await setup();
    const url = `/api/contents/${contentId}/speakers`;
    const { id } = speakerDtoSchema.parse((await app.inject({ method: "POST", url, headers: auth, payload: {} })).json());
    await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: auth, payload: upload(png(30, 30)) });
    const etag = (await app.inject({ method: "GET", url: `${url}/${id}/avatar`, headers: auth })).headers.etag as string;
    // What a restored older backup leaves: the same version number on other bytes.
    h.db.prepare("UPDATE content_speaker SET avatar = ? WHERE content_id = ? AND id = ?").run(png(31, 31), contentId, id);
    const after = await app.inject({ method: "GET", url: `${url}/${id}/avatar`, headers: { ...auth, "if-none-match": etag } });
    expect([after.statusCode, after.headers.etag === etag]).toEqual([200, false]);
  });

  it("refuses forged, truncated, oversized and SVG photos", async () => {
    const { app, contentId } = await setup();
    const url = `/api/contents/${contentId}/speakers`;
    const { id } = speakerDtoSchema.parse((await app.inject({ method: "POST", url, headers: auth, payload: {} })).json());
    const send = async (bytes: Buffer) => (await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: auth, payload: upload(bytes) })).statusCode;
    expect(await send(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(400);
    expect(await send(png().subarray(0, 20))).toBe(400);
    expect(await send(png(9999, 10))).toBe(400);
    expect(await send(png(10, 10, SPEAKER_AVATAR_MAX_BYTES + 1))).toBe(400);
    expect(await send(png().subarray(0, png().length - 12))).toBe(400);
    expect(await send(jpeg(10, 10).subarray(0, jpeg(10, 10).length - 2))).toBe(400);
    expect(await send(webp(SPEAKER_AVATAR_MAX_PX + 1, 10))).toBe(400);
    expect(await send(webp(10, SPEAKER_AVATAR_MAX_PX + 1))).toBe(400);
    expect(await send(Buffer.from("GIF89a-------------------------"))).toBe(400);
    expect(await send(png(10, 10, SPEAKER_AVATAR_MAX_BYTES))).toBe(200);
    expect(speakerDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json().items[0]).avatarVersion).toBe(1);
  });

  it("takes a body that fits the largest photo and refuses one past the route's limit", async () => {
    const { app, contentId } = await setup();
    const url = `/api/contents/${contentId}/speakers`;
    const { id } = speakerDtoSchema.parse((await app.inject({ method: "POST", url, headers: auth, payload: {} })).json());
    const largest = JSON.stringify(upload(png(10, 10, SPEAKER_AVATAR_MAX_BYTES)));
    expect(Buffer.byteLength(largest)).toBeLessThanOrEqual(SPEAKER_PATCH_BODY_LIMIT_BYTES);
    const ok = await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: { ...auth, "content-type": "application/json" }, payload: largest });
    expect(ok.statusCode).toBe(200);
    // The same acceptable body, padded with white space past the limit: only the size is wrong.
    const padded = `${largest}${" ".repeat(SPEAKER_PATCH_BODY_LIMIT_BYTES)}`;
    const refused = await app.inject({ method: "PATCH", url: `${url}/${id}`, headers: { ...auth, "content-type": "application/json" }, payload: padded });
    expect([refused.statusCode, refused.json().error.class]).toEqual([400, "invalid_request"]);
  });

  it("copies a speaker of another Content (name, color, photo) and keeps strangers out", async () => {
    const { h, app, contentId } = await setup();
    const otherContent = createLocalContent(h);
    const source = speakerDtoSchema.parse((await app.inject({ method: "POST", url: `/api/contents/${otherContent}/speakers`, headers: auth, payload: { name: "Host", colorIndex: 2 } })).json());
    await app.inject({ method: "PATCH", url: `/api/contents/${otherContent}/speakers/${source.id}`, headers: auth, payload: upload(png(30, 30, 100)) });
    const target = speakerDtoSchema.parse((await app.inject({ method: "POST", url: `/api/contents/${contentId}/speakers`, headers: auth, payload: {} })).json());
    const copied = await app.inject({
      method: "PATCH", url: `/api/contents/${contentId}/speakers/${target.id}`, headers: auth, payload: { copyFrom: { contentId: otherContent, speakerId: source.id } },
    });
    expect(speakerDtoSchema.parse(copied.json())).toMatchObject({ name: "Host", colorIndex: 2, avatarVersion: 1 });

    const suggestions = speakerSuggestionListDtoSchema.parse((await app.inject({ method: "GET", url: "/api/speakers/suggestions?q=ho", headers: auth })).json());
    expect(suggestions.items.map((item) => item.name)).toEqual(["Host", "Host"]);
    // From inside a Content, its own speakers are left out; an id that is unknown or someone else's excludes nothing.
    const others = async (query: string, as = auth) =>
      speakerSuggestionListDtoSchema.parse((await app.inject({ method: "GET", url: `/api/speakers/suggestions?q=ho&contentId=${query}`, headers: as })).json()).items.map((item) => item.contentId);
    expect(await others(contentId)).toEqual([otherContent]);
    expect(await others(otherContent)).toEqual([contentId]);
    expect(await others("missing")).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/speakers/suggestions?contentId=", headers: auth })).statusCode).toBe(400);
    const strangers = speakerSuggestionListDtoSchema.parse((await app.inject({ method: "GET", url: "/api/speakers/suggestions", headers: bob })).json());
    expect(strangers.items).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/speakers`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/speakers/${target.id}/avatar`, headers: bob })).statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const { app, contentId } = await setup();
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/speakers` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/speakers/suggestions" })).statusCode).toBe(401);
  });
});
