import { monotonicFactory } from "ulid";
import { COLLECTION_PARTIAL_SIZE } from "../../../shared/defaults.ts";
import type { ArtifactInputRef, RollupPartial } from "../../domain/artifact.ts";
import { withoutCitations } from "../../domain/citations.ts";
import { amberError } from "../../domain/errors.ts";
import { CITATION_NONE_FRAGMENT, outputLanguageName } from "../../domain/prompts.ts";
import { summarizeCollectionRequestSchema, type SummarizeCollectionRequest } from "../../domain/task-request.ts";
import { termsSection } from "../../domain/terminology.ts";
import type { Repository } from "../../ports/repository.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import { runRollup, storedDataError, type RollupGroup } from "./rollup-runner.ts";
import { displayTitleOf } from "../../domain/content.ts";

export interface CollectionSummaryStageDeps {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

type InputItem = SummarizeCollectionRequest["inputItems"][number];

/**
 * The `collection_summary` stage of `summarize_collection`. Its input is
 * frozen at submission: each member's `summary.core` revision and primary transcript. The
 * members are summarized rolling in groups of `COLLECTION_PARTIAL_SIZE` members under the
 * collection goal (`rollup.goal.collection`, the `{{template_body}}` of every call), and
 * `rollup.final.collection` writes the collection summary. A collection summary carries no
 * citations: a sentence of one member says little about a whole collection, and dozens of
 * them buried the text. Members' markers are stripped before they are sent, the calls are
 * asked not to cite (`citation.none`), and any marker the model writes anyway is stripped,
 * never repaired; its quality never degrades over citations.
 */
export class CollectionSummaryStageExecutor implements StageExecutor {
  private readonly deps: CollectionSummaryStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: CollectionSummaryStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const owner = context.task.userId;
    const collectionId = context.task.collectionId;
    if (collectionId === undefined) {
      throw amberError("internal", "a collection summary needs a Collection target");
    }
    const request = summarizeCollectionRequestSchema.parse(context.request);
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "no model for the collection summary stage");
    }
    const outputLanguage = outputLanguageName(request.outputLanguage);
    const { members, terms } = repository.withTransaction((scope) => {
      if (scope.collections.get(owner, collectionId) === undefined) {
        return storedDataError("the collection is gone");
      }
      const members = request.inputItems.map((item) => {
        const summary = scope.summaries.getRevision(owner, item.summaryRevisionId);
        if (summary === undefined) {
          return storedDataError("a frozen member summary is gone");
        }
        return { item, body: withoutCitations(summary.body), title: displayTitleOf(scope.contents.getIncludingTrashed(owner, item.contentId)) };
      });
      return { members, terms: termsSection(scope.terminology.effectiveForCollection(owner, collectionId)) };
    });
    const description = context.llm.describe(modelRef);
    const prompts = {
      goal: context.prompt("rollup.goal.collection"),
      partial: context.prompt("rollup.partial"),
      carry: context.prompt("rollup.carry"),
      final: context.prompt("rollup.final.collection"),
    };
    const snapshots = request.inputItems.map(snapshotOf);

    const groups: RollupGroup[] = [];
    for (let first = 0; first < members.length; first += COLLECTION_PARTIAL_SIZE) {
      const slice = members.slice(first, first + COLLECTION_PARTIAL_SIZE);
      groups.push({
        ids: slice.map((member) => `${member.item.collectionItemId}:${member.item.summaryRevisionId}`),
        content: slice
          .map((member, offset) => {
            const k = first + offset + 1;
            const heading = member.title === undefined ? `【第 ${k} 项】` : `【第 ${k} 项】${member.title}`;
            return `${heading}\n${member.body}`;
          })
          .join("\n\n"),
        inputs: snapshots.slice(first, first + COLLECTION_PARTIAL_SIZE),
      });
    }
    const outcome = await runRollup(context, {
      citations: { rules: CITATION_NONE_FRAGMENT },
      modelRef,
      limits: description.capability.limits,
      feature: "collection_summary",
      templateBody: prompts.goal.text,
      outputLanguage,
      terms,
      groups,
      partial: prompts.partial,
      carry: prompts.carry,
      final: { prompt: prompts.final, values: {} },
      digestBase: { collectionId, inputItems: request.inputItems, goalRef: prompts.goal.ref },
    });

    const revisionId = this.newId();
    const artifactId = this.newId();
    const createdAt = this.now();
    const partials: RollupPartial[] = outcome.partials.map((partial) => ({
      id: this.newId(),
      ownerRevisionId: revisionId,
      index: partial.index,
      inputs: partial.inputs,
      body: partial.text,
      citations: [],
      modelRef: description.snapshot,
      promptRef: outcome.partialRef,
      promptRefs: [outcome.partialRef],
      promptSnapshot: outcome.partialSnapshot,
      createdAt,
    }));
    return {
      resultJson: { revisionId, groups: groups.length, reasons: [] },
      publish: (scope) => {
        scope.collectionSummaries.insertRevision(owner, {
          collectionId,
          artifactId,
          revision: {
            id: revisionId,
            provenance: {
              inputs: snapshots,
              modelRef: description.snapshot,
              promptRef: prompts.final.ref,
              promptRefs: [prompts.goal.ref, prompts.partial.ref, prompts.carry.ref, prompts.final.ref],
              promptSnapshot: outcome.finalSnapshot,
              createdAt,
            },
            quality: "normal",
            inputItems: request.inputItems.map((item) => ({ ...item })),
            partialIds: partials.map((partial) => partial.id),
            body: outcome.final.text,
            citations: [],
          },
        });
        scope.collectionSummaries.setCurrent(owner, collectionId, revisionId);
        scope.collections.touch(owner, collectionId, createdAt);
        scope.rollupPartials.insertMany(owner, "collection_summary", partials);
        outcome.partials.forEach((partial, index) => scope.tokenUsage.attach(owner, partial.invocationIds, (partials[index] as RollupPartial).id));
        scope.tokenUsage.attach(owner, [...outcome.carryInvocationIds, ...outcome.final.invocationIds], revisionId);
      },
    };
  }
}

function snapshotOf(item: InputItem): ArtifactInputRef {
  return {
    kind: "collectionItemSnapshot",
    collectionItemId: item.collectionItemId,
    contentId: item.contentId,
    summaryRevisionId: item.summaryRevisionId,
    transcriptRevisionId: item.transcriptRevisionId,
    position: item.position,
  };
}
