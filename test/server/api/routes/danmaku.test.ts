import { afterEach, describe, expect, it } from "vitest";
import { registerDanmakuRoutes } from "../../../../src/server/api/routes/danmaku.ts";
import { DanmakuService } from "../../../../src/server/application/danmaku.ts";
import { PlatformRegistry } from "../../../../src/server/application/platforms.ts";
import type { PlatformSourceAdapter } from "../../../../src/server/ports/platform-source.ts";
import { DANMAKU_FETCH_COOLDOWN_MS } from "../../../../src/shared/defaults.ts";
import { danmakuFetchResultDtoSchema, danmakuSnapshotDtoSchema, type DanmakuItem } from "../../../../src/shared/dto/danmaku.ts";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const ITEM: DanmakuItem = { timeMs: 1000, mode: "top", color: 0xff0000, weight: 7, text: "<b>x</b>" };

async function setup() {
  const h = createHarness();
  open.push(h);
  let calls = 0;
  const bilibili = {
    kind: "bilibili",
    cookieDomains: [],
    parse: () => null,
    fetchDanmaku: async () => {
      calls += 1;
      return { items: [ITEM], truncated: false };
    },
  } as unknown as PlatformSourceAdapter;
  const time = { now: 1_790_000_000_000 };
  const danmaku = new DanmakuService({ repository: h.repository, platforms: new PlatformRegistry([bilibili]), now: () => time.now });
  const { app } = await h.app({ extraRoutes: (instance) => registerDanmakuRoutes(instance, { danmaku }) });
  const contentId = h.newId();
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id: contentId,
      userId: LOCAL.userId,
      source: { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD", platformContentId: "BV1xx411c7mD", platformPartId: "1001" },
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return { h, app, contentId, time, calls: () => calls };
}

describe("danmaku routes", () => {
  it("reads, fetches, then reads the stored snapshot", async () => {
    const { app, contentId, time } = await setup();
    const before = await app.inject({ method: "GET", url: `/api/contents/${contentId}/danmaku`, headers: auth });
    expect([before.statusCode, danmakuSnapshotDtoSchema.parse(before.json())]).toEqual([200, { supported: true }]);
    const fetched = await app.inject({ method: "POST", url: `/api/contents/${contentId}/danmaku/fetch`, headers: auth });
    expect(fetched.statusCode).toBe(200);
    expect(danmakuFetchResultDtoSchema.parse(fetched.json())).toEqual({ result: "fetched", snapshot: { fetchedAt: time.now, count: 1, items: [ITEM] } });
    const after = await app.inject({ method: "GET", url: `/api/contents/${contentId}/danmaku`, headers: auth });
    expect(after.json()).toEqual({ supported: true, snapshot: { fetchedAt: time.now, count: 1, items: [ITEM] } });
  });

  it("answers a cooldown with 429, Retry-After and retryAfterMs, without asking the platform", async () => {
    const { app, contentId, time, calls } = await setup();
    await app.inject({ method: "POST", url: `/api/contents/${contentId}/danmaku/fetch`, headers: auth });
    time.now += 1500;
    const refused = await app.inject({ method: "POST", url: `/api/contents/${contentId}/danmaku/fetch`, headers: auth });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe(String(Math.ceil((DANMAKU_FETCH_COOLDOWN_MS - 1500) / 1000)));
    expect(refused.json().error).toMatchObject({ code: "rate_limited.danmaku_cooldown", details: { retryAfterMs: DANMAKU_FETCH_COOLDOWN_MS - 1500 } });
    expect(calls()).toBe(1);
  });

  it("answers 400 for an unsupported Content and 404 for another owner's", async () => {
    const { h, app, contentId, calls } = await setup();
    const local = createLocalContent(h);
    expect((await app.inject({ method: "GET", url: `/api/contents/${local}/danmaku`, headers: auth })).json()).toEqual({ supported: false });
    const unsupported = await app.inject({ method: "POST", url: `/api/contents/${local}/danmaku/fetch`, headers: auth });
    expect([unsupported.statusCode, unsupported.json().error.code]).toEqual([400, "invalid_request.danmaku_unsupported"]);
    for (const request of [
      { method: "GET" as const, url: `/api/contents/${contentId}/danmaku` },
      { method: "POST" as const, url: `/api/contents/${contentId}/danmaku/fetch` },
    ]) {
      expect((await app.inject({ ...request, headers: bob })).statusCode).toBe(404);
    }
    expect(calls()).toBe(0);
  });
});
