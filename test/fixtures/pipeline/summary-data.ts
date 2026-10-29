import type { ArtifactInputRef, Citation } from "../../../src/server/domain/artifact.ts";
import type { CollectionSummaryRevision } from "../../../src/server/domain/artifact.ts";
import { lectureTranscripts, type TranscriptFixture } from "../transcripts/lecture.ts";
import { LOCAL, type Harness } from "./harness.ts";

/**
 * Direct writes of summaries and collection summaries for service and route tests: what
 * a finished summary stage would have published, without running one.
 */

export const MODEL_SNAPSHOT = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" };

/** The lecture transcripts on `contentId`, with the ASR original as primary. */
export function seedTranscripts(h: Harness, contentId: string, userId = LOCAL.userId): TranscriptFixture {
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(userId, contentId, fixture.asr.revision.id, 2);
  });
  return fixture;
}

/** A summary revision built from `transcriptRevisionId` (and chapters, when given), made current. */
export function insertSummary(
  h: Harness,
  input: {
    contentId: string;
    templateId?: string;
    transcriptRevisionId: string;
    chapterRevisionId?: string;
    citations?: Citation[];
    /** The stored body; by default one line per citation. */
    body?: string;
    quality?: "normal" | "degraded";
    createdAt?: number;
    userId?: string;
  },
): { artifactId: string; revisionId: string } {
  const userId = input.userId ?? LOCAL.userId;
  const revisionId = h.newId();
  const { artifactId } = h.repository.withTransaction((scope) => {
    const inserted = scope.summaries.insertRevision(userId, {
      contentId: input.contentId,
      templateId: input.templateId ?? "summary.core",
      artifactId: h.newId(),
      revision: {
        id: revisionId,
        provenance: {
          inputs: [
            { kind: "transcriptRevision", id: input.transcriptRevisionId },
            ...(input.chapterRevisionId === undefined ? [] : [{ kind: "chapterRevision" as const, id: input.chapterRevisionId }]),
          ],
          modelRef: MODEL_SNAPSHOT,
          promptRef: { id: input.templateId ?? "summary.core", version: 1 },
          promptSnapshot: "<summary prompt>",
          createdAt: input.createdAt ?? 10,
        },
        quality: input.quality ?? "normal",
        body: input.body ?? ((input.citations ?? []).map((citation) => `要点 [[seg:${citation.segmentId}]]`).join("\n") || "摘要"),
        citations: input.citations ?? [],
      },
    });
    scope.summaries.setCurrent(userId, inserted.artifactId, revisionId);
    return inserted;
  });
  return { artifactId, revisionId };
}

/** A current collection summary over `inputItems`, with one partial; `stored` overrides what the two hold. */
export function insertCollectionSummary(
  h: Harness,
  collectionId: string,
  inputItems: CollectionSummaryRevision["inputItems"],
  userId = LOCAL.userId,
  stored: { body?: string; citations?: Citation[]; partialBody?: string; partialCitations?: Citation[]; partialInputs?: ArtifactInputRef[] } = {},
): { artifactId: string; revisionId: string; partialId: string } {
  const revisionId = h.newId();
  const partialId = h.newId();
  const { artifactId } = h.repository.withTransaction((scope) => {
    const inserted = scope.collectionSummaries.insertRevision(userId, {
      collectionId,
      artifactId: h.newId(),
      revision: {
        id: revisionId,
        provenance: {
          inputs: inputItems.map((item) => ({ kind: "collectionItemSnapshot" as const, ...item })),
          modelRef: MODEL_SNAPSHOT,
          promptRef: { id: "rollup.final.collection", version: 1 },
          promptSnapshot: "<collection prompt>",
          createdAt: 20,
        },
        quality: "normal",
        inputItems,
        partialIds: [partialId],
        body: stored.body ?? "## 这门课在讲什么",
        citations: stored.citations ?? [],
      },
    });
    scope.rollupPartials.insertMany(userId, "collection_summary", [
      {
        id: partialId,
        ownerRevisionId: revisionId,
        index: 0,
        inputs: stored.partialInputs ?? [],
        body: stored.partialBody ?? "第一组归纳",
        citations: stored.partialCitations ?? [],
        modelRef: MODEL_SNAPSHOT,
        promptRef: { id: "rollup.partial", version: 1 },
        promptSnapshot: "<partial prompt>",
        createdAt: 20,
      },
    ]);
    scope.collectionSummaries.setCurrent(userId, collectionId, revisionId);
    return inserted;
  });
  return { artifactId, revisionId, partialId };
}
