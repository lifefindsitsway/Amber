import { monotonicFactory } from "ulid";
import { packContentDecisionSchema, type PackContentDiff, type PackContentResult } from "../../shared/dto/content-pack.ts";
import { originOf } from "../domain/content-pack/identity.ts";
import { amberError, appError, isAmberError } from "../domain/errors.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type {
  ContentPackEngine,
  PackCollectionsEngine,
  PackImportMediaPlan,
  PackPreviewState,
  PreparedPackContent,
  PreparedPackImport,
} from "./content-pack-engine.ts";
import { buildExport, exportPlan, validateSelection } from "./content-pack-documents.ts";
import {
  analyzeContent,
  checkPackDocuments,
  diffOf,
  EVERYTHING,
  matchContent,
  overLimits,
  speakersToCreate,
  type CheckedContent,
  type ContentAnalysis,
  type ContentMatch,
  type FigureFields,
  type NoteFields,
} from "./content-pack-preview.ts";
import { checkTarget, choicesOf, failedResult, skippedResult, writePackContent, type ParsedDecision, type TargetSnapshot } from "./content-pack-write.ts";

export interface ContentPackEngineOptions {
  mode: "server" | "local";
  repository: Repository;
  collections: PackCollectionsEngine;
  logger?: Logger;
  /** New local ids (ULIDs: sentence ids must be). */
  newId?: () => string;
}

/** The engine's memory of one preview: per carried Content its matches and what each live target looked like. */
interface PreviewMemory {
  owner: string;
  checked: ReadonlyMap<string, CheckedContent>;
  matches: Map<string, ContentMatch>;
  /** Carried key → target id → what the preview saw of it. */
  targets: Map<string, Map<string, TargetSnapshot>>;
}

interface PreparedMemory {
  owner: string;
  checked: CheckedContent;
  decision: ParsedDecision;
  contentId: string;
  isNew: boolean;
  snapshot?: TargetSnapshot;
  rememberMerge: boolean;
  media: PackImportMediaPlan[];
}

function invalidDecision(detail: string): never {
  throw amberError("invalid_request", `content pack decision refused: ${detail}`, { params: { detail } });
}

function snapshotOf(analysis: ContentAnalysis): TargetSnapshot {
  const notes = new Map<string, NoteFields>();
  for (const note of analysis.notes) if (note.state === "differs" && note.local !== undefined) notes.set(note.pack.key, note.local);
  const figures = new Map<string, FigureFields>();
  for (const figure of analysis.figures) if (figure.state === "differs" && !figure.imageConflict && figure.local !== undefined) figures.set(figure.pack.key, figure.local);
  const primary = analysis.target?.primaryTranscriptRevisionId;
  return { ...(primary === undefined ? {} : { primaryRevisionId: primary }), notes, figures };
}

/** The library side of content packs: export plans and documents, import previews and per-Content commits. */
export function createContentPackEngine(options: ContentPackEngineOptions): ContentPackEngine {
  const { repository, mode } = options;
  const newId = options.newId ?? monotonicFactory();
  const previews = new WeakMap<PackPreviewState, PreviewMemory>();
  const prepared = new WeakMap<PreparedPackContent, PreparedMemory>();

  const memoryOf = (owner: string, state: PackPreviewState): PreviewMemory => {
    const memory = previews.get(state);
    if (memory === undefined || memory.owner !== owner) throw amberError("not_found", "content pack preview not found");
    return memory;
  };

  /** Remembers what a live target looks like now and returns the diff the user sees for it. */
  const rememberTarget = (scope: RepositoryScope, memory: PreviewMemory, key: string, checked: CheckedContent, targetId: string | undefined): PackContentDiff => {
    const target = targetId === undefined ? undefined : scope.contents.get(memory.owner, targetId);
    if (targetId !== undefined && target === undefined) throw amberError("not_found", "content not found");
    const analysis = analyzeContent(scope, memory.owner, checked, target, EVERYTHING);
    const targets = memory.targets.get(key) ?? new Map<string, TargetSnapshot>();
    targets.set(targetId ?? "", snapshotOf(analysis));
    memory.targets.set(key, targets);
    return diffOf(analysis);
  };

  return {
    exportPlan: (owner, request) => exportPlan(repository, mode, owner, request),
    validateSelection: (owner, selection) => repository.withTransaction((scope) => validateSelection(scope, mode, owner, selection)),
    buildExport: (owner, selection, hooks) => buildExport(repository, mode, owner, selection, hooks, options.logger),

    analyzeImport(owner, documents) {
      const checked = checkPackDocuments(documents, newId);
      return repository.withTransaction((scope) => {
        const memory: PreviewMemory = { owner, checked: new Map(checked.map((item) => [item.document.key, item])), matches: new Map(), targets: new Map() };
        for (const item of checked) memory.matches.set(item.document.key, matchContent(scope, owner, item.document));
        // Two carried Contents never merge into one here: a target both would be offered is
        // suggested to neither, so each preview asks for a choice.
        const suggestedTwice = new Set<string>();
        const suggested = new Set<string>();
        for (const match of memory.matches.values()) {
          if (match.suggested === undefined) continue;
          if (suggested.has(match.suggested)) suggestedTwice.add(match.suggested);
          suggested.add(match.suggested);
        }
        for (const match of memory.matches.values()) {
          if (match.suggested !== undefined && suggestedTwice.has(match.suggested)) delete match.suggested;
        }
        const contents = checked.map((item) => {
          const { document } = item;
          const match = memory.matches.get(document.key) as ContentMatch;
          let diff: PackContentDiff | undefined;
          for (const candidate of match.candidates) {
            if (candidate.trashed) continue;
            const candidateDiff = rememberTarget(scope, memory, document.key, item, candidate.contentId);
            if (candidate.contentId === match.suggested) diff = candidateDiff;
          }
          const asNew = rememberTarget(scope, memory, document.key, item, undefined);
          const title = document.customTitle ?? document.title;
          return {
            key: document.key,
            ...(title === undefined ? {} : { title }),
            sourceKind: document.source.kind,
            ...(document.durationMs === undefined ? {} : { durationMs: document.durationMs }),
            match: match.match,
            candidates: match.candidates,
            diff: diff ?? asNew,
          };
        });
        const state = {} as PackPreviewState;
        previews.set(state, memory);
        return { contents, state };
      });
    },

    compare(owner, _documents, state, key, targetContentId) {
      const memory = memoryOf(owner, state);
      const checked = memory.checked.get(key) ?? invalidDecision("key");
      return repository.withTransaction((scope) => rememberTarget(scope, memory, key, checked, targetContentId));
    },

    prepareImport(owner, _documents, state, decisions): PreparedPackImport {
      const memory = memoryOf(owner, state);
      const parsed = decisions.contents.map((decision) => packContentDecisionSchema.parse(decision));
      const keys = parsed.map((decision) => decision.key);
      if (new Set(keys).size !== keys.length) invalidDecision("contents");
      for (const key of keys) if (!memory.checked.has(key)) invalidDecision("contents");
      const byKey = new Map(parsed.map((decision) => [decision.key, decision]));

      return repository.withTransaction((scope) => {
        const contents: PreparedPackContent[] = [];
        const media: PackImportMediaPlan[] = [];
        const imageEntries = new Set<string>();
        const refused: PackContentResult[] = [];
        const targets = parsed.flatMap((decision) => (decision.action === "merge" && decision.targetContentId !== undefined ? [decision.targetContentId] : []));
        if (new Set(targets).size !== targets.length) invalidDecision("targetContentId");
        for (const [key, checked] of memory.checked) {
          const { document } = checked;
          const title = document.customTitle ?? document.title;
          const decision = byKey.get(key) ?? packContentDecisionSchema.parse({ key, action: "skip", revisions: false, figures: false, notes: false });
          const match = memory.matches.get(key) as ContentMatch;
          const hand = (action: PreparedPackContent["action"], memo: Omit<PreparedMemory, "owner" | "checked" | "decision">): void => {
            const item: PreparedPackContent = { key, ...(title === undefined ? {} : { title }), action };
            prepared.set(item, { owner, checked, decision, ...memo });
            contents.push(item);
          };
          if (decision.action === "skip") {
            hand("skip", { contentId: "", isNew: false, rememberMerge: false, media: [] });
            continue;
          }
          if (match.match === "trashed") {
            const trashed = match.candidates.find((candidate) => candidate.trashed) ?? match.candidates[0];
            refused.push(failedResult(key, title, appError("conflict", { code: "conflict.pack_target_changed", details: { contentId: trashed?.contentId ?? "" } })));
            continue;
          }
          let targetId: string | undefined;
          if (decision.action === "merge") {
            targetId = decision.targetContentId ?? invalidDecision("targetContentId");
            const offered = match.candidates.some((candidate) => candidate.contentId === targetId && !candidate.trashed) || memory.targets.get(key)?.has(targetId) === true;
            if (!offered) invalidDecision("targetContentId");
            try {
              checkTarget(scope, owner, targetId);
            } catch (error) {
              if (!isAmberError(error)) throw error;
              refused.push(failedResult(key, title, error.appError));
              continue;
            }
          } else {
            // A new Content: only when nothing has this identity, or the match is a local file's fingerprint.
            const fingerprintOnly = match.match === "same_media" && match.candidates.every((candidate) => candidate.reason === "fingerprint");
            if (match.match !== "new" && !fingerprintOnly) invalidDecision("action");
            if (match.platformTaken) invalidDecision("action");
          }
          const target = targetId === undefined ? undefined : scope.contents.get(owner, targetId);
          const choices = choicesOf(decision);
          const analysis = analyzeContent(scope, owner, checked, target, choices);
          if (overLimits(analysis, choices).length > 0) invalidDecision("overLimit");
          checkDecision(decision, analysis);

          const snapshot = memory.targets.get(key)?.get(targetId ?? "") ?? snapshotOf(analysis);
          const contentId = targetId ?? newId();
          const plans = decision.mediaKeys.flatMap((mediaKey): PackImportMediaPlan[] => {
            const item = analysis.media.find((candidate) => candidate.pack.key === mediaKey) ?? invalidDecision("mediaKeys");
            if (item.state === "conflict") invalidDecision("mediaKeys");
            if (item.state === "existing") return [];
            const fills = item.state === "fill";
            const asset = item.asset;
            return [
              {
                entry: item.pack.entry,
                contentKey: key,
                contentId,
                assetId: fills && asset !== undefined ? asset.id : newId(),
                fills,
                targetKind: item.pack.kind === "cache" ? "platform_cache" : mode === "local" ? "external_local" : "managed_upload",
                media: item.pack,
                ...(fills && asset !== undefined ? { existingLocation: asset.kind === "external_local" ? { path: asset.storageRef } : { storageRef: asset.storageRef } } : {}),
              },
            ];
          });
          media.push(...plans);
          if (decision.figures) for (const figure of analysis.figures) if (figure.state === "new") imageEntries.add(figure.pack.entry);
          for (const speaker of speakersToCreate(analysis)) if (speaker.pack.avatar !== undefined) imageEntries.add(speaker.pack.avatar.entry);

          const rememberMerge = target !== undefined && originOf(target) !== document.key;
          hand(target === undefined ? "import" : "merge", { contentId, isNew: target === undefined, ...(target === undefined ? {} : { snapshot }), rememberMerge, media: plans });
        }
        return { contents, media, imageEntries, refused };
      });
    },

    commitContent(owner, _documents, item, inputs) {
      const memo = prepared.get(item);
      if (memo === undefined || memo.owner !== owner) {
        return failedResult(item.key, item.title, appError("internal", { upstreamMessage: "unknown prepared content" }));
      }
      if (item.action === "skip") return skippedResult(item.key, item.title);
      try {
        return repository.withTransaction((scope) =>
          writePackContent(scope, owner, {
            checked: memo.checked,
            decision: memo.decision,
            contentId: memo.contentId,
            isNew: memo.isNew,
            ...(memo.snapshot === undefined ? {} : { snapshot: memo.snapshot }),
            rememberMerge: memo.rememberMerge,
            media: memo.media,
            images: inputs.images,
            placed: inputs.media,
            newId,
            now: inputs.now,
          }),
        );
      } catch (error) {
        if (isAmberError(error)) return failedResult(item.key, item.title, error.appError);
        options.logger?.error("content_pack.commit_failed", { key: item.key, error: error instanceof Error ? error.message : String(error) });
        return failedResult(item.key, item.title, appError("internal"));
      }
    },

    collections: options.collections,
  };
}

/** The per-Content choices must name what the preview offered. */
function checkDecision(decision: ParsedDecision, analysis: ContentAnalysis): void {
  const revisions = new Map(analysis.revisions.map((revision) => [revision.pack.key, revision]));
  for (const key of decision.excludeRevisionKeys) if (!revisions.has(key)) invalidDecision("excludeRevisionKeys");
  if (decision.setPrimaryRevisionKey !== undefined) {
    const revision = revisions.get(decision.setPrimaryRevisionKey);
    const usable = revision !== undefined && revision.included && !revision.rejected && revision.pack.kind !== "translated" && revision.pack.archivedAt === undefined && (revision.state === "new" || revision.state === "existing");
    if (!usable) invalidDecision("setPrimaryRevisionKey");
  }
  for (const key of decision.currentTranslationKeys) {
    const revision = revisions.get(key);
    if (revision === undefined || revision.pack.kind !== "translated" || !revision.included || revision.rejected || revision.state !== "new") invalidDecision("currentTranslationKeys");
  }
  const seen = new Set<string>();
  for (const entry of decision.sameSpeakers) {
    const speaker = analysis.speakers[Number(entry.speakerKey)];
    if (!/^\d+$/u.test(entry.speakerKey) || speaker === undefined || speaker.state !== "new" || seen.has(entry.speakerKey) || !speaker.sameName.some((candidate) => candidate.speakerId === entry.localSpeakerId)) {
      invalidDecision("sameSpeakers");
    }
    seen.add(entry.speakerKey);
  }
}
