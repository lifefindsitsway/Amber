import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportContentService } from "../../../src/server/application/import-content.ts";
import { PlatformRegistry } from "../../../src/server/application/platforms.ts";
import { FairSemaphore } from "../../../src/server/pipeline/fair-semaphore.ts";
import { IMPORT_BATCH_MAX } from "../../../src/shared/defaults.ts";
import { platformTranscript } from "../../../src/server/domain/platform-subtitle.ts";
import { TRASH_RETENTION_MS } from "../../../src/server/domain/content.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { AppError } from "../../../src/shared/errors.ts";
import { builtinPromptRefs, BOB, configureLlm, createHarness, LOCAL, taskOf, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const BVID = "BV1xx411c7mD";
const LINK = `https://www.bilibili.com/video/${BVID}`;
const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const open: Harness[] = [];
function harness(): Harness {
  const created = createHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function errorOf(work: () => Promise<unknown>): Promise<AppError | undefined> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError;
    }
    throw error;
  }
  return undefined;
}

async function codeOf(work: () => Promise<unknown>): Promise<string | undefined> {
  return (await errorOf(work))?.code;
}

const request = (settings: Record<string, unknown> = {}, url = LINK) => ({ items: [{ url }], settings: { autoProofread: true, ...settings } });

function contentOf(h: Harness, contentId: string | undefined, userId = LOCAL.userId) {
  return h.repository.withTransaction((scope) => scope.contents.get(userId, contentId as string));
}

/** Three parts on one bilibili submission. */
function threeParts(h: Harness, bvid = BVID): void {
  h.platforms.bilibili.video(bvid, {
    parts: [
      { platformPartId: "c1", title: "Lecture 1" },
      { platformPartId: "c2", title: "Lecture 2" },
      { platformPartId: "c3", title: "Lecture 3" },
    ],
  });
}

function bvid(n: number): string {
  return `BV1xx411c${String(n).padStart(3, "0")}`;
}

/** Gives the Content a platform transcript as its primary, as a finished subtitle stage would. */
function givePrimary(h: Harness, contentId: string): string {
  const { revision, segments } = platformTranscript({
    revisionId: h.newId(),
    contentId,
    language: "zh-CN",
    cues: [{ startMs: 0, endMs: 1000, text: "hello" }],
    acquisition: "guest",
    newId: h.newId,
    createdAt: 1,
  });
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revision.id, 1);
  });
  return revision.id;
}

async function drain(h: Harness): Promise<void> {
  h.scheduler.start();
  await h.scheduler.whenIdle();
}

const SRT = "1\n00:00:00,000 --> 00:00:02,000\nhello\n\n2\n00:00:02,000 --> 00:00:04,000\nworld\n";

describe("importing a link", () => {
  it("creates Content, ImportBatch and a queued process_content Task with its frozen request", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const { status, body, replayed } = await h.importContent.import(LOCAL, request({ modelRef, outputLanguage: "zh-CN" }));
    expect({ status, replayed }).toEqual({ status: 202, replayed: false });
    const content = contentOf(h, body.contentIds[0]);
    expect(content).toMatchObject({
      source: { kind: "bilibili", sourceUrl: LINK, platformContentId: BVID, platformPartId: `${BVID}-cid` },
      importBatchId: body.importBatchId,
      processingStatus: "queued",
    });
    // A single-part submission carries no part title; the source stage fills the title.
    expect(content?.title).toBeUndefined();
    expect(JSON.parse(taskOf(h, body.taskIds[0] as string).requestJson)).toEqual({
      autoProofread: true,
      kind: "process_content",
      promptRefs: builtinPromptRefs("process_content"),
      modelRef,
      outputLanguage: "zh-CN",
      requestSchemaVersion: 1,
      templateRef: { id: "summary.core", version: 1 },
    });
    expect(h.repository.withTransaction((scope) => scope.importBatches.get(LOCAL.userId, body.importBatchId))).toMatchObject({
      sourceType: "links",
      totalItems: 1,
    });
  });

  it("freezes the user's default summary template when the settings name none", async () => {
    const h = harness();
    h.userSettings.patch(LOCAL, { defaultSummaryTemplateId: "summary.detailed" });
    const { body } = await h.importContent.import(LOCAL, request({}));
    expect(JSON.parse(taskOf(h, body.taskIds[0] as string).requestJson)).toMatchObject({ templateRef: { id: "summary.detailed", version: 2 } });
  });

  it("freezes only the requested ASR model, never the user's default, and refuses another user's or an unlisted one", async () => {
    const h = harness();
    const asrProfile = (userId: string, id: string) =>
      h.repository.withTransaction((scope) => scope.asrProfiles.insert({ id, userId, name: id, provider: "dashscope", models: [{ modelId: "fun-asr" }], createdAt: 1 }));
    asrProfile(LOCAL.userId, "mine");
    asrProfile(LOCAL.userId, "default");
    asrProfile(BOB.userId, "bobs");
    const frozen = async (settings: Record<string, unknown>, url: string) => {
      const { body } = await h.importContent.import(LOCAL, request(settings, url));
      return (JSON.parse(taskOf(h, body.taskIds[0] as string).requestJson) as { asrModelRef?: unknown }).asrModelRef;
    };
    expect(await frozen({}, `https://www.bilibili.com/video/${bvid(1)}`)).toBeUndefined();
    // The default only preselects a picker; a request that names no model stays without one.
    h.userSettings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: "default", modelId: "fun-asr" } });
    expect(await frozen({}, `https://www.bilibili.com/video/${bvid(2)}`)).toBeUndefined();
    expect(await frozen({ asrModelRef: { asrProfileId: "mine", modelId: "fun-asr" } }, `https://www.bilibili.com/video/${bvid(3)}`)).toEqual({ asrProfileId: "mine", modelId: "fun-asr" });
    for (const [index, asrModelRef] of [{ asrProfileId: "bobs", modelId: "fun-asr" }, { asrProfileId: "mine", modelId: "scribe_v2" }].entries()) {
      const refused = await errorOf(() => h.importContent.import(LOCAL, request({ asrModelRef }, `https://www.bilibili.com/video/${bvid(4 + index)}`)));
      expect(refused?.code).toBe("invalid_request");
      expect(refused?.userMessage).toContain("settings.asrModelRef");
    }
    expect(countRows(h.db, "task")).toBe(3);
  });

  it("stores the canonical URL and needs no network for a single YouTube video", async () => {
    const h = harness();
    const { body } = await h.importContent.import(LOCAL, request({}, "https://youtu.be/dQw4w9WgXcQ?t=42"));
    expect(contentOf(h, body.contentIds[0])?.source).toEqual({ kind: "youtube", sourceUrl: WATCH, platformContentId: "dQw4w9WgXcQ" });
    expect(h.platforms.youtube.calls).toEqual([]);
  });

  it("refuses unsupported links, foreign models and a disk below the low-water mark", async () => {
    const h = harness();
    expect(await codeOf(() => h.importContent.import(LOCAL, request({}, "https://example.com/v/1")))).toBe("source_unsupported_url");
    const bobs = configureLlm(h, BOB.userId);
    expect(await codeOf(() => h.importContent.import(LOCAL, request({ modelRef: bobs })))).toBe("invalid_request");
    h.disk.low();
    expect(await codeOf(() => h.importContent.import(LOCAL, request()))).toBe("disk_low");
    expect(countRows(h.db, "content")).toBe(0);
    expect(countRows(h.db, "import_batch")).toBe(0);
  });

  it("expands a short link before recognizing it", async () => {
    const h = harness();
    h.platforms.bilibili.shortLinks.set("https://b23.tv/abc123", LINK);
    const { body } = await h.importContent.import(LOCAL, request({}, "https://b23.tv/abc123"));
    expect(contentOf(h, body.contentIds[0])?.source.platformContentId).toBe(BVID);
  });

  it("imports the same video once when a batch names it twice", async () => {
    const h = harness();
    const { body } = await h.importContent.import(LOCAL, { items: [{ url: LINK }, { url: `${LINK}?spm_id_from=x` }], settings: { autoProofread: true } });
    expect(body.contentIds).toHaveLength(1);
    expect(countRows(h.db, "content")).toBe(1);
  });

  it("passes the user's platform login to the online steps", async () => {
    const h = harness();
    await h.importContent.import(LOCAL, request());
    await h.platformAccounts.putCookies(LOCAL, "bilibili", "bili_session=<placeholder>");
    await h.importContent.import(LOCAL, request({ autoProofread: false }, `${LINK}?p=1`)).catch(() => undefined);
    expect(h.platforms.bilibili.callsOf("resolveParts").map((call) => call.withAuth)).toEqual([false, true]);
  });
});

describe("multi-part submissions", () => {
  it("requires an explicit choice and names the parts", async () => {
    const h = harness();
    threeParts(h);
    const error = await errorOf(() => h.importContent.import(LOCAL, request()));
    expect(error).toMatchObject({ code: "invalid_request.multipart_choice_required", details: { parts: ["c1", "c2", "c3"] } });
    expect(countRows(h.db, "content")).toBe(0);
  });

  it("imports one Content per chosen part into one ImportBatch, titled by the part", async () => {
    const h = harness();
    threeParts(h);
    const all = await h.importContent.import(LOCAL, { items: [{ url: LINK, parts: "all" }], settings: { autoProofread: true } });
    expect(all.body.contentIds).toHaveLength(3);
    expect(all.body.contentIds.map((id) => contentOf(h, id)?.source)).toEqual(
      [1, 2, 3].map((p) => ({ kind: "bilibili", sourceUrl: `${LINK}?p=${p}`, platformContentId: BVID, platformPartId: `c${p}` })),
    );
    expect(contentOf(h, all.body.contentIds[1])?.title).toBe("Lecture 2");
    expect(h.repository.withTransaction((scope) => scope.importBatches.get(LOCAL.userId, all.body.importBatchId))?.totalItems).toBe(3);
  });

  it("takes p=N, 'first' and a list of part ids, and rejects parts that do not exist", async () => {
    const h = harness();
    threeParts(h);
    const second = await h.importContent.import(LOCAL, request({}, `${LINK}?p=2`));
    expect(contentOf(h, second.body.contentIds[0])?.source.platformPartId).toBe("c2");
    const first = await h.importContent.import(LOCAL, { items: [{ url: LINK, parts: "first" }], settings: { autoProofread: true } });
    expect(contentOf(h, first.body.contentIds[0])?.source.platformPartId).toBe("c1");
    const listed = await h.importContent.import(LOCAL, { items: [{ url: LINK, parts: ["c3", "c2"] }], settings: { autoProofread: true } });
    expect(listed.body.contentIds.map((id) => contentOf(h, id)?.source.platformPartId)).toEqual(["c3", "c2"]);
    // p=2 and the listed c2 are the same Content.
    expect(listed.body.contentIds[1]).toBe(second.body.contentIds[0]);

    expect(await codeOf(() => h.importContent.import(LOCAL, request({}, `${LINK}?p=9`)))).toBe("invalid_request");
    expect(await codeOf(() => h.importContent.import(LOCAL, { items: [{ url: LINK, parts: ["c9"] }], settings: { autoProofread: true } }))).toBe(
      "invalid_request",
    );
  });

  it("rejects a part choice on a link that has no parts", async () => {
    const h = harness();
    expect(await codeOf(() => h.importContent.import(LOCAL, { items: [{ url: WATCH, parts: "all" }], settings: { autoProofread: true } }))).toBe(
      "invalid_request",
    );
  });
});

describe("collections", () => {
  const SPACE = "https://space.bilibili.com/1/lists/2?type=season";

  function scriptCollection(h: Harness, count: number): void {
    h.platforms.bilibili.collections.set("1_2", {
      title: "Course",
      items: Array.from({ length: count }, (_, i) => ({
        platformContentId: bvid(i),
        platformPartId: `${bvid(i)}-cid`,
        title: `Lecture ${i + 1}`,
        canonicalUrl: `https://www.bilibili.com/video/${bvid(i)}`,
      })),
    });
  }

  function itemsOf(h: Harness, collectionId: string) {
    return h.repository.withTransaction((scope) => scope.collections.listItems(LOCAL.userId, collectionId));
  }

  it("expands a platform collection into ordered Contents of one Collection named after it, and reuses it next time", async () => {
    const h = harness();
    scriptCollection(h, 3);
    const { body } = await h.importContent.import(LOCAL, request({}, SPACE));
    expect(body.contentIds).toHaveLength(3);
    expect(h.repository.withTransaction((scope) => scope.importBatches.get(LOCAL.userId, body.importBatchId))).toMatchObject({
      sourceType: "platform_collection",
      totalItems: 3,
    });
    const collection = h.repository.withTransaction((scope) => scope.collections.findByPlatformCollectionId(LOCAL.userId, "1_2"));
    expect(collection).toMatchObject({ name: "Course", platformCollectionId: "1_2" });
    expect(itemsOf(h, collection?.id as string).map((item) => [item.contentId, item.position])).toEqual(body.contentIds.map((id, i) => [id, i]));
    expect(contentOf(h, body.contentIds[0])).toMatchObject({ title: "Lecture 1", source: { platformCollectionId: "1_2" } });

    scriptCollection(h, 4);
    const again = await h.importContent.import(LOCAL, request({}, SPACE));
    expect(again.body.contentIds.slice(0, 3)).toEqual(body.contentIds);
    expect(countRows(h.db, "collection")).toBe(1);
    expect(itemsOf(h, collection?.id as string)).toHaveLength(4);
  });

  it("files loose links into a new named Collection or an existing one", async () => {
    const h = harness();
    const named = await h.importContent.import(LOCAL, { items: [{ url: LINK }, { url: WATCH }], settings: { autoProofread: true }, collection: { name: "Mine" } });
    const collection = h.repository.withTransaction((scope) => scope.collections.list(LOCAL.userId)).find((c) => c.name === "Mine");
    expect(itemsOf(h, collection?.id as string).map((item) => item.contentId)).toEqual(named.body.contentIds);

    await h.importContent.import(LOCAL, { items: [{ url: `https://www.bilibili.com/video/${bvid(7)}` }], settings: { autoProofread: true }, collection: { id: collection?.id as string } });
    expect(itemsOf(h, collection?.id as string)).toHaveLength(3);
  });

  it("answers not_found for a Collection that is not the user's, writing nothing", async () => {
    const h = harness();
    expect(await codeOf(() => h.importContent.import(LOCAL, { ...request(), collection: { id: "nope" } }))).toBe("not_found");
    expect(countRows(h.db, "content")).toBe(0);
    expect(countRows(h.db, "import_batch")).toBe(0);
  });

  it("refuses parts or initial subtitles on a collection link", async () => {
    const h = harness();
    scriptCollection(h, 2);
    expect(await codeOf(() => h.importContent.import(LOCAL, { items: [{ url: SPACE, parts: "all" }], settings: { autoProofread: true } }))).toBe(
      "invalid_request",
    );
  });
});

describe("whole-batch checks", () => {
  it("rejects more than IMPORT_BATCH_MAX items before going online", async () => {
    const h = harness();
    const items = Array.from({ length: IMPORT_BATCH_MAX + 1 }, (_, i) => ({ url: `https://www.bilibili.com/video/${bvid(i)}` }));
    const error = await errorOf(() => h.importContent.import(LOCAL, { items, settings: { autoProofread: true } }));
    expect(error).toMatchObject({ code: "invalid_request.batch_too_large", details: { itemCount: IMPORT_BATCH_MAX + 1, limit: IMPORT_BATCH_MAX } });
    expect(h.platforms.bilibili.calls).toEqual([]);
  });

  it("counts expanded collection entries against the limit", async () => {
    const h = harness();
    h.platforms.bilibili.collections.set("1_2", {
      title: "Huge",
      items: Array.from({ length: IMPORT_BATCH_MAX + 1 }, (_, i) => ({ platformContentId: bvid(i), canonicalUrl: `https://www.bilibili.com/video/${bvid(i)}` })),
    });
    const error = await errorOf(() => h.importContent.import(LOCAL, request({}, "https://space.bilibili.com/1/lists/2")));
    expect(error).toMatchObject({ code: "invalid_request.batch_too_large", details: { itemCount: IMPORT_BATCH_MAX + 1 } });
    expect(countRows(h.db, "content")).toBe(0);
  });

  it("writes nothing when any item fails online", async () => {
    const h = harness();
    h.platforms.bilibili.resolveParts = async (ref) => {
      if (ref.platformContentId === bvid(2)) {
        throw amberError("source_unreachable", "scripted");
      }
      return [{ platformPartId: "c", index: 1, title: "", durationMs: 1000, canonicalUrl: `https://www.bilibili.com/video/${ref.platformContentId}` }];
    };
    const items = [1, 2, 3].map((i) => ({ url: `https://www.bilibili.com/video/${bvid(i)}` }));
    expect(await codeOf(() => h.importContent.import(LOCAL, { items, settings: { autoProofread: true } }))).toBe("source_unreachable");
    expect(countRows(h.db, "content")).toBe(0);
    expect(countRows(h.db, "import_batch")).toBe(0);
    expect(countRows(h.db, "task")).toBe(0);
  });
});

describe("initial subtitles", () => {
  it("imports the subtitle as the new Content's primary and records it on the Task", async () => {
    const h = harness();
    const { body } = await h.importContent.import(LOCAL, {
      items: [{ url: WATCH, initialSubtitle: { text: SRT, language: "en-us" } }],
      settings: { autoProofread: true },
    });
    const content = contentOf(h, body.contentIds[0]);
    const revisions = h.repository.withTransaction((scope) => scope.transcripts.listRevisions(LOCAL.userId, content?.id as string));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ kind: "imported", language: "en-US", segmentCount: 2 });
    expect(content?.primaryTranscriptRevisionId).toBe(revisions[0]?.id);
    expect(JSON.parse(taskOf(h, body.taskIds[0] as string).requestJson)).toMatchObject({ initialSubtitleRevisionId: revisions[0]?.id });
  });

  it("refuses an initial subtitle for an existing Content, a mismatched format and a bad language", async () => {
    const h = harness();
    await h.importContent.import(LOCAL, request({}, WATCH));
    const withSubtitle = (subtitle: Record<string, unknown>) => ({ items: [{ url: WATCH, initialSubtitle: subtitle }], settings: { autoProofread: true } });
    expect(await codeOf(() => h.importContent.import(LOCAL, withSubtitle({ text: SRT, language: "en" }) as never))).toBe("conflict");
    const fresh = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
    const other = (subtitle: Record<string, unknown>) => ({ items: [{ url: fresh, initialSubtitle: subtitle }], settings: { autoProofread: true } });
    expect(await codeOf(() => h.importContent.import(LOCAL, other({ text: SRT, format: "vtt", language: "en" }) as never))).toBe(
      "invalid_request.subtitle_format",
    );
    expect(await codeOf(() => h.importContent.import(LOCAL, other({ text: SRT, language: "not a tag" }) as never))).toBe("invalid_request");
    expect(countRows(h.db, "transcript_revision")).toBe(0);
  });

  it("refuses an initial subtitle on a multi-part choice", async () => {
    const h = harness();
    threeParts(h);
    const body = { items: [{ url: LINK, parts: "all" as const, initialSubtitle: { text: SRT, language: "zh" } }], settings: { autoProofread: true } };
    expect(await codeOf(() => h.importContent.import(LOCAL, body))).toBe("invalid_request");
  });
});

describe("inspecting a link", () => {
  it("describes single, multi-part and collection links without writing anything", async () => {
    const h = harness();
    expect(await h.importContent.inspect(LOCAL, WATCH)).toEqual({ kind: "single", canonicalUrl: WATCH });
    threeParts(h);
    expect(await h.importContent.inspect(LOCAL, LINK)).toEqual({
      kind: "multipart",
      canonicalUrl: LINK,
      parts: [1, 2, 3].map((index) => ({ platformPartId: `c${index}`, index, title: `Lecture ${index}`, durationMs: 600_000 })),
    });
    expect(await h.importContent.inspect(LOCAL, `${LINK}?p=3`)).toEqual({ kind: "single", canonicalUrl: `${LINK}?p=3`, title: "Lecture 3" });
    h.platforms.youtube.collections.set("PLabcdefghij", { title: "Playlist", items: [{ platformContentId: "dQw4w9WgXcQ", canonicalUrl: WATCH }] });
    expect(await h.importContent.inspect(LOCAL, "https://www.youtube.com/playlist?list=PLabcdefghij")).toEqual({
      kind: "collection",
      canonicalUrl: "https://www.youtube.com/playlist?list=PLabcdefghij",
      title: "Playlist",
      itemCount: 1,
      items: [{ platformContentId: "dQw4w9WgXcQ", canonicalUrl: WATCH }],
    });
    expect(countRows(h.db, "content")).toBe(0);
  });

  it("records a login the platform turns away as expired, and only a login", async () => {
    const h = harness();
    h.platforms.bilibili.resolveParts = async () => Promise.reject(amberError("auth_required", "scripted"));
    await expect(h.importContent.inspect(LOCAL, LINK)).rejects.toThrow();
    expect(h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "bilibili"))).toBeUndefined();
    h.platformAccounts.putCookies(LOCAL, "bilibili", "bili_session=<placeholder>");
    await expect(h.importContent.inspect(LOCAL, LINK)).rejects.toThrow();
    expect(h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "bilibili"))?.status).toBe("expired");
  });
});

describe("heavy-job governor", () => {
  const PLAYLIST = "https://www.youtube.com/playlist?list=PLabcdefghij";

  /** The harness's import service again, with `heavy` recording each slot's group and the platform calls made inside it. */
  function governed(h: Harness, governor: FairSemaphore) {
    const slots: Array<{ group: string; calls: string[] }> = [];
    const allCalls = () => [...h.platforms.bilibili.calls, ...h.platforms.youtube.calls];
    const service = new ImportContentService({
      repository: h.repository,
      bus: h.bus,
      control: { kick: () => undefined },
      platforms: new PlatformRegistry([h.platforms.bilibili, h.platforms.youtube]),
      credentials: h.platformAccounts,
      disk: h.disk,
      settings: h.settings,
      newId: h.newId,
      heavy: {
        run: (ref, signal, work) =>
          governor.run(ref, signal, async () => {
            const before = new Set(allCalls());
            try {
              return await work();
            } finally {
              slots.push({ group: ref.key, calls: allCalls().filter((call) => !before.has(call)).map((call) => call.method) });
            }
          }),
      },
    });
    return { service, slots };
  }

  it("resolves parts only once it holds a slot in the user's foreground group", async () => {
    const h = harness();
    threeParts(h);
    const governor = new FairSemaphore(() => 1);
    const { service, slots } = governed(h, governor);
    const release = await governor.acquire({ key: "task:other", createdAt: 0 }, new AbortController().signal);
    const imported = service.import(LOCAL, { items: [{ url: LINK, parts: "all" }], settings: { autoProofread: true } });
    await vi.waitFor(() => expect(governor.groupCount).toBe(2));
    // The only slot is taken: nothing has gone online for the parts yet.
    expect(h.platforms.bilibili.callsOf("resolveParts")).toEqual([]);
    release();
    expect((await imported).body.contentIds).toHaveLength(3);
    expect(slots).toEqual([{ group: `foreground:${LOCAL.userId}`, calls: ["resolveParts"] }]);
    expect(governor.inFlight).toBe(0);
  });

  it("runs every collection listing and part resolution in the user's foreground group, whatever the platform", async () => {
    const h = harness();
    threeParts(h);
    h.platforms.youtube.collections.set("PLabcdefghij", { title: "Playlist", items: [{ platformContentId: "dQw4w9WgXcQ", canonicalUrl: WATCH }] });
    h.platforms.bilibili.collections.set("1_2", { title: "Course", items: [{ platformContentId: bvid(1), canonicalUrl: `https://www.bilibili.com/video/${bvid(1)}` }] });
    const { service, slots } = governed(h, new FairSemaphore(() => 1));

    await service.import(LOCAL, { items: [{ url: LINK, parts: "first" }, { url: PLAYLIST }, { url: "https://space.bilibili.com/1/lists/2?type=season" }], settings: { autoProofread: true } });
    await service.inspect(BOB, LINK);
    await service.inspect(BOB, PLAYLIST);

    const local = `foreground:${LOCAL.userId}`;
    const bob = `foreground:${BOB.userId}`;
    expect(slots).toEqual([
      { group: local, calls: ["resolveParts"] },
      { group: local, calls: ["fetchCollection"] },
      { group: local, calls: ["fetchCollection"] },
      { group: bob, calls: ["resolveParts"] },
      { group: bob, calls: ["fetchCollection"] },
    ]);
  });
});

describe("re-importing the same link", () => {
  it("reuses an unfinished Task with the same intent and records a new ImportBatch", async () => {
    const h = harness();
    const first = await h.importContent.import(LOCAL, request());
    const again = await h.importContent.import(LOCAL, request());
    expect(again.body.taskIds).toEqual(first.body.taskIds);
    expect(again.body.contentIds).toEqual(first.body.contentIds);
    expect(again.body.importBatchId).not.toBe(first.body.importBatchId);
    expect(contentOf(h, first.body.contentIds[0])?.importBatchId).toBe(first.body.importBatchId);
    expect(countRows(h.db, "task")).toBe(1);
  });

  it("refuses a different intent while an unfinished Task holds the lane", async () => {
    const h = harness();
    await h.importContent.import(LOCAL, request());
    expect(await codeOf(() => h.importContent.import(LOCAL, request({ autoProofread: false })))).toBe("conflict.mutation_lane");
  });

  it("reuses a succeeded Task with the same intent and starts over after a failure", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const first = await h.importContent.import(LOCAL, request({ modelRef }));
    await drain(h);
    expect(taskOf(h, first.body.taskIds[0] as string).statusProjection).toBe("succeeded");
    const same = await h.importContent.import(LOCAL, request({ modelRef }));
    expect(same.body.taskIds).toEqual(first.body.taskIds);

    // Without a primary there is nothing to summarize from: a different intent is a new pass.
    const different = await h.importContent.import(LOCAL, request({ modelRef, outputLanguage: "en" }));
    expect(taskOf(h, different.body.taskIds[0] as string).kind).toBe("process_content");
    await h.scheduler.whenIdle();

    h.executors.source = { run: async () => Promise.reject(amberError("paid_content")) };
    const failing = await h.importContent.import(LOCAL, request({ modelRef, outputLanguage: "ja" }));
    await h.scheduler.whenIdle();
    expect(taskOf(h, failing.body.taskIds[0] as string).statusProjection).toBe("failed");
    const retried = await h.importContent.import(LOCAL, request({ modelRef, outputLanguage: "ja" }));
    expect(retried.body.taskIds).not.toEqual(failing.body.taskIds);
    expect(taskOf(h, retried.body.taskIds[0] as string).kind).toBe("process_content");
  });

  it("turns a change of model or output language alone into a regenerate_summary on the current primary", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const otherModel = configureLlm(h);
    const first = await h.importContent.import(LOCAL, request({ modelRef }));
    await drain(h);
    // Nothing runs from here on, so derived Tasks stay unfinished.
    await h.scheduler.stop();
    const contentId = first.body.contentIds[0] as string;
    const primary = givePrimary(h, contentId);

    const changed = await h.importContent.import(LOCAL, request({ modelRef: otherModel, outputLanguage: "en" }));
    const summary = taskOf(h, changed.body.taskIds[0] as string);
    expect(summary.kind).toBe("regenerate_summary");
    expect(JSON.parse(summary.requestJson)).toEqual({
      requestSchemaVersion: 1,
      kind: "regenerate_summary",
      promptRefs: builtinPromptRefs("regenerate_summary"),
      modelRef: otherModel,
      outputLanguage: "en",
      templateRef: { id: "summary.core", version: 1 },
      baseRevisionId: primary,
    });
    // Submitted again while it is unfinished: the same summary Task; a different summary intent conflicts.
    const again = await h.importContent.import(LOCAL, request({ modelRef: otherModel, outputLanguage: "en" }));
    expect(again.body.taskIds).toEqual(changed.body.taskIds);
    expect(await codeOf(() => h.importContent.import(LOCAL, request({ modelRef: otherModel, outputLanguage: "ja" })))).toBe("conflict.mutation_lane");
  });

  it("freezes the chosen template version and turns a template change alone into a regenerate_summary", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const first = await h.importContent.import(LOCAL, request({ modelRef }));
    await drain(h);
    await h.scheduler.stop();
    const contentId = first.body.contentIds[0] as string;
    const primary = givePrimary(h, contentId);
    const custom = h.summaryTemplates.create(LOCAL, { name: "Mine", prompt: "## 只要要点" });
    h.summaryTemplates.patch(LOCAL, custom.id, { prompt: "## 只要要点（第二版）" });

    const changed = await h.importContent.import(LOCAL, request({ modelRef, templateId: custom.id }));
    const summary = taskOf(h, changed.body.taskIds[0] as string);
    expect(summary.kind).toBe("regenerate_summary");
    expect(JSON.parse(summary.requestJson)).toMatchObject({ templateRef: { id: custom.id, version: 2 }, baseRevisionId: primary });
  });

  it("refuses a template that is unknown, deleted or another user's", async () => {
    const h = harness();
    const deleted = h.summaryTemplates.create(LOCAL, { name: "Gone", prompt: "x" });
    h.summaryTemplates.delete(LOCAL, deleted.id);
    const bobs = h.summaryTemplates.create(BOB, { name: "Bob's", prompt: "x" });
    for (const templateId of ["nope", deleted.id, bobs.id]) {
      const error = await errorOf(() => h.importContent.import(LOCAL, request({ templateId })));
      expect(error?.code).toBe("invalid_request");
      expect(error?.userMessage).toContain("settings.templateId");
    }
    expect(h.repository.withTransaction((scope) => scope.contents.list(LOCAL.userId))).toEqual([]);
  });

  it("ignores autoProofread once a primary exists", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const first = await h.importContent.import(LOCAL, request({ modelRef }));
    await drain(h);
    expect(taskOf(h, first.body.taskIds[0] as string).statusProjection).toBe("succeeded");
    givePrimary(h, first.body.contentIds[0] as string);
    const toggled = await h.importContent.import(LOCAL, request({ modelRef, autoProofread: false }));
    expect(toggled.body.taskIds).toEqual(first.body.taskIds);
    expect(countRows(h.db, "task")).toBe(1);
  });

  it("ignores the ASR model once a primary exists", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.repository.withTransaction((scope) => scope.asrProfiles.insert({ id: "other", userId: LOCAL.userId, name: "other", provider: "dashscope", models: [{ modelId: "fun-asr" }], createdAt: 1 }));
    const first = await h.importContent.import(LOCAL, request({ modelRef }));
    await drain(h);
    expect(taskOf(h, first.body.taskIds[0] as string).statusProjection).toBe("succeeded");
    givePrimary(h, first.body.contentIds[0] as string);
    const switched = await h.importContent.import(LOCAL, request({ modelRef, asrModelRef: { asrProfileId: "other", modelId: "fun-asr" } }));
    expect(switched.body.taskIds).toEqual(first.body.taskIds);
    expect(countRows(h.db, "task")).toBe(1);
  });

  it("keeps Content per user: the same link imported by another user is a separate Content", async () => {
    const h = harness();
    const mine = await h.importContent.import(LOCAL, request());
    const bobs = await h.importContent.import(BOB, request());
    expect(bobs.body.contentIds).not.toEqual(mine.body.contentIds);
  });
});

describe("Idempotency-Key", () => {
  it("replays the stored response for the same key and body without going online, even while new work is paused", async () => {
    const h = harness();
    const first = await h.importContent.import(LOCAL, request(), "key-1");
    const calls = h.platforms.bilibili.calls.length;
    h.disk.low();
    const second = await h.importContent.import(LOCAL, request(), "key-1");
    expect(second).toEqual({ ...first, replayed: true });
    expect(h.platforms.bilibili.calls).toHaveLength(calls);
    expect(countRows(h.db, "import_batch")).toBe(1);
    expect(countRows(h.db, "idempotency_record")).toBe(1);
  });

  it("answers idempotency_conflict for the same key with a different body", async () => {
    const h = harness();
    await h.importContent.import(LOCAL, request(), "key-1");
    expect(await codeOf(() => h.importContent.import(LOCAL, request({ autoProofread: false }), "key-1"))).toBe("idempotency_conflict");
  });

  it("scopes keys per user", async () => {
    const h = harness();
    const mine = await h.importContent.import(LOCAL, request(), "shared-key");
    const bobs = await h.importContent.import(BOB, request(), "shared-key");
    expect(bobs.replayed).toBe(false);
    expect(bobs.body.taskIds).not.toEqual(mine.body.taskIds);
  });
});

describe("importing what is in the trash", () => {
  const SPACE = "https://space.bilibili.com/1/lists/2?type=season";
  const T0 = 1_790_000_000_000;
  afterEach(() => {
    vi.useRealTimers();
  });

  function scriptCollection(h: Harness, count: number): void {
    h.platforms.bilibili.collections.set("1_2", {
      title: "Course",
      items: Array.from({ length: count }, (_, i) => ({
        platformContentId: bvid(i),
        platformPartId: `${bvid(i)}-cid`,
        title: `Lecture ${i + 1}`,
        canonicalUrl: `https://www.bilibili.com/video/${bvid(i)}`,
      })),
    });
  }

  /** Imports and finishes, so the Contents can go to the trash. */
  async function imported(h: Harness, body: ReturnType<typeof request>) {
    const result = await h.importContent.import(LOCAL, body);
    await drain(h);
    await h.scheduler.stop();
    return result.body;
  }

  const trashedIds = (h: Harness) => h.trash.list(LOCAL, { limit: 50 }).items.map((item) => item.id);

  it("restores a Content a new direct import names, in the same transaction, and reuses it", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const first = await imported(h, request({ modelRef }));
    const contentId = first.contentIds[0] as string;
    h.trash.trash(LOCAL, contentId);
    const again = await h.importContent.import(LOCAL, request({ modelRef }));
    expect(again.body).toMatchObject({ contentIds: [contentId], skippedTrashedContentIds: [] });
    // The same intent already succeeded: nothing new runs.
    expect(again.body.taskIds).toEqual(first.taskIds);
    expect(contentOf(h, contentId)?.id).toBe(contentId);
    expect(trashedIds(h)).toEqual([]);
  });

  it("skips Contents an expanded collection names, reporting them, and imports the rest", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    scriptCollection(h, 2);
    const first = await imported(h, request({ modelRef }, SPACE));
    const [kept, trashed] = first.contentIds as [string, string];
    h.trash.trash(LOCAL, trashed);
    scriptCollection(h, 3);
    const again = await h.importContent.import(LOCAL, request({ modelRef }, SPACE));
    expect(again.body.skippedTrashedContentIds).toEqual([trashed]);
    expect(again.body.contentIds).toHaveLength(2);
    expect(again.body.contentIds[0]).toBe(kept);
    expect(h.repository.withTransaction((scope) => scope.importBatches.get(LOCAL.userId, again.body.importBatchId))?.totalItems).toBe(2);
    expect(trashedIds(h)).toEqual([trashed]);
  });

  it("answers 202 with empty lists when every expanded item is in the trash, creating no platform collection", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    scriptCollection(h, 2);
    const first = await imported(h, request({ modelRef }, SPACE));
    for (const id of first.contentIds) h.trash.trash(LOCAL, id);
    h.repository.withTransaction((scope) => scope.collections.delete(LOCAL.userId, (scope.collections.findByPlatformCollectionId(LOCAL.userId, "1_2") as { id: string }).id));
    const again = await h.importContent.import(LOCAL, { ...request({ modelRef }, SPACE), collection: { name: "Renamed course" } });
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ taskIds: [], contentIds: [], skippedTrashedContentIds: [...first.contentIds].sort() });
    expect(h.repository.withTransaction((scope) => scope.collections.findByPlatformCollectionId(LOCAL.userId, "1_2"))).toBeUndefined();
    // A named target is still created, like for a collection that lists nothing.
    expect(h.collections.list(LOCAL).items.map((collection) => [collection.name, collection.itemCount])).toEqual([["Renamed course", 0]]);
    expect(h.repository.withTransaction((scope) => scope.importBatches.get(LOCAL.userId, again.body.importBatchId))?.totalItems).toBe(0);
  });

  it("restores an item named directly even when a collection in the same request lists it too", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    scriptCollection(h, 1);
    const first = await imported(h, request({ modelRef }, SPACE));
    const contentId = first.contentIds[0] as string;
    h.trash.trash(LOCAL, contentId);
    const again = await h.importContent.import(LOCAL, {
      items: [{ url: SPACE }, { url: `https://www.bilibili.com/video/${bvid(0)}` }],
      settings: { autoProofread: true, modelRef },
    });
    expect(again.body).toMatchObject({ contentIds: [contentId], skippedTrashedContentIds: [] });
    expect(trashedIds(h)).toEqual([]);
  });

  it("does not restore through an idempotent replay, nor once the retention has run out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const h = harness();
    const modelRef = configureLlm(h);
    h.platforms.bilibili.video(BVID, { parts: [{ platformPartId: "c1", title: "Lecture 1" }] });
    const first = await h.importContent.import(LOCAL, request({ modelRef }), "key-1");
    await drain(h);
    await h.scheduler.stop();
    const contentId = first.body.contentIds[0] as string;
    h.trash.trash(LOCAL, contentId);
    const replay = await h.importContent.import(LOCAL, request({ modelRef }), "key-1");
    expect(replay).toEqual({ ...first, replayed: true });
    expect(trashedIds(h)).toEqual([contentId]);

    vi.setSystemTime(T0 + TRASH_RETENTION_MS);
    const expired = await h.importContent.import(LOCAL, request({ modelRef }));
    expect(expired.body).toMatchObject({ taskIds: [], contentIds: [], skippedTrashedContentIds: [contentId] });
    expect(trashedIds(h)).toEqual([contentId]);
  });
});
