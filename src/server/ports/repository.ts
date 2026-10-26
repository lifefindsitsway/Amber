import type { ContentSourceKind, NoteColor, NoteMark, Platform, PlatformAccountStatus, ProcessingStatus, TaskKind } from "../../shared/enums.ts";
import type { ChapterEntry } from "../domain/platform-subtitle.ts";
import type {
  ChapterArtifact,
  ChapterRevision,
  CollectionSummaryArtifact,
  CollectionSummaryRevision,
  HighlightArtifact,
  HighlightRevision,
  RollupPartial,
  SummaryArtifact,
  SummaryRevision,
  SummaryTemplate,
  SummaryTemplateVersion,
  TranslationArtifact,
} from "../domain/artifact.ts";
import type { Collection, CollectionItem } from "../domain/collection.ts";
import type { Content, ContentSource, ImportBatch } from "../domain/content.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { Note } from "../domain/note.ts";
import type { AsrProviderProfile, OtherModelProfile, PlatformAccount, ProviderProfile } from "../domain/provider-profile.ts";
import type { TokenUsageFeature } from "../../shared/enums.ts";
import type { TerminologyEntry, TerminologyScope, TerminologySet } from "../domain/terminology.ts";
import type { AsrUsage, TokenUsage } from "../domain/usage.ts";
import type { IdempotencyRecord, InstanceSettings, NetworkAllowlistEntry, PendingFileDelete, Session, UserSettings } from "../domain/runtime-support.ts";
import type { StageRun, Task, WorkUnit, WorkUnitResult } from "../domain/task.ts";
import type { ModelRefSnapshot, PromptRef } from "../domain/model-ref.ts";
import type { ReferenceText, RevisionReference, TranscriptDraft, TranscriptRevision, TranscriptSegment } from "../domain/transcript.ts";
import type { ChatCompaction, ChatMessage, ChatThread } from "../domain/chat.ts";
import type { User, UserCredential } from "../domain/user.ts";
import type { WebSearchProfile } from "../domain/web-search.ts";
import type { SecretEnvelopeStore } from "./secret-store.ts";

/**
 * Invariant: every persisted row traces back to one owner. Reads and writes of owned
 * data take the owner explicitly and never reach another user's rows; an id owned by
 * someone else behaves exactly like an unknown id. Only administration and the methods
 * marked instance-wide or unscoped cross owners.
 */
export interface UserRepository {
  get(userId: string): User | undefined;
  /** Every user, oldest first (`createdAt`, then `id`); administration only. */
  list(): User[];
  insert(user: User): void;
  /** Rewrites role, status, displayName and storageLimitGB. */
  update(user: User): void;
  /** Active administrators; server mode always keeps at least one, so removing or suspending the last is a conflict. */
  countActiveAdmins(): number;
  /**
   * Deletes everything the user owns: Contents, Collections, LLM, ASR and other-model
   * profiles, platform accounts, Secrets, terminology sets, custom summary templates, Tasks,
   * the login credential, sessions, settings and usage rows. Instance-level rows (the
   * network allowlist) only lose their actor reference. Callers first cancel the user's
   * unfinished Tasks and wait for their process trees, and queue the user's files for removal.
   */
  delete(userId: string): boolean;
  getCredential(userId: string): UserCredential | undefined;
  /** By the normalized username (trimmed, NFKC, ASCII lower case). */
  findCredentialByUsername(username: string): UserCredential | undefined;
  /** Inserts the user's credential or replaces it; usernames are unique. */
  putCredential(credential: UserCredential): void;
  /** True once any login credential exists, i.e. the server instance is initialized. */
  anyCredential(): boolean;
}

/**
 * Server-mode sessions. The cookie carries only a high-entropy opaque id and the database
 * stores its hash, so every lookup is by that hash.
 */
export interface SessionRepository {
  get(sessionIdHash: string): Session | undefined;
  insert(session: Session): void;
  /** Slides a live session: new `lastSeenAt` and `expiresAt`. */
  touch(sessionIdHash: string, lastSeenAt: number, expiresAt: number): void;
  /** Revokes one live session; false when it is unknown or already revoked. */
  revoke(sessionIdHash: string, revokedAt: number): boolean;
  /** Revokes the user's live sessions, optionally keeping one; returns the hashes revoked. */
  revokeAllOf(userId: string, revokedAt: number, options?: { except?: string }): string[];
  /** Deletes expired and revoked rows; returns how many. */
  deleteStale(now: number): number;
}

/**
 * The instance-level allowlist of exact origins (`scheme://host[:port]`) an administrator
 * lets outbound requests reach despite the private-address block; not owned by any user.
 */
export interface NetworkAllowlistRepository {
  /** By origin. */
  list(): NetworkAllowlistEntry[];
  /** Replaces the whole list. */
  replace(entries: readonly NetworkAllowlistEntry[]): void;
}

/**
 * Keyset position in a Content listing: pinned Contents first (latest pin first), then the
 * rest newest first by `(createdAt, id)`. `pinnedAt` is the pin of the last item seen, so
 * the next page knows whether it is still inside the pinned run.
 */
export interface ContentCursor {
  pinnedAt?: number;
  createdAt: number;
  id: string;
}

/**
 * Where a listing page starts: strictly after a keyset cursor, or `offset` rows into the
 * same order for the numbered pages of the list endpoints. Never both.
 */
export type ListPosition<C> = { limit: number; after?: C; offset?: never } | { limit: number; offset: number; after?: never };

export interface ContentListFilters {
  status?: ProcessingStatus;
  source?: ContentSourceKind;
  collectionId?: string;
  /** Only Contents that belong to no collection (the sidebar's "Recent" group). */
  uncollected?: boolean;
  importBatchId?: string;
  /** Only these Contents (deduplicated, at most `CONTENT_LIST_IDS_MAX`); the other filters still apply. */
  ids?: readonly string[];
}

export type ContentListQuery = ListPosition<ContentCursor> & ContentListFilters;

/** Keyset position in a trash listing: latest `trashedAt` first, then `id` descending. */
export interface TrashCursor {
  trashedAt: number;
  id: string;
}

/**
 * Contents of the owner. Every read but `getIncludingTrashed`, `findByPlatformIdentity` and
 * the `*Trashed` / `*Expired` methods sees only Contents outside the trash:
 * request paths read through them and so answer `not_found` for a trashed Content. Writes
 * by id do not look at the trash; their callers have checked visibility already.
 */
export interface ContentRepository {
  /** A Content outside the trash. */
  get(ownerUserId: string, contentId: string): Content | undefined;
  /** A Content whether or not it is in the trash: for the pipeline, write guards and the trash itself. */
  getIncludingTrashed(ownerUserId: string, contentId: string): Content | undefined;
  /** Most recently updated first. */
  list(ownerUserId: string): Content[];
  /** Pinned first, then newest first by `(createdAt, id)`; every filter is optional. */
  page(ownerUserId: string, query: ContentListQuery): Content[];
  /** How many Contents `page` would list in total under the same filters. */
  count(ownerUserId: string, filters: ContentListFilters): number;
  /** Moves a Content outside the trash into it; `updatedAt` is left alone. */
  trash(ownerUserId: string, contentId: string, trashedAt: number): void;
  /** Takes a trashed Content out of the trash; `updatedAt` is left alone. */
  restore(ownerUserId: string, contentId: string): void;
  /** The owner's trash, latest `trashedAt` first, from `position`. */
  listTrashed(ownerUserId: string, position: ListPosition<TrashCursor>): Content[];
  countTrashed(ownerUserId: string): number;
  /** Every id in the owner's trash, latest `trashedAt` first. */
  listTrashedIds(ownerUserId: string): string[];
  /**
   * Instance-wide, for the sweep only: trashed Contents of every user with `trashedAt` at or
   * before `cutoff`, oldest first, strictly after `after` in that order when given. Never
   * used to answer a request.
   */
  listExpired(cutoff: number, limit: number, after?: TrashCursor): Array<{ userId: string; id: string; trashedAt: number }>;
  /** Instance-wide, for the sweep timer: the earliest `trashedAt` later than `after`. */
  earliestTrashedAfter(after: number): number | undefined;
  /** The user's own title; `undefined` restores the platform's or file's. */
  setCustomTitle(ownerUserId: string, contentId: string, title: string | undefined, updatedAt: number): void;
  /** Pins (a time) or unpins (`undefined`); deliberately leaves `updatedAt` alone, a pin is not an edit. */
  setPinned(ownerUserId: string, contentId: string, pinnedAt: number | undefined): void;
  /**
   * Lookup by the canonical platform identity `(platform, platformContentId, platformPartId)`
   * within the owner, trashed Contents included (the identity stays taken); local sources
   * never match.
   */
  findByPlatformIdentity(ownerUserId: string, source: ContentSource): Content | undefined;
  insert(content: Content): void;
  /**
   * Rewrites the processing-status projection, which mirrors the Content's latest
   * `process_content` Task; derived Tasks such as re-proofreading or translation never set it.
   */
  setProcessingStatus(ownerUserId: string, contentId: string, status: ProcessingStatus, updatedAt: number): void;
  /** Fills metadata learned by probing or fetching; only the given fields change. */
  setMetadata(
    ownerUserId: string,
    contentId: string,
    metadata: Partial<Pick<Content, "title" | "durationMs" | "coverUrl" | "publishedAt" | "rawLanguage"> & Pick<Content["source"], "channelId" | "channelTitle">>,
    updatedAt: number,
  ): void;
  /** Points the Content at one of its own revisions; `undefined` clears the pointer. */
  setPrimaryTranscript(ownerUserId: string, contentId: string, revisionId: string | undefined, updatedAt: number): void;
  /**
   * Permanent deletion: removes the Tasks targeting the Content with their stage runs, work
   * units and results, every transcript revision, the draft, reference texts, all artifacts
   * and revisions, rollup partials, the chat thread, notes, content-scoped terminology and
   * media asset rows. Usage rows stay with their Content, Task and artifact references
   * cleared. Callers first refuse deletion while a Task is unfinished, and queue the files
   * for removal in the same transaction.
   */
  delete(ownerUserId: string, contentId: string): boolean;
}

export interface CollectionRepository {
  get(ownerUserId: string, collectionId: string): Collection | undefined;
  list(ownerUserId: string): Collection[];
  insert(collection: Collection): void;
  /** The owner's Collection created for a platform collection or playlist, if any. */
  findByPlatformCollectionId(ownerUserId: string, platformCollectionId: string): Collection | undefined;
  /** Both the collection and the content must belong to `ownerUserId`. */
  addItem(ownerUserId: string, item: CollectionItem): void;
  /**
   * Every item, trashed members included, ordered by `position`. Only for writes that must
   * see every slot (adding a member, reordering, touching, import enrolment) and the trash
   * checks; anything shown or summarised reads `listVisibleItems`.
   */
  listItems(ownerUserId: string, collectionId: string): CollectionItem[];
  /** The items whose Content is outside the trash, ordered by `position`. */
  listVisibleItems(ownerUserId: string, collectionId: string): CollectionItem[];
  /** Only the given fields change; `description: undefined` inside `patch` clears it. */
  update(ownerUserId: string, collectionId: string, patch: { name?: string; description?: string | undefined }): void;
  /** An item of one of the owner's collections. */
  getItem(ownerUserId: string, itemId: string): CollectionItem | undefined;
  findItem(ownerUserId: string, collectionId: string, contentId: string): CollectionItem | undefined;
  removeItem(ownerUserId: string, collectionId: string, itemId: string): boolean;
  /**
   * Puts the named items into the order of `itemIds` within the positions they hold now:
   * the smallest of those positions goes to the first id, and so on. Items not named keep
   * theirs, so a trashed member returns to its old slot when restored.
   */
  reorder(ownerUserId: string, collectionId: string, itemIds: readonly string[]): void;
  /**
   * Sets the collection's `updatedAt` to `at`, in the transaction of the change that warrants
   * it: creation, a new name or description, members added or removed, a member entering or
   * leaving the trash, reordering, a new collection summary. A member's own processing or
   * renaming does not count.
   */
  touch(ownerUserId: string, collectionId: string, at: number): void;
  /** Marks every collection holding `contentId` changed: when it enters or leaves the trash, and before its purge removes its items. */
  touchByContent(ownerUserId: string, contentId: string, at: number): void;
  /**
   * Deletes the collection with its items, its collection summary, collection-scoped
   * terminology and the Tasks targeting it. Member Contents stay; usage rows stay with their
   * Task references cleared. Callers first refuse deletion while a Task is unfinished.
   */
  delete(ownerUserId: string, collectionId: string): boolean;
  /**
   * The owner's collections each Content belongs to, oldest membership first; Contents in
   * no collection map to an empty list.
   */
  membershipsOf(ownerUserId: string, contentIds: readonly string[]): Map<string, Array<{ id: string; name: string; itemId: string }>>;
}

export interface MediaAssetRepository {
  get(ownerUserId: string, assetId: string): MediaAsset | undefined;
  listByContent(ownerUserId: string, contentId: string): MediaAsset[];
  /** The Task-scoped assets (`extracted_audio` / `temporary`) of one Task, oldest first. */
  listByTask(ownerUserId: string, taskId: string): MediaAsset[];
  /** Assets of `ownerUserId` with this content hash, oldest first; used for the duplicate-file hint. */
  findByFingerprint(ownerUserId: string, fingerprint: string): MediaAsset[];
  /** The owner's `available` `platform_cache` assets, oldest first: the order cache eviction follows. */
  listAvailableCaches(ownerUserId: string): MediaAsset[];
  /**
   * Every user's `available` `platform_cache` assets, oldest first. An instance-level
   * operation: the cache root is one directory shared by all users, and moving it is an
   * administrator's action on the whole cache. Used only by the cache root
   * service, never on behalf of one user.
   */
  listAvailableCachesUnscoped(): MediaAsset[];
  /**
   * Every user's `platform_cache` assets stored at `storageRef`, in any availability. An
   * instance-level read like the one above: the start-up sweep decides from them whether a
   * file in the shared cache directory is Amber's leftover or a file it knows nothing about.
   */
  listCachesByStorageRefUnscoped(storageRef: string): MediaAsset[];
  /** Every `platform_cache` asset of the owner in any availability, oldest first: the files to clean up when the user is deleted. */
  listCachesOfUser(ownerUserId: string): MediaAsset[];
  /** `available` `temporary` assets of the owner's `burn` Tasks, the burn products not yet saved out, oldest first. */
  listBurnOutputs(ownerUserId: string): MediaAsset[];
  insert(asset: MediaAsset): void;
  /** Rewrites the mutable fields: storage location, MIME type, size, duration, quality and whether it was verified, fingerprint, availability. */
  update(ownerUserId: string, asset: MediaAsset): void;
  delete(ownerUserId: string, assetId: string): boolean;
}

export interface TranscriptRepository {
  /**
   * Commits a revision with its segments and lineage. Invariant: a committed revision and
   * its segments are immutable, and every segment has valid timing. Throws unless the
   * Content is the owner's, `checkTranscriptInvariants` finds nothing and every source
   * segment belongs to the parent revision.
   */
  insertRevision(ownerUserId: string, revision: TranscriptRevision, segments: readonly TranscriptSegment[]): void;
  getRevision(ownerUserId: string, revisionId: string): TranscriptRevision | undefined;
  /** Oldest first. */
  listRevisions(ownerUserId: string, contentId: string): TranscriptRevision[];
  /**
   * Ordered by `ordinal`; with a page, at most `limit` segments whose ordinal is greater
   * than `afterOrdinal` (keyset paging).
   */
  listSegments(ownerUserId: string, revisionId: string, page?: { afterOrdinal?: number; limit: number }): TranscriptSegment[];
  /** A segment by its globally unique id, when its revision belongs to the owner. */
  getSegment(ownerUserId: string, segmentId: string): TranscriptSegment | undefined;
  /** The Content's draft, if any; there is at most one per Content. */
  getDraft(ownerUserId: string, contentId: string): TranscriptDraft | undefined;
  /**
   * Inserts the Content's draft or replaces it whole; there is at most one per Content.
   * Its base revision must belong to the same Content.
   */
  putDraft(ownerUserId: string, draft: TranscriptDraft): void;
  deleteDraft(ownerUserId: string, contentId: string): boolean;
  /**
   * Removes one revision with its sentences, their lineage rows and its archive mark. The
   * caller has checked that nothing references it any more and deletes children first; a
   * remaining reference fails the statement.
   */
  deleteRevision(ownerUserId: string, revisionId: string): boolean;
  /** The Content's archived revisions with the time each was archived. */
  listArchived(ownerUserId: string, contentId: string): Array<{ revisionId: string; archivedAt: number }>;
  /** Archives the revision at `archivedAt`, or restores it when `archivedAt` is undefined; idempotent either way. */
  setArchived(ownerUserId: string, revisionId: string, archivedAt: number | undefined): void;
}

/**
 * Reads the rows that point at a Content's transcript revisions, so a revision is deleted
 * only when nothing would be left dangling.
 */
export interface RevisionReferenceRepository {
  /**
   * Every child revision, the draft, notes, highlights, chat messages and compactions,
   * summaries, rollup partials, chapters, the owner's collection summaries and the owner's
   * unfinished Tasks that reach a revision of the Content. An unfinished Task of the Content
   * itself reaches all of its revisions, since its stages may read the primary as their base
   * at run time. Rows that reach none of its revisions may or may not be included.
   */
  listReferences(ownerUserId: string, contentId: string): RevisionReference[];
}

export interface ImportBatchRepository {
  get(ownerUserId: string, batchId: string): ImportBatch | undefined;
  insert(batch: ImportBatch): void;
}

/** Position in the newest-first task listing. */
export interface TaskCursor {
  createdAt: number;
  id: string;
}

export interface TaskRepository {
  get(ownerUserId: string, taskId: string): Task | undefined;
  /**
   * Newest first (`createdAt`, then `id`), strictly after `after` when given; optionally
   * only unfinished or only finished Tasks, only those targeting one Content or Collection, and
   * only one kind.
   * Tasks of a trashed Content are never listed.
   */
  list(
    ownerUserId: string,
    options: { limit: number; after?: TaskCursor; unfinished?: boolean; finished?: boolean; contentId?: string; collectionId?: string; kind?: TaskKind },
  ): Task[];
  /** Every Task targeting the Content, oldest first. */
  listByContent(ownerUserId: string, contentId: string): Task[];
  /** Every Task targeting the Collection, oldest first. */
  listByCollection(ownerUserId: string, collectionId: string): Task[];
  /**
   * The scheduler's queue: unfinished Tasks of every user in FIFO order (`createdAt`, `id`).
   * Only the in-process scheduler reads across owners; it never exposes the result.
   */
  listUnfinished(): Task[];
  /** The owner's unfinished Tasks in FIFO order (`createdAt`, `id`). */
  listUnfinishedOf(ownerUserId: string): Task[];
  /**
   * A Task by id alone, for start-up file sweeping where only a `tmp/tasks/<taskId>/`
   * directory name is known. Never used to answer a request.
   */
  getUnscoped(taskId: string): Task | undefined;
  insert(task: Task): void;
  /** `finishedAt` is set for terminal projections and cleared otherwise. */
  setProjection(ownerUserId: string, taskId: string, status: ProcessingStatus, finishedAt: number | undefined): void;
}

export interface StageRunRepository {
  /** Every attempt of every stage, in insertion order. */
  listByTask(ownerUserId: string, taskId: string): StageRun[];
  insert(ownerUserId: string, run: StageRun): void;
  /** Rewrites the mutable fields; `inputJson` can only be set while still absent. */
  update(ownerUserId: string, run: StageRun): void;
}

export interface WorkUnitRepository {
  get(ownerUserId: string, workUnitId: string): WorkUnit | undefined;
  listByStageRun(ownerUserId: string, stageRunId: string): WorkUnit[];
  listByTask(ownerUserId: string, taskId: string): WorkUnit[];
  insert(ownerUserId: string, unit: WorkUnit): void;
  update(ownerUserId: string, unit: WorkUnit): void;
  getResult(ownerUserId: string, workUnitId: string): WorkUnitResult | undefined;
  /**
   * Written in the same transaction as the unit's `succeeded` state: a DB-only unit counts as
   * done only when both exist and the payload digest equals `outputDigest`.
   */
  putResult(ownerUserId: string, result: WorkUnitResult): void;
}

export interface IdempotencyRepository {
  get(ownerUserId: string, route: string, key: string): IdempotencyRecord | undefined;
  insert(record: IdempotencyRecord): void;
  /**
   * Drops the owner's records whose created resources or response name one of the revisions,
   * so a replay of the key runs the request again instead of returning a deleted id.
   */
  deleteReferencingRevisions(ownerUserId: string, revisionIds: readonly string[]): number;
  /**
   * Repoints the owner's records that created or name any of `fromIds` to `toId` (a chat
   * retry replaced those answers): a replay of the original key then returns the answer that
   * is in effect now. Returns how many records changed.
   */
  rebindResourceRefs(ownerUserId: string, fromIds: readonly string[], toId: string): number;
}

/** The single instance-level settings row; not owned by any user. */
export interface InstanceSettingsRepository {
  get(): InstanceSettings | undefined;
  /** Insert or replace the single row. */
  put(settings: InstanceSettings): void;
}

/** One preferences row per user. */
export interface UserSettingsRepository {
  get(ownerUserId: string): UserSettings | undefined;
  /** Insert or replace the owner's row. */
  put(settings: UserSettings): void;
  /**
   * Clears the chat and default model references that point at the Profile; with
   * `keepModelIds`, only those naming a model outside that list.
   */
  clearModelRefs(ownerUserId: string, providerProfileId: string, keepModelIds?: readonly string[]): void;
  /**
   * Clears the default ASR model reference when it points at the profile; with
   * `keepModelIds`, only when it names a model outside that list.
   */
  clearAsrModelRefs(ownerUserId: string, asrProfileId: string, keepModelIds?: readonly string[]): void;
  /** Clears the default template reference when it names this template. */
  clearDefaultTemplate(ownerUserId: string, templateId: string): void;
}

/** LLM endpoint profiles with their models; `models` keeps the order the user gave. */
export interface ProviderProfileRepository {
  get(ownerUserId: string, profileId: string): ProviderProfile | undefined;
  /** In the user's order; a new profile goes last. */
  list(ownerUserId: string): ProviderProfile[];
  insert(profile: ProviderProfile): void;
  /**
   * Rewrites name, baseURL and credentialRef, and replaces the model list with
   * `profile.models` as given, every capability layer included. Unknown or foreign ids throw.
   */
  update(profile: ProviderProfile): void;
  /** Deleting a profile deletes its Secret; usage rows keep their snapshot. */
  delete(ownerUserId: string, profileId: string): boolean;
  /** Numbers the given profiles 0, 1, 2… in that order; a foreign or unknown id throws. */
  reorder(ownerUserId: string, profileIds: readonly string[]): void;
  /**
   * Instance-wide, for "reset all credentials" (which also recovers from a master key that
   * can no longer decrypt the stored Secrets): every profile loses its credential reference.
   */
  clearAllCredentialRefs(): number;
}

/** A user's ASR profiles; several per user, `models` in the order the user gave. */
export interface AsrProfileRepository {
  get(ownerUserId: string, profileId: string): AsrProviderProfile | undefined;
  /** In the user's order; a new profile goes last. */
  list(ownerUserId: string): AsrProviderProfile[];
  insert(profile: AsrProviderProfile): void;
  /** Rewrites an existing profile of `profile.userId` in place (same `id`); `false` when there is none. */
  update(profile: AsrProviderProfile): boolean;
  /**
   * Deleting a profile deletes its Secret; usage rows keep their provider /
   * model snapshot. A default naming it is cleared by the caller (`clearAsrModelRefs`).
   */
  delete(ownerUserId: string, profileId: string): boolean;
  /** Numbers the given profiles 0, 1, 2… in that order; a foreign or unknown id throws. */
  reorder(ownerUserId: string, profileIds: readonly string[]): void;
  /**
   * Instance-wide, for "reset all credentials" (which also recovers from a master key that
   * can no longer decrypt the stored Secrets): every profile loses its credential reference.
   */
  clearAllCredentialRefs(): number;
}

/** At most one web search service per user. */
export interface WebSearchProfileRepository {
  get(ownerUserId: string): WebSearchProfile | undefined;
  /** Inserts or replaces the user's single profile. */
  put(profile: WebSearchProfile): void;
  /** Deletes it with its Secret; `false` when there was none. */
  delete(ownerUserId: string): boolean;
  /** Credential reset: every profile forgets its Secret reference (the Secrets go in the same transaction). */
  clearCredentials(): void;
}

/** A user's register of models Amber does not call; in the user's order. */
export interface OtherModelProfileRepository {
  get(ownerUserId: string, profileId: string): OtherModelProfile | undefined;
  /** In the user's order; a new profile goes last. */
  list(ownerUserId: string): OtherModelProfile[];
  insert(profile: OtherModelProfile): void;
  /** Rewrites name, note and models of an existing profile of `profile.userId`; `false` when there is none. */
  update(profile: OtherModelProfile): boolean;
  delete(ownerUserId: string, profileId: string): boolean;
  /** Numbers the given profiles 0, 1, 2… in that order; a foreign or unknown id throws. */
  reorder(ownerUserId: string, profileIds: readonly string[]): void;
}

export interface AsrUsageQuery {
  taskId?: string;
  contentId?: string;
  /** Inclusive lower bound on `createdAt`. */
  since?: number;
  /** Exclusive upper bound on `createdAt`. */
  until?: number;
}

export interface TokenUsageQuery extends AsrUsageQuery {
  feature?: TokenUsageFeature;
}

/** One row per LLM request that crossed the send boundary, written right after it. */
export interface TokenUsageRepository {
  insert(usage: TokenUsage): void;
  /** Oldest first (`createdAt`, then `id`). */
  list(ownerUserId: string, query?: TokenUsageQuery): TokenUsage[];
  /**
   * Attributes exactly the given invocations to the revision (or RollupPartial) they
   * produced, inside the publishing transaction; returns how many rows were updated.
   * Rows of other users are never touched.
   */
  attach(ownerUserId: string, invocationIds: readonly string[], artifactRevisionId: string): number;
}

/** Append-only: one row per ASR submission that crossed the send boundary. */
export interface AsrUsageRepository {
  insert(usage: AsrUsage): void;
  /** Oldest first. */
  list(ownerUserId: string, query?: AsrUsageQuery): AsrUsage[];
}

/** One terminology set per scope (global, collection or content) and owner. */
export interface TerminologyRepository {
  /** The set of one scope with its entries in `ordinal` order, if the owner has one. */
  get(ownerUserId: string, scope: TerminologyScope): TerminologySet | undefined;
  /**
   * Replaces the whole set of `set.scope` (entries included); a set without entries is
   * removed. A collection or content scope must name one of the owner's own.
   */
  put(set: TerminologySet): void;
  /**
   * The effective set for one Content: content scope, then each collection the Content
   * belongs to in ascending `CollectionItem.addedAt`, then global, merged by
   * `normalizedKey` with the earlier scope winning, ordered by scope then `ordinal`.
   */
  effectiveFor(ownerUserId: string, contentId: string): TerminologyEntry[];
  /** The effective set for a collection summary: collection scope, then global, merged the same way. */
  effectiveForCollection(ownerUserId: string, collectionId: string): TerminologyEntry[];
}

/**
 * Builtin templates have no owner and are visible to everyone; custom ones only to their
 * owner. Versions are append-only so every PromptRef stays resolvable.
 */
export interface SummaryTemplateRepository {
  /** A builtin or owned template, soft-deleted ones included. */
  get(ownerUserId: string, templateId: string): SummaryTemplate | undefined;
  /** Builtin templates first (by id), then the owner's (by id); soft-deleted ones only when asked. */
  list(ownerUserId: string, options?: { includeDeleted?: boolean }): SummaryTemplate[];
  getVersion(ownerUserId: string, templateId: string, version: number): SummaryTemplateVersion | undefined;
  /** Oldest first. */
  listVersions(ownerUserId: string, templateId: string): SummaryTemplateVersion[];
  /** A custom template (with `userId`) and its first version. */
  insert(template: SummaryTemplate, firstVersion: SummaryTemplateVersion): void;
  /** Appends `version.version`, which must be `currentVersion + 1`, and advances `currentVersion`. */
  addVersion(ownerUserId: string, version: SummaryTemplateVersion): void;
  rename(ownerUserId: string, templateId: string, name: string): void;
  /** Custom templates only; builtin ones cannot be deleted. */
  softDelete(ownerUserId: string, templateId: string, deletedAt: number): boolean;
  /**
   * Makes the builtin rows match the code: inserts missing templates and appends versions
   * the table lacks; never rewrites an existing version.
   */
  syncBuiltin(
    templates: ReadonlyArray<{ id: string; name: string; versions: ReadonlyArray<{ version: number; prompt: string }> }>,
    createdAt: number,
  ): void;
}

export interface SummaryRepository {
  getArtifact(ownerUserId: string, artifactId: string): SummaryArtifact | undefined;
  findArtifact(ownerUserId: string, contentId: string, templateId: string): SummaryArtifact | undefined;
  /** The Content's summary artifacts, one per template. */
  listArtifacts(ownerUserId: string, contentId: string): SummaryArtifact[];
  /**
   * Stores an immutable revision, creating the `(contentId, templateId)` artifact with
   * `artifactId` on first use; returns the artifact actually used. Does not move current.
   */
  insertRevision(
    ownerUserId: string,
    input: { contentId: string; templateId: string; artifactId: string; revision: Omit<SummaryRevision, "artifactId"> },
  ): { artifactId: string };
  getRevision(ownerUserId: string, revisionId: string): SummaryRevision | undefined;
  /** Oldest first. */
  listRevisions(ownerUserId: string, artifactId: string): SummaryRevision[];
  /** The revision must belong to the artifact. */
  setCurrent(ownerUserId: string, artifactId: string, revisionId: string): void;
}

export interface CollectionSummaryRepository {
  getArtifact(ownerUserId: string, collectionId: string): CollectionSummaryArtifact | undefined;
  /** Like `SummaryRepository.insertRevision`, for the collection's single artifact. */
  insertRevision(
    ownerUserId: string,
    input: { collectionId: string; artifactId: string; revision: Omit<CollectionSummaryRevision, "artifactId"> },
  ): { artifactId: string };
  getRevision(ownerUserId: string, revisionId: string): CollectionSummaryRevision | undefined;
  /** Oldest first. */
  listRevisions(ownerUserId: string, collectionId: string): CollectionSummaryRevision[];
  getCurrent(ownerUserId: string, collectionId: string): CollectionSummaryRevision | undefined;
  setCurrent(ownerUserId: string, collectionId: string, revisionId: string): void;
}

/**
 * Rolling-summary intermediates: each group's partial, copied from its work-unit result in
 * the final publish transaction.
 */
export interface RollupPartialRepository {
  /** `owner` names the revision kind the partials belong to; that revision must be the owner's. */
  insertMany(ownerUserId: string, owner: "summary" | "collection_summary", partials: readonly RollupPartial[]): void;
  /** By `index`. */
  listByOwnerRevision(ownerUserId: string, ownerRevisionId: string): RollupPartial[];
}

export interface ChapterRepository {
  /** Used by the `no_platform_chapters` stage condition. */
  hasPlatformChapters(ownerUserId: string, contentId: string): boolean;
  /**
   * Stores platform chapters as a `ChapterRevision(origin = platform)`, creating the
   * Content's ChapterArtifact on first use. An existing platform revision with the same
   * chapters is reused instead, so reprocessing adds a platform revision only when the
   * chapters changed; `created` tells which happened.
   */
  insertPlatformRevision(
    ownerUserId: string,
    contentId: string,
    revision: { id: string; artifactId: string; chapters: readonly ChapterEntry[]; createdAt: number },
  ): { revisionId: string; created: boolean };
  /**
   * Stores AI chapters as a `ChapterRevision(origin = ai)` built from one transcript
   * revision, creating the Content's ChapterArtifact (with `artifactId`) on first use. It
   * does not move the current pointer.
   */
  insertAiRevision(
    ownerUserId: string,
    contentId: string,
    revision: {
      id: string;
      artifactId: string;
      transcriptRevisionId: string;
      chapters: ChapterRevision["chapters"];
      modelRef: ModelRefSnapshot;
      promptRef: PromptRef;
      promptSnapshot: string;
      quality: ChapterRevision["quality"];
      createdAt: number;
    },
  ): void;
  getArtifact(ownerUserId: string, contentId: string): ChapterArtifact | undefined;
  getRevision(ownerUserId: string, revisionId: string): ChapterRevision | undefined;
  /** Every revision of the Content's ChapterArtifact, oldest first. */
  listRevisions(ownerUserId: string, contentId: string): ChapterRevision[];
  /** The revision the Content's ChapterArtifact currently points at. */
  getCurrent(ownerUserId: string, contentId: string): ChapterRevision | undefined;
  /** The revision must belong to the Content's ChapterArtifact. */
  setCurrent(ownerUserId: string, contentId: string, revisionId: string): void;
}

export interface ReferenceTextRepository {
  insert(ownerUserId: string, text: ReferenceText): void;
  listByContent(ownerUserId: string, contentId: string): ReferenceText[];
}

/** One account per `(userId, platform)`; deleting it deletes its Secret. */
export interface PlatformAccountRepository {
  get(ownerUserId: string, platform: Platform): PlatformAccount | undefined;
  list(ownerUserId: string): PlatformAccount[];
  insert(account: PlatformAccount): void;
  setStatus(ownerUserId: string, platform: Platform, status: PlatformAccountStatus, checkedAt: number | undefined): void;
  delete(ownerUserId: string, platform: Platform): boolean;
  /** Instance-wide, for "reset all credentials": every platform account is deleted and its Secret goes with it. */
  deleteAll(): number;
}

/**
 * Where a search looks: `global` covers every group including collections, `library` only
 * Contents with their transcript and summary hits, and a collection scope only that
 * collection's members; it names one of the owner's collections.
 */
export type SearchScope = { kind: "global" } | { kind: "library" } | { kind: "collection"; collectionId: string };

/**
 * How the query's terms are matched: FTS phrases, or a bounded `LIKE` scan for queries
 * shorter than three characters, which the trigram tokenizer cannot match.
 */
export interface SearchIndexQuery {
  /** Whitespace-separated terms; every term must occur. Matched literally, never as syntax. */
  terms: readonly string[];
  mode: "fts" | "like";
  scope: SearchScope;
  /** Hits kept per group. */
  groupLimit: number;
  /** Rows the `like` scan may inspect before grouping (`SEARCH_SHORT_QUERY_LIMIT`). */
  likeLimit: number;
}

/** One matched projection row, best first within its kind; the indexed text is returned whole. */
export type SearchIndexHit =
  | { kind: "title" | "reference"; contentId: string; text: string }
  | { kind: "segment"; contentId: string; transcriptRevisionId: string; segmentId: string; startMs: number; text: string }
  | { kind: "summary"; contentId: string; artifactId: string; templateId: string; summaryRevisionId: string; text: string }
  | { kind: "collection"; collectionId: string; text: string };

/**
 * The FTS5 search projection. It is never a source of truth: every write that
 * changes the corpus (a Content's title, primary revision, current summaries or reference
 * texts; a Collection's name or description; deletions) calls `sync*` / `remove*` in the
 * same transaction, and `rebuild` derives the whole table again from the business tables.
 * Collection membership is not projected: a collection scope filters through
 * `collection_item` at query time.
 */
export interface SearchIndexRepository {
  /** Re-derives every row of one Content (title, primary segments, current summaries, reference texts). */
  syncContent(ownerUserId: string, contentId: string): void;
  removeContent(ownerUserId: string, contentId: string): void;
  syncCollection(ownerUserId: string, collectionId: string): void;
  removeCollection(ownerUserId: string, collectionId: string): void;
  /** Hits of the owner within the scope; titles and template ids are joined from the business tables. */
  query(ownerUserId: string, query: SearchIndexQuery): SearchIndexHit[];
  /**
   * Chat retrieval when the transcript does not fit the model's budget: segments of one
   * revision of the owner ranked by `bm25()` against the OR of the question's character
   * trigrams; ids best first.
   */
  matchSegments(ownerUserId: string, transcriptRevisionId: string, question: string, limit: number): string[];
  /** Drops and re-derives the projection of every user. */
  rebuild(): void;
  /** False when the FTS integrity check fails or the projection is missing while data exists. */
  healthy(): boolean;
}

/** A thread with what is derived from its messages when read. */
export interface ChatThreadSummary extends ChatThread {
  /** Text of its first user message (`createdAt`, then `id`); absent while it has none. */
  firstQuestion?: string;
  /** `createdAt` of its newest message; absent while it has none. */
  lastMessageAt?: number;
}

/** The outcome of a streamed answer. */
export type ChatMessageOutcome = Pick<ChatMessage, "id" | "text" | "status" | "citations" | "suggestions" | "webSearch" | "error" | "finishedAt">;

/**
 * Chat threads of a Content. A message changes only once, to its final state; a compaction
 * only ever moves its end to an earlier message. Deleting a turn or a thread deletes rows.
 */
export interface ChatRepository {
  /** The Content's threads, newest first (`createdAt`, then `id`, descending). */
  listThreads(ownerUserId: string, contentId: string): ChatThreadSummary[];
  getThread(ownerUserId: string, threadId: string): ChatThreadSummary | undefined;
  /** The Content's newest thread. */
  latestThread(ownerUserId: string, contentId: string): ChatThreadSummary | undefined;
  insertThread(ownerUserId: string, thread: ChatThread): void;
  /** Deletes the thread with its messages and compactions; usage rows keep their snapshot. */
  deleteThread(ownerUserId: string, threadId: string): boolean;
  /** Deletes every thread of the Content; returns how many. */
  deleteThreadsOf(ownerUserId: string, contentId: string): number;
  /** Sets or clears (`undefined`) the thread's own title and its pin; `false` when it is not the owner's. */
  updateThread(ownerUserId: string, threadId: string, fields: { customTitle: string | undefined; pinnedAt: number | undefined }): boolean;
  /** Oldest first (`createdAt`, then `id`). */
  listMessages(ownerUserId: string, threadId: string): ChatMessage[];
  getMessage(ownerUserId: string, messageId: string): ChatMessage | undefined;
  insertMessage(ownerUserId: string, message: ChatMessage): void;
  /** Writes the outcome of a streamed answer. */
  finishMessage(ownerUserId: string, message: ChatMessageOutcome): void;
  /**
   * Deletes the owner's messages among `messageIds`; usage rows that named them keep their
   * snapshot. No compaction may still end on one of them. Returns how many went.
   */
  deleteMessages(ownerUserId: string, messageIds: readonly string[]): number;
  getCompaction(ownerUserId: string, compactionId: string): ChatCompaction | undefined;
  /** Oldest first (`createdAt`, then `id`). */
  listCompactions(ownerUserId: string, threadId: string): ChatCompaction[];
  /** Inserts the compaction and makes it the thread's current one. */
  insertCompaction(ownerUserId: string, compaction: ChatCompaction): void;
  /** Re-anchors a compaction on an earlier message of its thread; nothing else of it changes. */
  moveCompaction(ownerUserId: string, compactionId: string, throughMessageId: string): void;
  /** The thread's current compaction must not be this one any more. */
  deleteCompaction(ownerUserId: string, compactionId: string): void;
  /** `undefined` clears it. */
  setCurrentCompaction(ownerUserId: string, threadId: string, compactionId: string | undefined): void;
  /** Start-up: answers left `streaming` by a previous process become `interrupted` at `finishedAt`; returns how many. */
  interruptStreaming(finishedAt: number): number;
}

export interface HighlightRepository {
  /**
   * Stores AI highlights built from one transcript revision of the Content, creating the
   * Content's HighlightArtifact (with `artifactId`) on first use. It does not move the
   * current pointer.
   */
  insertRevision(
    ownerUserId: string,
    contentId: string,
    revision: {
      id: string;
      artifactId: string;
      transcriptRevisionId: string;
      items: HighlightRevision["items"];
      modelRef: ModelRefSnapshot;
      promptRef: PromptRef;
      promptSnapshot: string;
      quality: HighlightRevision["quality"];
      createdAt: number;
    },
  ): void;
  getArtifact(ownerUserId: string, contentId: string): HighlightArtifact | undefined;
  getRevision(ownerUserId: string, revisionId: string): HighlightRevision | undefined;
  /** The revision the Content's HighlightArtifact currently points at. */
  getCurrent(ownerUserId: string, contentId: string): HighlightRevision | undefined;
  /** The revision must belong to the Content's HighlightArtifact. */
  setCurrent(ownerUserId: string, contentId: string, revisionId: string): void;
}

export interface TranslationRepository {
  getArtifact(ownerUserId: string, contentId: string, targetLanguage: string): TranslationArtifact | undefined;
  /** Every TranslationArtifact of the Content, by target language. */
  listArtifacts(ownerUserId: string, contentId: string): TranslationArtifact[];
  /**
   * Points the language's TranslationArtifact at a `translated` revision of the Content in
   * that language, creating the artifact (with `artifactId`) on first use.
   */
  setCurrent(ownerUserId: string, contentId: string, targetLanguage: string, revisionId: string, artifactId: string): void;
  /** Removes the language's TranslationArtifact; its revisions are not touched. */
  deleteArtifact(ownerUserId: string, contentId: string, targetLanguage: string): boolean;
}

/** Position in the latest-first listing of note groups. */
export interface NoteGroupCursor {
  latestAt: number;
  contentId: string;
}

/** One Content that has notes: how many, and when the newest was created. */
export interface NoteGroup {
  contentId: string;
  count: number;
  latestAt: number;
}

/** A note with the start time of its first sentence, which orders it and is shown with it. */
export type TimedNote = Note & { startMs: number };

export interface NoteRepository {
  get(ownerUserId: string, noteId: string): TimedNote | undefined;
  /** In reading order of the anchor: start sentence `startMs`, then `startOffset`, `createdAt`, `id`. */
  listByContent(ownerUserId: string, contentId: string): TimedNote[];
  countByContent(ownerUserId: string, contentId: string): number;
  insert(note: Note): void;
  /** Only `mark / color / comment` can change; `comment: undefined` inside `patch` clears it. */
  update(ownerUserId: string, noteId: string, patch: { mark?: NoteMark; color?: NoteColor; comment?: string | undefined }, updatedAt: number): boolean;
  delete(ownerUserId: string, noteId: string): boolean;
  /** Latest first (`latestAt`, then `contentId`), from `position`; trashed Contents are left out. */
  listGroups(ownerUserId: string, position: ListPosition<NoteGroupCursor>): NoteGroup[];
  /** Contents outside the trash that have notes. */
  countGroups(ownerUserId: string): number;
}

/**
 * The instance-level queue of files to remove, not owned by any user, so it outlives a
 * deleted user. Purges register files here in the transaction that deletes their rows and a
 * worker removes them afterwards. Rows are unique per `(store, rootPath, storageRef)`.
 */
export interface PendingFileDeleteRepository {
  /** Registers a file; one already registered for the same root and ref keeps its row. */
  insert(entry: PendingFileDelete): void;
  /** Rows due at `now`, earliest first. */
  listDue(now: number, limit: number): PendingFileDelete[];
  /** Every row of one store, whatever its due time. */
  listByStore(store: PendingFileDelete["store"]): PendingFileDelete[];
  /** Records a failed attempt. */
  reschedule(id: string, attempts: number, nextAttemptAt: number, lastError: string | undefined): void;
  delete(id: string): void;
  /** The earliest `nextAttemptAt` of any row. */
  earliestAttemptAt(): number | undefined;
}

/** Entity repositories available inside a transaction. */
export interface RepositoryScope {
  users: UserRepository;
  sessions: SessionRepository;
  networkAllowlist: NetworkAllowlistRepository;
  contents: ContentRepository;
  collections: CollectionRepository;
  mediaAssets: MediaAssetRepository;
  transcripts: TranscriptRepository;
  revisionReferences: RevisionReferenceRepository;
  secretEnvelopes: SecretEnvelopeStore;
  importBatches: ImportBatchRepository;
  tasks: TaskRepository;
  stageRuns: StageRunRepository;
  workUnits: WorkUnitRepository;
  idempotency: IdempotencyRepository;
  instanceSettings: InstanceSettingsRepository;
  userSettings: UserSettingsRepository;
  providerProfiles: ProviderProfileRepository;
  asrProfiles: AsrProfileRepository;
  otherModelProfiles: OtherModelProfileRepository;
  webSearchProfiles: WebSearchProfileRepository;
  asrUsage: AsrUsageRepository;
  terminology: TerminologyRepository;
  tokenUsage: TokenUsageRepository;
  chapters: ChapterRepository;
  highlights: HighlightRepository;
  translations: TranslationRepository;
  summaryTemplates: SummaryTemplateRepository;
  summaries: SummaryRepository;
  collectionSummaries: CollectionSummaryRepository;
  rollupPartials: RollupPartialRepository;
  referenceTexts: ReferenceTextRepository;
  platformAccounts: PlatformAccountRepository;
  search: SearchIndexRepository;
  chat: ChatRepository;
  notes: NoteRepository;
  pendingFileDeletes: PendingFileDeleteRepository;
}

/** Rejects callbacks that return a promise: a transaction cannot stay open across an await. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Persistence boundary. A result is published in exactly one transaction: new revision,
 * provenance, current pointers, token usage and WorkUnit / StageRun terminal states
 * commit together or not at all. This publication point is also what a backup export holds
 * back while it takes its snapshot.
 *
 * Transactions are synchronous: the callback runs to completion before commit, and a
 * thrown error rolls everything back. Slow or remote work happens before or after, never
 * inside.
 */
export interface Repository {
  withTransaction<T>(work: (scope: RepositoryScope) => NotPromise<T>): T;
}
