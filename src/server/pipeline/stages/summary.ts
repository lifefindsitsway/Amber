import { monotonicFactory } from "ulid";
import { UI_LANGUAGE_DEFAULT } from "../../../shared/defaults.ts";
import type { ArtifactInputRef, ChapterRevision, RollupPartial } from "../../domain/artifact.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import { cappedCitations, finalizeCitations, transcriptAliasTable, type AliasTable } from "../../domain/citations.ts";
import type { Content } from "../../domain/content.ts";
import { amberError } from "../../domain/errors.ts";
import type { PromptRef } from "../../domain/model-ref.ts";
import { CITATION_RULES_FRAGMENT, DEFAULT_SUMMARY_TEMPLATE_ID, outputLanguageName, renderPrompt } from "../../domain/prompts.ts";
import { carryAllowance, planSummary, type SentenceGroup } from "../../domain/rollup.ts";
import { processContentRequestSchema, regenerateSummaryRequestSchema } from "../../domain/task-request.ts";
import { termsSection } from "../../domain/terminology.ts";
import type { TranscriptRevision } from "../../domain/transcript.ts";
import type { Repository } from "../../ports/repository.ts";
import { assertBaseRevisionExists, type StageExecutionContext, type StageExecutor, type StageOutcome } from "../executor.ts";
import { taskContent } from "./platform-access.ts";
import { digestOf, generateWithRepair, runRollup, storedDataError, type RollupGroup } from "./rollup-runner.ts";

export interface SummaryStageDeps {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

interface SummaryBase {
  revision: TranscriptRevision;
  templateRef: PromptRef;
  templateBody: string;
  outputLanguage: string;
}

/**
 * The `summary` stage of `process_content` and `regenerate_summary`. Sentences of the base
 * transcript are aliased `[[s1..sN]]` for the whole Task. When they fit the model's budget
 * one call under the `summary.envelope` prompt writes the summary (`summary:generate`);
 * otherwise it is summarized rolling (the `rollup.*` prompts), by the current chapters when
 * there are any. Aliases become canonical `[[seg:]]` markers, with one citation repair per
 * output over the limit, and each run of adjacent markers is cut to `CITATION_RUN_MAX`
 * before the revision and its partials are published. The new revision becomes its template's
 * current; partials are persisted with it, and usage is attributed in the same transaction.
 */
export class SummaryStageExecutor implements StageExecutor {
  private readonly deps: SummaryStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SummaryStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const content = taskContent(repository, context);
    const owner = content.userId;
    const base = this.baseOf(context, content);
    const { revision, templateRef, templateBody } = base;
    const outputLanguage = outputLanguageName(base.outputLanguage);
    const { segments, chapters, terms } = repository.withTransaction((scope) => ({
      segments: scope.transcripts.listSegments(owner, revision.id),
      chapters: scope.chapters.getCurrent(owner, content.id),
      terms: termsSection(scope.terminology.effectiveFor(owner, content.id)),
    }));
    if (segments.length === 0) {
      throw amberError("internal", "the base transcript has no sentences");
    }
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "no model for the summary stage");
    }
    const description = context.llm.describe(modelRef);
    const limits = description.capability.limits;
    const prompts = {
      envelope: context.prompt("summary.envelope"),
      partial: context.prompt("rollup.partial"),
      carry: context.prompt("rollup.carry"),
      final: context.prompt("rollup.final"),
    };
    const table = transcriptAliasTable(revision.id, segments);
    const lines = table.entries.map((entry) => table.line(entry.alias));
    const envelope = { output_language: outputLanguage, terms_section: terms, template_body: templateBody };
    const plan = planSummary({
      sentences: lines.map((line, index) => ({ line, startMs: (segments[index] as { startMs: number }).startMs })),
      ...(chapters === undefined ? {} : { chapterStarts: chapters.chapters.map((chapter) => chapter.startMs) }),
      singleFixed: renderPrompt(prompts.envelope.text, { ...envelope, transcript_with_aliases: "" }),
      partialFixed: renderPrompt(prompts.partial.text, {
        ...envelope,
        citation_rules: CITATION_RULES_FRAGMENT.text,
        carry: carryAllowance(),
        group_content: "",
      }),
      limits,
      modelRef,
    });
    const digestBase = { baseRevisionId: revision.id, templateRef, modelRef, outputLanguage, terms };
    const revisionId = this.newId();
    const artifactId = this.newId();
    const createdAt = this.now();
    const transcriptInput: ArtifactInputRef = { kind: "transcriptRevision", id: revision.id };

    if (plan.mode === "single") {
      const generated = await generateWithRepair(context, table, modelRef, {
        key: "summary:generate",
        inputDigest: digestOf(canonicalJson({ ...digestBase, promptRef: prompts.envelope.ref, aliases: digestOf(table.fingerprint()) })),
        prompt: renderPrompt(prompts.envelope.text, { ...envelope, transcript_with_aliases: lines.join("\n") }),
        feature: "summary",
      });
      const { body, citations } = published(generated.text, table);
      return {
        resultJson: { revisionId, mode: "single", reasons: generated.degraded ? ["citation_degraded"] : [] },
        publish: (scope) => {
          assertBaseRevisionExists(scope, owner, content.id, revision.id);
          const stored = scope.summaries.insertRevision(owner, {
            contentId: content.id,
            templateId: templateRef.id,
            artifactId,
            revision: {
              id: revisionId,
              provenance: {
                inputs: [transcriptInput],
                modelRef: description.snapshot,
                promptRef: templateRef,
                promptRefs: [templateRef, prompts.envelope.ref],
                promptSnapshot: renderPrompt(prompts.envelope.text, envelope),
                createdAt,
              },
              quality: generated.degraded ? "degraded" : "normal",
              body,
              citations,
              ...(chapters === undefined ? {} : { chapterRevisionId: chapters.id }),
            },
          });
          scope.summaries.setCurrent(owner, stored.artifactId, revisionId);
          scope.search.syncContent(owner, content.id);
          scope.tokenUsage.attach(owner, generated.invocationIds, revisionId);
        },
      };
    }

    const inputs: ArtifactInputRef[] =
      plan.byChapters && chapters !== undefined ? [transcriptInput, { kind: "chapterRevision", id: chapters.id }] : [transcriptInput];
    const groups: RollupGroup[] = plan.groups.map((group) => ({
      ids: segments.slice(group.first, group.first + group.count).map((segment) => segment.id),
      content: groupContent(lines, group, chapters),
      inputs,
    }));
    const outcome = await runRollup(context, {
      citations: { rules: CITATION_RULES_FRAGMENT, table },
      modelRef,
      limits,
      feature: "summary",
      templateBody,
      outputLanguage,
      terms,
      groups,
      partial: prompts.partial,
      carry: prompts.carry,
      final: { prompt: prompts.final, values: { template_body: templateBody } },
      digestBase,
    });
    const { body, citations } = published(outcome.final.text, table);
    const partials: RollupPartial[] = outcome.partials.map((partial) => {
      const finalized = published(partial.text, table);
      return {
        id: this.newId(),
        ownerRevisionId: revisionId,
        index: partial.index,
        inputs: partial.inputs,
        body: finalized.body,
        citations: finalized.citations,
        modelRef: description.snapshot,
        promptRef: outcome.partialRef,
        promptRefs: [outcome.partialRef],
        promptSnapshot: outcome.partialSnapshot,
        createdAt,
      };
    });
    return {
      resultJson: { revisionId, mode: "rolling", groups: groups.length, reasons: outcome.degraded ? ["citation_degraded"] : [] },
      publish: (scope) => {
        assertBaseRevisionExists(scope, owner, content.id, revision.id);
        const stored = scope.summaries.insertRevision(owner, {
          contentId: content.id,
          templateId: templateRef.id,
          artifactId,
          revision: {
            id: revisionId,
            provenance: {
              inputs,
              modelRef: description.snapshot,
              promptRef: templateRef,
              promptRefs: [templateRef, prompts.partial.ref, prompts.carry.ref, prompts.final.ref],
              promptSnapshot: outcome.finalSnapshot,
              createdAt,
            },
            quality: outcome.degraded ? "degraded" : "normal",
            body,
            citations,
            ...(chapters === undefined ? {} : { chapterRevisionId: chapters.id }),
            partialIds: partials.map((partial) => partial.id),
          },
        });
        scope.summaries.setCurrent(owner, stored.artifactId, revisionId);
        scope.search.syncContent(owner, content.id);
        scope.rollupPartials.insertMany(owner, "summary", partials);
        outcome.partials.forEach((partial, index) => scope.tokenUsage.attach(owner, partial.invocationIds, (partials[index] as RollupPartial).id));
        scope.tokenUsage.attach(owner, [...outcome.carryInvocationIds, ...outcome.final.invocationIds], revisionId);
      },
    };
  }

  /**
   * The transcript, template and language to summarize with: `process_content` takes the
   * primary at run time; `regenerate_summary` what was frozen at submission.
   * A request without `templateRef` uses the default template's current version.
   */
  private baseOf(context: StageExecutionContext, content: Content): SummaryBase {
    const owner = content.userId;
    let revisionId: string | undefined;
    let templateRef: PromptRef | undefined;
    let language: string | undefined;
    if (context.task.kind === "regenerate_summary") {
      const request = regenerateSummaryRequestSchema.parse(context.request);
      revisionId = request.baseRevisionId;
      templateRef = request.templateRef;
      language = request.outputLanguage;
    } else {
      const request = processContentRequestSchema.parse(context.request);
      revisionId = content.primaryTranscriptRevisionId;
      templateRef = request.templateRef;
      language = request.outputLanguage;
    }
    if (revisionId === undefined) {
      throw amberError("internal", "no primary transcript to summarize");
    }
    const id = revisionId;
    return this.deps.repository.withTransaction((scope) => {
      const revision = scope.transcripts.getRevision(owner, id);
      if (revision === undefined || revision.contentId !== content.id) {
        return storedDataError("the base transcript revision is gone");
      }
      let ref = templateRef;
      if (ref === undefined) {
        const fallback = scope.summaryTemplates.get(owner, DEFAULT_SUMMARY_TEMPLATE_ID);
        if (fallback === undefined) {
          return storedDataError("the default summary template is missing");
        }
        ref = { id: fallback.id, version: fallback.currentVersion };
      }
      const version = scope.summaryTemplates.getVersion(owner, ref.id, ref.version);
      if (version === undefined) {
        return storedDataError("the frozen summary template version is missing");
      }
      return { revision, templateRef: ref, templateBody: version.prompt, outputLanguage: language ?? UI_LANGUAGE_DEFAULT };
    });
  }
}

/**
 * A model output in its stored form: canonical markers, each run cut to the cap, and the
 * citations index of what is left. The cap does not touch the quality, which reflects the
 * output as the model wrote it.
 */
function published(text: string, table: AliasTable): ReturnType<typeof finalizeCitations> {
  const { body, citations } = finalizeCitations(text, table);
  return cappedCitations(body, citations);
}

/** A group's lines, headed by its chapter's title when it was cut by chapter. */
function groupContent(lines: readonly string[], group: SentenceGroup, chapters: ChapterRevision | undefined): string {
  const body = lines.slice(group.first, group.first + group.count).join("\n");
  const title = group.chapterIndex === undefined ? undefined : chapters?.chapters[group.chapterIndex]?.title;
  return title === undefined ? body : `【章节】${title}\n${body}`;
}
