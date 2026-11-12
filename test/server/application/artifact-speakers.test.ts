import { afterEach, describe, expect, it } from "vitest";
import type { Citation } from "../../../src/server/domain/artifact.ts";
import { BUILTIN_SUMMARY_TEMPLATES } from "../../../src/server/domain/prompts.ts";
import { attributionDigest, speakerLabels, type SpeakerContextSnapshot } from "../../../src/server/domain/speaker-context.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const CORE = BUILTIN_SUMMARY_TEMPLATES[0] as (typeof BUILTIN_SUMMARY_TEMPLATES)[number];
const MODEL = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };

interface Rev {
  revision: TranscriptRevision;
  segments: TranscriptSegment[];
}

/**
 * A Content with speakers x (named and confirmed) and y, a reviewed root revision of six
 * sentences, and helpers to derive revisions from it the way edits do (each new sentence
 * names its sources) and to store results generated from it with speakers.
 */
function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  h.repository.withTransaction((scope) => {
    scope.summaryTemplates.syncBuiltin(
      BUILTIN_SUMMARY_TEMPLATES.map((template) => ({ id: template.id, name: template.nameKey, versions: [{ version: template.version, prompt: template.prompt }] })),
      1,
    );
    scope.speakers.insert(LOCAL.userId, contentId, [{ id: "x", name: "蒋炎岩", nameConfirmedAt: 1 }, { id: "y" }], 1);
  });
  /** `sources[i]`: the parent positions sentence i comes from (none = a new sentence). */
  const insert = (speakers: Array<string | undefined>, parent?: Rev, sources?: number[][]): Rev => {
    const id = h.newId();
    const revision: TranscriptRevision = {
      id,
      contentId,
      kind: parent === undefined ? "asr" : "manual",
      ...(parent === undefined ? {} : { parentRevisionId: parent.revision.id }),
      language: "zh-CN",
      timingFidelity: parent === undefined ? "exact_words" : "inherited_segment",
      generation: parent === undefined ? { kind: "asr", asrProfileId: "a", modelId: "m" } : { kind: "manual" },
      segmentCount: speakers.length,
      createdAt: 1,
    };
    const segments: TranscriptSegment[] = speakers.map((speakerId, ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text: `句${ordinal}`,
      ...(speakerId === undefined ? {} : { speakerId }),
      sourceSegmentIds:
        parent === undefined ? [] : (sources?.[ordinal] ?? [ordinal]).map((position) => parent.segments[position]?.id as SegmentId),
    }));
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
      scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, id, 2);
    });
    return { revision, segments };
  };
  const confirm = (revisionId: string) => h.repository.withTransaction((scope) => scope.speakerConfirmations.set(LOCAL.userId, contentId, revisionId, 3));
  const snapshotOf = (rev: Rev): SpeakerContextSnapshot =>
    h.repository.withTransaction((scope) => ({
      version: 1,
      rules: { id: "speaker.rules", version: 1 },
      attributionDigest: attributionDigest(rev.segments),
      speakers: speakerLabels(scope.speakers.list(LOCAL.userId, contentId)),
    }));
  const base = insert(["x", "y", "x", "y", "x", "y"]);
  confirm(base.revision.id);
  return { h, contentId, insert, confirm, snapshotOf, base };
}

type Setup = ReturnType<typeof setup>;

/** A current summary of `rev` citing `cited` (positions), and optionally rolling partials citing `partialCited`. */
function storeSummary(s: Setup, rev: Rev, options: { cited: number[]; partialCited?: number[]; speakers?: boolean }): string {
  const citation = (position: number): Citation => ({ transcriptRevisionId: rev.revision.id, segmentId: rev.segments[position]?.id as SegmentId });
  const revisionId = s.h.newId();
  const partialIds = options.partialCited === undefined ? undefined : [s.h.newId()];
  s.h.repository.withTransaction((scope) => {
    const { artifactId } = scope.summaries.insertRevision(LOCAL.userId, {
      contentId: s.contentId,
      templateId: CORE.id,
      artifactId: scope.summaries.findArtifact(LOCAL.userId, s.contentId, CORE.id)?.id ?? s.h.newId(),
      revision: {
        id: revisionId,
        provenance: {
          inputs: [{ kind: "transcriptRevision", id: rev.revision.id }],
          promptRef: { id: CORE.id, version: CORE.version },
          ...(options.speakers === false ? {} : { speakerContext: s.snapshotOf(rev) }),
          createdAt: 1,
        },
        quality: "normal",
        body: options.cited.map((position) => `要点 [[seg:${rev.segments[position]?.id}]]`).join("\n"),
        citations: options.cited.map(citation),
        ...(partialIds === undefined ? {} : { partialIds }),
      },
    });
    if (partialIds !== undefined) {
      scope.rollupPartials.insertMany(LOCAL.userId, "summary", [
        {
          id: partialIds[0] as string,
          ownerRevisionId: revisionId,
          index: 0,
          inputs: [{ kind: "transcriptRevision", id: rev.revision.id }],
          body: "分组",
          citations: (options.partialCited ?? []).map(citation),
          modelRef: MODEL,
          promptRef: { id: "rollup.partial", version: 3 },
          promptSnapshot: "p",
          createdAt: 1,
        },
      ]);
    }
    scope.summaries.setCurrent(LOCAL.userId, artifactId, revisionId);
  });
  return revisionId;
}

const summaryContext = (s: Setup) => s.h.summaries.list(LOCAL, s.contentId).templates.find((entry) => entry.template.id === CORE.id)?.current?.speakerContext;

describe("summary speaker context", () => {
  it("is consistent while nothing changed, and absent on a summary generated without speakers", () => {
    const s = setup();
    storeSummary(s, s.base, { cited: [0] });
    expect(summaryContext(s)).toEqual({
      state: "consistent",
      speakers: [
        { id: "x", label: "蒋炎岩" },
        { id: "y", label: "发言人 2" },
      ],
    });
    storeSummary(s, s.base, { cited: [0], speakers: false });
    expect(summaryContext(s)).toBeUndefined();
  });

  it("reports sentences that changed hands, with how many", () => {
    const s = setup();
    storeSummary(s, s.base, { cited: [0] });
    const edited = s.insert(["x", "x", "x", "x", "x", "y"], s.base);
    s.confirm(edited.revision.id);
    expect(summaryContext(s)).toMatchObject({ state: "attribution_changed", changedSentences: 2 });
  });

  it("reports a deleted sentence only when the summary or one of its partials cites it", () => {
    const s = setup();
    const kept = [0, 1, 2, 3, 4];
    storeSummary(s, s.base, { cited: [0] });
    const dropLast = s.insert(["x", "y", "x", "y", "x"], s.base, kept.map((position) => [position]));
    s.confirm(dropLast.revision.id);
    // The last sentence was not cited: deleting it (say, a filler word) changes nothing.
    expect(summaryContext(s)?.state).toBe("consistent");

    storeSummary(s, s.base, { cited: [0], partialCited: [5] });
    expect(summaryContext(s)).toMatchObject({ state: "evidence_removed", removedCitations: 1 });
    storeSummary(s, s.base, { cited: [5] });
    expect(summaryContext(s)).toMatchObject({ state: "evidence_removed", removedCitations: 1 });
  });

  it("is unknown when a sentence names a speaker but descends from nothing", () => {
    const s = setup();
    storeSummary(s, s.base, { cited: [0] });
    const added = s.insert(["x", "y", "x", "y", "x", "y", "x"], s.base, [[0], [1], [2], [3], [4], [5], []]);
    s.confirm(added.revision.id);
    expect(summaryContext(s)).toEqual({ state: "unknown", speakers: expect.any(Array) });
  });

  it("reports names as they would be sent now, then a primary that is not reviewed", () => {
    const s = setup();
    storeSummary(s, s.base, { cited: [0] });
    s.h.repository.withTransaction((scope) => scope.speakers.update(LOCAL.userId, s.contentId, "x", { name: "张三", nameConfirmedAt: 5 }, 5));
    expect(summaryContext(s)).toMatchObject({ state: "names_changed", renamed: [{ id: "x", was: "蒋炎岩", now: "张三" }] });
    s.h.repository.withTransaction((scope) => scope.speakers.update(LOCAL.userId, s.contentId, "x", { name: "蒋炎岩", nameConfirmedAt: 6 }, 6));
    const copy = s.insert(["x", "y", "x", "y", "x", "y"], s.base);
    expect(summaryContext(s)?.state).toBe("unconfirmed");
    s.confirm(copy.revision.id);
    expect(summaryContext(s)?.state).toBe("consistent");
  });

  it("derives the state on each read and stores none: the same rows read differently once sentences change hands", () => {
    const s = setup();
    const revisionId = storeSummary(s, s.base, { cited: [0], partialCited: [1] });
    const rows = () => ({
      summary: s.h.db.prepare("SELECT * FROM summary_revision WHERE id = ?").get(revisionId),
      partials: s.h.db.prepare("SELECT * FROM rollup_partial WHERE summary_revision_id = ? ORDER BY partial_index").all(revisionId),
    });
    const stored = rows();
    const recorded = JSON.parse((stored.summary as { speaker_context_json: string }).speaker_context_json) as Record<string, unknown>;
    // What is kept is the snapshot the summary was made with; the state is nowhere in it.
    expect(recorded).toEqual(s.snapshotOf(s.base));
    expect(recorded).not.toHaveProperty("state");
    const before = summaryContext(s);
    expect(before?.state).toBe("consistent");

    const edited = s.insert(["x", "x", "x", "y", "x", "y"], s.base);
    s.confirm(edited.revision.id);
    const after = summaryContext(s);
    expect(after).toMatchObject({ state: "attribution_changed", changedSentences: 1 });
    expect(after).not.toEqual(before);
    expect(rows()).toEqual(stored);

    // Moving back to the original transcript reads the very same rows as consistent again.
    s.h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, s.contentId, s.base.revision.id, 4));
    expect(summaryContext(s)).toEqual(before);
    expect(rows()).toEqual(stored);
  });

  it("gives no state once the summary's transcript is out of the primary's lineage, and never touches the summary", () => {
    const s = setup();
    const revisionId = storeSummary(s, s.base, { cited: [0] });
    const other = s.insert(["y", "x"]);
    s.confirm(other.revision.id);
    const current = s.h.summaries.list(LOCAL, s.contentId).templates.find((entry) => entry.template.id === CORE.id)?.current;
    expect(current?.stale).toBe(true);
    expect(current?.speakerContext).toBeUndefined();
    // Every revision listed for the artifact gets the same treatment; nothing was regenerated or removed.
    const artifactId = current?.artifactId as string;
    expect(s.h.summaries.revisions(LOCAL, artifactId).items.map((item) => [item.id, item.speakerContext])).toEqual([[revisionId, undefined]]);
    expect(s.h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, s.contentId))).toEqual([]);
  });
});

describe("chapter and highlight speaker context", () => {
  function storeChapters(s: Setup, rev: Rev, starts: number[]): void {
    const id = s.h.newId();
    s.h.repository.withTransaction((scope) => {
      scope.chapters.insertAiRevision(LOCAL.userId, s.contentId, {
        id,
        artifactId: scope.chapters.getArtifact(LOCAL.userId, s.contentId)?.id ?? s.h.newId(),
        transcriptRevisionId: rev.revision.id,
        chapters: starts.map((position) => ({
          startMs: position * 1000,
          endMs: position * 1000 + 900,
          title: `章${position}`,
          startSegmentId: rev.segments[position]?.id as SegmentId,
        })),
        modelRef: MODEL,
        promptRef: { id: "chapter.ai", version: 2 },
        promptSnapshot: "c",
        speakerContext: s.snapshotOf(rev),
        quality: "normal",
        createdAt: 1,
      });
      scope.chapters.setCurrent(LOCAL.userId, s.contentId, id);
    });
  }

  function storeHighlights(s: Setup, rev: Rev, positions: number[]): void {
    const id = s.h.newId();
    s.h.repository.withTransaction((scope) => {
      scope.highlights.insertRevision(LOCAL.userId, s.contentId, {
        id,
        artifactId: scope.highlights.getArtifact(LOCAL.userId, s.contentId)?.id ?? s.h.newId(),
        transcriptRevisionId: rev.revision.id,
        items: positions.map((position) => ({ segmentId: rev.segments[position]?.id as SegmentId, score: 80, text: "重要" })),
        modelRef: MODEL,
        promptRef: { id: "highlight.default", version: 1 },
        promptSnapshot: "h",
        speakerContext: s.snapshotOf(rev),
        quality: "normal",
        createdAt: 1,
      });
      scope.highlights.setCurrent(LOCAL.userId, s.contentId, id);
    });
  }

  it("a chapter cites the sentence it starts at", () => {
    const s = setup();
    storeChapters(s, s.base, [0, 5]);
    expect(s.h.chapters.get(LOCAL, s.contentId).current?.speakerContext?.state).toBe("consistent");
    const dropLast = s.insert(["x", "y", "x", "y", "x"], s.base, [[0], [1], [2], [3], [4]]);
    s.confirm(dropLast.revision.id);
    const chapters = s.h.chapters.get(LOCAL, s.contentId);
    expect(chapters.current?.speakerContext).toMatchObject({ state: "evidence_removed", removedCitations: 1 });
    expect(chapters.revisions.map((revision) => revision.speakerContext?.state)).toEqual(["evidence_removed"]);
  });

  it("platform chapters have no speaker context", () => {
    const s = setup();
    s.h.repository.withTransaction((scope) => {
      const { revisionId } = scope.chapters.insertPlatformRevision(LOCAL.userId, s.contentId, {
        id: s.h.newId(),
        artifactId: s.h.newId(),
        chapters: [{ startMs: 0, endMs: 1000, title: "平台章节" }],
        createdAt: 1,
      });
      scope.chapters.setCurrent(LOCAL.userId, s.contentId, revisionId);
    });
    expect(s.h.chapters.get(LOCAL, s.contentId).current?.speakerContext).toBeUndefined();
  });

  it("each highlight carries its sentence's speaker, and cites that sentence", () => {
    const s = setup();
    storeHighlights(s, s.base, [1, 4]);
    const shown = s.h.highlights.get(LOCAL, s.contentId).current;
    expect(shown?.items.map((item) => item.speakerId)).toEqual(["y", "x"]);
    expect(shown?.speakerContext?.state).toBe("consistent");
    const reassigned = s.insert(["x", "x", "x", "y", "x", "y"], s.base);
    s.confirm(reassigned.revision.id);
    expect(s.h.highlights.get(LOCAL, s.contentId).current?.speakerContext).toMatchObject({ state: "attribution_changed", changedSentences: 1 });
  });
});
