import { afterEach, describe, expect, it } from "vitest";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { lectureTranscripts } from "../../fixtures/transcripts/lecture.ts";
import { BOB, createHarness, createLocalContent, createTaskOfKind, LOCAL, LOCAL_TOKEN, type Harness } from "../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content whose primary is the ASR original, with a current highlight revision built from it. */
function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  const revisionId = h.newId();
  const artifactId = h.newId();
  const [first, , third] = fixture.asr.segments;
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.asr.revision.id, 2);
    scope.highlights.insertRevision(LOCAL.userId, contentId, {
      id: revisionId,
      artifactId,
      transcriptRevisionId: fixture.asr.revision.id,
      // Stored out of time order on purpose: the DTO lists them by time.
      items: [
        { segmentId: third?.id as SegmentId, score: 91, text: "工作原理" },
        { segmentId: first?.id as SegmentId, score: 62, text: "引入主题" },
      ],
      modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
      promptRef: { id: "highlight.default", version: 1 },
      promptSnapshot: "<highlight prompt>",
      quality: "normal",
      createdAt: 5,
    });
    scope.highlights.setCurrent(LOCAL.userId, contentId, revisionId);
  });
  return { h, contentId, fixture, revisionId, artifactId };
}

describe("HighlightService", () => {
  it("lists the current items in time order with their sentences and freshness", () => {
    const { h, contentId, fixture, revisionId, artifactId } = setup();
    const dto = h.highlights.get(LOCAL, contentId);
    const [first, , third] = fixture.asr.segments;
    expect(dto).toEqual({
      artifactId,
      current: {
        id: revisionId,
        artifactId,
        transcriptRevisionId: fixture.asr.revision.id,
        items: [
          { segmentId: first?.id, score: 62, text: "引入主题", segmentText: first?.text, startMs: first?.startMs, endMs: first?.endMs },
          { segmentId: third?.id, score: 91, text: "工作原理", segmentText: third?.text, startMs: third?.startMs, endMs: third?.endMs },
        ],
        modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
        promptRef: { id: "highlight.default", version: 1 },
        quality: "normal",
        qualityReasons: [],
        stale: false,
        createdAt: 5,
      },
    });
  });

  it("stays fresh when the primary is edited from its transcript, and reads stale with transcript_changed on another lineage", async () => {
    const { h, contentId, fixture, revisionId } = setup();
    const { app } = await h.app();
    const url = `/api/contents/${contentId}/highlights`;
    const setPrimary = (id: string) => app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: id } });
    expect((await app.inject({ method: "GET", url, headers: auth })).json().current).toMatchObject({ id: revisionId, stale: false });

    // The proofread child shares the sentences and timing of the transcript they were built from.
    expect((await setPrimary(fixture.corrected.revision.id)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url, headers: auth })).json().current).toMatchObject({ id: revisionId, stale: false });

    expect((await setPrimary(fixture.platform.revision.id)).statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url, headers: auth })).json();
    // Kept, not recomputed: still the same revision, on the sentences it was built from.
    expect(after.current).toMatchObject({ id: revisionId, transcriptRevisionId: fixture.asr.revision.id, stale: true, staleReason: "transcript_changed" });
    expect(after.current.items[0].segmentText).toBe(fixture.asr.segments[0]?.text);

    await app.inject({ method: "PUT", url: `/api/contents/${contentId}/primary-transcript`, headers: auth, payload: { revisionId: fixture.asr.revision.id } });
    expect((await app.inject({ method: "GET", url, headers: auth })).json().current).toMatchObject({ stale: false });
  });

  it("names the unfinished recompute Task, and is empty before any highlights exist", () => {
    const { h, contentId, fixture } = setup();
    const taskId = createTaskOfKind(
      h,
      "recompute_highlights",
      { baseRevisionId: fixture.asr.revision.id, outputLanguage: "zh-CN" },
      { contentId },
    );
    expect(h.highlights.get(LOCAL, contentId).activeTaskId).toBe(taskId);
    // A Task of another kind is not this one.
    const other = createLocalContent(h);
    createTaskOfKind(h, "translate", { targetLanguages: ["en"], baseRevisionId: "r" }, { contentId: other });
    expect(h.highlights.get(LOCAL, other)).toEqual({});
  });

  it("does not reveal another user's Content", () => {
    const { h, contentId } = setup();
    expect(() => h.highlights.get(BOB, contentId)).toThrow(expect.objectContaining({ appError: expect.objectContaining({ class: "not_found" }) }));
  });

  it("refuses an item that points outside its transcript revision", () => {
    const { h, contentId, fixture } = setup();
    const id = h.newId();
    h.repository.withTransaction((scope) => {
      scope.highlights.insertRevision(LOCAL.userId, contentId, {
        id,
        artifactId: h.newId(),
        transcriptRevisionId: fixture.asr.revision.id,
        items: [{ segmentId: fixture.corrected.segments[0]?.id as SegmentId, score: 1, text: "x" }],
        modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
        promptRef: { id: "highlight.default", version: 1 },
        promptSnapshot: "<highlight prompt>",
        quality: "normal",
        createdAt: 6,
      });
      scope.highlights.setCurrent(LOCAL.userId, contentId, id);
    });
    expect(() => h.highlights.get(LOCAL, contentId)).toThrow(expect.objectContaining({ appError: expect.objectContaining({ class: "internal" }) }));
  });
});
