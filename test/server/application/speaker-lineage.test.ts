import { afterEach, describe, expect, it } from "vitest";
import { currentSpeakerLabels, SpeakerLineageReader, type SpeakerLabeler } from "../../../src/server/application/speaker-lineage.ts";
import type { SpeakerContextSnapshot } from "../../../src/server/domain/speaker-context.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

/** Labels as a model would see them in these tests: a confirmed name, else 「发言人 N」. */
const labeler: SpeakerLabeler = (speakers) =>
  new Map(speakers.map((speaker) => [speaker.id, speaker.name !== undefined && speaker.nameConfirmedAt !== undefined ? speaker.name : `发言人 ${speaker.ordinal}`]));

function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  h.repository.withTransaction((scope) => scope.speakers.insert(LOCAL.userId, contentId, [{ id: "x", name: "蒋炎岩", nameConfirmedAt: 1 }, { id: "y" }], 1));
  const insert = (speakers: Array<string | undefined>, parent?: { revision: TranscriptRevision; segments: TranscriptSegment[] }) => {
    const id = h.newId();
    const revision: TranscriptRevision = {
      id, contentId, kind: parent === undefined ? "asr" : "manual", ...(parent === undefined ? {} : { parentRevisionId: parent.revision.id }), language: "zh-CN",
      timingFidelity: parent === undefined ? "exact_words" : "inherited_segment",
      generation: parent === undefined ? { kind: "asr", asrProfileId: "a", modelId: "m" } : { kind: "manual" }, segmentCount: speakers.length, createdAt: 1,
    };
    const segments: TranscriptSegment[] = speakers.map((speakerId, ordinal) => ({
      id: h.newId() as SegmentId, revisionId: id, ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, text: `句${ordinal}`,
      ...(speakerId === undefined ? {} : { speakerId }),
      sourceSegmentIds: parent === undefined ? [] : [parent.segments[ordinal]?.id as SegmentId],
    }));
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
      scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, id, 2);
    });
    return { revision, segments };
  };
  const confirm = (revisionId: string) => h.repository.withTransaction((scope) => scope.speakerConfirmations.set(LOCAL.userId, contentId, revisionId, 3));
  return { h, contentId, insert, confirm };
}

const snapshot: SpeakerContextSnapshot = {
  version: 1,
  rules: { id: "speaker.rules", version: 1 },
  attributionDigest: "d",
  speakers: [
    { id: "x", ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" },
    { id: "y", ordinal: 2, label: "发言人 2" },
  ],
};

describe("SpeakerLineageReader.state", () => {
  it("is consistent while nothing changed and the primary is reviewed, unconfirmed when it is not", () => {
    const { h, contentId, insert, confirm } = setup();
    const base = insert(["x", "y", "x"]);
    const reader = new SpeakerLineageReader();
    const state = () =>
      h.repository.withTransaction((scope) =>
        reader.state(scope, LOCAL.userId, { contentId, generatedFromRevisionId: base.revision.id, snapshot, citedSegmentIds: [base.segments[0]?.id as string] }, labeler),
      );
    expect(state()).toEqual({ state: "unconfirmed" });
    confirm(base.revision.id);
    expect(state()).toEqual({ state: "consistent" });
    h.repository.withTransaction((scope) => scope.speakers.update(LOCAL.userId, contentId, "x", { name: "张三", nameConfirmedAt: null }, 4));
    // Renamed, but not confirmed: the model would now see 「发言人 1」.
    expect(state()).toEqual({ state: "names_changed", renamed: [{ id: "x", was: "蒋炎岩", now: "发言人 1" }] });
  });

  it("compares the generated-from revision with the current primary sentence by sentence", () => {
    const { h, contentId, insert, confirm } = setup();
    const base = insert(["x", "y", "x"]);
    const edited = insert(["y", "y", "x"], base);
    confirm(edited.revision.id);
    const reader = new SpeakerLineageReader();
    const result = h.repository.withTransaction((scope) =>
      reader.state(scope, LOCAL.userId, { contentId, generatedFromRevisionId: base.revision.id, snapshot, citedSegmentIds: [] }, labeler),
    );
    expect(result).toEqual({ state: "attribution_changed", changedSentences: 1 });
  });

  it("gives no state without a primary in the same lineage", () => {
    const { h, contentId, insert } = setup();
    const first = insert(["x"]);
    insert(["x"]);
    const reader = new SpeakerLineageReader();
    const result = h.repository.withTransaction((scope) =>
      reader.state(scope, LOCAL.userId, { contentId, generatedFromRevisionId: first.revision.id, snapshot, citedSegmentIds: [] }, labeler),
    );
    expect(result).toBeUndefined();
  });
});

describe("SpeakerLineageReader.compare cache", () => {
  it("keeps a revision pair's comparison and drops the least recently used past its capacity", () => {
    const { h, contentId, insert } = setup();
    const base = insert(["x", "y"]);
    const one = insert(["x", "y"], base);
    const two = insert(["y", "y"], one);
    const reader = new SpeakerLineageReader({ capacity: 2 });
    const compare = (from: string, to: string) => h.repository.withTransaction((scope) => reader.compare(scope, LOCAL.userId, contentId, from, to));
    const first = compare(base.revision.id, two.revision.id);
    expect(compare(base.revision.id, two.revision.id)).toBe(first);
    compare(one.revision.id, two.revision.id);
    compare(base.revision.id, two.revision.id);
    compare(base.revision.id, one.revision.id);
    // The pair (one, two) was used least recently and is computed again; (base, two) is still kept.
    expect(compare(base.revision.id, two.revision.id)).toBe(first);
    const again = compare(base.revision.id, one.revision.id);
    expect(compare(base.revision.id, one.revision.id)).toBe(again);
    expect(first).toMatchObject({ kind: "compared" });
  });
});

describe("currentSpeakerLabels", () => {
  it("labels as a request would now: confirmed names, else the ordinal", () => {
    const labels = currentSpeakerLabels([
      { contentId: "c", id: "x", userId: "u", ordinal: 1, name: "蒋炎岩", nameConfirmedAt: 1, colorIndex: 0, createdAt: 1, updatedAt: 1 },
      { contentId: "c", id: "y", userId: "u", ordinal: 2, name: "张三", colorIndex: 1, createdAt: 1, updatedAt: 1 },
    ]);
    expect([...labels]).toEqual([["x", "蒋炎岩"], ["y", "发言人 2"]]);
  });
});
