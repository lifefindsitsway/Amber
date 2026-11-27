import { afterEach, describe, expect, it } from "vitest";
import { BilibiliAdapter } from "../../../../src/server/adapters/platform/bilibili/index.ts";
import { XiaohongshuAdapter } from "../../../../src/server/adapters/platform/xiaohongshu/index.ts";
import { amberError, isAmberError } from "../../../../src/server/domain/errors.ts";
import type { StageExecutionContext } from "../../../../src/server/pipeline/executor.ts";
import { expiringOnRefusal, type PlatformAccess } from "../../../../src/server/pipeline/stages/platform-access.ts";
import { DescriptionClock } from "../../../../src/server/domain/content-description.ts";
import { SourceStageExecutor } from "../../../../src/server/pipeline/stages/source.ts";
import { createHarness, LOCAL, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { FakePlatformAdapter } from "../../../fixtures/platform/fake-adapter.ts";
import { ScriptedHttp, scriptedYtDlp } from "../../../fixtures/platform/scripted-io.ts";
import { FakeHttp, loginRedirect, noteLink, VIDEO_NOTE_ID } from "../../../fixtures/platform/xiaohongshu/pages.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

const BVID = "BV1exp41c001";
const REF = { platformContentId: BVID };

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("expiringOnRefusal", () => {
  it("reports a refused login once and rethrows the same error", async () => {
    const adapter = new FakePlatformAdapter("bilibili").video(BVID, { metadataError: amberError("auth_required", "not logged in") });
    let refused = 0;
    const wrapped = expiringOnRefusal(adapter, () => refused++);
    const error = await failureOf(wrapped.fetchMetadata(REF, undefined, new AbortController().signal));
    expect(isAmberError(error) && error.appError.class).toBe("auth_required");
    expect(refused).toBe(1);
  });

  it("leaves other refusals, successes and synchronous members alone", async () => {
    const adapter = new FakePlatformAdapter("bilibili");
    let refused = 0;
    const wrapped = expiringOnRefusal(adapter, () => refused++);
    for (const errorClass of ["paid_content", "platform_blocked", "source_unreachable"] as const) {
      adapter.video(BVID, { metadataError: amberError(errorClass, "refused") });
      await failureOf(wrapped.fetchMetadata(REF, undefined, new AbortController().signal));
    }
    adapter.video(BVID, {});
    expect((await wrapped.fetchMetadata(REF, undefined, new AbortController().signal)).title).toBe(`title ${BVID}`);
    expect(wrapped.kind).toBe("bilibili");
    expect(wrapped.parse(`https://www.bilibili.com/video/${BVID}`)?.platformContentId).toBe(BVID);
    expect(refused).toBe(0);
  });
});

/** A bilibili Content whose source stage runs against the real adapter and a scripted web API. */
function bilibiliSource(h: Harness, apiCode: number) {
  const http = new ScriptedHttp(() => ({ body: { code: apiCode, message: "scripted", ttl: 1 } }));
  const adapter = new BilibiliAdapter({ ytDlp: scriptedYtDlp().ytDlp, http });
  const platforms: PlatformAccess = { ...h.platformAccess, adapterFor: () => adapter };
  const contentId = h.newId();
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id: contentId,
      userId: LOCAL.userId,
      source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${BVID}`, platformContentId: BVID, platformPartId: "111" },
      processingStatus: "running",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const executor = new SourceStageExecutor({ repository: h.repository, platforms, newId: h.newId, descriptionClock: new DescriptionClock(Date.now) });
  const context = {
    task: { userId: LOCAL.userId, contentId },
    signal: new AbortController().signal,
    withHeavySlot: <T>(work: () => Promise<T>) => work(),
  } as unknown as StageExecutionContext;
  return { http, run: () => executor.run(context) };
}

const accountOf = (h: Harness) => h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "bilibili"));

describe("a login the platform turns away is recorded as expired", () => {
  it("marks the account expired when the web API answers -101 to a logged-in request", async () => {
    const h = harness();
    h.platformAccounts.putCookies(LOCAL, "bilibili", "SESSDATA=<placeholder>");
    const source = bilibiliSource(h, -101);
    const error = await failureOf(source.run());
    expect(isAmberError(error) && error.appError.class).toBe("auth_required");
    expect(accountOf(h)).toMatchObject({ status: "expired", checkedAt: expect.any(Number) });
    expect(source.http.requests[0]?.headers?.["Cookie"]).toBeDefined();
  });

  it("keeps the status on risk control and creates nothing for a guest", async () => {
    const h = harness();
    h.platformAccounts.putCookies(LOCAL, "bilibili", "SESSDATA=<placeholder>");
    await failureOf(bilibiliSource(h, -352).run());
    expect(accountOf(h)?.status).toBe("unknown");

    const guest = harness();
    await failureOf(bilibiliSource(guest, -101).run());
    expect(accountOf(guest)).toBeUndefined();
  });
});

describe("a Xiaohongshu login is tried only behind the login page", () => {
  /** A Xiaohongshu Content whose source stage runs against the real adapter; every note page redirects to the login page. */
  function xiaohongshuSource(h: Harness) {
    const http = new FakeHttp((request) => loginRedirect(request.url));
    const adapter = new XiaohongshuAdapter({ http });
    const platforms: PlatformAccess = { ...h.platformAccess, adapterFor: () => adapter };
    const contentId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.contents.insert({
        id: contentId,
        userId: LOCAL.userId,
        source: { kind: "xiaohongshu", sourceUrl: noteLink(VIDEO_NOTE_ID), platformContentId: VIDEO_NOTE_ID },
        processingStatus: "running",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const executor = new SourceStageExecutor({ repository: h.repository, platforms, newId: h.newId, descriptionClock: new DescriptionClock(Date.now) });
    const context = {
      task: { userId: LOCAL.userId, contentId },
      signal: new AbortController().signal,
      withHeavySlot: <T>(work: () => Promise<T>) => work(),
    } as unknown as StageExecutionContext;
    return { http, run: () => executor.run(context) };
  }

  const xhsAccount = (h: Harness) => h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "xiaohongshu"));

  it("retries once with the stored login and marks it expired when it is still turned away", async () => {
    const h = harness();
    h.platformAccounts.putCookies(LOCAL, "xiaohongshu", "web_session=<placeholder>");
    const source = xiaohongshuSource(h);
    const error = await failureOf(source.run());
    expect(isAmberError(error) && error.appError.class).toBe("auth_required");
    expect(xhsAccount(h)).toMatchObject({ status: "expired", checkedAt: expect.any(Number) });
    expect(source.http.requests.map((request) => request.headers?.["Cookie"] !== undefined)).toEqual([false, false, true]);
  });

  it("does not retry without a login and records nothing", async () => {
    const h = harness();
    const source = xiaohongshuSource(h);
    const error = await failureOf(source.run());
    expect(isAmberError(error) && error.appError.class).toBe("auth_required");
    expect(source.http.requests).toHaveLength(2);
    expect(xhsAccount(h)).toBeUndefined();
  });
});
