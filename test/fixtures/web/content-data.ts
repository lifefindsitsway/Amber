import type { ContentDetailDto, TranscriptRevisionListItemDto } from "../../../src/shared/dto/content.ts";
import type { HighlightsDto } from "../../../src/shared/dto/highlight.ts";
import type { TranscriptSegmentDto } from "../../../src/shared/dto/transcript.ts";
import type { TranslationsDto } from "../../../src/shared/dto/translation.ts";

/** Detail-page fixtures: one Content, its revisions and sentences, in DTO shape. */
export function contentDetail(overrides: Partial<ContentDetailDto> = {}): ContentDetailDto {
  return {
    id: "c1",
    source: { kind: "bilibili", platformContentId: "BV1xx411c7mD", platformPartId: "123", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=2" },
    title: "第一讲",
    durationMs: 600_000,
    primaryTranscriptRevisionId: "r1",
    processingStatus: "succeeded",
    collections: [{ id: "col1", name: "课程", itemId: "ci1" }],
    createdAt: 1,
    updatedAt: 1,
    media: [],
    ...overrides,
  };
}

/** A revision as the revision list returns it; the segment page's revision schema drops the list-only fields. */
export function revision(id: string, overrides: Partial<TranscriptRevisionListItemDto> = {}): TranscriptRevisionListItemDto {
  return {
    id,
    contentId: "c1",
    kind: "platform",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: {},
    segmentCount: 3,
    createdAt: 1,
    archived: false,
    deletable: false,
    blockers: { children: 0, draft: 0, notes: 0, highlights: 0, chatMessages: 0, artifacts: 0, activeTasks: 0, history: 0 },
    historyArtifacts: [],
    descendantIds: [],
    ...overrides,
  };
}

export function segment(id: string, ordinal: number, startMs: number, endMs: number, text: string, overrides: Partial<TranscriptSegmentDto> = {}): TranscriptSegmentDto {
  return { id, revisionId: "r1", ordinal, startMs, endMs, text, sourceSegmentIds: [], ...overrides };
}

/** A ULID: citations are validated as segment ids. */
export const CITED_SEGMENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ3";

export const SEGMENTS: TranscriptSegmentDto[] = [
  segment("s1", 0, 0, 4_000, "今天讲检索。"),
  segment("s2", 1, 4_000, 8_000, "先看向量库。"),
  segment(CITED_SEGMENT_ID, 2, 75_000, 80_000, "再看重排序。"),
];

/** API routes for a fully generated Content: summary with one citation, chapters, one revision. */
export function contentRoutes(detail: ContentDetailDto = contentDetail()) {
  return {
    [`GET /api/contents/${detail.id}`]: { body: detail },
    [`GET /api/contents/${detail.id}/transcript/revisions`]: { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1")] } },
    "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
    [`GET /api/contents/${detail.id}/chapters`]: {
      body: {
        revisions: [],
        current: {
          id: "ch1",
          artifactId: "a-ch",
          origin: { kind: "platform" },
          chapters: [{ startMs: 0, endMs: 60_000, title: "开场" }, { startMs: 60_000, endMs: 600_000, title: "正文" }],
          quality: "normal",
          qualityReasons: [],
          stale: false,
          createdAt: 1,
        },
      },
    },
    [`GET /api/contents/${detail.id}/summaries`]: {
      body: {
        templates: [
          {
            template: { id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false },
            artifactId: "a1",
            current: {
              id: "sr1",
              artifactId: "a1",
              body: `## 摘要\n讲了重排序 [[seg:${CITED_SEGMENT_ID}]]。`,
              citations: [{ transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID }],
              transcriptRevisionId: "r1",
              quality: "normal",
              qualityReasons: [],
              stale: false,
              createdAt: 1,
            },
            stale: false,
          },
          { template: { id: "summary.detailed", builtin: true, name: "summaryTemplate.detailed", currentVersion: 1, deleted: false }, stale: false },
        ],
      },
    },
    [`GET /api/contents/${detail.id}/highlights`]: { body: {} satisfies HighlightsDto },
    [`GET /api/contents/${detail.id}/translations`]: { body: { translations: [], activeTasks: [] } satisfies TranslationsDto },
    [`GET /api/contents/${detail.id}/notes`]: { body: { items: [] } },
    "GET /api/notes/groups": { body: { items: [], total: 0 } },
    "GET /api/tasks": { body: { items: [], eventSeq: 0 } },
    "GET /api/tasks/events": { body: undefined },
    "GET /api/providers": { body: { items: [] } },
    "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
  };
}

/** Current AI highlights over the fixture sentences: one strong, one at the default threshold, one weak. */
export function highlightsBody(overrides: Partial<NonNullable<HighlightsDto["current"]>> = {}): HighlightsDto {
  return {
    artifactId: "a-hl",
    current: {
      id: "hl1",
      artifactId: "a-hl",
      transcriptRevisionId: "r1",
      items: [
        { segmentId: "s1", score: 92, text: "开宗明义", segmentText: "今天讲检索。", startMs: 0, endMs: 4_000 },
        { segmentId: "s2", score: 40, text: "铺垫", segmentText: "先看向量库。", startMs: 4_000, endMs: 8_000 },
        { segmentId: CITED_SEGMENT_ID, score: 80, text: "关键方法", segmentText: "再看重排序。", startMs: 75_000, endMs: 80_000 },
      ],
      quality: "normal",
      qualityReasons: [],
      stale: false,
      createdAt: 1,
      ...overrides,
    },
  };
}
