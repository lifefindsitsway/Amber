import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerSubtitleRoutes } from "../../../../src/server/api/routes/subtitles.ts";
import { SubtitleImportService } from "../../../../src/server/application/subtitle-import.ts";
import type { Content } from "../../../../src/server/domain/content.ts";
import { subtitleTextDigest } from "../../../../src/server/domain/subtitle-package.ts";
import { subtitleInspectResponseSchema } from "../../../../src/shared/dto/subtitle-import.ts";
import { BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const VTT = "WEBVTT\n\n00:00.000 --> 00:02.000\n<v Alice>hello\n\n00:02.000 --> 00:04.000\n<v Bob>world\n\n00:04.000 --> 00:06.000\n<v Alice>again\n";

const harnesses: Harness[] = [];
const stacks: MediaStack[] = [];
function harness(): Harness {
  const created = createHarness();
  harnesses.push(created);
  return created;
}
function stack(): MediaStack {
  const created = createMediaStack();
  stacks.push(created);
  return created;
}
afterEach(async () => {
  for (const created of harnesses.splice(0)) await created.close();
  for (const created of stacks.splice(0)) await created.close();
});

function insertContent(h: Harness, fields: Partial<Content> = {}): Content {
  const content: Content = { id: h.newId(), userId: LOCAL.userId, source: { kind: "local" }, processingStatus: "queued", createdAt: 1, updatedAt: 1, ...fields };
  h.repository.withTransaction((scope) => scope.contents.insert(content));
  return content;
}

describe("subtitle preview routes", () => {
  it("previews a text and a granted local file in local mode, with the target of the caller's own Content only", async () => {
    const s = stack();
    const h = s.h;
    const content = insertContent(h, { durationMs: 6000 });
    // The stack signs grants with its own key; a verifier that trusts the stack's grants stands in for the shell's.
    const subtitleImport = new SubtitleImportService({ repository: h.repository, grants: { verify: (grant, expected) => grant.path === expected.path && grant.purpose === expected.purpose } });
    const app = await h.app({ extraRoutes: (instance) => registerSubtitleRoutes(instance, { subtitleImport, local: true }) });
    const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };

    const inspected = await app.app.inject({ method: "POST", url: "/api/subtitles/inspect", headers: auth, payload: { text: VTT, filename: "a.vtt", contentId: content.id } });
    expect(inspected.statusCode).toBe(200);
    const body = subtitleInspectResponseSchema.parse(inspected.json());
    expect(body).toMatchObject({ format: "vtt", digest: subtitleTextDigest(VTT), cueCount: 3, speakers: { source: "explicit" } });
    expect(body.target).toEqual({ primaryRevisionId: null, speakers: [], speakerRoom: expect.any(Number), currentTranslations: {}, durationMs: 6000, coverageWarning: false });

    const short = insertContent(h, { durationMs: 600_000 });
    const coverage = await app.app.inject({ method: "POST", url: "/api/subtitles/inspect", headers: auth, payload: { text: VTT, contentId: short.id } });
    expect(coverage.json().target.coverageWarning).toBe(true);

    const malformed = await app.app.inject({ method: "POST", url: "/api/subtitles/inspect", headers: auth, payload: { text: VTT, extra: 1 } });
    expect(malformed.statusCode).toBe(400);
    const foreign = await app.app.inject({ method: "POST", url: "/api/subtitles/inspect", headers: { authorization: `Bearer ${BOB_TOKEN}` }, payload: { text: VTT, contentId: content.id } });
    expect(foreign.statusCode).toBe(404);

    const path = join(tempDataDir("amber-sub-"), "talk.vtt");
    writeFileSync(path, VTT);
    const local = await app.app.inject({ method: "POST", url: "/api/subtitles/inspect-local", headers: auth, payload: { path, grant: s.grant(path) } });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ format: "vtt", digest: subtitleTextDigest(VTT) });
  });

  it("registers the local-file preview only in local mode", async () => {
    const h = harness();
    const subtitleImport = new SubtitleImportService({ repository: h.repository });
    const app = await h.app({ extraRoutes: (instance) => registerSubtitleRoutes(instance, { subtitleImport, local: false }) });
    const response = await app.app.inject({ method: "POST", url: "/api/subtitles/inspect-local", headers: { authorization: `Bearer ${LOCAL_TOKEN}` }, payload: { path: "/x", grant: {} } });
    expect(response.statusCode).toBe(404);
  });
});
