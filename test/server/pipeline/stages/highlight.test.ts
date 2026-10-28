import { afterEach, describe, expect, it } from "vitest";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../../src/server/domain/model-ref.ts";
import { chapterWindowNote, customPromptRef, HIGHLIGHT_DEFAULT_PROMPT, renderPrompt } from "../../../../src/server/domain/prompts.ts";
import { estimateTokens } from "../../../../src/server/domain/token-estimate.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { HighlightStageExecutor } from "../../../../src/server/pipeline/stages/highlight.ts";
import { highlightsDtoSchema } from "../../../../src/shared/dto/highlight.ts";
import { CITATION_INVALID_RATIO_MAX, CONTEXT_SAFETY_RATIO } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import { PipelineLlmProvider } from "../../../fixtures/llm/pipeline-llm.ts";
import {
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  LOCAL_TOKEN,
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

function setup(options: { contextWindowTokens?: number; structured?: boolean; provider?: FakeLlmProvider } = {}): Setup {
  const fake = options.provider ?? new FakeLlmProvider();
  const h = createHarness({ llmProviders: [fake] });
  open.push(h);
  h.executors.highlight = new HighlightStageExecutor({ repository: h.repository, newId: h.newId });
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

function recompute(s: Setup, texts: readonly string[]) {
  const contentId = createLocalContent(s.h);
  const base = transcript(s.h, contentId, texts);
  const taskId = createTaskOfKind(s.h, "recompute_highlights", { modelRef: s.modelRef, baseRevisionId: base.revision.id, outputLanguage: "zh-CN" }, { contentId });
  return { contentId, taskId, ...base };
}

async function settled(h: Harness, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed", "skipped"].includes(stageStatuses(h, taskId)["highlight"] ?? ""));
  return stageStatuses(h, taskId)["highlight"] as string;
}

function promptOf(request: LlmRequest): string {
  const part = request.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
}

function aliasesOf(request: LlmRequest): string[] {
  return [...promptOf(request).matchAll(/\[\[(s\d+)\]\]/g)].map((match) => match[1] as string);
}

function json(value: unknown): LlmStreamEvent[] {
  return reply(typeof value === "string" ? value : JSON.stringify(value));
}

const texts = (count: number): string[] => Array.from({ length: count }, (_, index) => `第 ${index + 1} 句`);
const currentOf = (h: Harness, contentId: string) => h.repository.withTransaction((scope) => scope.highlights.getCurrent(LOCAL.userId, contentId));
const resultOf = (h: Harness, taskId: string) =>
  JSON.parse(stageRunsOf(h, taskId).filter((run) => run.stage === "highlight").at(-1)?.resultJson ?? "{}") as Record<string, unknown>;
const errorOf = (h: Harness, taskId: string) => stageRunsOf(h, taskId).filter((run) => run.stage === "highlight").at(-1)?.error;

describe("highlight stage", () => {
  it("scored items point at sentences of the base transcript, scores are rounded and clamped, and the DTO carries the sentences", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = recompute(s, ["开场白", "核心结论\n在这里", "一个例子", "总结"]);
    s.fake.script({
      events: json({
        highlights: [
          { alias: "s4", score: 87.4, text: " 收束全片 " },
          { alias: "s2", score: 104.6, text: "核心结论" },
          { alias: "s1", score: -3, text: "开场" },
        ],
      }),
    });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    const current = currentOf(s.h, job.contentId);
    expect(current?.id).toBe(resultOf(s.h, job.taskId)["revisionId"]);
    expect(current?.transcriptRevisionId).toBe(job.revision.id);
    expect(current?.items).toEqual([
      { segmentId: job.segments[0]?.id, score: 0, text: "开场" },
      { segmentId: job.segments[1]?.id, score: 100, text: "核心结论" },
      { segmentId: job.segments[3]?.id, score: 87, text: "收束全片" },
    ]);
    const segmentIds = new Set(job.segments.map((segment) => segment.id as string));
    expect(current?.items.every((item) => segmentIds.has(item.segmentId) && item.score >= 0 && item.score <= 100)).toBe(true);
    expect(current?.provenance).toMatchObject({
      inputs: [{ kind: "transcriptRevision", id: job.revision.id }],
      modelRef: { ...s.modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: s.modelRef.modelId },
      promptRef: { id: "highlight.default", version: 2 },
      promptSnapshot: renderPrompt(HIGHLIGHT_DEFAULT_PROMPT.text, { output_language: "简体中文" }),
    });
    expect(resultOf(s.h, job.taskId)).toEqual({ revisionId: current?.id, windows: 1, dropped: 0, reasons: [] });

    // One physical line per sentence on the wire; the stored text is unchanged.
    const prompt = promptOf(s.fake.calls[0]?.request as LlmRequest);
    expect(prompt).toContain("[[s1]] 开场白\n[[s2]] 核心结论 在这里\n[[s3]] 一个例子");
    expect(prompt).toContain("说明使用 简体中文");
    expect(prompt).not.toContain("这是全文的第");
    const usage = s.h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId, { taskId: job.taskId }));
    expect(usage.map((row) => [row.feature, row.artifactRevisionId])).toEqual([["highlight", current?.id]]);
    expect(workUnitsOf(s.h, job.taskId).map((unit) => [unit.key, unit.billing])).toEqual([["highlight:window:0", "llm"]]);

    const { app } = await s.h.app();
    const response = await app.inject({ method: "GET", url: `/api/contents/${job.contentId}/highlights`, headers: { authorization: `Bearer ${LOCAL_TOKEN}` } });
    expect(response.statusCode).toBe(200);
    const dto = highlightsDtoSchema.parse(response.json());
    expect(dto.current?.items).toEqual([
      { segmentId: job.segments[0]?.id, score: 0, text: "开场", segmentText: "开场白", startMs: 1000, endMs: 1900 },
      { segmentId: job.segments[1]?.id, score: 100, text: "核心结论", segmentText: "核心结论\n在这里", startMs: 2000, endMs: 2900 },
      { segmentId: job.segments[3]?.id, score: 87, text: "收束全片", segmentText: "总结", startMs: 4000, endMs: 4900 },
    ]);
    // The highlight threshold filter works on these scores.
    expect(dto.current?.items.filter((item) => item.score >= 80).map((item) => item.score)).toEqual([100, 87]);
    expect(dto.current).toMatchObject({ stale: false, quality: "normal", qualityReasons: [] });
  });

  it("invalid aliases above CITATION_INVALID_RATIO_MAX fail the window with output_mismatch and the retry succeeds", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = recompute(s, ["一", "二", "三"]);
    const invalid = { highlights: [{ alias: "s2", score: 90, text: "有效" }, { alias: "s9", score: 80, text: "越界" }] };
    expect(1 / invalid.highlights.length).toBeGreaterThan(CITATION_INVALID_RATIO_MAX);
    s.fake.script({ events: json(invalid) }, { events: json({ highlights: [{ alias: "s3", score: 75, text: "重答" }] }) });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(s.fake.calls).toHaveLength(2);
    // The retry happens inside the unit's run: one unit, two calls, one revision.
    expect(workUnitsOf(s.h, job.taskId).map((unit) => [unit.key, unit.status])).toEqual([["highlight:window:0", "succeeded"]]);
    expect(currentOf(s.h, job.contentId)?.items).toEqual([{ segmentId: job.segments[2]?.id, score: 75, text: "重答" }]);
    const revisions = s.h.db.prepare("SELECT COUNT(*) AS n FROM highlight_revision").get() as { n: number };
    expect(revisions.n).toBe(1);
  });

  it("invalid entries within CITATION_INVALID_RATIO_MAX are dropped without a retry", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = recompute(s, texts(25));
    const valid = Array.from({ length: 20 }, (_, index) => ({ alias: `s${index + 1}`, score: 60 + index, text: `理由 ${index + 1}` }));
    const entries = [...valid, { alias: "s99", score: 99, text: "越界" }];
    expect(1 / entries.length).toBeLessThanOrEqual(CITATION_INVALID_RATIO_MAX);
    s.fake.script({ events: json({ highlights: entries }) });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(s.fake.calls).toHaveLength(1);
    expect(currentOf(s.h, job.contentId)?.items).toHaveLength(20);
    expect(resultOf(s.h, job.taskId)).toMatchObject({ dropped: 1 });
  });

  it.each([
    ["a score that is not a number", { highlights: [{ alias: "s1", score: "高", text: "x" }, { alias: "s2", score: 50, text: "y" }] }],
    ["an alias that is not s<n>", { highlights: [{ alias: "第一句", score: 90, text: "x" }, { alias: "s2", score: 50, text: "y" }] }],
    ["an output that is not JSON", "以下是高光"],
    ["a JSON object without highlights", { items: [] }],
  ])("retries the window with output_mismatch for %s", async (_case, invalid) => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = recompute(s, ["一", "二", "三"]);
    s.fake.script({ events: json(invalid) }, { events: json("```json\n" + JSON.stringify({ highlights: [{ alias: "s1", score: 70, text: "好" }] }) + "\n```") });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(s.fake.calls).toHaveLength(2);
    expect(currentOf(s.h, job.contentId)?.items).toEqual([{ segmentId: job.segments[0]?.id, score: 70, text: "好" }]);
  });

  it("keeps the first entry of a repeated alias and accepts an empty list", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = recompute(s, ["一", "二"]);
    s.fake.script({ events: json({ highlights: [{ alias: "s2", score: 90, text: "先" }, { alias: "s2", score: 10, text: "后" }] }) });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(currentOf(s.h, job.contentId)?.items).toEqual([{ segmentId: job.segments[1]?.id, score: 90, text: "先" }]);
    expect(resultOf(s.h, job.taskId)).toMatchObject({ dropped: 0 });

    const empty = setup({ contextWindowTokens: 128_000 });
    const emptyJob = recompute(empty, ["一"]);
    empty.fake.script({ events: json({ highlights: [] }) });
    empty.h.scheduler.start();
    expect(await settled(empty.h, emptyJob.taskId)).toBe("succeeded");
    expect(currentOf(empty.h, emptyJob.contentId)?.items).toEqual([]);
  });

  it("splits a long transcript into budget-sized windows and merges their items in time order", async () => {
    const lines = ["甲甲甲甲甲甲", "乙乙乙乙乙乙", "丙丙丙丙丙丙", "丁丁丁丁丁丁", "戊戊戊戊戊戊", "己己己己己己"];
    const template = renderPrompt(HIGHLIGHT_DEFAULT_PROMPT.text, { output_language: "简体中文" });
    const fixed = estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(lines.length, lines.length), transcript_with_aliases: "" }));
    const line = estimateTokens(`[[s1]] ${lines[0]}\n`);
    // Room for two lines and a half: the budget is floored, so exactly two would be fragile.
    const s = setup({ contextWindowTokens: Math.ceil((fixed + 2.5 * line + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO) });
    const job = recompute(s, lines);
    for (let i = 0; i < 3; i += 1) {
      s.fake.script((request) =>
        (async function* () {
          const aliases = aliasesOf(request);
          // The later sentence first, to show the merge orders by time.
          yield* json({ highlights: [{ alias: aliases[1], score: 80, text: "后" }, { alias: aliases[0], score: 90, text: "前" }] });
        })(),
      );
    }
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    const windows = s.fake.calls.map((call) => aliasesOf(call.request)).sort((a, b) => a[0]!.localeCompare(b[0]!));
    expect(windows).toEqual([["s1", "s2"], ["s3", "s4"], ["s5", "s6"]]);
    const notes = s.fake.calls.map((call) => /这是全文的第 (\d)\/3 段。/.exec(promptOf(call.request))?.[1]).sort();
    expect(notes).toEqual(["1", "2", "3"]);
    expect(currentOf(s.h, job.contentId)?.items.map((item) => item.segmentId)).toEqual(job.segments.map((segment) => segment.id));
    expect(workUnitsOf(s.h, job.taskId).map((unit) => unit.key).sort()).toEqual(["highlight:window:0", "highlight:window:1", "highlight:window:2"]);
    expect(resultOf(s.h, job.taskId)).toMatchObject({ windows: 3 });
  });

  it("asks for a JSON schema with an object root only when structured output is supported", async () => {
    for (const structured of [true, false]) {
      const s = setup({ contextWindowTokens: 128_000, structured });
      const job = recompute(s, ["一", "二"]);
      s.fake.script({ events: json({ highlights: [{ alias: "s1", score: 90, text: "好" }] }) });
      s.h.scheduler.start();
      expect(await settled(s.h, job.taskId)).toBe("succeeded");
      const request = s.fake.calls[0]?.request as LlmRequest;
      if (structured) {
        expect(request.responseFormat).toMatchObject({ type: "json_schema", schema: { type: "object", required: ["highlights"] } });
      } else {
        expect(request).not.toHaveProperty("responseFormat");
      }
    }
  });

  it("fails before any call with context_window_unknown when the model has no effective window", async () => {
    const s = setup();
    const job = recompute(s, ["一", "二"]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)).toMatchObject({
      class: "llm_capability",
      code: "llm_capability.context_window_unknown",
      details: { providerProfileId: s.modelRef.providerProfileId, modelId: s.modelRef.modelId },
    });
    expect(s.fake.calls).toHaveLength(0);
    expect(workUnitsOf(s.h, job.taskId)).toEqual([]);
  });

  it("fails with context_length when a single sentence exceeds the budget", async () => {
    const template = renderPrompt(HIGHLIGHT_DEFAULT_PROMPT.text, { output_language: "简体中文" });
    const fixed = estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(2, 2), transcript_with_aliases: "" }));
    const s = setup({ contextWindowTokens: Math.ceil((fixed + 50 + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO) });
    const job = recompute(s, ["短句", "长".repeat(200)]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)?.code).toBe("llm_capability.context_length");
    expect(s.fake.calls).toHaveLength(0);
  });

  it("runs on the frozen base even after the primary moved, and answers the pipeline fixture", async () => {
    const s = setup({ contextWindowTokens: 128_000, provider: new PipelineLlmProvider() });
    const job = recompute(s, texts(9));
    // A newer primary does not change what the Task works on.
    transcript(s.h, job.contentId, ["新稿"]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    const current = currentOf(s.h, job.contentId);
    expect(current?.transcriptRevisionId).toBe(job.revision.id);
    expect(current?.items.map((item) => item.segmentId)).toEqual([job.segments[0]?.id, job.segments[4]?.id, job.segments[8]?.id]);
  });

  describe("custom prompts", () => {
    const CUSTOM_V1 = `${HIGHLIGHT_DEFAULT_PROMPT.text}\n自定义标记一：偏好定义类片段。`;
    const CUSTOM_V2 = `${HIGHLIGHT_DEFAULT_PROMPT.text}\n自定义标记二：偏好例子。`;
    const answer = { events: json({ highlights: [{ alias: "s1", score: 80, text: "开场" }, { alias: "s2", score: 60, text: "结论" }] }) };

    async function submitted(s: Setup, sentences: readonly string[]) {
      const contentId = createLocalContent(s.h);
      const base = transcript(s.h, contentId, sentences);
      const accepted = await s.h.derivedTasks.recomputeHighlights(LOCAL, contentId, { modelRef: s.modelRef });
      return { contentId, taskId: accepted.body.taskId, ...base };
    }

    it("a custom highlight.default prompt is sent, its JSON answer parsed, and recorded as the provenance", async () => {
      const s = setup({ contextWindowTokens: 128_000 });
      s.h.prompts.update(LOCAL, "highlight.default", { text: CUSTOM_V1 });
      const job = await submitted(s, ["开场白", "核心结论"]);
      s.fake.script(answer);
      s.h.scheduler.start();
      expect(await settled(s.h, job.taskId)).toBe("succeeded");

      expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toBe(
        renderPrompt(CUSTOM_V1, { output_language: "简体中文", window_note: "", transcript_with_aliases: "[[s1]] 开场白\n[[s2]] 核心结论" }),
      );
      const current = currentOf(s.h, job.contentId);
      expect(current?.items.map((item) => [item.segmentId, item.score])).toEqual([[job.segments[0]?.id, 80], [job.segments[1]?.id, 60]]);
      const ref = customPromptRef("highlight.default", 1);
      expect(current?.provenance.promptRef).toEqual(ref);
      expect(current?.provenance.promptRefs).toEqual([ref]);
      expect(current?.provenance.promptSnapshot).toBe(renderPrompt(CUSTOM_V1, { output_language: "简体中文" }));
    });

    it("a queued Task keeps the version frozen at submission; a Task without frozen prompts takes the one in effect", async () => {
      const s = setup({ contextWindowTokens: 128_000 });
      s.h.prompts.update(LOCAL, "highlight.default", { text: CUSTOM_V1 });
      const frozenJob = await submitted(s, ["甲", "乙"]);
      const legacyJob = recompute(s, ["丙", "丁"]);
      s.h.prompts.update(LOCAL, "highlight.default", { text: CUSTOM_V2 });
      s.fake.script(answer, answer);
      s.h.scheduler.start();
      expect(await settled(s.h, frozenJob.taskId)).toBe("succeeded");
      expect(await settled(s.h, legacyJob.taskId)).toBe("succeeded");

      const sentFor = (first: string) => promptOf(s.fake.calls.find((call) => promptOf(call.request).includes(`[[s1]] ${first}`))?.request as LlmRequest);
      expect(sentFor("甲")).toContain("自定义标记一");
      expect(sentFor("甲")).not.toContain("自定义标记二");
      expect(sentFor("丙")).toContain("自定义标记二");
      expect(currentOf(s.h, frozenJob.contentId)?.provenance.promptRefs).toEqual([customPromptRef("highlight.default", 1)]);
      expect(currentOf(s.h, legacyJob.contentId)?.provenance.promptRefs).toEqual([customPromptRef("highlight.default", 2)]);
    });
  });
});
