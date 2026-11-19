import { afterEach, describe, expect, it } from "vitest";
import { searchResultDtoSchema } from "../../../../src/shared/dto/search.ts";
import { BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { seedContent } from "../../../fixtures/search/corpus.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const seeded = seedContent(h, { title: "检索增强生成", lines: ["向量数据库负责召回。"] });
  const collection = h.collections.create(LOCAL, { name: "检索课程" });
  const { app } = await h.app();
  return { h, app, seeded, collection };
}

describe("GET /api/search", () => {
  it("answers the grouped result with snippets and offsets", async () => {
    const { app, seeded } = await setup();
    const response = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("数据库")}&scope=library`, headers: auth });
    expect(response.statusCode).toBe(200);
    const body = searchResultDtoSchema.parse(response.json());
    expect(body.segments).toEqual([
      expect.objectContaining({ contentId: seeded.contentId, segmentId: seeded.segmentIds[0], snippet: "向量数据库负责召回。", ranges: [{ start: 2, end: 5 }] }),
    ]);
    expect(body.collections).toEqual([]);
  });

  it("defaults to the global scope, which includes collections", async () => {
    const { app, collection } = await setup();
    const body = (await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("检索")}`, headers: auth })).json();
    expect(body.collections).toEqual([expect.objectContaining({ collectionId: collection.id, name: "检索课程" })]);
    expect(body.contents).toHaveLength(1);
  });

  it("rejects a missing or blank query and unknown parameters", async () => {
    const { app } = await setup();
    for (const url of ["/api/search", "/api/search?q=%20%20", "/api/search?q=abc&page=2"]) {
      const response = await app.inject({ method: "GET", url, headers: auth });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.class).toBe("invalid_request");
    }
  });

  it("treats another user's collection as not found and shows them nothing of ours", async () => {
    const { app, collection } = await setup();
    const scoped = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("检索")}&scope=${collection.id}`, headers: bob });
    expect(scoped.statusCode).toBe(404);
    const global = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("检索")}`, headers: bob });
    expect(global.json()).toEqual({ contents: [], segments: [], summaries: [], collections: [], figures: [] });
  });

  it("requires authentication", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/search?q=abc" })).statusCode).toBe(401);
  });
});
