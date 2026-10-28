import { monotonicFactory } from "ulid";
import { IMPORT_BATCH_MAX, SUBTITLE_IMPORT_MAX_BYTES } from "../../shared/defaults.ts";
import type { ImportItem, ImportRequest, ImportResponse, InspectResponse } from "../../shared/dto/import.ts";
import { BYTES_PER_MB } from "../../shared/units.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import type { Collection } from "../domain/collection.ts";
import { platformContentKey, trashPurgeAt, type Content, type ContentSource } from "../domain/content.ts";
import type { AsrModelRef, PromptRef } from "../domain/model-ref.ts";
import { promptIdsOf } from "../domain/prompts.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import { canonicalLanguageTag, importedTranscript, parseTimedSubtitle, type ParsedSubtitle } from "../domain/subtitle-file.ts";
import type { Task } from "../domain/task.ts";
import {
  intentDifferences,
  sameIntent,
  type ProcessContentRequest,
  type RegenerateSummaryRequest,
} from "../domain/task-request.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { PlatformCredential, PlatformPart, PlatformSourceAdapter } from "../ports/platform-source.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import type { FairSemaphore } from "../pipeline/fair-semaphore.ts";
import { laneConflict, laneKeys, mutationLaneError } from "../pipeline/lane.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { expiringOnRefusal } from "../pipeline/stages/platform-access.ts";
import { type Outbox, transact } from "../pipeline/publish.ts";
import { modelRefProblem } from "../pipeline/requirements.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import { createTask } from "../pipeline/task-state.ts";
import { freezePromptRefs } from "./prompts.ts";
import { jsonRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";
import type { PlatformRegistry } from "./platforms.ts";
import { asrModelRefForSubmission } from "./settings.ts";
import { resolveTemplateRef } from "./summary-templates.ts";
import type { TaskControl } from "./tasks.ts";
import { restoreTrashed } from "./trash.ts";

export const IMPORT_ROUTE = "POST /api/contents/import";

/** Settings fields whose change alone is served by a new summary rather than a new pass. */
const SUMMARY_ONLY_FIELDS: ReadonlySet<string> = new Set([
  "templateRef",
  "outputLanguage",
  "modelRef",
  ...promptIdsOf("regenerate_summary").map((id) => `promptRefs.${id}`),
]);

/** Prompts frozen by `process_content` that none of its stages sends. */
const UNUSED_PROMPT_FIELDS: readonly string[] = ["promptRefs.highlight.default"];

/** Prompts whose change, like `autoProofread`'s, changes nothing a pass does to a Content that already has a primary. */
const PROOFREAD_PROMPT_FIELDS: readonly string[] = ["promptRefs.proofread.text", "promptRefs.proofread.audio"];

/**
 * Like `intentDifferences`, with frozen prompt versions compared prompt by prompt
 * (`promptRefs.<id>`). A request stored before prompts were frozen ran with whatever was in
 * effect then, so against it prompt versions are not compared at all.
 */
function requestDifferences(requestJson: string, otherJson: string, ignore: readonly string[]): string[] {
  const differences = intentDifferences(requestJson, otherJson, [...ignore, "promptRefs"]);
  const a = (JSON.parse(requestJson) as { promptRefs?: Record<string, PromptRef> }).promptRefs;
  const b = (JSON.parse(otherJson) as { promptRefs?: Record<string, PromptRef> }).promptRefs;
  if (a === undefined || b === undefined) {
    return differences;
  }
  const prompts = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((id) => canonicalJson(a[id] ?? null) !== canonicalJson(b[id] ?? null))
    .map((id) => `promptRefs.${id}`)
    .filter((field) => !ignore.includes(field));
  return [...differences, ...prompts].sort();
}

export interface ImportContentServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  platforms: PlatformRegistry;
  /** The user's login for a platform, when there is one, and where a refused login is recorded. */
  credentials: {
    credentialFor(ownerUserId: string, platform: PlatformSourceAdapter["kind"]): PlatformCredential | undefined;
    markExpired(ownerUserId: string, platform: PlatformSourceAdapter["kind"]): void;
  };
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  /**
   * The instance's managed heavy-job governor: every collection listing and
   * part resolution takes a slot in the user's foreground group, whatever the platform.
   * Without it they run directly.
   */
  heavy?: Pick<FairSemaphore, "run">;
  now?: () => number;
  newId?: () => string;
}

interface InitialSubtitle {
  subtitle: ParsedSubtitle;
  language: string;
}

/**
 * One Content-to-be after URL recognition, part selection and collection expansion.
 * `direct` items were named by the request itself, `expanded` ones came from listing a
 * platform collection: only a direct item brings a Content back from the trash.
 */
interface ResolvedItem {
  origin: "direct" | "expanded";
  source: ContentSource;
  title?: string;
  durationMs?: number;
  platformCollection?: { platformCollectionId: string; title: string };
  initialSubtitle?: InitialSubtitle;
}

function invalid(detail: string, message = `invalid ${detail}`): AmberError {
  return amberError("invalid_request", message, { params: { detail } });
}

function batchTooLarge(itemCount: number): AmberError {
  return amberError("invalid_request", "too many items in one import", {
    code: "invalid_request.batch_too_large",
    params: { limit: String(IMPORT_BATCH_MAX) },
    details: { itemCount, limit: IMPORT_BATCH_MAX },
  });
}

/** An initial subtitle given as text: UTF-8 by construction, format decided by content. */
function parseInitialSubtitle(item: ImportItem, index: number): InitialSubtitle | undefined {
  const given = item.initialSubtitle;
  if (given === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(given.text, "utf8") > SUBTITLE_IMPORT_MAX_BYTES) {
    throw amberError("media_too_large", "initial subtitle is too large", { params: { limit: `${SUBTITLE_IMPORT_MAX_BYTES / BYTES_PER_MB} MB` } });
  }
  const language = canonicalLanguageTag(given.language);
  if (language === undefined) {
    throw invalid(`items[${index}].initialSubtitle.language`);
  }
  const subtitle = parseTimedSubtitle(given.text);
  if (given.format !== undefined && given.format !== subtitle.format) {
    throw amberError("invalid_request", "subtitle content does not match its declared format", { code: "invalid_request.subtitle_format" });
  }
  return { subtitle, language };
}

/** The `regenerate_summary` request that carries a re-import's summary settings onto `baseRevisionId`. */
function summaryRequestJson(requestJson: string, baseRevisionId: string): string {
  const request = JSON.parse(requestJson) as ProcessContentRequest;
  const summary: RegenerateSummaryRequest = {
    requestSchemaVersion: 1,
    kind: "regenerate_summary",
    ...(request.modelRef === undefined ? {} : { modelRef: request.modelRef }),
    ...(request.outputLanguage === undefined ? {} : { outputLanguage: request.outputLanguage }),
    ...(request.templateRef === undefined ? {} : { templateRef: request.templateRef }),
    ...(request.promptRefs === undefined
      ? {}
      : { promptRefs: Object.fromEntries(promptIdsOf("regenerate_summary").flatMap((id) => (request.promptRefs?.[id] === undefined ? [] : [[id, request.promptRefs[id]]]))) }),
    baseRevisionId,
  };
  return canonicalJson(summary);
}

/**
 * `POST /api/contents/import` and `POST /api/contents/inspect` for platform links.
 * Everything that needs the network happens first — short-link expansion, part ids of
 * multi-part submissions, collection listings — and any failure there rejects the whole
 * batch before anything is written. Then one transaction creates the ImportBatch, the
 * Contents (with metadata known so far), any initial subtitles, Collections and Tasks.
 *
 * Re-importing an existing Content, by the first rule that holds: an unfinished
 * Task whose lane intersects is reused with the same intent and is a
 * `conflict.mutation_lane` otherwise; the latest `process_content` is reused when it
 * succeeded with the same intent; with a usable primary, a change of template, output
 * language or model alone becomes a `regenerate_summary`; anything else is a new
 * `process_content`. With a primary, `autoProofread` and `asrModelRef` take no part in
 * either comparison.
 * An idempotent replay answers what the first request did and never restores anything.
 */
export class ImportContentService {
  private readonly options: ImportContentServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: ImportContentServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  async import(
    principal: RequestPrincipal,
    body: ImportRequest,
    idempotencyKey?: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<IdempotentResult<ImportResponse>> {
    const owner = principal.userId;
    const context = { userId: owner, route: IMPORT_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest(body) };
    // A replay answers even while new work is paused and without going online again.
    const replay = this.options.repository.withTransaction((scope) =>
      idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, IMPORT_ROUTE, idempotencyKey),
    );
    let resolved: ResolvedItem[] = [];
    if (replay === undefined) {
      if (body.items.length > IMPORT_BATCH_MAX) {
        throw batchTooLarge(body.items.length);
      }
      const low = await diskLowError(this.options.disk, this.options.settings.effective());
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark");
      }
      resolved = await this.resolveItems(owner, body.items, signal);
    }
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
      runIdempotent(scope, context, this.now(), () => this.create(scope, outbox, owner, body, resolved)),
    );
    if (!result.replayed) {
      this.options.control.kick();
    }
    return result;
  }

  /** What `url` would import, for the new-content page's part and batch prompts; creates nothing. */
  async inspect(principal: RequestPrincipal, url: string, signal: AbortSignal = new AbortController().signal): Promise<InspectResponse> {
    const owner = principal.userId;
    const { adapter, auth, parsed } = await this.recognize(owner, url, signal);
    if (parsed.platformContentId === undefined) {
      const platformCollectionId = parsed.platformCollectionId as string;
      const collection = await this.heavyJob(owner, signal, () => adapter.fetchCollection(platformCollectionId, auth, signal));
      return {
        kind: "collection",
        canonicalUrl: parsed.canonicalUrl,
        title: collection.title,
        itemCount: collection.items.length,
        items: collection.items,
      };
    }
    if (adapter.resolveParts === undefined) {
      return { kind: "single", canonicalUrl: parsed.canonicalUrl };
    }
    const resolveParts = adapter.resolveParts.bind(adapter);
    const platformContentId = parsed.platformContentId;
    const parts = await this.heavyJob(owner, signal, () => resolveParts({ platformContentId }, auth, signal));
    const chosen = parsed.partIndex === undefined ? undefined : parts.find((part) => part.index === parsed.partIndex);
    if (parsed.partIndex !== undefined && chosen === undefined) {
      throw invalid("url", "the submission has no such part");
    }
    if (chosen !== undefined || parts.length === 1) {
      const part = (chosen ?? parts[0]) as PlatformPart;
      return { kind: "single", canonicalUrl: part.canonicalUrl, ...(part.title === "" ? {} : { title: part.title }) };
    }
    return {
      kind: "multipart",
      canonicalUrl: parsed.canonicalUrl,
      parts: parts.map(({ platformPartId, index, title, durationMs }) => ({ platformPartId, index, title, durationMs })),
    };
  }

  /**
   * Import parsing is the same kind of platform work as the pipeline's metadata steps, so it
   * counts against the same heavy-job capacity, in the user's foreground group.
   * Every adapter goes through it alike: the service never decides by platform.
   */
  private heavyJob<T>(owner: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const heavy = this.options.heavy;
    return heavy === undefined ? work() : heavy.run({ key: `foreground:${owner}`, createdAt: this.now() }, signal, work);
  }

  /** The adapter for `url` and the owner's login, set to record a login the platform refuses. */
  private async recognize(owner: string, url: string, signal: AbortSignal) {
    const { adapter, parsed } = await this.options.platforms.recognize(url, signal);
    const kind = adapter.kind;
    const auth = this.options.credentials.credentialFor(owner, kind);
    const credentials = this.options.credentials;
    return {
      adapter: auth === undefined ? adapter : expiringOnRefusal(adapter, () => credentials.markExpired(owner, kind)),
      auth,
      parsed,
    };
  }

  private async resolveItems(owner: string, items: readonly ImportItem[], signal: AbortSignal): Promise<ResolvedItem[]> {
    const subtitles = items.map((item, index) => parseInitialSubtitle(item, index));
    const resolved: ResolvedItem[] = [];
    const seen = new Map<string, ResolvedItem>();
    for (const [index, item] of items.entries()) {
      for (const candidate of await this.resolveItem(owner, item, index, subtitles[index], signal)) {
        const key = platformContentKey(owner, candidate.source) as string;
        const first = seen.get(key);
        if (first === undefined) {
          seen.set(key, candidate);
          resolved.push(candidate);
        } else if (candidate.origin === "direct") {
          // Named on its own as well as inside a collection: the user asked for it directly.
          first.origin = "direct";
        }
      }
    }
    if (resolved.length > IMPORT_BATCH_MAX) {
      throw batchTooLarge(resolved.length);
    }
    return resolved;
  }

  private async resolveItem(
    owner: string,
    item: ImportItem,
    index: number,
    initialSubtitle: InitialSubtitle | undefined,
    signal: AbortSignal,
  ): Promise<ResolvedItem[]> {
    const { adapter, auth, parsed } = await this.recognize(owner, item.url, signal);
    const kind = adapter.kind;
    if (parsed.platformContentId === undefined) {
      if (item.parts !== undefined || initialSubtitle !== undefined) {
        throw invalid(`items[${index}]`, "parts and initial subtitles apply to single videos only");
      }
      const platformCollectionId = parsed.platformCollectionId as string;
      const collection = await this.heavyJob(owner, signal, () => adapter.fetchCollection(platformCollectionId, auth, signal));
      return collection.items.map((entry) => ({
        origin: "expanded" as const,
        source: {
          kind,
          sourceUrl: entry.canonicalUrl,
          platformContentId: entry.platformContentId,
          ...(entry.platformPartId === undefined ? {} : { platformPartId: entry.platformPartId }),
          platformCollectionId,
        },
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
        platformCollection: { platformCollectionId, title: collection.title },
      }));
    }

    const platformContentId = parsed.platformContentId;
    if (adapter.resolveParts === undefined) {
      if (item.parts !== undefined) {
        throw invalid(`items[${index}].parts`, "this link has no parts to choose from");
      }
      return [
        { origin: "direct", source: { kind, sourceUrl: parsed.canonicalUrl, platformContentId }, ...(initialSubtitle === undefined ? {} : { initialSubtitle }) },
      ];
    }
    const resolveParts = adapter.resolveParts.bind(adapter);
    const parts = await this.heavyJob(owner, signal, () => resolveParts({ platformContentId }, auth, signal));
    const chosen = this.chooseParts(parts, parsed.partIndex, item.parts, index);
    if (initialSubtitle !== undefined && chosen.length !== 1) {
      throw invalid(`items[${index}].initialSubtitle`, "an initial subtitle belongs to exactly one part");
    }
    const multipart = parts.length > 1;
    return chosen.map((part) => ({
      origin: "direct" as const,
      source: { kind, sourceUrl: part.canonicalUrl, platformContentId, platformPartId: part.platformPartId },
      ...(multipart && part.title !== "" ? { title: part.title } : {}),
      ...(part.durationMs > 0 ? { durationMs: part.durationMs } : {}),
      ...(initialSubtitle === undefined ? {} : { initialSubtitle }),
    }));
  }

  /** `p=N` in the link picks one part; a multi-part submission without it needs an explicit choice. */
  private chooseParts(parts: readonly PlatformPart[], partIndex: number | undefined, choice: ImportItem["parts"], index: number): PlatformPart[] {
    if (partIndex !== undefined) {
      const part = parts.find((candidate) => candidate.index === partIndex);
      if (part === undefined) {
        throw invalid(`items[${index}].url`, "the submission has no such part");
      }
      return [part];
    }
    if (parts.length === 1) {
      return [...parts];
    }
    if (choice === undefined) {
      throw amberError("invalid_request", "choose which parts to import", {
        code: "invalid_request.multipart_choice_required",
        details: { parts: parts.map((part) => part.platformPartId) },
      });
    }
    if (choice === "first") {
      return [parts[0] as PlatformPart];
    }
    if (choice === "all") {
      return [...parts];
    }
    return choice.map((id) => {
      const part = parts.find((candidate) => candidate.platformPartId === id);
      if (part === undefined) {
        throw invalid(`items[${index}].parts`, "no such part id");
      }
      return part;
    });
  }

  private create(scope: RepositoryScope, outbox: Outbox, owner: string, body: ImportRequest, resolved: readonly ResolvedItem[]) {
    const { settings } = body;
    if (settings.modelRef !== undefined && modelRefProblem(scope, owner, settings.modelRef) !== undefined) {
      throw amberError("invalid_request", "modelRef does not name an owned model", { params: { detail: "settings.modelRef" } });
    }
    const templateRef = resolveTemplateRef(scope, owner, settings.templateId, "settings.templateId");
    const asrModelRef = asrModelRefForSubmission(scope, owner, settings.asrModelRef, "settings.asrModelRef");
    const target = body.collection;
    if (target !== undefined && "id" in target && scope.collections.get(owner, target.id) === undefined) {
      throw amberError("not_found", "collection not found");
    }
    const now = this.now();
    const batchId = this.newId();
    const fromCollections = resolved.length > 0 && resolved.every((item) => item.platformCollection !== undefined);
    // Contents in the trash: a direct item restores its Content in this
    // transaction; one found by expanding a collection, or one whose retention has run out,
    // is left where it is and only reported.
    const skippedTrashedContentIds: string[] = [];
    const processed: ResolvedItem[] = [];
    for (const item of resolved) {
      const existing = scope.contents.findByPlatformIdentity(owner, item.source);
      if (existing?.trashedAt !== undefined && (item.origin === "expanded" || trashPurgeAt(existing.trashedAt) <= now)) {
        skippedTrashedContentIds.push(existing.id);
      } else {
        processed.push(item);
      }
    }
    scope.importBatches.insert({
      id: batchId,
      userId: owner,
      createdAt: now,
      sourceType: fromCollections ? "platform_collection" : "links",
      totalItems: processed.length,
    });
    const created: string[] = [batchId];
    const taskIds: string[] = [];
    const contentIds: string[] = [];
    const members = new Map<string, string[]>();
    const enroll = (collectionId: string, contentId: string) => members.set(collectionId, [...(members.get(collectionId) ?? []), contentId]);

    let named: Collection | undefined;
    if (target !== undefined && "name" in target) {
      named = { id: this.newId(), userId: owner, name: target.name, createdAt: now, updatedAt: now };
      scope.collections.insert(named);
      scope.search.syncCollection(owner, named.id);
      created.push(named.id);
    }
    const platformCollections = new Map<string, Collection>();

    for (const item of processed) {
      const { content, task, createdIds } = this.createOrReuse(scope, outbox, owner, { ...frozen(settings, asrModelRef), templateRef }, batchId, item, now);
      created.push(...createdIds);
      contentIds.push(content.id);
      taskIds.push(task.id);
      if (item.platformCollection !== undefined) {
        const { platformCollectionId, title } = item.platformCollection;
        let collection = platformCollections.get(platformCollectionId) ?? scope.collections.findByPlatformCollectionId(owner, platformCollectionId);
        if (collection === undefined) {
          collection = { id: this.newId(), userId: owner, name: title, platformCollectionId, createdAt: now, updatedAt: now };
          scope.collections.insert(collection);
          scope.search.syncCollection(owner, collection.id);
          created.push(collection.id);
        }
        platformCollections.set(platformCollectionId, collection);
        enroll(collection.id, content.id);
      }
      if (target !== undefined) {
        enroll("id" in target ? target.id : (named as Collection).id, content.id);
      }
    }
    for (const [collectionId, contents] of members) {
      const items = scope.collections.listItems(owner, collectionId);
      const present = new Set(items.map((item) => item.contentId));
      let position = items.reduce((max, item) => Math.max(max, item.position), -1);
      let joined = false;
      for (const contentId of contents) {
        if (!present.has(contentId)) {
          present.add(contentId);
          scope.collections.addItem(owner, { id: this.newId(), collectionId, contentId, position: ++position, addedAt: now });
          joined = true;
        }
      }
      if (joined) scope.collections.touch(owner, collectionId, now);
    }
    return { status: 202, body: { importBatchId: batchId, taskIds, contentIds, skippedTrashedContentIds }, resourceRefs: created };
  }

  private createOrReuse(
    scope: RepositoryScope,
    outbox: Outbox,
    owner: string,
    settings: ImportRequest["settings"] & { templateRef: { id: string; version: number } },
    batchId: string,
    item: ResolvedItem,
    now: number,
  ): { content: Content; task: Task; createdIds: string[] } {
    const createdIds: string[] = [];
    const request: ProcessContentRequest = {
      requestSchemaVersion: 1,
      kind: "process_content",
      promptRefs: freezePromptRefs(scope, owner, "process_content"),
      ...(settings.modelRef === undefined ? {} : { modelRef: settings.modelRef }),
      ...(settings.asrModelRef === undefined ? {} : { asrModelRef: settings.asrModelRef }),
      ...(settings.outputLanguage === undefined ? {} : { outputLanguage: settings.outputLanguage }),
      autoProofread: settings.autoProofread,
      templateRef: settings.templateRef,
    };
    const found = scope.contents.findByPlatformIdentity(owner, item.source);
    if (found !== undefined) {
      if (item.initialSubtitle !== undefined) {
        throw amberError("conflict", "an initial subtitle can only come with a new content; import it into the existing one instead");
      }
      if (found.trashedAt !== undefined) {
        restoreTrashed(scope, owner, found, now);
      }
      const { trashedAt: _restored, ...existing } = found;
      const reused = this.reuseOrDerive(scope, outbox, existing, canonicalJson(request), now);
      if (reused.created) {
        createdIds.push(reused.task.id);
      }
      return { content: existing, task: reused.task, createdIds };
    }

    const content: Content = {
      id: this.newId(),
      userId: owner,
      source: item.source,
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
      importBatchId: batchId,
      processingStatus: "queued",
      createdAt: now,
      updatedAt: now,
    };
    scope.contents.insert(content);
    createdIds.push(content.id);
    if (item.initialSubtitle !== undefined) {
      const { revision, segments } = importedTranscript({
        revisionId: this.newId(),
        contentId: content.id,
        language: item.initialSubtitle.language,
        subtitle: item.initialSubtitle.subtitle,
        newId: this.newId,
        createdAt: now,
      });
      scope.transcripts.insertRevision(owner, revision, segments);
      scope.contents.setPrimaryTranscript(owner, content.id, revision.id, now);
      request.initialSubtitleRevisionId = revision.id;
      createdIds.push(revision.id);
    }
    scope.search.syncContent(owner, content.id);
    const task = createTask(scope, outbox, {
      task: { id: this.newId(), userId: owner, contentId: content.id, kind: "process_content", requestJson: canonicalJson(request), createdAt: now },
      sourceKind: content.source.kind,
      newId: this.newId,
    });
    createdIds.push(task.id);
    return { content, task, createdIds };
  }

  private reuseOrDerive(scope: RepositoryScope, outbox: Outbox, content: Content, requestJson: string, now: number): { task: Task; created: boolean } {
    const tasks = scope.tasks.listByContent(content.userId, content.id);
    const candidate = { id: "", kind: "process_content" as const, requestJson };
    const unfinished = tasks
      .filter((task) => !isTerminalProjection(task.statusProjection))
      .map((task) => ({ task, keys: laneKeys(task, content.source.kind) }));
    const primary = content.primaryTranscriptRevisionId;
    const summaryJson = primary === undefined ? undefined : summaryRequestJson(requestJson, primary);
    const blocking = laneConflict(laneKeys(candidate, content.source.kind), unfinished);
    if (blocking !== undefined) {
      // The same re-import submitted again while its derived summary Task still runs.
      const sameSummary = blocking.kind === "regenerate_summary" && summaryJson !== undefined && sameIntent("regenerate_summary", summaryJson, blocking);
      if (sameSummary || sameIntent(candidate.kind, requestJson, blocking)) {
        return { task: blocking, created: false };
      }
      throw mutationLaneError(blocking, "another unfinished task works on this content");
    }

    const latest = tasks.filter((task) => task.kind === "process_content").at(-1);
    // With a primary, neither choice changes what the Task would do to the Content now.
    const ignore = primary === undefined ? UNUSED_PROMPT_FIELDS : ["autoProofread", "asrModelRef", ...PROOFREAD_PROMPT_FIELDS, ...UNUSED_PROMPT_FIELDS];
    const differences = latest === undefined ? undefined : requestDifferences(requestJson, latest.requestJson, ignore);
    if (latest !== undefined && latest.statusProjection === "succeeded" && differences?.length === 0) {
      return { task: latest, created: false };
    }
    if (summaryJson !== undefined && differences !== undefined && differences.length > 0 && differences.every((field) => SUMMARY_ONLY_FIELDS.has(field))) {
      const task = createTask(scope, outbox, {
        task: { id: this.newId(), userId: content.userId, contentId: content.id, kind: "regenerate_summary", requestJson: summaryJson, createdAt: now },
        sourceKind: content.source.kind,
        newId: this.newId,
      });
      return { task, created: true };
    }
    const task = createTask(scope, outbox, {
      task: { id: this.newId(), userId: content.userId, contentId: content.id, kind: "process_content", requestJson, createdAt: now },
      sourceKind: content.source.kind,
      newId: this.newId,
    });
    return { task, created: true };
  }
}

/** The import settings with the ASR model checked at submission (the requested one, else none). */
function frozen(settings: ImportRequest["settings"], asrModelRef: AsrModelRef | undefined): ImportRequest["settings"] {
  const { asrModelRef: _requested, ...rest } = settings;
  return asrModelRef === undefined ? rest : { ...rest, asrModelRef };
}
