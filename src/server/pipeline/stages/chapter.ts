import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { CHAPTER_COUNT_MAX, UI_LANGUAGE_DEFAULT } from "../../../shared/defaults.ts";
import type { SegmentId } from "../../../shared/ids.ts";
import type { ChapterRevision } from "../../domain/artifact.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import type { Content } from "../../domain/content.ts";
import { amberError } from "../../domain/errors.ts";
import type { LlmRequest } from "../../domain/llm.ts";
import type { ModelRef } from "../../domain/model-ref.ts";
import {
  candidateClock,
  CHAPTER_AI_PROMPT,
  CHAPTER_MERGE_PROMPT,
  chapterWindowNote,
  isBuiltinVersion,
  outputLanguageName,
  renderPrompt,
} from "../../domain/prompts.ts";
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
 *
 * Only the current builtin `chapter.ai` states `CHAPTER_COUNT_MAX` in its text, so only a
 * Task frozen on exactly that version is capped: when the transcript took several windows,
 * or its one window gave more chapters than the cap, every window's chapters become
 * candidates of one more call (`chapter.merge`, its own `chapter:merge` WorkUnit) that merges
 * neighbours — across window borders too — into at most the cap. A custom version or an
 * older builtin one is sent, digested and published exactly as before the cap existed.
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

    const capped = isBuiltinVersion(prompt.ref, CHAPTER_AI_PROMPT);
    // A merge is certain up front only with several windows; one window over the cap adds it late.
    const steps = windows.length + (capped && windows.length > 1 ? 1 : 0);
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
        context.reportProgress(finished / steps);
        return payload;
      }),
    );
    const failure = stageUnitFailure(settled);
    if (failure !== undefined) {
      throw failure;
    }
    const payloads = settled.map((result) => (result as PromiseFulfilledResult<WindowPayload>).value);
    const candidates = payloads.flatMap((payload) => payload.chapters);
    const merged =
      capped && (windows.length > 1 || candidates.length > CHAPTER_COUNT_MAX)
        ? await this.runMerge(context, { modelRef, revision, segments, payloads, structured, outputLanguage, limits })
        : undefined;
    const chapters = chaptersOf(segments, merged === undefined ? candidates : merged.chapters);
    const invocationIds = [...payloads.map((payload) => payload.invocationId), ...(merged === undefined ? [] : [merged.invocationId])];
    const promptRefs = [prompt.ref, ...(framing === undefined ? [] : [framing.rules.ref]), ...(merged === undefined ? [] : [CHAPTER_MERGE_PROMPT.ref])];
    const revisionId = this.newId();
    const artifactId = this.newId();
    const createdAt = this.now();
    return {
      resultJson: { revisionId, windows: windows.length, ...(merged === undefined ? {} : { merged: { candidates: candidates.length } }), reasons: [] },
      publish: (scope) => {
        assertBaseRevisionExists(scope, owner, content.id, revision.id);
        scope.chapters.insertAiRevision(owner, content.id, {
          id: revisionId,
          artifactId,
          transcriptRevisionId: revision.id,
          chapters,
          modelRef: description.snapshot,
          promptRef: prompt.ref,
          promptRefs,
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

  /**
   * The `chapter.merge` call over every window's chapters, as one paid DB-only WorkUnit. Its
   * digest covers the windows' results rather than the transcript: after a crash the
   * finished windows are reused, so an unchanged digest reuses a finished merge as well.
   * The request is checked against the budget as rendered; there is no further level of
   * merging, so a candidate list that does not fit fails the stage.
   */
  private async runMerge(
    context: StageExecutionContext,
    input: {
      modelRef: ModelRef;
      revision: TranscriptRevision;
      segments: readonly TranscriptSegment[];
      payloads: readonly WindowPayload[];
      structured: boolean;
      outputLanguage: string;
      limits: { contextWindowTokens?: number; maxOutputTokens?: number };
    },
  ): Promise<WindowPayload> {
    const { modelRef, revision, segments, payloads, structured, outputLanguage, limits } = input;
    const position = new Map(segments.map((segment, index) => [segment.id as string, index]));
    const candidates = payloads.flatMap((payload) => payload.chapters);
    const starts = candidates.map((chapter) => {
      const at = position.get(chapter.startSegmentId);
      if (at === undefined) {
        throw amberError("internal", "a stored chapter starts at a sentence outside the base transcript");
      }
      return at;
    });
    const lines = candidates.map((chapter, index) => {
      const at = starts[index] as number;
      const head = `[[s${at + 1}]] ${candidateClock((segments[at] as TranscriptSegment).startMs)} ${oneLine(chapter.title)}`;
      return chapter.summary === undefined ? head : `${head}｜${oneLine(chapter.summary)}`;
    });
    const prompt = renderPrompt(CHAPTER_MERGE_PROMPT.text, {
      max_chapters: String(CHAPTER_COUNT_MAX),
      output_language: outputLanguageName(outputLanguage),
      candidates: lines.join("\n"),
    });
    assertWindowFits(prompt, structured ? estimateTokens(JSON.stringify(RESPONSE_SCHEMA)) : 0, limits);
    const request: LlmRequest = {
      modelRef,
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      ...(structured ? { responseFormat: { type: "json_schema" as const, schema: RESPONSE_SCHEMA } } : {}),
    };
    const inputDigest = digestOf(
      canonicalJson({
        baseRevisionId: revision.id,
        windows: payloads.map((payload) => digestOf(canonicalJson(payload.chapters))),
        promptRef: CHAPTER_MERGE_PROMPT.ref,
        maxChapters: CHAPTER_COUNT_MAX,
        modelRef,
        outputLanguage,
        structured,
      }),
    );
    const value = await context.runUnit({
      key: "chapter:merge",
      inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity): Promise<WindowPayload> => {
        const completion = await context.llm.complete(request, { feature: "chapter", workUnitId: unit.id });
        return { chapters: parseMerge(completion.text, segments, starts), invocationId: completion.invocationId };
      },
    });
    const parsed = windowPayloadSchema.safeParse(value);
    if (!parsed.success) {
      throw amberError("internal", "a stored chapter merge does not match its shape");
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
 * strictly increasing order and titles are not blank. The count is not enforced here. Anything else is `output_mismatch`.
 */
function parseWindow(text: string, window: Window): WindowPayload["chapters"] {
  return checkedChapters(
    chapterEntries(text),
    (position) => window.segments[position - window.offset],
    window.offset,
    "chapter aliases are invalid, out of order or do not start the window",
  );
}

/**
 * The merged chapters, checked by the rules of the `chapter.merge` prompt: 1 to
 * `CHAPTER_COUNT_MAX` chapters, each starting at a candidate's start, the first at the first
 * candidate (the transcript's first sentence), in strictly increasing order, titles not
 * blank. Anything else is `output_mismatch`, so the merge is asked again.
 */
function parseMerge(text: string, segments: readonly TranscriptSegment[], starts: readonly number[]): WindowPayload["chapters"] {
  const chapters = chapterEntries(text);
  if (chapters.length > CHAPTER_COUNT_MAX) {
    throw amberError("output_mismatch", "the merge kept more chapters than the cap");
  }
  const allowed = new Set(starts);
  return checkedChapters(
    chapters,
    (position) => (allowed.has(position) ? segments[position] : undefined),
    starts[0] as number,
    "merged chapters do not start at candidates, are out of order or do not start the transcript",
  );
}

/** The chapter entries of a JSON answer, possibly wrapped in prose or a code fence; none is `output_mismatch`. */
function chapterEntries(text: string): z.infer<typeof outputSchema>["chapters"] {
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
  return parsed.data.chapters;
}

/**
 * Chapters whose start aliases resolve through `segmentAt` (by position in the revision),
 * the first at `first`, strictly increasing, with a title.
 */
function checkedChapters(
  chapters: z.infer<typeof outputSchema>["chapters"],
  segmentAt: (position: number) => TranscriptSegment | undefined,
  first: number,
  invalid: string,
): WindowPayload["chapters"] {
  let previous = -1;
  return chapters.map((chapter, index) => {
    const match = ALIAS.exec(chapter.startAlias.trim());
    const position = match === null ? Number.NaN : Number(match[1]) - 1;
    const segment = Number.isNaN(position) ? undefined : segmentAt(position);
    if (segment === undefined || position <= previous || (index === 0 && position !== first)) {
      throw amberError("output_mismatch", invalid);
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

/** A model-written title or summary on one candidate line. */
function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** Chapter times are projections of sentence timing: each ends where the next starts, the last with the last sentence. */
function chaptersOf(segments: readonly TranscriptSegment[], starts: WindowPayload["chapters"]): ChapterRevision["chapters"] {
  const byId = new Map(segments.map((segment) => [segment.id as string, segment]));
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
