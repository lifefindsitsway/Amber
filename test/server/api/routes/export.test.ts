import { afterEach, describe, expect, it } from "vitest";
import type { ExportFile } from "../../../../src/server/application/export.ts";
import { seedExportCollection, seedExportContent } from "../../../fixtures/export/export-data.ts";
import { BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const fixture = seedExportContent(h);
  const { app } = await h.app();
  return { h, app, fixture };
}

async function text(file: ExportFile): Promise<string> {
  let out = "";
  for await (const chunk of file.body) out += chunk;
  return out;
}

describe("POST /api/contents/:id/export", () => {
  it("streams the file as an attachment named after the title", async () => {
    const { h, app, fixture } = await setup();
    const body = { format: "srt", revisionId: fixture.asr.revision.id } as const;
    const response = await app.inject({ method: "POST", url: `/api/contents/${fixture.contentId}/export`, headers: auth, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-subrip; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("示例课程：第一讲导论.srt")}`);
    expect(response.body).toBe(await text(h.exports.exportContent(LOCAL, fixture.contentId, body)));
    expect(response.body.startsWith("1\n00:00:01,000 --> 00:00:02,600\nHello world.\n")).toBe(true);
  });

  it("serves every format with its content type", async () => {
    const { app, fixture } = await setup();
    const revisionId = fixture.corrected.revision.id;
    const translationRevisionId = fixture.translated.revision.id;
    const cases = [
      [{ format: "vtt", revisionId }, "text/vtt; charset=utf-8", ".vtt"],
      [{ format: "txt", revisionId }, "text/plain; charset=utf-8", ".txt"],
      [{ format: "ass", revisionId }, "text/x-ssa; charset=utf-8", ".ass"],
      [{ format: "ass-bilingual", revisionId, translationRevisionId }, "text/x-ssa; charset=utf-8", ".ass"],
      [{ format: "srt-bilingual", revisionId, translationRevisionId }, "application/x-subrip; charset=utf-8", ".srt"],
      [{ format: "markdown", sections: { chapters: true }, backlinks: true }, "text/markdown; charset=utf-8", ".md"],
    ] as const;
    for (const [payload, type, extension] of cases) {
      const response = await app.inject({ method: "POST", url: `/api/contents/${fixture.contentId}/export`, headers: auth, payload });
      expect(response.statusCode, payload.format).toBe(200);
      expect(response.headers["content-type"]).toBe(type);
      expect(response.headers["content-disposition"]).toMatch(new RegExp(`${extension.replace(".", "\\.")}$`));
    }
  });

  it("refuses with a JSON error before streaming", async () => {
    const { app, fixture } = await setup();
    const url = `/api/contents/${fixture.contentId}/export`;
    const post = (payload: unknown, headers = auth) => app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });

    expect((await post({ format: "srt-bilingual", revisionId: fixture.corrected.revision.id })).statusCode).toBe(400);
    expect((await post({ format: "srt", revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id })).statusCode).toBe(400);
    expect((await post({ format: "pdf", revisionId: fixture.corrected.revision.id })).statusCode).toBe(400);
    expect((await post({ format: "markdown", sections: {} })).statusCode).toBe(400);

    const mismatch = await post({ format: "ass-bilingual", revisionId: fixture.asr.revision.id, translationRevisionId: fixture.translated.revision.id });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.headers["content-type"]).toContain("application/json");
    expect(mismatch.json().error).toMatchObject({ class: "invalid_request" });

    const missing = await post({ format: "markdown", sections: { summary: { templateId: "summary.terms" } }, backlinks: true });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.class).toBe("invalid_request");

    expect((await post({ format: "srt", revisionId: "no-such-revision" })).statusCode).toBe(404);
    expect((await post({ format: "srt", revisionId: fixture.asr.revision.id }, bob)).statusCode).toBe(404);
  });
});

describe("POST /api/collections/:id/export", () => {
  it("streams the collection Markdown; another user gets 404", async () => {
    const { h, app, fixture } = await setup();
    const second = seedExportContent(h, LOCAL.userId, "local");
    const collectionId = seedExportCollection(h, fixture, second);
    const url = `/api/collections/${collectionId}/export`;
    const response = await app.inject({ method: "POST", url, headers: auth, payload: { backlinks: true } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("示例合集.md")}`);
    expect(response.body).toBe(await text(h.exports.exportCollection(LOCAL, collectionId, { backlinks: true })));
    expect(response.body).toContain("## 各项内容");

    expect((await app.inject({ method: "POST", url, headers: bob, payload: { backlinks: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: {} })).statusCode).toBe(400);
  });
});
