import type { SegmentId } from "../../shared/ids.ts";
import type { ModelRefSnapshot, PromptRef } from "./model-ref.ts";

/**
 * Invariant: evidence into a transcript is stored as
 * `transcriptRevisionId + segmentId`, never as bare seconds. In bodies it appears as the
 * canonical marker `[[seg:<segmentId>]]`; `[[s<n>]]` aliases exist only during a model call.
 */
export interface Citation {
  transcriptRevisionId: string;
  segmentId: SegmentId;
}

export type ArtifactInputRef =
  | { kind: "transcriptRevision"; id: string }
  | { kind: "summaryRevision"; id: string }
  | { kind: "chapterRevision"; id: string }
  | {
      kind: "collectionItemSnapshot";
      collectionItemId: string;
      contentId: string;
      summaryRevisionId?: string;
      transcriptRevisionId?: string;
      position: number;
    }
  | { kind: "referenceText"; id: string };

/**
 * Invariant: every derived artifact records what it was built
 * from. Freshness is derived by comparing `inputs` with current pointers; nothing is
 * ever recomputed automatically.
 */
export interface Provenance {
  inputs: ArtifactInputRef[];
  /** Absent for non-AI artifacts such as platform chapters. */
  modelRef?: ModelRefSnapshot;
  promptRef?: PromptRef;
  /**
   * Every prompt version that produced the stored result (`promptRef` keeps its own meaning);
   * absent on artifacts stored before it was recorded.
   */
  promptRefs?: PromptRef[];
  /** Effective prompt: envelope + template + parameters + terminology, not just the template text. */
  promptSnapshot?: string;
  createdAt: number;
}

/**
 * Created only after a successful commit; failures live on WorkUnit / StageRun errors.
 * Usage is not attached here: TokenUsage points back via `artifactRevisionId`.
 */
export interface ArtifactRevisionBase {
  id: string;
  artifactId: string;
  provenance: Provenance;
  quality: "normal" | "degraded";
}

export interface SummaryTemplate {
  id: string;
  /** Builtin templates have no owner. */
  userId?: string;
  builtin: boolean;
  name: string;
  currentVersion: number;
  /** Custom templates are soft-deleted so every PromptRef stays resolvable. */
  deletedAt?: number;
}

/**
 * A user's own text for a customizable system prompt, one row per user and prompt. Without
 * `currentVersion` the builtin text is in effect; restoring it keeps every version.
 */
export interface PromptOverride {
  userId: string;
  promptId: string;
  currentVersion?: number;
  updatedAt: number;
}

/** Append-only (`version` ≥ 1), so a frozen `custom:<promptId>` ref stays resolvable. */
export interface PromptOverrideVersion {
  userId: string;
  promptId: string;
  version: number;
  text: string;
  createdAt: number;
}

/** Append-only so every PromptRef stays resolvable. */
export interface SummaryTemplateVersion {
  templateId: string;
  version: number;
  /** Markdown. */
  prompt: string;
  createdAt: number;
}

export interface SummaryArtifact {
  id: string;
  contentId: string;
  templateId: string;
  currentRevisionId?: string;
}

export interface SummaryRevision extends ArtifactRevisionBase {
  /** Markdown with canonical `[[seg:<segmentId>]]` markers. */
  body: string;
  /** De-duplicated index of the citations in `body`. */
  citations: Citation[];
  chapterRevisionId?: string;
  /** RollupPartial ids when a long video was summarized chapter by chapter. */
  partialIds?: string[];
}

export interface ChapterArtifact {
  id: string;
  contentId: string;
  currentRevisionId?: string;
}

export interface ChapterRevision extends ArtifactRevisionBase {
  origin: { kind: "platform" } | { kind: "ai"; transcriptRevisionId: string };
  /**
   * Platform chapters keep the platform's millisecond anchors only. AI chapters must
   * carry `startSegmentId`; their times are display projections of segment timing.
   */
  chapters: Array<{ startMs: number; endMs: number; title: string; summary?: string; startSegmentId?: SegmentId }>;
}

export interface HighlightArtifact {
  id: string;
  contentId: string;
  currentRevisionId?: string;
}

export interface HighlightRevision extends ArtifactRevisionBase {
  transcriptRevisionId: string;
  /** `score` is 0–100. */
  items: Array<{ segmentId: SegmentId; score: number; text: string }>;
}

/**
 * The one deliberate exception to the Artifact/Revision pattern: current points directly
 * at a `translated` TranscriptRevision, whose generation and parent carry provenance.
 */
export interface TranslationArtifact {
  id: string;
  contentId: string;
  targetLanguage: string;
  /** A TranscriptRevision id. */
  currentRevisionId?: string;
}

export interface CollectionSummaryArtifact {
  id: string;
  collectionId: string;
  currentRevisionId?: string;
}

export interface CollectionSummaryRevision extends ArtifactRevisionBase {
  /** Snapshot of the inputs; any change of a member's current pointers or of order makes this stale. */
  inputItems: Array<{
    collectionItemId: string;
    contentId: string;
    summaryRevisionId?: string;
    transcriptRevisionId?: string;
    position: number;
  }>;
  partialIds: string[];
  body: string;
  citations: Citation[];
}

/** Persisted intermediate of rolling summarization, visible and expandable in the UI. */
export interface RollupPartial {
  id: string;
  /** A SummaryRevision (long video) or CollectionSummaryRevision (collection). */
  ownerRevisionId: string;
  index: number;
  inputs: ArtifactInputRef[];
  body: string;
  citations: Citation[];
  modelRef: ModelRefSnapshot;
  promptRef: PromptRef;
  /** The prompt versions that produced this partial; absent on partials stored before it was recorded. */
  promptRefs?: PromptRef[];
  promptSnapshot: string;
  createdAt: number;
}
