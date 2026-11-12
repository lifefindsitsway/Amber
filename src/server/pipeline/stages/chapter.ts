import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { UI_LANGUAGE_DEFAULT } from "../../../shared/defaults.ts";
import type { SegmentId } from "../../../shared/ids.ts";
import type { ChapterRevision } from "../../domain/artifact.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import type { Content } from "../../domain/content.ts";
import { amberError } from "../../domain/errors.ts";
import type { LlmRequest } from "../../domain/llm.ts";
import type { ModelRef } from "../../domain/model-ref.ts";
import { chapterWindowNote, outputLanguageName, renderPrompt } from "../../domain/prompts.ts";
import type { PromptRef } from "../../domain/model-ref.ts";
import { framingForRead, speakerContextDigest, type SpeakerContextSnapshot, type SpeakerFraming } from "../../domain/speaker-context.ts";
import { processContentRequestSchema, regenerateChaptersRequestSchema } from "../../domain/task-request.ts";
import { estimateTokens } from "../../domain/token-estimate.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../domain/transcript.ts";
import type { Repository } from "../../ports/repository.ts";
import { assertBaseRevisionExists, stageUnitFailure, type StageExecutionContext, type StageExecutor, type StageOutcome, type UnitIdentity } from "../executor.ts";
import { taskContent } from "./platform-access.ts";
import { assertCarries } from "./rollup-runner.ts";
import { assertWindowFits, planSentenceWindows, type SentenceWindow } from "./windows.ts";

export interface ChapterStageDeps {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

/** The JSON object the `chapter.ai` prompt asks for; the root is an object so structured output can describe it. */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: { startAlias: { type: "string" }, title: { type: "string" }, summary: { type: "string" } },
        required: ["startAlias", "title", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["chapters"],
  additionalProperties: false,
} as const;

const outputSchema = z.object({
  chapters: z.array(z.object({ startAlias: z.string(), title: z.string(), summary: z.string().optional() })),
});

/** A window's result as persisted in `WorkUnitResult`. */
const windowPayloadSchema = z.object({
  chapters: z.array(z.object({ startSegmentId: z.string(), title: z.string(), summary: z.string().exactOptional() })),
  invocationId: z.string(),
});
type WindowPayload = z.infer<typeof windowPayloadSchema>;

const ALIAS = /^s([1-9][0-9]*)$/;

/**
 * The `chapter` stage of `process_content` and `regenerate_chapters`. Platform chapters,
 * when present, are the chapters and no model is called. Otherwise the base transcript is
 * cut into windows that fit the model's budget, each window is one DB-only WorkUnit asking
 * for chapters by `[[s<n>]]` alias (the `chapter.ai` prompt), and the windows are merged
 * into one `ChapterRevision(origin = ai)`: every chapter starts at a sentence and its times
 * are projections of sentence timing. The new revision becomes current; usage of the calls
 * that produced it is attributed to it in the same transaction.
 *
 * A `regenerate_chapters` request with a frozen speaker context sends each window with its
 * speakers: the `speaker.rules` fragment opens `{{transcript_with_aliases}}` and header lines
 * mark the window's first speaker and every change; windows are planned with those lines
 * priced in, and each is checked again as rendered before anything is sent.
 */
export class ChapterStageExecutor implements StageExecutor {
  private readonly deps: ChapterStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: ChapterStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const content = taskContent(repository, context);
    const owner = content.userId;
    const base = this.baseOf(context, content);
    if (base === undefined) {
      // Platform chapters are the chapters; the `no_platform_chapters` condition normally skips this stage.
      return { resultJson: { reasons: [] } };
    }
    const { revision, outputLanguage } = base;
    const segments = repository.withTransaction((scope) => scope.transcripts.listSegments(owner, revision.id));
    if (segments.length === 0) {
      throw amberError("internal", "the base transcript has no sentences");
    }
    const framing = framingForRead(base.speakerContext, segments);
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "no model for the chapter stage");
    }
    const description = context.llm.describe(modelRef);
    const structured = description.capability.flags.structuredOutput === "supported";
    const prompt = context.prompt("chapter.ai");
    const template = renderPrompt(prompt.text, { output_language: outputLanguageName(outputLanguage) });
    const limits = description.capability.limits;
    const windows = planWindows(segments, template, structured, limits, modelRef, framing);
    const prompts = windows.map((window, index) => windowPrompt(template, window, index, windows.length, framing));
    if (framing !== undefined) {
      const schemaTokens = structured ? estimateTokens(JSON.stringify(RESPONSE_SCHEMA)) : 0;
      prompts.forEach((rendered) => assertWindowFits(rendered, schemaTokens, limits));
    }

    let finished = 0;
    const settled = await Promise.allSettled(
      windows.map(async (window, index) => {
        const payload = await this.runWindow(context, {
          modelRef,
          promptRef: prompt.ref,
          revision,
          prompt: prompts[index] as string,
          structured,
          outputLanguage,
          window,
          index,
          count: windows.length,
          framing,
        });
        finished += 1;
        context.reportProgress(finished / windows.length);
        return payload;
      }),
    );
    const failure = stageUnitFailure(settled);
    if (failure !== undefined) {
      throw failure;
    }
    const payloads = settled.map((result) => (result as PromiseFulfilledResult<WindowPayload>).value);
    const chapters = mergeWindows(segments, payloads);
    const invocationIds = payloads.map((payload) => payload.invocationId);
    const revisionId = this.newId();
    const artifactId = this.newId();
    const createdAt = this.now();
    return {
      resultJson: { revisionId, windows: windows.length, reasons: [] },
      publish: (scope) => {
        assertBaseRevisionExists(scope, owner, content.id, revision.id);
        scope.chapters.insertAiRevision(owner, content.id, {
          id: revisionId,
          artifactId,
          transcriptRevisionId: revision.id,
          chapters,
          modelRef: description.snapshot,
          promptRef: prompt.ref,
          promptRefs: framing === undefined ? [prompt.ref] : [prompt.ref, framing.rules.ref],
          promptSnapshot: template,
          ...(framing === undefined ? {} : { speakerContext: framing.snapshot }),
          quality: "normal",
          createdAt,
        });
        scope.chapters.setCurrent(owner, content.id, revisionId);
        scope.tokenUsage.attach(owner, invocationIds, revisionId);
      },
    };
  }

  /**
   * The transcript to divide and the chapter language: `process_content` takes the primary
   * at run time and the request's language; `regenerate_chapters` takes what was frozen at
   * submission. `undefined` when platform chapters make the stage a no-op.
   */
  private baseOf(
    context: StageExecutionContext,
    content: Content,
  ): { revision: TranscriptRevision; outputLanguage: string; speakerContext?: SpeakerContextSnapshot } | undefined {
    const owner = content.userId;
    let revisionId: string | undefined;
    let outputLanguage: string;
    let speakerContext: SpeakerContextSnapshot | undefined;
    if (context.task.kind === "regenerate_chapters") {
      const request = regenerateChaptersRequestSchema.parse(context.request);
      revisionId = request.baseRevisionId;
      outputLanguage = request.outputLanguage;
      speakerContext = request.speakerContext;
    } else {
      const request = processContentRequestSchema.parse(context.request);
      if (this.deps.repository.withTransaction((scope) => scope.chapters.hasPlatformChapters(owner, content.id))) {
        return undefined;
      }
      revisionId = content.primaryTranscriptRevisionId;
      outputLanguage = request.outputLanguage ?? UI_LANGUAGE_DEFAULT;
    }
    if (revisionId === undefined) {
      throw amberError("internal", "no primary transcript to divide into chapters");
    }
    const id = revisionId;
    const revision = this.deps.repository.withTransaction((scope) => scope.transcripts.getRevision(owner, id));
    if (revision === undefined || revision.contentId !== content.id) {
      throw amberError("internal", "the base transcript revision is gone");
    }
    return { revision, outputLanguage, ...(speakerContext === undefined ? {} : { speakerContext }) };
  }

  private async runWindow(
    context: StageExecutionContext,
    input: {
      modelRef: ModelRef;
      promptRef: PromptRef;
      revision: TranscriptRevision;
      prompt: string;
      structured: boolean;
      outputLanguage: string;
      window: Window;
      index: number;
      count: number;
      framing: SpeakerFraming | undefined;
    },
  ): Promise<WindowPayload> {
    const { modelRef, promptRef, revision, prompt, structured, outputLanguage, window, index, count, framing } = input;
    const request: LlmRequest = {
      modelRef,
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      ...(structured ? { responseFormat: { type: "json_schema" as const, schema: RESPONSE_SCHEMA } } : {}),
    };
    const inputDigest = digestOf(
      canonicalJson({
        baseRevisionId: revision.id,
        i: index,
        n: count,
        segmentIds: window.segments.map((segment) => segment.id),
        promptRef,
        modelRef,
        outputLanguage,
        structured,
        ...(framing === undefined ? {} : { speakerContext: speakerContextDigest(framing.snapshot) }),
      }),
    );
    const value = await context.runUnit({
      key: `chapter:window:${index}`,
      inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity): Promise<WindowPayload> => {
        assertCarries(prompt, framing?.rules, "{{transcript_with_aliases}}");
        const completion = await context.llm.complete(request, { feature: "chapter", workUnitId: unit.id });
        return { chapters: parseWindow(completion.text, window), invocationId: completion.invocationId };
      },
    });
    const parsed = windowPayloadSchema.safeParse(value);
    if (!parsed.success) {
      throw amberError("internal", "a stored chapter window does not match its shape");
    }
    return parsed.data;
  }
}

type Window = SentenceWindow;

/**
 * The chapter windows: the fixed part is the prompt with an empty transcript and the
 * longest window note, plus the JSON schema when structured output is used.
 */
function planWindows(
  segments: readonly TranscriptSegment[],
  template: string,
  structured: boolean,
  limits: { contextWindowTokens?: number; maxOutputTokens?: number },
  modelRef: ModelRef,
  framing: SpeakerFraming | undefined,
): Window[] {
  const emptyTranscript = framing === undefined ? "" : framing.slotValue("");
  const fixedTokens =
    estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(segments.length, segments.length), transcript_with_aliases: emptyTranscript })) +
    (structured ? estimateTokens(JSON.stringify(RESPONSE_SCHEMA)) : 0);
  return planSentenceWindows(segments, { fixedTokens, limits, modelRef, ...(framing === undefined ? {} : { speakers: framing }) });
}

/** Window `index` of `count` as sent: with speakers, the rules fragment and header lines carry in its transcript. */
function windowPrompt(template: string, window: Window, index: number, count: number, framing: SpeakerFraming | undefined): string {
  return renderPrompt(template, {
    window_note: chapterWindowNote(index + 1, count),
    transcript_with_aliases: framing === undefined ? window.lines.join("\n") : framing.slotValue(framing.block(window.lines, window.offset).join("\n")),
  });
}

/**
 * The chapters of one window, checked by the rules of the `chapter.ai` prompt: the first
 * chapter starts at the window's first sentence, aliases name sentences of this window in
 * strictly increasing order and titles are not blank. The count is not enforced. Anything else is `output_mismatch`.
 */
function parseWindow(text: string, window: Window): WindowPayload["chapters"] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw amberError("output_mismatch", "chapter output holds no JSON object");
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw amberError("output_mismatch", "chapter output is not valid JSON");
  }
  const parsed = outputSchema.safeParse(json);
  if (!parsed.success || parsed.data.chapters.length === 0) {
    throw amberError("output_mismatch", "chapter output does not match the expected shape");
  }
  let previous = -1;
  return parsed.data.chapters.map((chapter, index) => {
    const match = ALIAS.exec(chapter.startAlias.trim());
    const position = match === null ? Number.NaN : Number(match[1]) - 1 - window.offset;
    const segment = window.segments[position];
    if (segment === undefined || position <= previous || (index === 0 && position !== 0)) {
      throw amberError("output_mismatch", "chapter aliases are invalid, out of order or do not start the window");
    }
    previous = position;
    const title = chapter.title.trim();
    if (title === "") {
      throw amberError("output_mismatch", "a chapter has no title");
    }
    const summary = chapter.summary?.trim() ?? "";
    return { startSegmentId: segment.id, title, ...(summary === "" ? {} : { summary }) };
  });
}

/** Chapter times are projections of sentence timing: each ends where the next starts, the last with the last sentence. */
function mergeWindows(segments: readonly TranscriptSegment[], payloads: readonly WindowPayload[]): ChapterRevision["chapters"] {
  const byId = new Map(segments.map((segment) => [segment.id as string, segment]));
  const starts = payloads.flatMap((payload) => payload.chapters);
  const last = segments[segments.length - 1] as TranscriptSegment;
  return starts.map((chapter, index) => {
    const segment = byId.get(chapter.startSegmentId);
    if (segment === undefined) {
      throw amberError("internal", "a stored chapter starts at a sentence outside the base transcript");
    }
    const next = starts[index + 1];
    const endMs = next === undefined ? last.endMs : (byId.get(next.startSegmentId) as TranscriptSegment).startMs;
    return {
      startMs: segment.startMs,
      endMs,
      title: chapter.title,
      ...(chapter.summary === undefined ? {} : { summary: chapter.summary }),
      startSegmentId: segment.id as SegmentId,
    };
  });
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
