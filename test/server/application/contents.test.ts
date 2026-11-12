import { afterEach, describe, expect, it } from "vitest";
import { ContentService } from "../../../src/server/application/contents.ts";
import type { Content } from "../../../src/server/domain/content.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import type { TranscriptRevision } from "../../../src/server/domain/transcript.ts";
import type { ContentListQuery, Repository } from "../../../src/server/ports/repository.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const SRT = "1\n00:00:00,000 --> 00:00:02,000\nhello\n\n2\n00:00:02,000 --> 00:00:04,000\nworld\n";
const VTT = "WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n\n00:02.000 --> 00:04.000\nworld\n";

const open: Harness[] = [];
function harness(): Harness {
  const created = createHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

function insertContent(h: Harness, fields: Partial<Content> & { createdAt: number }, userId = LOCAL.userId): Content {
  const content: Content = { id: h.newId(), userId, source: { kind: "local" }, processingStatus: "queued", updatedAt: fields.createdAt, ...fields };
  h.repository.withTransaction((scope) => scope.contents.insert(content));
  return content;
}

function contentOf(h: Harness, contentId: string) {
  return h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
}

function revisionsOf(h: Harness, contentId: string) {
  return h.repository.withTransaction((scope) => scope.transcripts.listRevisions(LOCAL.userId, contentId));
}

describe("ContentService.list", () => {
  it("pages newest first with an opaque cursor", () => {
    const h = harness();
    const created = [1, 2, 3, 4, 5].map((createdAt) => insertContent(h, { createdAt }));
    insertContent(h, { createdAt: 9 }, BOB.userId);
    const first = h.contents.list(LOCAL, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([created[4]?.id, created[3]?.id]);
    expect(first.items[0]).not.toHaveProperty("userId");
    const second = h.contents.list(LOCAL, { limit: 2, cursor: first.nextCursor as string });
    expect(second.items.map((item) => item.id)).toEqual([created[2]?.id, created[1]?.id]);
    const last = h.contents.list(LOCAL, { limit: 2, cursor: second.nextCursor as string });
    expect(last.items.map((item) => item.id)).toEqual([created[0]?.id]);
    expect(last.nextCursor).toBeUndefined();
  });

  it("breaks createdAt ties by id so no Content is skipped across pages", () => {
    const h = harness();
    const created = [0, 1, 2].map(() => insertContent(h, { createdAt: 7 }));
    const first = h.contents.list(LOCAL, { limit: 2 });
    const second = h.contents.list(LOCAL, { limit: 2, cursor: first.nextCursor as string });
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(created.map((content) => content.id).reverse());
  });

  it("filters by status, source, collection and import batch", () => {
    const h = harness();
    const batchId = h.newId();
    const collectionId = h.newId();
    h.repository.withTransaction((scope) => {
      scope.importBatches.insert({ id: batchId, userId: LOCAL.userId, createdAt: 1, sourceType: "links", totalItems: 1 });
      scope.collections.insert({ id: collectionId, userId: LOCAL.userId, name: "c", createdAt: 1, updatedAt: 1 });
    });
    const platform = insertContent(h, {
      createdAt: 1,
      source: { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD", platformContentId: "BV1xx411c7mD" },
      importBatchId: batchId,
    });
    const done = insertContent(h, { createdAt: 2, processingStatus: "succeeded" });
    const member = insertContent(h, { createdAt: 3 });
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId, contentId: member.id, position: 0, addedAt: 1 }));
    const ids = (query: Parameters<Harness["contents"]["list"]>[1]) => h.contents.list(LOCAL, query).items.map((item) => item.id);
    expect(ids({ limit: 10, status: "succeeded" })).toEqual([done.id]);
    expect(ids({ limit: 10, source: "bilibili" })).toEqual([platform.id]);
    expect(ids({ limit: 10, importBatchId: batchId })).toEqual([platform.id]);
    expect(ids({ limit: 10, collectionId })).toEqual([member.id]);
    expect(ids({ limit: 10, source: "youtube" })).toEqual([]);
  });

  it("lists and details every Content with the collections it belongs to, oldest membership first", () => {
    const h = harness();
    const [first, second] = [h.newId(), h.newId()];
    h.repository.withTransaction((scope) => {
      scope.collections.insert({ id: first, userId: LOCAL.userId, name: "first", createdAt: 1, updatedAt: 1 });
      scope.collections.insert({ id: second, userId: LOCAL.userId, name: "second", createdAt: 2, updatedAt: 2 });
    });
    const member = insertContent(h, { createdAt: 1 });
    const loner = insertContent(h, { createdAt: 2 });
    const [secondItem, firstItem] = [h.newId(), h.newId()];
    h.repository.withTransaction((scope) => {
      scope.collections.addItem(LOCAL.userId, { id: secondItem, collectionId: second, contentId: member.id, position: 0, addedAt: 5 });
      scope.collections.addItem(LOCAL.userId, { id: firstItem, collectionId: first, contentId: member.id, position: 0, addedAt: 9 });
    });
    const memberships = [
      { id: second, name: "second", itemId: secondItem },
      { id: first, name: "first", itemId: firstItem },
    ];
    const listed = h.contents.list(LOCAL, { limit: 10 }).items;
    expect(listed.map((item) => [item.id, item.collections])).toEqual([
      [loner.id, []],
      [member.id, memberships],
    ]);
    expect(h.contents.get(LOCAL, member.id).collections).toEqual(memberships);
  });

  it("rejects a malformed cursor", async () => {
    const h = harness();
    // The two-element cursor of earlier builds is refused like any other malformed one.
    for (const cursor of ["!!", Buffer.from("[1]").toString("base64url"), Buffer.from('["x","y"]').toString("base64url"), Buffer.from('[1,"id"]').toString("base64url"), Buffer.from('["p",1,"id"]').toString("base64url")]) {
      expect(await codeOf(() => h.contents.list(LOCAL, { limit: 1, cursor })), cursor).toBe("invalid_request");
    }
  });
});

describe("ContentService.list: pins, totals and uncollected", () => {
  it("lists pinned Contents first across pages, counts every match and filters out collected ones", () => {
    const h = harness();
    const collectionId = h.newId();
    h.repository.withTransaction((scope) => scope.collections.insert({ id: collectionId, userId: LOCAL.userId, name: "c", createdAt: 1, updatedAt: 1 }));
    const created = [1, 2, 3, 4].map((createdAt) => insertContent(h, { createdAt }));
    const [oldest, , third, newest] = created as [Content, Content, Content, Content];
    h.contents.patch(LOCAL, oldest.id, { pinned: true });
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId, contentId: third.id, position: 0, addedAt: 1 }));
    const first = h.contents.list(LOCAL, { limit: 2 });
    expect(first.total).toBe(4);
    const second = h.contents.list(LOCAL, { limit: 2, cursor: first.nextCursor as string });
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual([oldest.id, newest.id, third.id, created[1]?.id]);
    expect(second.total).toBe(4);
    const recent = h.contents.list(LOCAL, { limit: 10, uncollected: true });
    expect(recent.items.map((item) => item.id)).toEqual([oldest.id, newest.id, created[1]?.id]);
    expect(recent.total).toBe(3);
  });
});

describe("ContentService.list: numbered pages and ids", () => {
  const idsOf = (h: Harness, query: Parameters<Harness["contents"]["list"]>[1]) => h.contents.list(LOCAL, query).items.map((item) => item.id);

  /** A service whose repository records every `page` query while still reading the real database. */
  function recorded(h: Harness): { service: ContentService; pages: ContentListQuery[] } {
    const pages: ContentListQuery[] = [];
    const repository: Repository = {
      withTransaction: (work) =>
        h.repository.withTransaction((scope) =>
          work({
            ...scope,
            contents: {
              ...scope.contents,
              page: (owner, query) => {
                pages.push(query);
                return scope.contents.page(owner, query);
              },
            },
          }),
        ),
    };
    return { service: new ContentService({ repository }), pages };
  }

  it("gives page 1 exactly the cursor's first page, without nextCursor, and leaves the cursor path as it was", () => {
    const h = harness();
    const created = [1, 2, 3, 4, 5].map((createdAt) => insertContent(h, { createdAt }));
    const byCursor = h.contents.list(LOCAL, { limit: 2 });
    const byPage = h.contents.list(LOCAL, { limit: 2, page: 1 });
    expect(byPage.items).toEqual(byCursor.items);
    expect(byPage).toEqual({ items: byCursor.items, total: 5 });
    expect(byCursor.nextCursor).toEqual(expect.any(String));
    expect(idsOf(h, { limit: 2, page: 2 })).toEqual([created[2]?.id, created[1]?.id]);
    expect(h.contents.list(LOCAL, { limit: 2, page: 3 })).toEqual({ items: [expect.objectContaining({ id: created[0]?.id })], total: 5 });
    const { service, pages } = recorded(h);
    service.list(LOCAL, { limit: 2, cursor: byCursor.nextCursor as string });
    expect(pages).toHaveLength(1);
    expect(pages[0]).not.toHaveProperty("offset");
    expect(pages[0]?.after).toEqual({ createdAt: 4, id: created[3]?.id });
  });

  it("answers a page past the end with no items and the total, without reading a page", () => {
    const h = harness();
    [1, 2, 3].map((createdAt) => insertContent(h, { createdAt }));
    const { service, pages } = recorded(h);
    expect(service.list(LOCAL, { limit: 2, page: 3 })).toEqual({ items: [], total: 3 });
    expect(service.list(LOCAL, { limit: 1, page: Number.MAX_SAFE_INTEGER })).toEqual({ items: [], total: 3 });
    expect(pages).toEqual([]);
    expect(service.list(LOCAL, { limit: 2, page: 2 }).items).toHaveLength(1);
    expect(pages).toEqual([{ limit: 2, offset: 2 }]);
  });

  it("answers an empty library with total 0 on page 1", () => {
    const h = harness();
    const { service, pages } = recorded(h);
    expect(service.list(LOCAL, { limit: 10, page: 1 })).toEqual({ items: [], total: 0 });
    expect(pages).toEqual([]);
  });

  it("walks every page of pins and equal creation times without repeating or skipping", () => {
    const h = harness();
    const created = [7, 7, 7, 7, 3, 3, 9].map((createdAt) => insertContent(h, { createdAt }));
    for (const index of [1, 4, 5]) h.contents.patch(LOCAL, created[index]?.id as string, { pinned: true });
    const all = idsOf(h, { limit: 100 });
    for (const limit of [1, 2, 3]) {
      const walked: string[] = [];
      for (let page = 1; page <= Math.ceil(all.length / limit); page += 1) walked.push(...idsOf(h, { limit, page }));
      expect(walked, `limit ${limit}`).toEqual(all);
    }
  });

  it("refuses page together with cursor, and a page that is not a positive safe integer", async () => {
    const h = harness();
    insertContent(h, { createdAt: 1 });
    const cursor = Buffer.from(JSON.stringify([null, 1, "x"])).toString("base64url");
    for (const page of [1, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const query = page === 1 ? { limit: 1, page, cursor } : { limit: 1, page };
      expect(await codeOf(() => h.contents.list(LOCAL, query)), String(page)).toBe("invalid_request");
    }
  });

  it("lists only the given ids that also match the other filters and belong to the user", () => {
    const h = harness();
    const collectionId = h.newId();
    h.repository.withTransaction((scope) => scope.collections.insert({ id: collectionId, userId: LOCAL.userId, name: "c", createdAt: 1, updatedAt: 1 }));
    const done = insertContent(h, { createdAt: 1, processingStatus: "succeeded" });
    const platform = insertContent(h, { createdAt: 2, source: { kind: "youtube", platformContentId: "dQw4w9WgXcQ" } });
    const member = insertContent(h, { createdAt: 3 });
    const outside = insertContent(h, { createdAt: 4 });
    const theirs = insertContent(h, { createdAt: 5 }, BOB.userId);
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId, contentId: member.id, position: 0, addedAt: 1 }));
    const ids = [done.id, platform.id, member.id, theirs.id];
    expect(h.contents.list(LOCAL, { limit: 10, page: 1, ids })).toMatchObject({ total: 3 });
    expect(idsOf(h, { limit: 10, page: 1, ids })).toEqual([member.id, platform.id, done.id]);
    expect(idsOf(h, { limit: 10, ids })).toEqual([member.id, platform.id, done.id]);
    expect(idsOf(h, { limit: 10, page: 1, ids, status: "succeeded" })).toEqual([done.id]);
    expect(idsOf(h, { limit: 10, page: 1, ids, source: "youtube" })).toEqual([platform.id]);
    expect(idsOf(h, { limit: 10, page: 1, ids, collectionId })).toEqual([member.id]);
    expect(idsOf(h, { limit: 10, page: 1, ids, uncollected: true })).toEqual([platform.id, done.id]);
    expect(idsOf(h, { limit: 1, page: 2, ids })).toEqual([platform.id]);
    expect(idsOf(h, { limit: 10, page: 1, ids: [outside.id] })).toEqual([outside.id]);
    expect(h.contents.list(LOCAL, { limit: 10, page: 1, ids: [theirs.id] })).toEqual({ items: [], total: 0 });
    expect(h.contents.list(BOB, { limit: 10, page: 1, ids: [done.id, theirs.id] }).items.map((item) => item.id)).toEqual([theirs.id]);
  });
});

describe("ContentService.patch", () => {
  it("renames into customTitle, shows it as the title everywhere a DTO goes, and restores the original", () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1, title: "平台标题" });
    const renamed = h.contents.patch(LOCAL, content.id, { title: "我的标题" });
    expect(renamed).toMatchObject({ title: "我的标题", customTitle: "我的标题" });
    expect(contentOf(h, content.id)).toMatchObject({ title: "平台标题", customTitle: "我的标题" });
    expect(h.contents.list(LOCAL, { limit: 10 }).items[0]?.title).toBe("我的标题");
    expect(h.contents.get(LOCAL, content.id).title).toBe("我的标题");
    const searched = h.repository.withTransaction((scope) => scope.search.query(LOCAL.userId, { terms: ["我的标题"], mode: "like", scope: { kind: "global" }, groupLimit: 20, likeLimit: 200 }));
    expect(searched.map((hit) => [hit.kind, "contentId" in hit ? hit.contentId : undefined])).toEqual([["title", content.id]]);
    const collectionId = h.newId();
    h.repository.withTransaction((scope) => {
      scope.collections.insert({ id: collectionId, userId: LOCAL.userId, name: "c", createdAt: 1, updatedAt: 1 });
      scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId, contentId: content.id, position: 0, addedAt: 1 });
    });
    h.contents.patch(LOCAL, content.id, { pinned: true });
    expect(h.collections.get(LOCAL, collectionId).items[0]).toMatchObject({ title: "我的标题", pinnedAt: expect.any(Number) });
    const restored = h.contents.patch(LOCAL, content.id, { title: null });
    expect(restored.title).toBe("平台标题");
    expect(restored).not.toHaveProperty("customTitle");
  });

  it("pins without touching updatedAt, and refuses another user's Content", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    const pinned = h.contents.patch(LOCAL, content.id, { pinned: true });
    expect(pinned.pinnedAt).toEqual(expect.any(Number));
    expect(pinned.updatedAt).toBe(1);
    expect(h.contents.patch(LOCAL, content.id, { pinned: false })).not.toHaveProperty("pinnedAt");
    expect(await codeOf(() => h.contents.patch(BOB, content.id, { pinned: true }))).toBe("not_found");
    expect(contentOf(h, content.id)).not.toHaveProperty("pinnedAt");
  });
});

describe("ContentService.get and revisions", () => {
  it("returns the Content with its media but never storage references or fingerprints", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1, title: "Talk" });
    const asset: MediaAsset = {
      id: h.newId(),
      userId: LOCAL.userId,
      contentId: content.id,
      kind: "managed_upload",
      storageRef: `assets/local/${content.id}/secret-location`,
      displayName: "talk.mp4",
      mimeType: "video/mp4",
      sizeBytes: 10,
      fingerprint: "sha256:abcdef",
      availability: "available",
      retentionPolicy: "keep",
      createdAt: 1,
    };
    h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
    const detail = h.contents.get(LOCAL, content.id);
    expect(detail).toMatchObject({ id: content.id, title: "Talk", media: [{ id: asset.id, kind: "managed_upload", displayName: "talk.mp4", sizeBytes: 10 }] });
    const text = JSON.stringify(detail);
    expect(text).not.toContain("secret-location");
    expect(text).not.toContain("sha256:abcdef");
    expect(text).not.toContain('"userId"');
    expect(await codeOf(() => h.contents.get(BOB, content.id))).toBe("not_found");
  });

  it("lists revisions with the current primary", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    expect(h.contents.revisions(LOCAL, content.id)).toEqual({ revisions: [] });
    const { transcriptRevisionId } = h.contents.importSubtitle(LOCAL, content.id, { text: SRT, language: "en" });
    expect(h.contents.revisions(LOCAL, content.id)).toMatchObject({
      primaryTranscriptRevisionId: transcriptRevisionId,
      revisions: [{ id: transcriptRevisionId, kind: "imported", generation: { kind: "imported", format: "srt" } }],
    });
    expect(await codeOf(() => h.contents.revisions(BOB, content.id))).toBe("not_found");
  });
});

describe("ContentService.setPrimary", () => {
  it("switches between the Content's own revisions only, never to a translation or a reference text", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    const first = h.contents.importSubtitle(LOCAL, content.id, { text: SRT, language: "en" }).transcriptRevisionId as string;
    const second = h.contents.importSubtitle(LOCAL, content.id, { text: VTT, language: "en" }).transcriptRevisionId as string;
    expect(contentOf(h, content.id)?.primaryTranscriptRevisionId).toBe(second);
    expect(h.contents.setPrimary(LOCAL, content.id, first).primaryTranscriptRevisionId).toBe(first);

    const translated: TranscriptRevision = {
      id: h.newId(),
      contentId: content.id,
      kind: "translated",
      parentRevisionId: first,
      language: "zh-CN",
      timingFidelity: "segment_only",
      generation: { kind: "manual" },
      segmentCount: 0,
      createdAt: 2,
    };
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, translated, []));
    expect(await codeOf(() => h.contents.setPrimary(LOCAL, content.id, translated.id))).toBe("invalid_request");

    const { referenceTextId } = h.contents.importSubtitle(LOCAL, content.id, { text: "notes", format: "txt" });
    expect(await codeOf(() => h.contents.setPrimary(LOCAL, content.id, referenceTextId as string))).toBe("not_found");

    const other = insertContent(h, { createdAt: 3 });
    expect(await codeOf(() => h.contents.setPrimary(LOCAL, other.id, first))).toBe("not_found");
    expect(await codeOf(() => h.contents.setPrimary(BOB, content.id, first))).toBe("not_found");
    expect(await codeOf(() => h.contents.setPrimary(LOCAL, "missing", first))).toBe("not_found");
    expect(contentOf(h, content.id)?.primaryTranscriptRevisionId).toBe(first);
  });
});

describe("ContentService.importSubtitle", () => {
  it("an SRT becomes an imported, segment_only revision that is made primary, with no ReferenceText", () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    const response = h.contents.importSubtitle(LOCAL, content.id, { text: SRT, language: "zh-cn", filename: "a.srt" });
    expect(response).toEqual({ transcriptRevisionId: expect.any(String), warnings: [] });
    const [revision] = revisionsOf(h, content.id);
    expect(revision).toMatchObject({ id: response.transcriptRevisionId, kind: "imported", timingFidelity: "segment_only", language: "zh-CN", segmentCount: 2 });
    expect(contentOf(h, content.id)?.primaryTranscriptRevisionId).toBe(response.transcriptRevisionId);
    expect(countRows(h.db, "reference_text")).toBe(0);
  });

  it("stores the imported revision as not reviewed, even over a primary whose speakers were reviewed", () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    const reviewed: TranscriptRevision = {
      id: h.newId(), contentId: content.id, kind: "asr", language: "en", timingFidelity: "segment_only",
      generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe" }, segmentCount: 1, createdAt: 1,
    };
    h.repository.withTransaction((scope) => {
      scope.speakers.insert(LOCAL.userId, content.id, [{ id: "S1", name: "Ann", nameConfirmedAt: 1 }], 1);
      scope.transcripts.insertRevision(LOCAL.userId, reviewed, [
        { id: h.newId() as SegmentId, revisionId: reviewed.id, ordinal: 0, startMs: 0, endMs: 900, text: "hi", speakerId: "S1", sourceSegmentIds: [] },
      ]);
      scope.contents.setPrimaryTranscript(LOCAL.userId, content.id, reviewed.id, 1);
      scope.speakerConfirmations.set(LOCAL.userId, content.id, reviewed.id, 5);
    });
    const { transcriptRevisionId } = h.contents.importSubtitle(LOCAL, content.id, { text: SRT, language: "en" });
    expect(contentOf(h, content.id)?.primaryTranscriptRevisionId).toBe(transcriptRevisionId);
    expect(revisionsOf(h, content.id).find((revision) => revision.id === transcriptRevisionId)).toMatchObject({ kind: "imported" });
    const confirmedAt = (revisionId: string) => h.repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAt(LOCAL.userId, revisionId));
    expect(confirmedAt(transcriptRevisionId as string)).toBeUndefined();
    expect(confirmedAt(reviewed.id)).toBe(5);
    expect(countRows(h.db, "transcript_revision_speaker_confirmation")).toBe(1);
  });

  it("recognizes VTT by content and rejects a declared format that does not match", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    h.contents.importSubtitle(LOCAL, content.id, { text: VTT, language: "en" });
    expect(revisionsOf(h, content.id)[0]?.generation).toEqual({ kind: "imported", format: "vtt" });
    expect(await codeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: VTT, format: "srt", language: "en" }))).toBe("invalid_request.subtitle_format");
    expect(await codeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: "no cues here", format: "srt", language: "en" }))).toBe(
      "invalid_request.subtitle_format",
    );
  });

  it("TXT and Markdown become ReferenceTexts and leave transcripts and the primary alone", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    const primary = h.contents.importSubtitle(LOCAL, content.id, { text: SRT, language: "en" }).transcriptRevisionId;
    const txt = h.contents.importSubtitle(LOCAL, content.id, { text: "plain notes" });
    const md = h.contents.importSubtitle(LOCAL, content.id, { text: "# Notes\n\n00:00:01,000 --> 00:00:02,000\n", filename: "notes.md" });
    expect(txt).toEqual({ referenceTextId: expect.any(String), warnings: [] });
    expect(md.referenceTextId).toEqual(expect.any(String));
    const texts = h.repository.withTransaction((scope) => scope.referenceTexts.listByContent(LOCAL.userId, content.id));
    expect(texts.map((text) => [text.id, text.origin])).toEqual([
      [txt.referenceTextId, "txt_import"],
      [md.referenceTextId, "md_import"],
    ]);
    expect(revisionsOf(h, content.id)).toHaveLength(1);
    expect(contentOf(h, content.id)?.primaryTranscriptRevisionId).toBe(primary);
    // A ReferenceText is not a transcript revision, so it cannot become the primary.
    expect(await codeOf(() => h.contents.setPrimary(LOCAL, content.id, txt.referenceTextId as string))).toBe("not_found");
    expect(contentOf(h, content.id)?.primaryTranscriptRevisionId).toBe(primary);
  });

  it("needs a valid language for a timed subtitle", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    expect(await codeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: SRT }))).toBe("invalid_request");
    expect(await codeOf(() => h.contents.importSubtitle(LOCAL, content.id, { text: SRT, format: "srt", language: "not a tag" }))).toBe("invalid_request");
    expect(countRows(h.db, "transcript_revision")).toBe(0);
  });

  it("warns about dropped cues and a timeline that does not fit the known duration", () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1, durationMs: 600_000 });
    const withBroken = `${SRT}\n3\n00:00:05,000 --> 00:00:04,000\nbackwards\n`;
    const { warnings } = h.contents.importSubtitle(LOCAL, content.id, { text: withBroken, language: "en" });
    expect(warnings).toEqual(["subtitle_cue_dropped", "imported_subtitle_invalid", "subtitle_coverage_low"]);
    // Warnings never stop the import.
    expect(contentOf(h, content.id)?.primaryTranscriptRevisionId).toBeDefined();
  });

  it("refuses a Content that is not the user's", async () => {
    const h = harness();
    const content = insertContent(h, { createdAt: 1 });
    expect(await codeOf(() => h.contents.importSubtitle(BOB, content.id, { text: SRT, language: "en" }))).toBe("not_found");
    expect(await codeOf(() => h.contents.importSubtitle(BOB, content.id, { text: "notes" }))).toBe("not_found");
    expect(countRows(h.db, "transcript_revision")).toBe(0);
    expect(countRows(h.db, "reference_text")).toBe(0);
  });
});

describe("ContentService.get in local mode: files that vanished outside Amber", () => {
  function asset(h: Harness, contentId: string, fields: Partial<MediaAsset> & Pick<MediaAsset, "kind" | "storageRef">): MediaAsset {
    const created: MediaAsset = {
      id: h.newId(),
      userId: LOCAL.userId,
      contentId,
      mimeType: "video/mp4",
      sizeBytes: 10,
      availability: "available",
      retentionPolicy: fields.kind === "external_local" ? "never_delete" : "evictable",
      createdAt: 1,
      ...fields,
    };
    h.repository.withTransaction((scope) => scope.mediaAssets.insert(created));
    return created;
  }

  it("marks a gone original missing and a gone cache evicted, keeps present files, and leaves server mode alone", async () => {
    const { ContentService } = await import("../../../src/server/application/contents.ts");
    const h = harness();
    const contentId = insertContent(h, { createdAt: 1 }).id;
    const gone = asset(h, contentId, { kind: "external_local", storageRef: "/videos/moved away.mp4" });
    const present = asset(h, contentId, { kind: "external_local", storageRef: "/videos/still here.mp4" });
    const cache = asset(h, contentId, { kind: "platform_cache", storageRef: `assets/${LOCAL.userId}/${contentId}/cache` });
    const existing = new Set(["/videos/still here.mp4"]);

    const server = new ContentService({ repository: h.repository });
    expect(server.get(LOCAL, contentId).media.map((item) => item.availability)).toEqual(["available", "available", "available"]);

    const local = new ContentService({
      repository: h.repository,
      localPaths: { pathOf: (ref) => `/data/${ref}`, isFile: (path) => existing.has(path) },
    });
    const media = new Map(local.get(LOCAL, contentId).media.map((item) => [item.id, item]));
    expect(media.get(gone.id)?.availability).toBe("missing");
    expect(media.get(gone.id)).not.toHaveProperty("localPath");
    expect(media.get(present.id)).toMatchObject({ availability: "available", localPath: "/videos/still here.mp4" });
    expect(media.get(cache.id)?.availability).toBe("evicted");
    const stored = h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
    expect(stored.map((item) => item.availability)).toEqual(["missing", "available", "evicted"]);

    // A file that reappears is not trusted again without relinking.
    existing.add("/videos/moved away.mp4");
    expect(local.get(LOCAL, contentId).media.find((item) => item.id === gone.id)?.availability).toBe("missing");
  });

  it("leaves a cache available while the cache root itself is unavailable, and still notices a gone original", async () => {
    const { ContentService } = await import("../../../src/server/application/contents.ts");
    const h = harness();
    const contentId = insertContent(h, { createdAt: 1 }).id;
    const gone = asset(h, contentId, { kind: "external_local", storageRef: "/videos/moved away.mp4" });
    const cache = asset(h, contentId, { kind: "platform_cache", storageRef: `assets/${LOCAL.userId}/${contentId}/cache` });
    let cacheAvailable = false;
    const local = new ContentService({
      repository: h.repository,
      localPaths: { pathOf: (ref) => `/cache/${ref}`, isFile: () => false, cacheAvailable: () => cacheAvailable },
    });
    const first = new Map(local.get(LOCAL, contentId).media.map((item) => [item.id, item]));
    expect(first.get(gone.id)?.availability).toBe("missing");
    expect(first.get(cache.id)).toMatchObject({ availability: "available", localPath: `/cache/assets/${LOCAL.userId}/${contentId}/cache` });
    // Once the root is back, a file that is really gone is noticed.
    cacheAvailable = true;
    expect(local.get(LOCAL, contentId).media.find((item) => item.id === cache.id)?.availability).toBe("evicted");
  });
});
