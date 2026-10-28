import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../../src/server/domain/model-ref.ts";
import { CHAPTER_AI_PROMPT, chapterWindowNote, customPromptRef, renderPrompt } from "../../../../src/server/domain/prompts.ts";
import { estimateTokens } from "../../../../src/server/domain/token-estimate.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { transact } from "../../../../src/server/pipeline/publish.ts";
import { ChapterStageExecutor } from "../../../../src/server/pipeline/stages/chapter.ts";
import { SourceStageExecutor } from "../../../../src/server/pipeline/stages/source.ts";
import { createTask } from "../../../../src/server/pipeline/task-state.ts";
import { CONTEXT_SAFETY_RATIO } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import type { Logger } from "../../../../src/server/ports/logger.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import {
  configureLlm,
  countingExecutor,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  platformPipelineExecutors,
  silentLogger,
  stageRunsOf,
  stageStatuses,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const MAX_OUTPUT = 10;

interface Setup {
  h: Harness;
  fake: FakeLlmProvider;
  modelRef: ModelRef;
}

function setup(options: { contextWindowTokens?: number; structured?: boolean; logger?: Logger } = {}): Setup {
  const fake = new FakeLlmProvider();
  const h = createHarness({ llmProviders: [fake], ...(options.logger === undefined ? {} : { logger: options.logger }) });
  open.push(h);
  h.executors.chapter = new ChapterStageExecutor({ repository: h.repository, newId: h.newId });
  const modelRef = configureLlm(h);
  const limits = options.contextWindowTokens === undefined ? null : JSON.stringify({ contextWindowTokens: options.contextWindowTokens, maxOutputTokens: MAX_OUTPUT });
  h.db
    .prepare("UPDATE model_capability SET limits_user_override_json = ?, flags_user_override_json = ? WHERE profile_id = ?")
    .run(limits, JSON.stringify({ structuredOutput: options.structured === true ? "supported" : "unsupported" }), modelRef.providerProfileId);
  return { h, fake, modelRef };
}

/** An imported revision with one sentence per text, 1 s each, made primary. */
function transcript(h: Harness, contentId: string, texts: readonly string[]): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = texts.map((text, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId,
    ordinal,
    startMs: 1000 + ordinal * 1000,
    endMs: 1900 + ordinal * 1000,
    text,
    sourceSegmentIds: [],
  }));
  const revision: TranscriptRevision = {
    id: revisionId,
    contentId,
    kind: "imported",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "imported", format: "srt" },
    segmentCount: segments.length,
    createdAt: 1,
  };
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 2);
  });
  return { revision, segments };
}

function regenerate(s: Setup, texts: readonly string[]) {
  const contentId = createLocalContent(s.h);
  const base = transcript(s.h, contentId, texts);
  const taskId = createTaskOfKind(s.h, "regenerate_chapters", { modelRef: s.modelRef, baseRevisionId: base.revision.id, outputLanguage: "zh-CN" }, { contentId });
  return { contentId, taskId, ...base };
}

async function settled(h: Harness, taskId: string, stage = "chapter"): Promise<string> {
  await waitFor(() => ["succeeded", "failed", "skipped"].includes(stageStatuses(h, taskId)[stage] ?? ""));
  return stageStatuses(h, taskId)[stage] as string;
}

function promptOf(request: LlmRequest): string {
  const part = request.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
}

/** Aliases in a call's transcript section, in order. */
function aliasesOf(request: LlmRequest): string[] {
  return [...promptOf(request).matchAll(/\[\[(s\d+)\]\]/g)].map((match) => match[1] as string);
}

function json(text: unknown): LlmStreamEvent[] {
  return reply(typeof text === "string" ? text : JSON.stringify(text));
}

/** Answers every call with one chapter per window, starting at the window's first sentence. */
function oneChapterPerWindow(fake: FakeLlmProvider, calls = 20, invalidFirstFor?: string): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < calls; i += 1) {
    fake.script((request) =>
      (async function* () {
        const first = aliasesOf(request)[0] as string;
        const count = (seen.get(first) ?? 0) + 1;
        seen.set(first, count);
        if (first === invalidFirstFor && count === 1) {
          yield* json("抱歉，无法完成");
          return;
        }
        yield* json({ chapters: [{ startAlias: first, title: `第 ${first} 起`, summary: "概要" }] });
      })(),
    );
  }
}

const currentOf = (h: Harness, contentId: string) => h.repository.withTransaction((scope) => scope.chapters.getCurrent(LOCAL.userId, contentId));
const resultOf = (h: Harness, taskId: string) =>
  JSON.parse(stageRunsOf(h, taskId).filter((run) => run.stage === "chapter").at(-1)?.resultJson ?? "{}") as Record<string, unknown>;
const errorOf = (h: Harness, taskId: string) => stageRunsOf(h, taskId).filter((run) => run.stage === "chapter").at(-1)?.error;

describe("chapter stage", () => {
  it("one window yields an AI revision anchored to sentences, made current, with usage attributed", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = regenerate(s, ["开场白", "第一部分内容", "第二部分内容", "总结"]);
    s.fake.script({ events: json({ chapters: [{ startAlias: "s1", title: " 开场 ", summary: "引入" }, { startAlias: "s3", title: "第二部分", summary: "" }] }) });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    const current = currentOf(s.h, job.contentId);
    expect(current?.id).toBe(resultOf(s.h, job.taskId)["revisionId"]);
    expect(current?.origin).toEqual({ kind: "ai", transcriptRevisionId: job.revision.id });
    expect(current?.chapters).toEqual([
      { startMs: 1000, endMs: 3000, title: "开场", summary: "引入", startSegmentId: job.segments[0]?.id },
      { startMs: 3000, endMs: 4900, title: "第二部分", startSegmentId: job.segments[2]?.id },
    ]);
    expect(current?.provenance).toMatchObject({
      inputs: [{ kind: "transcriptRevision", id: job.revision.id }],
      modelRef: { ...s.modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: s.modelRef.modelId },
      promptRef: { id: "chapter.ai", version: 2 },
      promptSnapshot: renderPrompt(CHAPTER_AI_PROMPT.text, { output_language: "简体中文" }),
    });
    expect(current?.provenance.promptSnapshot).toContain("{{transcript_with_aliases}}");
    expect(resultOf(s.h, job.taskId)).toMatchObject({ windows: 1, reasons: [] });

    const [call] = s.fake.calls;
    expect(promptOf(call?.request as LlmRequest)).toContain("[[s1]] 开场白\n[[s2]] 第一部分内容");
    expect(promptOf(call?.request as LlmRequest)).not.toContain("{{window_note}}");
    expect(promptOf(call?.request as LlmRequest)).not.toContain("这是全文的第");
    const usage = s.h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId, { taskId: job.taskId }));
    expect(usage.map((row) => [row.feature, row.artifactRevisionId])).toEqual([["chapter", current?.id]]);
    expect(workUnitsOf(s.h, job.taskId).map((unit) => [unit.key, unit.billing])).toEqual([["chapter:window:0", "llm"]]);
  });

  it("splits a long transcript into budget-sized windows of consecutive sentences and merges them", async () => {
    const texts = ["甲甲甲甲甲甲", "乙乙乙乙乙乙", "丙丙丙丙丙丙", "丁丁丁丁丁丁", "戊戊戊戊戊戊", "己己己己己己"];
    const template = renderPrompt(CHAPTER_AI_PROMPT.text, { output_language: "简体中文" });
    const fixed = estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(texts.length, texts.length), transcript_with_aliases: "" }));
    const line = estimateTokens(`[[s1]] ${texts[0]}\n`);
    const contextWindowTokens = Math.ceil((fixed + 2 * line + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO);
    const s = setup({ contextWindowTokens });
    const job = regenerate(s, texts);
    oneChapterPerWindow(s.fake);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    const windows = s.fake.calls.map((call) => aliasesOf(call.request)).sort((a, b) => a[0]!.localeCompare(b[0]!));
    expect(windows).toEqual([["s1", "s2"], ["s3", "s4"], ["s5", "s6"]]);
    const notes = s.fake.calls.map((call) => /这是全文的第 (\d)\/3 段。/.exec(promptOf(call.request))?.[1]).sort();
    expect(notes).toEqual(["1", "2", "3"]);
    expect(currentOf(s.h, job.contentId)?.chapters.map((chapter) => [chapter.startSegmentId, chapter.startMs, chapter.endMs])).toEqual([
      [job.segments[0]?.id, 1000, 3000],
      [job.segments[2]?.id, 3000, 5000],
      [job.segments[4]?.id, 5000, 6900],
    ]);
    expect(workUnitsOf(s.h, job.taskId).map((unit) => unit.key).sort()).toEqual(["chapter:window:0", "chapter:window:1", "chapter:window:2"]);
    expect(resultOf(s.h, job.taskId)).toMatchObject({ windows: 3 });
  });

  it.each([
    ["the first chapter does not start the window", { chapters: [{ startAlias: "s2", title: "A", summary: "" }] }],
    ["aliases do not increase", { chapters: [{ startAlias: "s1", title: "A", summary: "" }, { startAlias: "s3", title: "B", summary: "" }, { startAlias: "s2", title: "C", summary: "" }] }],
    ["an alias is outside the transcript", { chapters: [{ startAlias: "s1", title: "A", summary: "" }, { startAlias: "s9", title: "B", summary: "" }] }],
    ["a title is blank", { chapters: [{ startAlias: "s1", title: "  ", summary: "" }] }],
    ["the output is not JSON", "好的，以下是章节划分"],
  ])("retries the window once with output_mismatch when %s", async (_case, invalid) => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = regenerate(s, ["一", "二", "三"]);
    s.fake.script({ events: json(invalid) }, { events: json("```json\n" + JSON.stringify({ chapters: [{ startAlias: "s1", title: "全部" }] }) + "\n```") });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(s.fake.calls).toHaveLength(2);
    // The retry happens inside the unit's run: one unit, two calls.
    expect(workUnitsOf(s.h, job.taskId).map((unit) => [unit.key, unit.status])).toEqual([["chapter:window:0", "succeeded"]]);
    expect(currentOf(s.h, job.contentId)?.chapters).toEqual([{ startMs: 1000, endMs: 3900, title: "全部", startSegmentId: job.segments[0]?.id }]);
  });

  it("retries only the window whose output was invalid", async () => {
    const texts = ["甲甲甲甲甲甲", "乙乙乙乙乙乙", "丙丙丙丙丙丙", "丁丁丁丁丁丁"];
    const template = renderPrompt(CHAPTER_AI_PROMPT.text, { output_language: "简体中文" });
    const fixed = estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(texts.length, texts.length), transcript_with_aliases: "" }));
    const line = estimateTokens(`[[s1]] ${texts[0]}\n`);
    const s = setup({ contextWindowTokens: Math.ceil((fixed + 2 * line + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO) });
    const job = regenerate(s, texts);
    oneChapterPerWindow(s.fake, 20, "s3");
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    const firstAliases = s.fake.calls.map((call) => aliasesOf(call.request)[0]).sort();
    expect(firstAliases).toEqual(["s1", "s3", "s3"]);
    expect(Object.fromEntries(workUnitsOf(s.h, job.taskId).map((unit) => [unit.key, unit.status]))).toEqual({ "chapter:window:0": "succeeded", "chapter:window:1": "succeeded" });
  });

  it("asks for a JSON schema with an object root only when structured output is supported", async () => {
    for (const structured of [true, false]) {
      const s = setup({ contextWindowTokens: 128_000, structured });
      const job = regenerate(s, ["一", "二"]);
      s.fake.script({ events: json({ chapters: [{ startAlias: "s1", title: "全部", summary: "概要" }] }) });
      s.h.scheduler.start();
      expect(await settled(s.h, job.taskId)).toBe("succeeded");
      const request = s.fake.calls[0]?.request as LlmRequest;
      if (structured) {
        expect(request.responseFormat).toMatchObject({ type: "json_schema", schema: { type: "object", required: ["chapters"] } });
      } else {
        expect(request).not.toHaveProperty("responseFormat");
      }
    }
  });

  it("fails before any call with context_window_unknown when the model has no effective window", async () => {
    const s = setup();
    const job = regenerate(s, ["一", "二"]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)).toMatchObject({
      class: "llm_capability",
      code: "llm_capability.context_window_unknown",
      retryDisposition: "never",
      details: { providerProfileId: s.modelRef.providerProfileId, modelId: s.modelRef.modelId },
    });
    expect(s.fake.calls).toHaveLength(0);
    expect(workUnitsOf(s.h, job.taskId)).toEqual([]);
  });

  it("fails with context_length when nothing fits the budget or one sentence alone exceeds it", async () => {
    const tiny = setup({ contextWindowTokens: 100 });
    const tinyJob = regenerate(tiny, ["一", "二"]);
    tiny.h.scheduler.start();
    expect(await settled(tiny.h, tinyJob.taskId)).toBe("failed");
    expect(errorOf(tiny.h, tinyJob.taskId)?.code).toBe("llm_capability.context_length");

    const template = renderPrompt(CHAPTER_AI_PROMPT.text, { output_language: "简体中文" });
    const fixed = estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(2, 2), transcript_with_aliases: "" }));
    const small = setup({ contextWindowTokens: Math.ceil((fixed + 50 + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO) });
    const smallJob = regenerate(small, ["短句", "长".repeat(200)]);
    small.h.scheduler.start();
    expect(await settled(small.h, smallJob.taskId)).toBe("failed");
    expect(errorOf(small.h, smallJob.taskId)?.code).toBe("llm_capability.context_length");
    expect(tiny.fake.calls.length + small.fake.calls.length).toBe(0);
  });

  it("a Content with platform chapters never calls the model; its first chapter starts at 0", async () => {
    const fake = new FakeLlmProvider();
    const executors = platformPipelineExecutors();
    const h = createHarness({ llmProviders: [fake], executors });
    open.push(h);
    executors.source = Object.assign(new SourceStageExecutor({ repository: h.repository, platforms: h.platformAccess, newId: h.newId }), { calls: 0 });
    executors.chapter = Object.assign(new ChapterStageExecutor({ repository: h.repository, newId: h.newId }), { calls: 0 });
    executors.subtitle = countingExecutor({ verdict: "valid", reasons: [] });
    const modelRef = configureLlm(h);
    const bvid = "BV1chp41c001";
    h.platforms.bilibili.video(bvid, {
      metadata: { title: "课程", durationMs: 600_000, chapters: [{ startMs: 4_000, title: "开篇" }, { startMs: 300_000, title: "深入" }] },
    });
    const contentId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.contents.insert({
        id: contentId,
        userId: LOCAL.userId,
        source: { kind: "bilibili", sourceUrl: `https://www.bilibili.com/video/${bvid}`, platformContentId: bvid, platformPartId: `${bvid}-cid` },
        processingStatus: "queued",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const taskId = transact(h.repository, h.bus, (scope, outbox) =>
      createTask(scope, outbox, {
        task: {
          id: h.newId(),
          userId: LOCAL.userId,
          contentId,
          kind: "process_content",
          requestJson: canonicalJson({ requestSchemaVersion: 1, kind: "process_content", modelRef, autoProofread: false }),
          createdAt: Date.now(),
        },
        sourceKind: "bilibili",
        newId: h.newId,
      }).id,
    );
    h.scheduler.start();
    await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId)["summary"] ?? ""));
    expect(stageStatuses(h, taskId)).toMatchObject({ source: "succeeded", chapter: "skipped" });
    expect(fake.calls).toHaveLength(0);
    const current = currentOf(h, contentId);
    expect(current?.origin).toEqual({ kind: "platform" });
    expect(current?.chapters[0]).toMatchObject({ startMs: 0, title: "开篇" });
  });

  it("is a no-op without a model call when platform chapters exist even if the stage is reached", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const contentId = createLocalContent(s.h);
    transcript(s.h, contentId, ["一", "二"]);
    s.h.repository.withTransaction((scope) =>
      scope.chapters.insertPlatformRevision(LOCAL.userId, contentId, { id: s.h.newId(), artifactId: s.h.newId(), chapters: [{ startMs: 0, endMs: 5000, title: "平台" }], createdAt: 3 }),
    );
    const context = {
      task: { id: "t", userId: LOCAL.userId, contentId, kind: "process_content" },
      request: { requestSchemaVersion: 1, kind: "process_content", autoProofread: false },
      modelRef: s.modelRef,
    } as unknown as Parameters<ChapterStageExecutor["run"]>[0];
    const outcome = await new ChapterStageExecutor({ repository: s.h.repository }).run(context);
    expect(outcome.publish).toBeUndefined();
    expect(s.fake.calls).toHaveLength(0);
  });

  describe("custom prompts", () => {
    const CUSTOM_V1 = `${CHAPTER_AI_PROMPT.text}\n自定义标记一：章节标题用名词短语。`;
    const CUSTOM_V2 = `${CHAPTER_AI_PROMPT.text}\n自定义标记二：标题不超过 8 字。`;

    /** A Content with a primary transcript and a chapter Task created through the service, which freezes the prompts in effect. */
    async function submitted(s: Setup, texts: readonly string[]) {
      const contentId = createLocalContent(s.h);
      const base = transcript(s.h, contentId, texts);
      const accepted = await s.h.derivedTasks.regenerateChapters(LOCAL, contentId, { modelRef: s.modelRef });
      return { contentId, taskId: accepted.body.taskId, ...base };
    }

    it("a custom chapter.ai prompt is sent, its JSON answer parsed, and recorded as the provenance", async () => {
      const s = setup({ contextWindowTokens: 128_000 });
      s.h.prompts.update(LOCAL, "chapter.ai", { text: CUSTOM_V1 });
      const job = await submitted(s, ["开场白", "第一部分", "第二部分"]);
      s.fake.script({ events: json({ chapters: [{ startAlias: "s1", title: "开场", summary: "引入" }, { startAlias: "s2", title: "主体", summary: "" }] }) });
      s.h.scheduler.start();
      expect(await settled(s.h, job.taskId)).toBe("succeeded");

      const sent = promptOf(s.fake.calls[0]?.request as LlmRequest);
      expect(sent).toBe(renderPrompt(CUSTOM_V1, { output_language: "简体中文", window_note: "", transcript_with_aliases: "[[s1]] 开场白\n[[s2]] 第一部分\n[[s3]] 第二部分" }));
      const current = currentOf(s.h, job.contentId);
      expect(current?.chapters.map((chapter) => chapter.title)).toEqual(["开场", "主体"]);
      const ref = customPromptRef("chapter.ai", 1);
      expect(current?.provenance.promptRef).toEqual(ref);
      expect(current?.provenance.promptRefs).toEqual([ref]);
      expect(current?.provenance.promptSnapshot).toBe(renderPrompt(CUSTOM_V1, { output_language: "简体中文" }));
    });

    it("a queued Task runs with the version frozen at submission, not one saved afterwards", async () => {
      const s = setup({ contextWindowTokens: 128_000 });
      s.h.prompts.update(LOCAL, "chapter.ai", { text: CUSTOM_V1 });
      const customJob = await submitted(s, ["一", "二"]);
      s.h.prompts.restore(LOCAL, "chapter.ai");
      const builtinJob = await submitted(s, ["三", "四"]);
      s.h.prompts.update(LOCAL, "chapter.ai", { text: CUSTOM_V2 });
      oneChapterPerWindow(s.fake, 2);
      s.h.scheduler.start();
      expect(await settled(s.h, customJob.taskId)).toBe("succeeded");
      expect(await settled(s.h, builtinJob.taskId)).toBe("succeeded");

      const sentFor = (first: string) => promptOf(s.fake.calls.find((call) => promptOf(call.request).includes(`[[s1]] ${first}`))?.request as LlmRequest);
      expect(sentFor("一")).toContain("自定义标记一");
      expect(sentFor("三")).not.toContain("自定义标记");
      expect(s.fake.calls.some((call) => promptOf(call.request).includes("自定义标记二"))).toBe(false);
      expect(currentOf(s.h, customJob.contentId)?.provenance.promptRefs).toEqual([customPromptRef("chapter.ai", 1)]);
      expect(currentOf(s.h, builtinJob.contentId)?.provenance.promptRefs).toEqual([CHAPTER_AI_PROMPT.ref]);
    });

    it("a Task without frozen prompts runs with the version in effect when it executes", async () => {
      const s = setup({ contextWindowTokens: 128_000 });
      const job = regenerate(s, ["一", "二"]);
      s.h.prompts.update(LOCAL, "chapter.ai", { text: CUSTOM_V1 });
      oneChapterPerWindow(s.fake, 1);
      s.h.scheduler.start();
      expect(await settled(s.h, job.taskId)).toBe("succeeded");
      expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toContain("自定义标记一");
      expect(currentOf(s.h, job.contentId)?.provenance.promptRef).toEqual(customPromptRef("chapter.ai", 1));
    });

    it.each([
      ["a builtin version that never existed", { id: "chapter.ai", version: 99 }],
      ["a custom version the user does not have", { id: "custom:chapter.ai", version: 7 }],
    ])("a frozen ref to %s falls back to the current builtin text and still succeeds", async (_case, frozen) => {
      const warnings: Array<{ message: string; fields?: unknown }> = [];
      const logger: Logger = { ...silentLogger, warn: (message, fields) => void warnings.push({ message, fields }), child: () => logger };
      const s = setup({ contextWindowTokens: 128_000, logger });
      s.h.prompts.update(LOCAL, "chapter.ai", { text: CUSTOM_V1 });
      const contentId = createLocalContent(s.h);
      const base = transcript(s.h, contentId, ["一", "二"]);
      const taskId = createTaskOfKind(
        s.h,
        "regenerate_chapters",
        { modelRef: s.modelRef, baseRevisionId: base.revision.id, outputLanguage: "zh-CN", promptRefs: { "chapter.ai": frozen } },
        { contentId },
      );
      oneChapterPerWindow(s.fake, 1);
      s.h.scheduler.start();
      expect(await settled(s.h, taskId)).toBe("succeeded");

      const sent = promptOf(s.fake.calls[0]?.request as LlmRequest);
      expect(sent).toBe(renderPrompt(CHAPTER_AI_PROMPT.text, { output_language: "简体中文", window_note: "", transcript_with_aliases: "[[s1]] 一\n[[s2]] 二" }));
      expect(currentOf(s.h, contentId)?.provenance.promptRef).toEqual(CHAPTER_AI_PROMPT.ref);
      expect(warnings).toContainEqual({
        message: "prompt_version_unresolved",
        fields: expect.objectContaining({ taskId, stage: "chapter", promptId: "chapter.ai", ref: `${frozen.id}@${frozen.version}` }),
      });
    });
  });
});
