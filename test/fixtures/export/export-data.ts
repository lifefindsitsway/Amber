import type { TranscriptRevision, TranscriptSegment, TranscriptWord } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { LOCAL, type Harness } from "../pipeline/harness.ts";
import { MODEL_SNAPSHOT } from "../pipeline/summary-data.ts";

/** Six hours plus 1.234 s: hour digits must survive every format. */
export const SIX_HOURS_MS = 6 * 3_600_000 + 1234;

export interface ExportLine {
  startMs: number;
  endMs: number;
  text: string;
  words?: TranscriptWord[];
  speakerId?: string;
}

/**
 * The ASR original of the export fixture, with real word timing: a Latin sentence with a
 * pause between its words, a Chinese one, a sentence a long pause later (a new paragraph),
 * one at 99:59, one at 100:00 and one past six hours.
 */
export const ASR_LINES: readonly ExportLine[] = [
  {
    startMs: 1000,
    endMs: 2600,
    text: "Hello world.",
    words: [
      { text: "Hello", startMs: 1000, endMs: 1400 },
      { text: "world.", startMs: 1600, endMs: 2500 },
    ],
  },
  {
    startMs: 3000,
    endMs: 4000,
    text: "你好世界",
    words: [
      { text: "你好", startMs: 3000, endMs: 3500 },
      { text: "世界", startMs: 3500, endMs: 3500 },
    ],
  },
  { startMs: 9000, endMs: 10_000, text: "第二段{\\b1}开始", words: [{ text: "第二段{\\b1}开始", startMs: 9000, endMs: 10_000 }] },
  { startMs: 5_999_000, endMs: 5_999_900, text: "九十九分", words: [{ text: "九十九分", startMs: 5_999_000, endMs: 5_999_900 }] },
  { startMs: 6_000_000, endMs: 6_000_900, text: "一百分", words: [{ text: "一百分", startMs: 6_000_000, endMs: 6_000_900 }] },
  { startMs: SIX_HOURS_MS, endMs: SIX_HOURS_MS + 1766, text: "六小时", words: [{ text: "六小时", startMs: SIX_HOURS_MS, endMs: SIX_HOURS_MS + 1766 }] },
];

export interface ExportFixture {
  contentId: string;
  asr: { revision: TranscriptRevision; segments: TranscriptSegment[] };
  corrected: { revision: TranscriptRevision; segments: TranscriptSegment[] };
  translated: { revision: TranscriptRevision; segments: TranscriptSegment[] };
  summaryRevisionId: string;
  chapterRevisionId: string;
}

function revisionWith(
  h: Harness,
  contentId: string,
  base: Omit<TranscriptRevision, "id" | "contentId" | "segmentCount" | "createdAt">,
  lines: readonly ExportLine[],
  parents: readonly TranscriptSegment[] = [],
  // Local noon: revision labels print local time, so the expected text holds in every time zone.
  createdAt = new Date(2026, 9, 1, 12).getTime(),
): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const id = h.newId();
  const revision: TranscriptRevision = { ...base, id, contentId, segmentCount: lines.length, createdAt };
  const segments: TranscriptSegment[] = lines.map((line, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId: id,
    ordinal,
    startMs: line.startMs,
    endMs: line.endMs,
    text: line.text,
    ...(base.timingFidelity === "exact_words" && line.words !== undefined ? { words: line.words } : {}),
    ...(line.speakerId === undefined ? {} : { speakerId: line.speakerId }),
    sourceSegmentIds: parents[ordinal] === undefined ? [] : [(parents[ordinal] as TranscriptSegment).id],
  }));
  return { revision, segments };
}

/**
 * A bilibili part (`?p=2`) with an ASR original as primary, a proofread child, an English
 * translation of the proofread child, a current core summary citing two sentences plus an
 * unresolved marker, and current AI chapters.
 */
export function seedExportContent(
  h: Harness,
  userId = LOCAL.userId,
  source: "bilibili" | "local" = "bilibili",
  options: { lines?: readonly ExportLine[]; speakerNames?: Readonly<Record<string, string>>; language?: string } = {},
): ExportFixture {
  const lines = options.lines ?? ASR_LINES;
  const language = options.language ?? "zh-CN";
  const contentId = h.newId();
  const asr = revisionWith(h, contentId, { kind: "asr", language, timingFidelity: "exact_words", generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe" } }, lines);
  const corrected = revisionWith(
    h,
    contentId,
    { kind: "corrected", parentRevisionId: asr.revision.id, language, timingFidelity: "inherited_segment", generation: { kind: "llm", modelRef: MODEL_SNAPSHOT, promptRef: { id: "proofread.text", version: 1 }, promptSnapshot: "<p>" } },
    lines.map(({ words: _words, ...line }) => ({ ...line, text: line.text.replace("Hello", "Hi") })),
    asr.segments,
  );
  const translated = revisionWith(
    h,
    contentId,
    { kind: "translated", parentRevisionId: corrected.revision.id, language: "en", timingFidelity: "segment_only", generation: { kind: "llm", modelRef: MODEL_SNAPSHOT, promptRef: { id: "translate.subtitles", version: 1 }, promptSnapshot: "<t>" } },
    lines.map(({ words: _words, ...line }, index) => ({ ...line, text: `EN ${index + 1}` })),
    corrected.segments,
  );
  const summaryRevisionId = h.newId();
  const chapterRevisionId = h.newId();
  h.repository.withTransaction((scope) => {
    scope.contents.insert({
      id: contentId,
      userId,
      source:
        source === "bilibili"
          ? { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1export?p=2", platformContentId: "BV1export", platformPartId: "cid-2" }
          : { kind: "local" },
      ...(source === "bilibili" ? { title: "示例课程：第一讲/导论" } : {}),
      durationMs: SIX_HOURS_MS + 2000,
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    });
    // Sentences name only speakers registered for their Content.
    const speakerIds = [...new Set(lines.flatMap((line) => (line.speakerId === undefined ? [] : [line.speakerId])))];
    scope.speakers.insert(
      userId,
      contentId,
      speakerIds.map((id) => ({ id, ...(options.speakerNames?.[id] === undefined ? {} : { name: options.speakerNames[id] }) })),
      1,
    );
    for (const { revision, segments } of [asr, corrected, translated]) {
      scope.transcripts.insertRevision(userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(userId, contentId, corrected.revision.id, 2);
    const cited = corrected.segments;
    const { artifactId } = scope.summaries.insertRevision(userId, {
      contentId,
      templateId: "summary.core",
      artifactId: h.newId(),
      revision: {
        id: summaryRevisionId,
        provenance: { inputs: [{ kind: "transcriptRevision", id: corrected.revision.id }], modelRef: MODEL_SNAPSHOT, promptRef: { id: "summary.core", version: 1 }, promptSnapshot: "<s>", createdAt: 10 },
        quality: "normal",
        body: `## 摘要\n开场 [[seg:${cited[0]?.id}]]，结尾 [[seg:${cited[5]?.id}]]，另有 [[unresolved:s99]]。\n`,
        citations: [cited[0], cited[5]].map((segment) => ({ transcriptRevisionId: corrected.revision.id, segmentId: (segment as TranscriptSegment).id })),
      },
    });
    scope.summaries.setCurrent(userId, artifactId, summaryRevisionId);
    scope.chapters.insertAiRevision(userId, contentId, {
      id: chapterRevisionId,
      artifactId: h.newId(),
      transcriptRevisionId: corrected.revision.id,
      chapters: [
        { startMs: 1000, endMs: 5_999_000, title: "开场", summary: "问候与介绍", startSegmentId: cited[0]?.id as SegmentId },
        { startMs: 5_999_000, endMs: SIX_HOURS_MS + 1766, title: "收尾", startSegmentId: cited[3]?.id as SegmentId },
      ],
      modelRef: MODEL_SNAPSHOT,
      promptRef: { id: "chapter.ai", version: 1 },
      promptSnapshot: "<c>",
      quality: "normal",
      createdAt: 11,
    });
    scope.chapters.setCurrent(userId, contentId, chapterRevisionId);
  });
  return { contentId, asr, corrected, translated, summaryRevisionId, chapterRevisionId };
}

/** Gives a local Content its file's display name, the way local-file import registers it. */
export function addLocalFile(h: Harness, contentId: string, displayName: string, userId = LOCAL.userId): void {
  h.repository.withTransaction((scope) =>
    scope.mediaAssets.insert({
      id: h.newId(),
      userId,
      contentId,
      kind: "external_local",
      storageRef: `/media/${displayName}`,
      displayName,
      mimeType: "video/mp4",
      sizeBytes: 10,
      availability: "available",
      retentionPolicy: "keep",
      createdAt: 1,
    }),
  );
}

/** A collection of the two Contents (in that order) with a current collection summary citing the first one. */
export function seedExportCollection(h: Harness, first: ExportFixture, second: ExportFixture, userId = LOCAL.userId): string {
  const collectionId = h.newId();
  h.repository.withTransaction((scope) => {
    scope.collections.insert({ id: collectionId, userId, name: "示例合集", createdAt: 1, updatedAt: 1 });
    [first, second].forEach((fixture, position) =>
      scope.collections.addItem(userId, { id: h.newId(), collectionId, contentId: fixture.contentId, position, addedAt: 1 }),
    );
    const revisionId = h.newId();
    scope.collectionSummaries.insertRevision(userId, {
      collectionId,
      artifactId: h.newId(),
      revision: {
        id: revisionId,
        provenance: { inputs: [], modelRef: MODEL_SNAPSHOT, promptRef: { id: "rollup.final.collection", version: 1 }, promptSnapshot: "<f>", createdAt: 20 },
        quality: "normal",
        inputItems: [],
        partialIds: [],
        body: `## 这门课在讲什么\n总起 [[seg:${first.corrected.segments[0]?.id}]]`,
        citations: [],
      },
    });
    scope.collectionSummaries.setCurrent(userId, collectionId, revisionId);
  });
  return collectionId;
}
