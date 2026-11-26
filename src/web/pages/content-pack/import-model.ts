import type {
  ContentPackImportDecisions,
  ContentPackImportResult,
  ContentPackPreviewDto,
  PackCandidate,
  PackCollectionDecision,
  PackContentDiff,
  PackLimitedCategory,
  PackPreviewCollection,
  PackPreviewContent,
} from "../../../shared/dto/content-pack.ts";

/**
 * The import preview's decisions and what they mean, free of React so they can be tested on
 * their own. The preview answers three questions first: what is imported, what changes here,
 * what needs the user. A decision starts from what the preview suggests and never touches
 * an existing Content unless the user saw the target and kept the merge.
 */

export interface ContentDraft {
  /** `undefined` while the user still has to pick a target among several candidates. */
  action: "skip" | "import" | "merge" | undefined;
  targetContentId?: string;
  /** Picked through 「合并到其它内容」 rather than suggested by the preview. */
  manualTarget?: boolean;
  /** The title and duration of a target picked by hand, which the preview's candidates do not know. */
  targetTitle?: string;
  targetDurationMs?: number;
  /** The diff against the current target (the preview's, or one compared for a picked target). */
  diff: PackContentDiff;
  revisions: boolean;
  excludeRevisionKeys: readonly string[];
  figures: boolean;
  notes: boolean;
  mediaKeys: readonly string[];
  adoptPack: boolean;
  setPrimaryRevisionKey?: string;
  currentTranslationKeys: readonly string[];
  /** Carried speaker key → the same-named local speaker it is merged into. */
  sameSpeakers: Readonly<Record<string, string>>;
}

/** Files a decision takes by default: everything new, and files registered here whose file is missing. */
function defaultMediaKeys(diff: PackContentDiff): string[] {
  return diff.media.filter((media) => media.state === "new" || media.state === "fill").map((media) => media.key);
}

/** A draft pointing at a target (or at a new Content) with the diff that goes with it. */
export function draftFor(diff: PackContentDiff, action: ContentDraft["action"], manual?: { title: string | undefined; durationMs: number | undefined }): ContentDraft {
  return {
    action,
    ...(diff.targetContentId === undefined ? {} : { targetContentId: diff.targetContentId }),
    ...(manual === undefined
      ? {}
      : { manualTarget: true, ...(manual.title === undefined ? {} : { targetTitle: manual.title }), ...(manual.durationMs === undefined ? {} : { targetDurationMs: manual.durationMs }) }),
    diff,
    revisions: true,
    excludeRevisionKeys: [],
    figures: true,
    notes: true,
    mediaKeys: defaultMediaKeys(diff),
    adoptPack: false,
    currentTranslationKeys: [],
    sameSpeakers: {},
  };
}

/**
 * The preview's suggestion: a new Content is imported, a single live match is merged into,
 * several candidates wait for the user, a match in the trash is skipped.
 */
export function initialDraft(item: PackPreviewContent): ContentDraft {
  if (item.match === "trashed") return draftFor(item.diff, "skip");
  if (item.match === "new") return draftFor(item.diff, "import");
  return draftFor(item.diff, item.diff.targetContentId === undefined ? undefined : "merge");
}

/**
 * The candidates of the tier that decided the match: identity first (the same origin, or an
 * earlier merge), else the same media. Other tiers are not offered as targets.
 */
export function decidingCandidates(item: PackPreviewContent): PackCandidate[] {
  const same = item.candidates.filter((candidate) => candidate.reason === "origin" || candidate.reason === "mapped");
  return same.length > 0 ? same : item.candidates;
}

/** Whether a carried Content may be imported as a new one beside its match: a local file whose media alone matched. */
export function canImportAsNew(item: PackPreviewContent): boolean {
  return item.match === "same_media" && item.sourceKind === "local" && !item.candidates.some((candidate) => candidate.reason === "platform");
}

/** The categories over their limit that the draft still imports. */
export function blockingOverLimit(draft: ContentDraft): Array<{ category: PackLimitedCategory; over: number; limit: number }> {
  if (draft.action === "skip" || draft.action === undefined) return [];
  return draft.diff.overLimit.filter((entry) => (entry.category === "figures" ? draft.figures : entry.category === "notes" ? draft.notes : draft.revisions));
}

export type Conclusion =
  | { kind: "new" }
  | { kind: "merge" | "mergeMedia" | "mergeOther"; title: string | undefined }
  | { kind: "importAsNew" }
  | { kind: "choose"; count: number }
  | { kind: "shared"; title: string | undefined }
  | { kind: "trashed" }
  | { kind: "skip" };

/**
 * The one-line conclusion of a row. `shared` names the local Content this row matches
 * together with other rows (`sharedMatches`), which is why nothing was suggested.
 */
export function conclusionOf(item: PackPreviewContent, draft: ContentDraft, shared?: { title: string | undefined }): Conclusion {
  if (item.match === "trashed") return { kind: "trashed" };
  if (draft.action === "skip") return { kind: "skip" };
  if (draft.action === undefined && shared !== undefined) return { kind: "shared", title: shared.title };
  if (draft.action === undefined) return { kind: "choose", count: decidingCandidates(item).filter((candidate) => !candidate.trashed).length };
  if (draft.action === "import") return item.match === "new" ? { kind: "new" } : { kind: "importAsNew" };
  const target = draft.targetContentId;
  const title = item.candidates.find((candidate) => candidate.contentId === target)?.title;
  if (draft.manualTarget === true) return { kind: "mergeOther", title: draft.targetTitle ?? title };
  return { kind: item.match === "same_media" ? "mergeMedia" : "merge", title };
}

/** What a row's change summary counts under the current draft. */
export interface ChangeSummary {
  revisions: number;
  speakers: number;
  figures: number;
  notes: number;
  media: number;
  /** Items here that differ from the pack's (notes and figures kept, speakers' names kept). */
  differs: number;
  /** Items that cannot be imported: differing revisions, cache files of another content, rejected translations. */
  conflicts: number;
  /** Items already here. */
  existing: number;
}

export function changeSummary(draft: ContentDraft): ChangeSummary {
  const { diff } = draft;
  const excluded = new Set(draft.excludeRevisionKeys);
  const revisionsOn = draft.revisions;
  const newRevisions = revisionsOn ? diff.revisions.filter((revision) => revision.state === "new" && revision.rejected === undefined && !excluded.has(revision.key)).length : 0;
  const media = new Set(draft.mediaKeys);
  return {
    revisions: newRevisions,
    speakers: revisionsOn ? diff.speakers.filter((speaker) => speaker.state === "new" && draft.sameSpeakers[speaker.key] === undefined).length : 0,
    figures: draft.figures ? diff.figures.new : 0,
    notes: draft.notes ? diff.notes.new : 0,
    media: diff.media.filter((item) => (item.state === "new" || item.state === "fill") && media.has(item.key)).length,
    differs:
      (draft.figures ? diff.figures.differs : 0) +
      (draft.notes ? diff.notes.differs : 0) +
      (revisionsOn ? diff.speakers.filter((speaker) => speaker.state === "differs").length : 0),
    conflicts:
      (revisionsOn ? diff.revisions.filter((revision) => revision.state === "differs" || revision.rejected !== undefined).length : 0) +
      diff.media.filter((item) => item.state === "conflict").length,
    existing:
      diff.revisions.filter((revision) => revision.state === "existing").length +
      diff.figures.existing +
      diff.notes.existing +
      diff.media.filter((item) => item.state === "existing").length,
  };
}

/**
 * Whether a row shows its details without being asked: something needs the user (several
 * candidates, a limit, a same-named speaker) or something will not be imported as is
 * (a conflict, a differing note or figure, a rejected translation).
 */
export function needsAttention(item: PackPreviewContent, draft: ContentDraft): boolean {
  if (item.match === "trashed" || draft.action === "skip") return false;
  if (draft.action === undefined) return true;
  if (blockingOverLimit(draft).length > 0) return true;
  const summary = changeSummary(draft);
  if (summary.conflicts > 0 || summary.differs > 0) return true;
  return draft.revisions && draft.diff.speakers.some((speaker) => speaker.state === "new" && speaker.sameNameCandidates.length > 0);
}

export interface CollectionDraft {
  action: PackCollectionDecision["action"];
  targetCollectionId?: string;
}

/** A matched collection is joined; a same-named one is offered but a new one is the default; else a new one. */
export function initialCollectionDraft(collection: PackPreviewCollection): CollectionDraft {
  const target = collection.candidates[0];
  if (collection.match === "same" && target !== undefined) return { action: "join", targetCollectionId: target.collectionId };
  return { action: "create" };
}

/** Whether any of a collection's Contents is imported or merged; a collection of skipped Contents is left alone. */
export function collectionUsable(collection: PackPreviewCollection, preview: ContentPackPreviewDto, drafts: ReadonlyMap<string, ContentDraft>): boolean {
  return collection.contentKeys.some((key) => {
    const item = preview.contents.find((entry) => entry.key === key);
    const action = drafts.get(key)?.action ?? (item === undefined ? undefined : initialDraft(item).action);
    return action === "import" || action === "merge";
  });
}

/**
 * Rows that match the same local Content with no target suggested: when several carried
 * Contents would land on one local Content the server suggests it to none of them, so each
 * row asks the user. Maps a row to the other rows sharing its match, with that Content.
 */
export function sharedMatches(preview: ContentPackPreviewDto): Map<string, { contentId: string; title: string | undefined; otherKeys: string[] }> {
  const byTarget = new Map<string, { title: string | undefined; keys: string[] }>();
  for (const item of preview.contents) {
    if (item.match !== "same" && item.match !== "same_media") continue;
    if (item.diff.targetContentId !== undefined) continue;
    for (const candidate of decidingCandidates(item)) {
      if (candidate.trashed) continue;
      const entry = byTarget.get(candidate.contentId) ?? { title: candidate.title, keys: [] };
      if (!entry.keys.includes(item.key)) entry.keys.push(item.key);
      byTarget.set(candidate.contentId, entry);
    }
  }
  const shared = new Map<string, { contentId: string; title: string | undefined; otherKeys: string[] }>();
  for (const [contentId, { title, keys }] of byTarget) {
    if (keys.length < 2) continue;
    for (const key of keys) if (!shared.has(key)) shared.set(key, { contentId, title, otherKeys: keys.filter((other) => other !== key) });
  }
  return shared;
}

/**
 * Rows merging into a local Content another row also merges into. A local Content takes at
 * most one carried Content per import (the server refuses the commit otherwise), so every
 * such row is flagged as soon as the second one is chosen. Maps a row to the other rows.
 */
export function clashingTargets(preview: ContentPackPreviewDto, drafts: ReadonlyMap<string, ContentDraft>): Map<string, { contentId: string; otherKeys: string[] }> {
  const byTarget = new Map<string, string[]>();
  for (const item of preview.contents) {
    const draft = drafts.get(item.key) ?? initialDraft(item);
    if (draft.action !== "merge" || draft.targetContentId === undefined) continue;
    byTarget.set(draft.targetContentId, [...(byTarget.get(draft.targetContentId) ?? []), item.key]);
  }
  const clashes = new Map<string, { contentId: string; otherKeys: string[] }>();
  for (const [contentId, keys] of byTarget) {
    if (keys.length < 2) continue;
    for (const key of keys) clashes.set(key, { contentId, otherKeys: keys.filter((other) => other !== key) });
  }
  return clashes;
}

export interface BlockingProblems {
  /** Rows still waiting for a target. */
  choose: number;
  /** Rows importing a category over its limit. */
  overLimit: number;
  /** Rows merging into a local Content another row merges into too. */
  sameTarget: number;
  /** Every row is skipped. */
  nothing: boolean;
}

export function blockingProblems(preview: ContentPackPreviewDto, drafts: ReadonlyMap<string, ContentDraft>): BlockingProblems {
  let choose = 0;
  let overLimit = 0;
  let acting = 0;
  for (const item of preview.contents) {
    const draft = drafts.get(item.key) ?? initialDraft(item);
    if (draft.action === undefined) choose += 1;
    else if (draft.action !== "skip") {
      acting += 1;
      if (blockingOverLimit(draft).length > 0) overLimit += 1;
    }
  }
  return { choose, overLimit, sameTarget: clashingTargets(preview, drafts).size, nothing: choose === 0 && acting === 0 };
}

export function canStart(problems: BlockingProblems): boolean {
  return problems.choose === 0 && problems.overLimit === 0 && problems.sameTarget === 0 && !problems.nothing;
}

export interface Totals {
  create: number;
  merge: number;
  skip: number;
  mediaBytes: number;
}

export function totals(preview: ContentPackPreviewDto, drafts: ReadonlyMap<string, ContentDraft>): Totals {
  const result: Totals = { create: 0, merge: 0, skip: 0, mediaBytes: 0 };
  for (const item of preview.contents) {
    const draft = drafts.get(item.key) ?? initialDraft(item);
    if (draft.action === "import") result.create += 1;
    else if (draft.action === "merge") result.merge += 1;
    else if (draft.action === "skip") result.skip += 1;
    if (draft.action === "import" || draft.action === "merge") {
      const keys = new Set(draft.mediaKeys);
      result.mediaBytes += draft.diff.media.filter((media) => keys.has(media.key)).reduce((sum, media) => sum + media.sizeBytes, 0);
    }
  }
  return result;
}

/**
 * Whether the import writes original files that need a directory picked in the desktop
 * client: an original new to this library. A file that only fills in a missing one goes
 * where the registered one was.
 */
export function needsOriginalsDir(preview: ContentPackPreviewDto, drafts: ReadonlyMap<string, ContentDraft>): boolean {
  return preview.contents.some((item) => {
    const draft = drafts.get(item.key) ?? initialDraft(item);
    if (draft.action !== "import" && draft.action !== "merge") return false;
    const keys = new Set(draft.mediaKeys);
    return draft.diff.media.some((media) => keys.has(media.key) && media.kind === "original" && media.state === "new");
  });
}

/**
 * The commit body. A row still waiting for a target is sent as skipped; the caller does not
 * start while one waits. A collection whose Contents are all skipped is skipped too.
 */
export function buildDecisions(
  preview: ContentPackPreviewDto,
  drafts: ReadonlyMap<string, ContentDraft>,
  collections: ReadonlyMap<string, CollectionDraft>,
): ContentPackImportDecisions {
  const contents = preview.contents.map((item) => {
    const draft = drafts.get(item.key) ?? initialDraft(item);
    const action = draft.action ?? "skip";
    const acting = action === "import" || action === "merge";
    const known = new Set(draft.diff.revisions.map((revision) => revision.key));
    const mediaKeys = new Set(draft.diff.media.map((media) => media.key));
    return {
      key: item.key,
      action,
      ...(action === "merge" && draft.targetContentId !== undefined ? { targetContentId: draft.targetContentId } : {}),
      revisions: acting && draft.revisions,
      excludeRevisionKeys: draft.excludeRevisionKeys.filter((key) => known.has(key)),
      figures: acting && draft.figures,
      notes: acting && draft.notes,
      mediaKeys: acting ? draft.mediaKeys.filter((key) => mediaKeys.has(key)) : [],
      adoptPack: acting && draft.adoptPack,
      ...(acting && action === "merge" && draft.revisions && draft.setPrimaryRevisionKey !== undefined && known.has(draft.setPrimaryRevisionKey)
        ? { setPrimaryRevisionKey: draft.setPrimaryRevisionKey }
        : {}),
      currentTranslationKeys: acting && draft.revisions ? draft.currentTranslationKeys.filter((key) => known.has(key)) : [],
      sameSpeakers: acting && draft.revisions ? Object.entries(draft.sameSpeakers).map(([speakerKey, localSpeakerId]) => ({ speakerKey, localSpeakerId })) : [],
    };
  });
  return {
    contents,
    collections: preview.collections.map((collection): PackCollectionDecision => {
      const draft = collections.get(collection.key) ?? initialCollectionDraft(collection);
      if (!collectionUsable(collection, preview, drafts) || draft.action === "skip") return { key: collection.key, action: "skip" };
      if (draft.action === "join" && draft.targetCollectionId !== undefined) return { key: collection.key, action: "join", targetCollectionId: draft.targetCollectionId };
      return { key: collection.key, action: "create" };
    }),
  };
}

export interface ResultSummary {
  imported: number;
  merged: number;
  skipped: number;
  failed: number;
  collectionsFailed: number;
  /** Only when nothing failed, Contents and collections alike. */
  allOk: boolean;
}

export function resultSummary(result: ContentPackImportResult): ResultSummary {
  const count = (status: string): number => result.contents.filter((item) => item.status === status).length;
  const failed = count("failed");
  const collectionsFailed = result.collections.filter((item) => item.status === "failed").length;
  return { imported: count("imported"), merged: count("merged"), skipped: count("skipped"), failed, collectionsFailed, allOk: failed === 0 && collectionsFailed === 0 };
}

/**
 * Whether two durations differ enough to warn before merging by hand. `toleranceMs` is the
 * tolerance two recognitions of the same media are allowed; unknown durations never warn.
 */
export function durationsDiffer(packMs: number | undefined, localMs: number | undefined, toleranceMs: number): boolean {
  if (packMs === undefined || localMs === undefined) return false;
  return Math.abs(packMs - localMs) > toleranceMs;
}
