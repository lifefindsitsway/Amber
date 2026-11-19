import { FIGURES_PER_CONTENT_MAX, NOTES_PER_CONTENT_MAX, SPEAKERS_PER_CONTENT_MAX } from "../../shared/defaults.ts";
import type {
  PackCandidate,
  PackContentDiff,
  PackItemState,
  PackLimitedCategory,
  PackMatchKind,
  PackMatchReason,
  PackMediaDiff,
  PackRevisionDiff,
  PackSpeakerDiff,
} from "../../shared/dto/content-pack.ts";
import type { NoteColor, NoteMark, TimingFidelity, TranscriptKind } from "../../shared/enums.ts";
import { isValidCacheFileName } from "../../shared/cache-file-name.ts";
import type { SegmentId } from "../../shared/ids.ts";
import type { Content } from "../domain/content.ts";
import { displayTitle } from "../domain/content.ts";
import type { ContentDocument, PackFigure, PackMedia, PackNote, PackRevision, PackSpeaker, RevisionDocument } from "../domain/content-pack/document.ts";
import { originOf } from "../domain/content-pack/identity.ts";
import {
  localSpeakerIdentity,
  packSpeakerIdentity,
  sameTransferableContent,
  textAndTimingDigest,
  transferableDigest,
  transferableOfLocal,
  transferableOfPack,
  type TransferableRevision,
} from "../domain/content-pack/transferable.ts";
import { amberError } from "../domain/errors.ts";
import type { ContentFigure } from "../domain/figure.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import { noteAnchorProblem } from "../domain/note.ts";
import { isPlatform } from "../domain/platform.ts";
import { normalizeSpeakerName } from "../../shared/speakers.ts";
import type { ContentSpeaker } from "../domain/speaker.ts";
import { checkTranscriptInvariants, type TranscriptRevision, type TranscriptSegment } from "../domain/transcript.ts";
import type { PackDocuments } from "../ports/content-pack.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import { cacheRowsAt } from "../pipeline/cache-swap.ts";

/**
 * The import half of the content pack engine that only reads: the semantic checks the schemas
 * cannot make, how a carried Content relates to the library, and what importing it into a
 * target would change. The same analysis runs for the preview, for the decisions and once
 * more inside each commit's transaction, so a commit acts on the library as it is then.
 */

// ---------------------------------------------------------------------------------------------
// Semantic checks

/** One carried Content after the checks: its revision documents by revision key. */
export interface CheckedContent {
  entry: string;
  document: ContentDocument;
  revisionDocuments: ReadonlyMap<string, RevisionDocument>;
  /** Revision keys, parents before children. */
  order: readonly string[];
}

function invalidDocument(entry: string, why: string): never {
  throw amberError("backup_invalid", `content pack document refused: ${why}`, { code: "backup_invalid.pack_entry", details: { entry, reason: "document" } });
}

const ROOT_KINDS: ReadonlySet<TranscriptKind> = new Set(["platform", "imported", "asr"]);
const SINGLE_SOURCE_KINDS: ReadonlySet<TranscriptKind> = new Set(["corrected", "translated"]);

/**
 * Everything a strict schema cannot say: unique keys, revision documents that match their
 * entries, speaker and source indexes in range, lineage without cycles, every revision passing
 * the transcript invariants, every note anchor passing the note rules, figure and media fields
 * consistent. A pack failing any of them is refused whole: it was not written by Amber.
 */
export function checkPackDocuments(documents: PackDocuments, newId: () => string): CheckedContent[] {
  const contentKeys = new Set<string>();
  return documents.contents.map((content) => {
    const { document, entry } = content;
    if (contentKeys.has(document.key)) invalidDocument(entry, "duplicate content key");
    contentKeys.add(document.key);

    const speakerIdentities = new Set(document.speakers.map(packSpeakerIdentity));
    const ordinals = new Set(document.speakers.map((speaker) => speaker.ordinal));
    if (speakerIdentities.size !== document.speakers.length || ordinals.size !== document.speakers.length) invalidDocument(entry, "duplicate speaker");

    const revisions = new Map<string, PackRevision>();
    const revisionDocuments = new Map<string, RevisionDocument>();
    for (const revision of document.revisions) {
      if (revisions.has(revision.key)) invalidDocument(entry, "duplicate revision key");
      revisions.set(revision.key, revision);
      // Revision documents are named by their archive entry.
      const read = content.revisions.get(revision.entry);
      if (read === undefined || read.key !== revision.key) invalidDocument(revision.entry, "revision document missing");
      if (read.segments.length !== revision.segmentCount) invalidDocument(revision.entry, "segment count");
      revisionDocuments.set(revision.key, read);
    }
    const order = lineageOrder(document.revisions, entry);
    for (const revision of document.revisions) {
      checkRevision(revision, revisionDocuments, document, newId);
    }
    if (document.primaryRevisionKey !== undefined && !revisions.has(document.primaryRevisionKey)) invalidDocument(entry, "primary revision not carried");

    const noteKeys = new Set<string>();
    for (const note of document.notes) {
      if (noteKeys.has(note.key)) invalidDocument(entry, "duplicate note key");
      noteKeys.add(note.key);
      const revision = revisions.get(note.start.revisionKey);
      const segments = revisionDocuments.get(note.start.revisionKey);
      if (revision === undefined || segments === undefined || note.end.revisionKey !== note.start.revisionKey) invalidDocument(entry, "note anchor revision");
      const sentence = (ordinal: number) => {
        const segment = segments.segments[ordinal];
        return segment === undefined ? undefined : { id: `s${ordinal}`, revisionId: revision.key, ordinal, text: segment.text };
      };
      const problem = noteAnchorProblem(
        { transcriptRevisionId: revision.key, startSegmentId: `s${note.start.ordinal}`, startOffset: note.startOffset, endSegmentId: `s${note.end.ordinal}`, endOffset: note.endOffset },
        { id: revision.key, kind: revision.kind },
        sentence(note.start.ordinal),
        sentence(note.end.ordinal),
      );
      if (problem !== undefined) invalidDocument(entry, "note anchor");
    }

    const figureKeys = new Set<string>();
    const figureEntries = new Set<string>();
    for (const figure of document.figures) {
      if (figureKeys.has(figure.key) || figureEntries.has(figure.entry)) invalidDocument(entry, "duplicate figure");
      figureKeys.add(figure.key);
      figureEntries.add(figure.entry);
      if ((figure.source === "capture") !== (figure.capturedAtMs !== undefined)) invalidDocument(entry, "figure capture time");
      const anchored = figure.anchor === undefined ? undefined : revisionDocuments.get(figure.anchor.revisionKey);
      if (figure.anchor !== undefined && anchored !== undefined && anchored.segments[figure.anchor.ordinal] === undefined) invalidDocument(entry, "figure anchor");
    }

    const mediaKeys = new Set<string>();
    const mediaEntries = new Set<string>();
    for (const media of document.media) {
      if (mediaKeys.has(media.key) || mediaEntries.has(media.entry)) invalidDocument(entry, "duplicate media");
      mediaKeys.add(media.key);
      mediaEntries.add(media.entry);
      if (media.kind === "cache" ? media.cacheFileName === undefined || !isValidCacheFileName(media.cacheFileName) : media.cacheFileName !== undefined) {
        invalidDocument(entry, "media cache name");
      }
    }
    return { entry, document, revisionDocuments, order };
  });
}

/** Revision keys with every carried parent before its children; a cycle refuses the document. */
function lineageOrder(revisions: readonly PackRevision[], entry: string): string[] {
  const keys = new Set(revisions.map((revision) => revision.key));
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const byKey = new Map(revisions.map((revision) => [revision.key, revision]));
  const visit = (key: string): void => {
    if (done.has(key)) return;
    if (visiting.has(key)) invalidDocument(entry, "revision lineage cycle");
    visiting.add(key);
    const parent = byKey.get(key)?.parentKey;
    if (parent !== undefined && keys.has(parent)) visit(parent);
    visiting.delete(key);
    done.add(key);
    order.push(key);
  };
  for (const revision of revisions) visit(revision.key);
  return order;
}

/** The transcript invariants over a carried revision as it is written in the pack. */
function checkRevision(revision: PackRevision, documents: ReadonlyMap<string, RevisionDocument>, content: ContentDocument, newId: () => string): void {
  const read = documents.get(revision.key) as RevisionDocument;
  const parent = revision.parentKey === undefined ? undefined : documents.get(revision.parentKey);
  if (ROOT_KINDS.has(revision.kind) && revision.parentKey !== undefined) invalidDocument(revision.entry, "root revision with a parent");
  const id = newId();
  const segments = read.segments.map((segment, ordinal): TranscriptSegment => {
    if (segment.speaker !== undefined && content.speakers[segment.speaker] === undefined) invalidDocument(revision.entry, "speaker index");
    const sources = segment.sources ?? [];
    if (ROOT_KINDS.has(revision.kind) && sources.length > 0) invalidDocument(revision.entry, "sources on a root revision");
    if (parent !== undefined && sources.some((source) => parent.segments[source] === undefined)) invalidDocument(revision.entry, "source outside the parent");
    if (new Set(sources).size !== sources.length) invalidDocument(revision.entry, "repeated source");
    return {
      id: newId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      ...(segment.words === undefined ? {} : { words: segment.words }),
      ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
      // Placeholders keep the count; whether they resolve is decided when the parent is known.
      sourceSegmentIds: sources.map(() => newId() as SegmentId),
    };
  });
  const candidate: TranscriptRevision = {
    id,
    contentId: "pack",
    kind: revision.kind,
    language: revision.language,
    timingFidelity: revision.timingFidelity,
    generation: revision.generation,
    segmentCount: revision.segmentCount,
    ...(revision.looseJoin === true ? { looseJoin: true } : {}),
    createdAt: revision.createdAt,
  };
  if (checkTranscriptInvariants(candidate, segments).length > 0) invalidDocument(revision.entry, "transcript invariants");
}

// ---------------------------------------------------------------------------------------------
// Matching

export interface ContentMatch {
  match: PackMatchKind;
  candidates: PackCandidate[];
  /** The single live candidate of the deciding tier, merged into by default. */
  suggested?: string;
  /** A platform identity is taken here (perhaps in the trash), so the Content cannot be created again. */
  platformTaken: boolean;
}

/**
 * How a carried Content relates to the library: its identity (or an earlier merge) first,
 * then the same media (an original file's SHA-256, or the platform identity). Several
 * candidates are all listed and none is picked; titles and durations never match anything.
 */
export function matchContent(scope: RepositoryScope, owner: string, document: ContentDocument): ContentMatch {
  const found = new Map<string, { content: Content; reason: PackMatchReason }>();
  const add = (content: Content | undefined, reason: PackMatchReason): void => {
    if (content !== undefined && !found.has(content.id)) found.set(content.id, { content, reason });
  };
  for (const content of scope.transferOrigins.contentsByIdentity(owner, document.key)) add(content, "origin");
  for (const id of scope.transferOrigins.contentTargets(owner, document.key)) add(scope.contents.getIncludingTrashed(owner, id), "mapped");
  const fingerprints = new Set([...(document.fingerprint === undefined ? [] : [document.fingerprint]), ...document.media.filter((media) => media.kind === "original").map((media) => `sha256:${media.sha256}`)]);
  for (const fingerprint of fingerprints) {
    for (const asset of scope.mediaAssets.findByFingerprint(owner, fingerprint)) {
      if (asset.kind === "external_local" || asset.kind === "managed_upload") add(scope.contents.getIncludingTrashed(owner, asset.contentId), "fingerprint");
    }
  }
  let platformTaken = false;
  if (isPlatform(document.source.kind) && document.source.platformContentId !== undefined) {
    const holder = scope.contents.findByPlatformIdentity(owner, document.source);
    platformTaken = holder !== undefined;
    add(holder, "platform");
  }
  const candidates = [...found.values()].map(({ content, reason }): PackCandidate => {
    const title = displayTitle(content);
    return {
      contentId: content.id,
      ...(title === undefined ? {} : { title }),
      ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
      reason,
      trashed: content.trashedAt !== undefined,
    };
  });
  const same = candidates.filter((candidate) => candidate.reason === "origin" || candidate.reason === "mapped");
  const tier = same.length > 0 ? same : candidates;
  const live = tier.filter((candidate) => !candidate.trashed);
  const match: PackMatchKind = tier.length === 0 ? "new" : live.length === 0 ? "trashed" : same.length > 0 ? "same" : "same_media";
  return { match, candidates, ...(live.length === 1 ? { suggested: (live[0] as PackCandidate).contentId } : {}), platformTaken };
}

// ---------------------------------------------------------------------------------------------
// Analysis against one target

/** What the user's decisions leave in; the preview analyses with everything in. */
export interface AnalysisChoices {
  revisions: boolean;
  excludedRevisions: ReadonlySet<string>;
  notes: boolean;
  figures: boolean;
  /** Carried speaker index → the same-named local speaker it is merged into. */
  sameSpeakers: ReadonlyMap<number, string>;
}

export const EVERYTHING: AnalysisChoices = { revisions: true, excludedRevisions: new Set(), notes: true, figures: true, sameSpeakers: new Map() };

export interface RevisionAnalysis {
  pack: PackRevision;
  document: RevisionDocument;
  included: boolean;
  state: PackItemState;
  /** The local revision of the same identity (`existing` / `differs`). */
  localId?: string;
  /** Where a new revision's parent is: carried in this import, or already here. */
  parent?: { carried: string } | { local: string };
  standalone: boolean;
  rejected: boolean;
  kind: TranscriptKind;
  timingFidelity: TimingFidelity;
  sameTextAs?: string;
  /** What `sameTextAs` is, named the way a revision label names it. */
  sameTextAsRevision?: PackRevisionDiff["sameTextAsRevision"];
  becomesCurrentTranslation: boolean;
}

export interface SpeakerAnalysis {
  index: number;
  pack: PackSpeaker;
  state: PackItemState;
  localId?: string;
  localName?: string;
  sameName: Array<{ speakerId: string; name: string }>;
  /** Named by a revision this import writes. */
  needed: boolean;
  /** Where its sentences go: the identity-matched or chosen same-named local speaker; absent = created. */
  mappedTo?: string;
  mappedByName: boolean;
}

export interface NoteFields {
  mark: NoteMark;
  color: NoteColor;
  comment?: string;
}

export interface NoteAnalysis {
  pack: PackNote;
  state: PackItemState;
  localId?: string;
  local?: NoteFields;
  /** When the local note of the same identity last changed; shown for reference only. */
  localUpdatedAt?: number;
  /** A new note whose revision is here or comes along. */
  placeable: boolean;
}

export type FigureFields = Pick<ContentFigure, "caption" | "widthRatio" | "displayMs" | "sortKey" | "anchor">;

export interface FigureAnalysis {
  pack: PackFigure;
  state: PackItemState;
  /** Deleted here and still restorable: never imported again. */
  deletedHere: boolean;
  /** Same identity, another image: a conflict, the image is never replaced. */
  imageConflict: boolean;
  localId?: string;
  local?: FigureFields;
  /** When the local figure of the same identity last changed; shown for reference only. */
  localUpdatedAt?: number;
  /** A new figure whose anchor revision is here or comes along. */
  anchored: boolean;
  /**
   * Whether the pack says where the figure is: its anchor maps to a revision here (or one this
   * import writes), or neither side is anchored and both go by time. Otherwise only caption
   * and width are compared and adopted; the local place stays.
   */
  positionKnown: boolean;
}

export interface MediaAnalysis {
  pack: PackMedia;
  state: PackMediaDiff["state"];
  /** For `existing` / `fill`: the registered asset. */
  asset?: MediaAsset;
}

export interface ContentAnalysis {
  target?: Content;
  revisions: RevisionAnalysis[];
  speakers: SpeakerAnalysis[];
  notes: NoteAnalysis[];
  figures: FigureAnalysis[];
  media: MediaAnalysis[];
  platformChapters: PackContentDiff["platformChapters"];
  /** What the target holds now, for the limits. */
  counts: { notes: number; figures: number; speakers: number };
}

/**
 * Whether the pack's note says nothing the local one does not: mark and colour equal, and the
 * comment equal when the pack has one. A pack without a comment never clears a local one, so
 * it is not a difference either.
 */
function sameNoteFields(local: NoteFields, carried: NoteFields): boolean {
  return local.mark === carried.mark && local.color === carried.color && (carried.comment === undefined || local.comment === carried.comment);
}

export function sameAnchor(a: ContentFigure["anchor"], b: ContentFigure["anchor"]): boolean {
  return a === undefined || b === undefined ? a === b : a.revisionId === b.revisionId && a.segmentId === b.segmentId && a.side === b.side;
}

export function sameFigureFields(a: FigureFields, b: FigureFields): boolean {
  return a.caption === b.caption && a.widthRatio === b.widthRatio && a.displayMs === b.displayMs && a.sortKey === b.sortKey && sameAnchor(a.anchor, b.anchor);
}

export function figureFieldsOf(figure: ContentFigure): FigureFields {
  return {
    ...(figure.caption === undefined ? {} : { caption: figure.caption }),
    widthRatio: figure.widthRatio,
    displayMs: figure.displayMs,
    sortKey: figure.sortKey,
    ...(figure.anchor === undefined ? {} : { anchor: { ...figure.anchor } }),
  };
}

const CACHE_REF_PREFIX = "media/";

/** The target's revisions and their sentences, read once per analysis. */
class TargetRevisions {
  private readonly segments = new Map<string, TranscriptSegment[]>();
  readonly byIdentity = new Map<string, TranscriptRevision>();
  readonly byId: Map<string, TranscriptRevision>;
  readonly archived: Set<string>;
  private readonly scope: RepositoryScope;
  private readonly owner: string;

  constructor(scope: RepositoryScope, owner: string, target: Content | undefined) {
    this.scope = scope;
    this.owner = owner;
    const revisions = target === undefined ? [] : scope.transcripts.listRevisions(owner, target.id);
    this.byId = new Map(revisions.map((revision) => [revision.id, revision]));
    for (const revision of revisions) {
      const identity = originOf(revision);
      if (!this.byIdentity.has(identity)) this.byIdentity.set(identity, revision);
    }
    this.archived = new Set(target === undefined ? [] : scope.transcripts.listArchived(owner, target.id).map((entry) => entry.revisionId));
  }

  segmentsOf(revisionId: string): TranscriptSegment[] {
    let segments = this.segments.get(revisionId);
    if (segments === undefined) {
      segments = this.scope.transcripts.listSegments(this.owner, revisionId);
      this.segments.set(revisionId, segments);
    }
    return segments;
  }
}

/**
 * What importing `checked` into `target` (or as a new Content when absent) would do, with the
 * user's `choices`. Nothing is written.
 */
export function analyzeContent(scope: RepositoryScope, owner: string, checked: CheckedContent, target: Content | undefined, choices: AnalysisChoices): ContentAnalysis {
  const { document } = checked;
  const contentIdentity = target === undefined ? document.key : originOf(target);
  const local = new TargetRevisions(scope, owner, target);
  const localSpeakers: ContentSpeaker[] = target === undefined ? [] : scope.speakers.list(owner, target.id);
  const comparisonOnly = target === undefined ? new Set<string>() : scope.speakers.comparisonOnlyIds(owner, target.id);
  const speakerByIdentity = new Map(localSpeakers.map((speaker) => [localSpeakerIdentity(speaker, contentIdentity), speaker]));
  const translationArtifacts = new Set(target === undefined ? [] : scope.translations.listArtifacts(owner, target.id).map((artifact) => artifact.targetLanguage));

  // Pack speakers merged into a same-named local one by an earlier import: pack identity →
  // local identity, read back from the revisions that import wrote (see `inferSpeakers`).
  const inferred = new Map<string, string>();
  const packIdentities = new Set(document.speakers.map(packSpeakerIdentity));

  // Revisions, parents first.
  const byKey = new Map(document.revisions.map((revision) => [revision.key, revision]));
  const analysed = new Map<string, RevisionAnalysis>();
  let textDigests: Map<string, string> | undefined;
  const localDigests = (): Map<string, string> => {
    if (textDigests === undefined) {
      textDigests = new Map();
      for (const revision of local.byId.values()) {
        const transferable = transferableOfLocal(revision, local.segmentsOf(revision.id), localSpeakers, contentIdentity);
        textDigests.set(revision.id, textAndTimingDigest(transferable));
      }
    }
    return textDigests;
  };
  for (const key of checked.order) {
    const pack = byKey.get(key) as PackRevision;
    const revisionDocument = checked.revisionDocuments.get(key) as RevisionDocument;
    const included = choices.revisions && !choices.excludedRevisions.has(key);
    const carried = transferableOfPack(pack, revisionDocument, document.speakers);
    const here = local.byIdentity.get(key);
    const base = { pack, document: revisionDocument, included, becomesCurrentTranslation: false, standalone: false, rejected: false, kind: pack.kind, timingFidelity: pack.timingFidelity };
    if (here !== undefined) {
      const mine = transferableOfLocal(here, local.segmentsOf(here.id), localSpeakers, contentIdentity);
      const same = sameTransferableContent(mine, carried) || inferSpeakers(mine, carried, inferred, speakerByIdentity, packIdentities);
      analysed.set(key, { ...base, state: same ? "existing" : "differs", localId: here.id });
      continue;
    }
    const parent = resolveParent(pack, revisionDocument, analysed, local);
    const digest = textAndTimingDigest(carried);
    const sameText = [...localDigests()].find(([, value]) => value === digest)?.[0];
    const sameRevision = sameText === undefined ? undefined : local.byId.get(sameText);
    const common = {
      ...base,
      state: "new" as const,
      ...(sameText === undefined ? {} : { sameTextAs: sameText }),
      ...(sameRevision === undefined ? {} : { sameTextAsRevision: revisionNaming(sameRevision) }),
    };
    if (parent !== undefined || ROOT_KINDS.has(pack.kind)) {
      analysed.set(key, { ...common, ...(parent === undefined ? {} : { parent }) });
    } else if (pack.kind === "translated") {
      analysed.set(key, { ...common, rejected: true });
    } else {
      const words = revisionDocument.segments.some((segment) => segment.words !== undefined);
      analysed.set(key, { ...common, standalone: true, kind: "imported", timingFidelity: words ? "exact_words" : "segment_only" });
    }
  }
  const revisions = checked.order.map((key) => analysed.get(key) as RevisionAnalysis);
  const written = (revision: RevisionAnalysis): boolean => revision.included && revision.state === "new" && !revision.rejected;

  // The current translation of each language that has none here yet.
  const byLanguage = new Map<string, RevisionAnalysis[]>();
  for (const revision of revisions) {
    if (revision.pack.kind === "translated" && written(revision) && revision.pack.archivedAt === undefined && !translationArtifacts.has(revision.pack.language)) {
      byLanguage.set(revision.pack.language, [...(byLanguage.get(revision.pack.language) ?? []), revision]);
    }
  }
  for (const list of byLanguage.values()) {
    const chosen = list.find((revision) => revision.pack.currentTranslation === true) ?? [...list].sort((a, b) => b.pack.createdAt - a.pack.createdAt)[0];
    if (chosen !== undefined) chosen.becomesCurrentTranslation = true;
  }

  // Speakers.
  const neededIndexes = new Set(revisions.filter(written).flatMap((revision) => revision.document.segments.flatMap((segment) => (segment.speaker === undefined ? [] : [segment.speaker]))));
  const speakers = document.speakers.map((pack, index): SpeakerAnalysis => {
    const identity = packSpeakerIdentity(pack);
    const byIdentity = speakerByIdentity.get(identity);
    const mergedEarlier = byIdentity === undefined ? inferred.get(identity) : undefined;
    const here = byIdentity ?? (mergedEarlier === undefined ? undefined : speakerByIdentity.get(mergedEarlier));
    const name = packSpeakerName(pack);
    const sameName = name === undefined
      ? []
      : localSpeakers.filter((speaker) => speaker.name === name && !comparisonOnly.has(speaker.id)).map((speaker) => ({ speakerId: speaker.id, name: speaker.name as string }));
    if (here !== undefined) {
      return {
        index,
        pack,
        state: here.name === name ? "existing" : "differs",
        localId: here.id,
        ...(here.name === undefined ? {} : { localName: here.name }),
        sameName: [],
        needed: neededIndexes.has(index),
        mappedTo: here.id,
        mappedByName: byIdentity === undefined,
      };
    }
    const chosen = choices.sameSpeakers.get(index);
    return { index, pack, state: "new", sameName, needed: neededIndexes.has(index), ...(chosen === undefined ? {} : { mappedTo: chosen }), mappedByName: chosen !== undefined };
  });

  // Notes.
  const notesHere = target === undefined ? [] : scope.notes.listByContent(owner, target.id);
  const noteByIdentity = new Map(notesHere.map((note) => [originOf(note), note]));
  const revisionLands = (key: string): boolean => revisionLandsIn(analysed, key);
  const notes = document.notes.map((pack): NoteAnalysis => {
    const here = noteByIdentity.get(pack.key);
    const carried: NoteFields = { mark: pack.mark, color: pack.color, ...(pack.comment === undefined ? {} : { comment: pack.comment }) };
    if (here !== undefined) {
      const fields: NoteFields = { mark: here.mark, color: here.color, ...(here.comment === undefined ? {} : { comment: here.comment }) };
      return { pack, state: sameNoteFields(fields, carried) ? "existing" : "differs", localId: here.id, local: fields, localUpdatedAt: here.updatedAt, placeable: false };
    }
    return { pack, state: "new", placeable: revisionLands(pack.start.revisionKey) };
  });

  // Figures.
  const figuresHere = target === undefined ? [] : scope.figures.listByContent(owner, target.id);
  const figureByIdentity = new Map(figuresHere.map((figure) => [originOf(figure), figure]));
  const anchorIdentity = (anchor: ContentFigure["anchor"]): string | undefined => {
    if (anchor === undefined) return undefined;
    const revision = local.byId.get(anchor.revisionId);
    if (revision === undefined) return undefined;
    const ordinal = local.segmentsOf(revision.id).findIndex((segment) => segment.id === anchor.segmentId);
    return ordinal < 0 ? undefined : `${originOf(revision)}\u0000${ordinal}\u0000${anchor.side}`;
  };
  const packAnchorIdentity = (anchor: PackFigure["anchor"]): string | undefined => {
    if (anchor === undefined || !revisionLands(anchor.revisionKey)) return undefined;
    const revision = analysed.get(anchor.revisionKey) as RevisionAnalysis;
    if (revision.state === "existing" && revision.localId !== undefined && local.segmentsOf(revision.localId)[anchor.ordinal] === undefined) return undefined;
    return `${anchor.revisionKey}\u0000${anchor.ordinal}\u0000${anchor.side}`;
  };
  const figures = document.figures.map((pack): FigureAnalysis => {
    const here = figureByIdentity.get(pack.key);
    const carriedAnchor = packAnchorIdentity(pack.anchor);
    if (here !== undefined) {
      const local = figureFieldsOf(here);
      const positionKnown = carriedAnchor !== undefined || (pack.anchor === undefined && here.anchor === undefined);
      const base = { pack, localId: here.id, local, localUpdatedAt: here.updatedAt, anchored: false, positionKnown };
      if (here.deletedAt !== undefined) return { ...base, state: "existing", deletedHere: true, imageConflict: false };
      if (here.image.sha256 !== pack.image.sha256) return { ...base, state: "differs", deletedHere: false, imageConflict: true };
      const samePlace = !positionKnown || (here.displayMs === pack.displayMs && here.sortKey === pack.sortKey && anchorIdentity(here.anchor) === carriedAnchor);
      // A pack without a caption is no difference: adopting it would not remove the local one.
      const sameCaption = pack.caption === undefined || here.caption === pack.caption;
      const same = sameCaption && here.widthRatio === pack.widthRatio && samePlace;
      return { ...base, state: same ? "existing" : "differs", deletedHere: false, imageConflict: false };
    }
    return { pack, state: "new", deletedHere: false, imageConflict: false, anchored: carriedAnchor !== undefined, positionKnown: true };
  });

  // Media.
  const assetsHere = target === undefined ? [] : scope.mediaAssets.listByContent(owner, target.id);
  const media = document.media.map((pack): MediaAnalysis => {
    if (pack.kind === "original") {
      const fingerprint = `sha256:${pack.sha256}`;
      const asset = assetsHere.find((candidate) => (candidate.kind === "external_local" || candidate.kind === "managed_upload") && candidate.fingerprint === fingerprint);
      if (asset === undefined) return { pack, state: "new" };
      return { pack, state: asset.availability === "available" ? "existing" : "fill", asset };
    }
    const ref = `${CACHE_REF_PREFIX}${pack.cacheFileName as string}`;
    // Names are compared as Windows compares them: another casing is the same file.
    const rows = cacheRowsAt(scope, ref);
    if (rows.some((row) => row.userId !== owner || row.contentId !== target?.id)) return { pack, state: "conflict" };
    const asset = rows[0];
    if (asset === undefined) return { pack, state: "new" };
    // A cache downloaded here may not record its digest; the size then stands in for it.
    const same = asset.fingerprint === undefined ? asset.sizeBytes === pack.sizeBytes : asset.fingerprint === `sha256:${pack.sha256}`;
    if (!same) return { pack, state: "conflict" };
    return { pack, state: asset.availability === "available" ? "existing" : "fill", asset };
  });

  const carriedChapters = (document.platformChapters ?? []).length > 0;
  const platformChapters = !carriedChapters ? "none" : target !== undefined && scope.chapters.hasPlatformChapters(owner, target.id) ? "keep" : "add";
  return {
    ...(target === undefined ? {} : { target }),
    revisions,
    speakers,
    notes,
    figures,
    media,
    platformChapters,
    counts: {
      notes: notesHere.length,
      figures: target === undefined ? 0 : scope.figures.countByContent(owner, target.id),
      speakers: localSpeakers.length,
    },
  };
}

/**
 * Whether a carried revision is a place notes and figures can sit on: one already here (by
 * identity and with the same content, chosen or not) or one this import writes.
 */
export function revisionLandsIn(analysed: ReadonlyMap<string, RevisionAnalysis>, key: string): boolean {
  const revision = analysed.get(key);
  if (revision === undefined) return false;
  return revision.state === "existing" || (revision.state === "new" && revision.included && !revision.rejected);
}

/** A carried speaker's name as it is stored here (normalized), or none. */
export function packSpeakerName(speaker: Pick<PackSpeaker, "name">): string | undefined {
  if (speaker.name === undefined) return undefined;
  const name = normalizeSpeakerName(speaker.name);
  return name === undefined || name === "too_long" ? undefined : name;
}

/**
 * The cover a carried Content may keep: only a platform Content's, and only over HTTPS without
 * credentials in the URL. A local file has no cover on the web, so a pack claiming one for it
 * is not believed.
 */
export function carriedCoverUrl(document: Pick<ContentDocument, "source" | "coverUrl">): string | undefined {
  if (document.coverUrl === undefined || !isPlatform(document.source.kind)) return undefined;
  try {
    const url = new URL(document.coverUrl);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? document.coverUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A revision here and its carried copy that read the same but name other speakers: the mark
 * an earlier import left when the user merged a carried speaker into a same-named local one
 * (the sentences it wrote name the local speaker). Recognised without storing anything: text,
 * timing and paragraphs agree, unassigned sentences agree, and every differing pair maps a
 * carried speaker that has no speaker of its own here onto one local speaker that is no carried
 * speaker, consistently across every revision of the analysis (`inferred` collects the pairs).
 * Revisions never change, so speakers can only differ this way for the same identity.
 */
function inferSpeakers(
  mine: TransferableRevision,
  carried: TransferableRevision,
  inferred: Map<string, string>,
  localIdentities: ReadonlyMap<string, unknown>,
  packIdentities: ReadonlySet<string>,
): boolean {
  const withoutSpeakers = (revision: TransferableRevision): TransferableRevision => ({
    ...revision,
    segments: revision.segments.map(({ speaker: _speaker, ...rest }) => rest),
  });
  if (transferableDigest(withoutSpeakers(mine)) !== transferableDigest(withoutSpeakers(carried))) return false;
  const pairs = new Map<string, string>();
  const owners = new Map<string, string>([...inferred].map(([pack, here]) => [here, pack]));
  for (const [index, segment] of carried.segments.entries()) {
    const theirs = segment.speaker;
    const ours = mine.segments[index]?.speaker;
    if (theirs === undefined || ours === undefined) {
      if (theirs !== ours) return false;
      continue;
    }
    if (theirs === ours) continue;
    if (localIdentities.has(theirs) || packIdentities.has(ours)) return false;
    const mapped = pairs.get(theirs) ?? inferred.get(theirs);
    const owner = owners.get(ours);
    if ((mapped !== undefined && mapped !== ours) || (owner !== undefined && owner !== theirs)) return false;
    pairs.set(theirs, ours);
    owners.set(ours, theirs);
  }
  for (const [pack, here] of pairs) inferred.set(pack, here);
  return true;
}

/**
 * The parent a new revision keeps: carried and written in the same import (or already here
 * with the same content), or not carried but here by identity with sentences enough for every
 * source. Otherwise there is none and the revision stands alone (a translation is refused).
 */
function resolveParent(
  pack: PackRevision,
  document: RevisionDocument,
  analysed: ReadonlyMap<string, RevisionAnalysis>,
  local: TargetRevisions,
): RevisionAnalysis["parent"] {
  if (pack.parentKey === undefined || ROOT_KINDS.has(pack.kind)) return undefined;
  const carried = analysed.get(pack.parentKey);
  if (carried !== undefined && carried.included) {
    if (carried.state === "existing" && carried.localId !== undefined) return { local: carried.localId };
    if (carried.state === "new" && !carried.rejected) return { carried: pack.parentKey };
    return undefined;
  }
  const here = local.byIdentity.get(pack.parentKey);
  if (here === undefined) return undefined;
  const count = here.segmentCount;
  const fits = document.segments.every((segment) => (segment.sources ?? []).every((source) => source < count));
  const single = !SINGLE_SOURCE_KINDS.has(pack.kind) || document.segments.every((segment) => (segment.sources ?? []).length === 1);
  return fits && single ? { local: here.id } : undefined;
}

/** Categories over their per-Content limit with the user's choices. */
export function overLimits(analysis: ContentAnalysis, choices: AnalysisChoices): PackContentDiff["overLimit"] {
  const over: PackContentDiff["overLimit"] = [];
  const check = (category: PackLimitedCategory, total: number, limit: number): void => {
    if (total > limit) over.push({ category, over: total - limit, limit });
  };
  if (choices.notes) check("notes", analysis.counts.notes + analysis.notes.filter((note) => note.state === "new" && note.placeable).length, NOTES_PER_CONTENT_MAX);
  if (choices.figures) check("figures", analysis.counts.figures + analysis.figures.filter((figure) => figure.state === "new").length, FIGURES_PER_CONTENT_MAX);
  check("speakers", analysis.counts.speakers + speakersToCreate(analysis).length, SPEAKERS_PER_CONTENT_MAX);
  return over;
}

/** Carried speakers this import creates: named by a written revision and mapped to no local one. */
export function speakersToCreate(analysis: ContentAnalysis): SpeakerAnalysis[] {
  return analysis.speakers.filter((speaker) => speaker.needed && speaker.mappedTo === undefined);
}

/**
 * The latest change on each side among the items that differ, or nothing when none does. Only
 * shown beside 「采用包里的」: the two devices' clocks need not agree, so nothing decides by it.
 */
function differsUpdatedAt(items: ReadonlyArray<{ here: number; pack: number }>): { differsUpdatedAt: { here: number; pack: number } } | Record<string, never> {
  if (items.length === 0) return {};
  return {
    differsUpdatedAt: {
      here: items.reduce((latest, item) => Math.max(latest, item.here), 0),
      pack: items.reduce((latest, item) => Math.max(latest, item.pack), 0),
    },
  };
}

/** A local revision as a label names it: kind, language, creation time and the model that made it. */
function revisionNaming(revision: TranscriptRevision): NonNullable<PackRevisionDiff["sameTextAsRevision"]> {
  const { generation } = revision;
  const model =
    generation.kind === "llm"
      ? generation.modelRef.modelDisplaySnapshot || generation.modelRef.modelId
      : generation.kind === "asr"
        ? generation.modelId
        : generation.kind === "pack"
          ? generation.modelName
          : undefined;
  // An empty display name is no name; labels then fall back to the kind and time alone.
  return { kind: revision.kind, language: revision.language, createdAt: revision.createdAt, ...(model ? { modelName: model } : {}) };
}

function counts<T>(items: readonly T[], state: (item: T) => PackItemState | undefined): { new: number; existing: number; differs: number } {
  const result = { new: 0, existing: 0, differs: 0 };
  for (const item of items) {
    const value = state(item);
    if (value !== undefined) result[value] += 1;
  }
  return result;
}

/** The preview's view of an analysis. */
export function diffOf(analysis: ContentAnalysis, choices: AnalysisChoices = EVERYTHING): PackContentDiff {
  const { target } = analysis;
  const revisions = analysis.revisions.map((revision): PackRevisionDiff => ({
    key: revision.pack.key,
    kind: revision.kind,
    originalKind: revision.pack.generation.originalKind,
    language: revision.pack.language,
    segmentCount: revision.pack.segmentCount,
    createdAt: revision.pack.createdAt,
    archived: revision.pack.archivedAt !== undefined,
    ...(revision.pack.generation.modelName === undefined ? {} : { modelName: revision.pack.generation.modelName }),
    state: revision.state,
    standalone: revision.standalone,
    ...(revision.rejected ? { rejected: "translation_without_parent" as const } : {}),
    ...(revision.sameTextAs === undefined ? {} : { sameTextAs: revision.sameTextAs }),
    ...(revision.sameTextAsRevision === undefined ? {} : { sameTextAsRevision: revision.sameTextAsRevision }),
    becomesCurrentTranslation: revision.becomesCurrentTranslation,
  }));
  const speakers = analysis.speakers.map((speaker): PackSpeakerDiff => ({
    key: String(speaker.index),
    ...(speaker.pack.name === undefined ? {} : { name: speaker.pack.name }),
    ordinal: speaker.pack.ordinal,
    state: speaker.state,
    ...(speaker.localId === undefined ? {} : { localSpeakerId: speaker.localId }),
    ...(speaker.localName === undefined ? {} : { localName: speaker.localName }),
    sameNameCandidates: speaker.sameName,
  }));
  const figures = {
    ...counts(analysis.figures, (figure) => (figure.deletedHere ? undefined : figure.state)),
    placedByTime: analysis.figures.filter((figure) => figure.state === "new" && !figure.anchored).length,
    deletedHere: analysis.figures.filter((figure) => figure.deletedHere).length,
    // Image conflicts cannot be adopted, so they need no time to compare.
    ...differsUpdatedAt(
      analysis.figures.flatMap((figure) =>
        figure.state === "differs" && !figure.deletedHere && !figure.imageConflict && figure.localUpdatedAt !== undefined ? [{ here: figure.localUpdatedAt, pack: figure.pack.updatedAt }] : [],
      ),
    ),
  };
  const notes = {
    ...counts(analysis.notes, (note) => (note.state === "new" && !note.placeable ? undefined : note.state)),
    unplaceable: analysis.notes.filter((note) => note.state === "new" && !note.placeable).length,
    ...differsUpdatedAt(analysis.notes.flatMap((note) => (note.state === "differs" && note.localUpdatedAt !== undefined ? [{ here: note.localUpdatedAt, pack: note.pack.updatedAt }] : []))),
  };
  const media = analysis.media.map((item): PackMediaDiff => ({
    key: item.pack.key,
    kind: item.pack.kind,
    ...(item.pack.displayName === undefined ? {} : { displayName: item.pack.displayName }),
    sizeBytes: item.pack.sizeBytes,
    ...(item.pack.quality === undefined ? {} : { quality: item.pack.quality }),
    state: item.state,
  }));
  return {
    ...(target === undefined ? {} : { targetContentId: target.id }),
    revisions,
    speakers,
    figures,
    notes,
    platformChapters: analysis.platformChapters,
    media,
    overLimit: overLimits(analysis, choices),
    ...(target?.primaryTranscriptRevisionId === undefined ? {} : { targetPrimaryRevisionId: target.primaryTranscriptRevisionId }),
  };
}
