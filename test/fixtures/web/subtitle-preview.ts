import type { SubtitleInspectResponse } from "../../../src/shared/dto/subtitle-import.ts";

/** A preview digest; any 64 lowercase hex characters. */
export const DIGEST = "a".repeat(64);

type Preview = SubtitleInspectResponse;
type Target = NonNullable<Preview["target"]>;

/** A plain SRT preview without speakers or translations; `overrides` replace whole fields. */
export function srtPreview(overrides: Partial<Preview> = {}): Preview {
  return {
    format: "srt",
    digest: DIGEST,
    cueCount: 10,
    droppedCues: { count: 0, samples: [] },
    rangeMs: { start: 0, end: 62_000 },
    speakers: { source: "none", candidates: [], sequence: [] },
    limits: [],
    ...overrides,
  };
}

/**
 * An SRT whose leading names were found: 张三 (4 cues, preselected), 李四 (3, preselected) and
 * 注意 (1, not). In file order: 张三 ×2, unlabelled ×2, 李四 ×3, 注意, 张三 ×2.
 */
export function prefixPreview(overrides: Partial<Preview> = {}): Preview {
  return srtPreview({
    speakers: {
      source: "prefix",
      candidates: [
        { key: "张三", label: "张三", count: 4, preselected: true },
        { key: "李四", label: "李四", count: 3, preselected: true },
        { key: "注意", label: "注意", count: 1, preselected: false },
      ],
      sequence: [
        [0, 2],
        [-1, 2],
        [1, 3],
        [2, 1],
        [0, 2],
      ],
    },
    limits: ["speaker_identity", "unlabeled_inferred"],
    ...overrides,
  });
}

/** An Amber subtitle package with two speakers and an English translation. */
export function packagePreview(overrides: Partial<Preview> = {}): Preview {
  return {
    format: "ambersub",
    digest: DIGEST,
    cueCount: 2888,
    droppedCues: { count: 0, samples: [] },
    rangeMs: { start: 0, end: 3_723_000 },
    speakers: {
      source: "package",
      candidates: [
        { key: "s1", label: "张三", count: 2000, preselected: true },
        { key: "s2", label: "发言人 2", count: 888, preselected: true },
      ],
      sequence: [
        [0, 2000],
        [1, 888],
      ],
    },
    bilingual: { source: "package", count: 2888, samples: [{ original: "你好", translation: "Hello" }], languages: ["en"] },
    package: {
      formatVersion: 1,
      generator: { app: "Amber", version: "0.7.0" },
      language: "zh-CN",
      segmentCount: 2888,
      speakerCount: 2,
      translationLanguages: ["en"],
    },
    limits: ["package_scope"],
    ...overrides,
  };
}

/** The state of an existing Content a preview names with `contentId`. */
export function target(overrides: Partial<Target> = {}): Target {
  return {
    primaryRevisionId: "r1",
    speakers: [],
    speakerRoom: 126,
    currentTranslations: {},
    coverageWarning: false,
    ...overrides,
  };
}
