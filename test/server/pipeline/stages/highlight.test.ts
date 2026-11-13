import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../../src/server/domain/model-ref.ts";
import {
  builtinPromptOf,
  chapterWindowNote,
  customPromptRef,
  HIGHLIGHT_DEFAULT_PROMPT,
  HIGHLIGHT_SELECT_PROMPT,
  renderPrompt,
  SPEAKER_RULES_FRAGMENT,
} from "../../../../src/server/domain/prompts.ts";
import { estimateTokens } from "../../../../src/server/domain/token-estimate.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { HighlightStageExecutor } from "../../../../src/server/pipeline/stages/highlight.ts";
import { highlightsDtoSchema } from "../../../../src/shared/dto/highlight.ts";
import { CITATION_INVALID_RATIO_MAX, CONTEXT_SAFETY_RATIO, HIGHLIGHT_COUNT_MAX, RETRY_MAX } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import * as sc from "../../../fixtures/pipeline/speaker-context.ts";
import { resolveSpeakerContext } from "../../../../src/server/application/speaker-context.ts";
import { PipelineLlmProvider, pipelinePromptKind } from "../../../fixtures/llm/pipeline-llm.ts";
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

/** The previous builtin version, frozen on a Task: it states no cap and is never capped. */
const V2 = { "highlight.default": { id: "highlight.default", version: 2 } };
const V2_TEXT = builtinPromptOf(V2["highlight.default"])?.text as string;

function recompute(s: Setup, texts: readonly string[], promptRefs?: Record<string, { id: string; version: number }>) {
  const contentId = createLocalContent(s.h);
  const base = transcript(s.h, contentId, texts);
  const taskId = createTaskOfKind(
    s.h,
    "recompute_highlights",
    { modelRef: s.modelRef, baseRevisionId: base.revision.id, outputLanguage: "zh-CN", ...(promptRefs === undefined ? {} : { promptRefs }) },
    { contentId },
  );
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
      promptRef: { id: "highlight.default", version: 3 },
      promptRefs: [{ id: "highlight.default", version: 3 }],
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

  it("invalid entries within CITATION_INVALID_RATIO_MAX are dropped without a retry (frozen v2: no cap)", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = recompute(s, texts(25), V2);
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

  it("splits a long transcript into budget-sized windows and merges their items in time order (frozen v2: no selection)", async () => {
    const lines = ["甲甲甲甲甲甲", "乙乙乙乙乙乙", "丙丙丙丙丙丙", "丁丁丁丁丁丁", "戊戊戊戊戊戊", "己己己己己己"];
    const template = renderPrompt(V2_TEXT, { output_language: "简体中文" });
    const fixed = estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(lines.length, lines.length), transcript_with_aliases: "" }));
    const line = estimateTokens(`[[s1]] ${lines[0]}\n`);
    // Room for two lines and a half: the budget is floored, so exactly two would be fragile.
    const s = setup({ contextWindowTokens: Math.ceil((fixed + 2.5 * line + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO) });
    const job = recompute(s, lines, V2);
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

describe("highlight stage: reviewed speakers", () => {
  const SPEAKERS: sc.SeedOptions = {
    speakers: [{ name: "蒋炎岩", confirmed: true }, { name: "张伟" }],
    assign: (position) => (position % 7 === 6 ? undefined : Math.floor(position / 5) % 2),
    reviewed: true,
  };
  const frozenOf = (h: Harness) =>
    h.repository.withTransaction((scope) => resolveSpeakerContext(scope, LOCAL.userId, sc.FIXED_CONTENT_ID, sc.FIXED_REVISION_ID, "transcript"));
  const errorOf = (h: Harness, taskId: string) => stageRunsOf(h, taskId).filter((run) => run.stage === "highlight").at(-1)?.error;

  it("sends every window with the rules and header lines and records the snapshot with the rules ref", async () => {
    const fake = sc.scriptedProvider();
    const { h, modelRef } = sc.speakerHarness(fake, 2_500);
    open.push(h);
    sc.seedContent(h, SPEAKERS);
    const taskId = (await h.derivedTasks.recomputeHighlights(LOCAL, sc.FIXED_CONTENT_ID, { modelRef })).body.taskId;
    expect(await sc.settle(h, taskId, "highlight")).toBe("succeeded");
    expect(fake.calls.length).toBeGreaterThan(1);
    // The windows' candidates are selected without any speaker lines.
    const selections = fake.calls.filter((call) => pipelinePromptKind(call.request) === "highlight_select");
    expect(selections).toHaveLength(1);
    expect(sc.promptOf(selections[0]?.request as LlmRequest)).not.toContain("【发言人】");
    for (const call of fake.calls.filter((candidate) => pipelinePromptKind(candidate.request) === "highlight")) {
      const value = sc.promptOf(call.request).split("【逐字稿】\n")[1] ?? "";
      expect(value.startsWith(`${SPEAKER_RULES_FRAGMENT.text}\n【发言人】`)).toBe(true);
    }
    const current = h.repository.withTransaction((scope) => scope.highlights.getCurrent(LOCAL.userId, sc.FIXED_CONTENT_ID));
    expect(current?.provenance.speakerContext).toEqual(frozenOf(h));
    expect(current?.provenance.promptRefs).toEqual([HIGHLIGHT_DEFAULT_PROMPT.ref, SPEAKER_RULES_FRAGMENT.ref, HIGHLIGHT_SELECT_PROMPT.ref]);
  });

  it("keeps the rules in a custom prompt that keeps its slot, and records both refs", async () => {
    const fake = sc.scriptedProvider();
    const { h, modelRef } = sc.speakerHarness(fake, 2_500);
    open.push(h);
    sc.seedContent(h, SPEAKERS);
    h.prompts.update(LOCAL, "highlight.default", { text: `自定义高光说明。\n${HIGHLIGHT_DEFAULT_PROMPT.text}` });
    const taskId = (await h.derivedTasks.recomputeHighlights(LOCAL, sc.FIXED_CONTENT_ID, { modelRef })).body.taskId;
    expect(await sc.settle(h, taskId, "highlight")).toBe("succeeded");
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      const prompt = sc.promptOf(call.request);
      expect(prompt.startsWith("自定义高光说明。")).toBe(true);
      expect((prompt.split("【逐字稿】\n")[1] ?? "").startsWith(`${SPEAKER_RULES_FRAGMENT.text}\n【发言人】`)).toBe(true);
    }
    const current = h.repository.withTransaction((scope) => scope.highlights.getCurrent(LOCAL.userId, sc.FIXED_CONTENT_ID));
    expect(current?.provenance.speakerContext).toEqual(frozenOf(h));
    expect(current?.provenance.promptRefs).toEqual([customPromptRef("highlight.default", 1), SPEAKER_RULES_FRAGMENT.ref]);
  });

  it("fails before any call when the frozen attributions do not match the read revision", async () => {
    const fake = sc.scriptedProvider();
    const { h, modelRef } = sc.speakerHarness(fake, 2_500);
    open.push(h);
    sc.seedContent(h, SPEAKERS);
    const snapshot = frozenOf(h);
    const taskId = createTaskOfKind(
      h,
      "recompute_highlights",
      { modelRef, baseRevisionId: sc.FIXED_REVISION_ID, outputLanguage: "zh-CN", speakerContext: { ...snapshot, attributionDigest: "sha256:0" } },
      { contentId: sc.FIXED_CONTENT_ID },
    );
    h.scheduler.kick();
    expect(await sc.settle(h, taskId, "highlight")).toBe("failed");
    expect(errorOf(h, taskId)?.code).toBe("internal");
    expect(fake.calls).toHaveLength(0);
    expect(workUnitsOf(h, taskId)).toHaveLength(0);
  });
});

describe("highlight stage: the count cap of the builtin prompt", () => {
  /** Equal-length sentences: a window holds `perWindow` of them, and a selection over a few per window still fits. */
  const longTexts = (count: number): string[] => Array.from({ length: count }, (_, index) => `${"甲乙丙丁戊己庚辛壬癸"[index % 10]}`.repeat(24));
  const PER_WINDOW = 30;

  /** The window prompt's JSON schema as sent with structured output: planning prices it in. */
  const WINDOW_SCHEMA = {
    type: "object",
    properties: {
      highlights: {
        type: "array",
        items: {
          type: "object",
          properties: { alias: { type: "string" }, score: { type: "integer" }, text: { type: "string" } },
          required: ["alias", "score", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["highlights"],
    additionalProperties: false,
  };

  function windowTokens(promptText: string, sentences: readonly string[], perWindow: number, structured = false): number {
    const template = renderPrompt(promptText, { output_language: "简体中文" });
    const fixed =
      estimateTokens(renderPrompt(template, { window_note: chapterWindowNote(sentences.length, sentences.length), transcript_with_aliases: "" })) +
      (structured ? estimateTokens(JSON.stringify(WINDOW_SCHEMA)) : 0);
    const line = estimateTokens(`[[s${sentences.length}]] ${sentences[0]}\n`);
    return Math.ceil((fixed + (perWindow + 0.5) * line + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO);
  }

  const isSelect = (request: LlmRequest) => promptOf(request).includes("【候选片段】");
  /** Line-start aliases of a window's transcript. */
  const windowAliases = (request: LlmRequest) => [...promptOf(request).matchAll(/^\[\[(s\d+)\]\]/gm)].map((match) => match[1] as string);
  /** Lines after `【候选片段】`, as `{ alias, rest }`. */
  const candidatesOf = (request: LlmRequest) =>
    (promptOf(request).split("【候选片段】\n")[1] ?? "")
      .split("\n")
      .map((line) => /^\[\[(s\d+)\]\] (.*)$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => ({ alias: match[1] as string, rest: match[2] as string }));

  function answer(
    fake: FakeLlmProvider,
    window: (aliases: string[]) => unknown,
    select: (candidates: Array<{ alias: string; rest: string }>, attempt: number) => unknown,
    calls = 40,
  ): void {
    let selections = 0;
    for (let i = 0; i < calls; i += 1) {
      fake.script((request) =>
        (async function* () {
          if (isSelect(request)) {
            selections += 1;
            yield* json(select(candidatesOf(request), selections));
            return;
          }
          yield* json(window(windowAliases(request)));
        })(),
      );
    }
  }
  /** The first `count` sentences of each window, each with its own reason. */
  const firstOf = (count: number, score = 50) => (aliases: string[]) => ({
    highlights: aliases.slice(0, count).map((alias) => ({ alias, score, text: `理由${alias}` })),
  });
  const selectCount = (s: Setup) => s.fake.calls.filter((call) => isSelect(call.request)).length;
  const keysOf = (h: Harness, taskId: string) => workUnitsOf(h, taskId).map((unit) => unit.key).sort();
  const at = (job: { segments: TranscriptSegment[] }, alias: string) => job.segments[Number(alias.slice(1)) - 1]?.id;

  it("keeps the best-scored HIGHLIGHT_COUNT_MAX of one window over the cap, the earlier on a tie, in time order, without another call", async () => {
    const s = setup({ contextWindowTokens: 128_000 });
    const job = recompute(s, texts(15));
    const scores = [80, 90, 90, 10, 80, 80, 80, 70, 95, 80, 85, 85, 80];
    expect(scores.length).toBeGreaterThan(HIGHLIGHT_COUNT_MAX);
    answer(s.fake, () => ({ highlights: scores.map((score, index) => ({ alias: `s${index + 1}`, score, text: `理由${index + 1}` })) }), () => ({ highlights: [] }));
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    expect(s.fake.calls).toHaveLength(1);
    expect(keysOf(s.h, job.taskId)).toEqual(["highlight:window:0"]);
    const current = currentOf(s.h, job.contentId);
    // The six at 80 compete for the last five places: s13, the latest, is left out.
    expect(current?.items.map((item) => [item.segmentId, item.score, item.text])).toEqual(
      [1, 2, 3, 5, 6, 7, 9, 10, 11, 12].map((n) => [job.segments[n - 1]?.id, scores[n - 1], `理由${n}`]),
    );
    expect(current?.provenance.promptRefs).toEqual([HIGHLIGHT_DEFAULT_PROMPT.ref]);
    expect(resultOf(s.h, job.taskId)).toEqual({ revisionId: current?.id, windows: 1, dropped: 0, reasons: [] });
  });

  it.each([
    ["plain-text JSON", false],
    ["structured output", true],
  ])("rescores the candidates of several windows in one selection, reasons kept from the windows (%s)", async (_case, structured) => {
    const sentences = longTexts(3 * PER_WINDOW);
    const s = setup({ contextWindowTokens: windowTokens(HIGHLIGHT_DEFAULT_PROMPT.text, sentences, PER_WINDOW, structured), structured });
    const job = recompute(s, sentences);
    const rescored: Record<string, number> = { s1: 70, s2: 99, s3: 70, s4: 80, s31: 70, s32: 90, s33: 70, s34: 85, s61: 55, s62: 88, s63: 70, s64: 101.6 };
    answer(s.fake, firstOf(4), (candidates) => {
      const value = { highlights: candidates.map(({ alias }) => ({ alias, score: rescored[alias], text: "模型另写的理由" })) };
      return structured ? value : `结果如下：\n${JSON.stringify(value)}`;
    });
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    expect(s.fake.calls).toHaveLength(4);
    const select = s.fake.calls.find((call) => isSelect(call.request))?.request as LlmRequest;
    const lines = Object.keys(rescored).map((alias) => {
      const n = Number(alias.slice(1));
      const seconds = String(n % 60).padStart(2, "0");
      return `[[${alias}]] ${String(Math.floor(n / 60)).padStart(2, "0")}:${seconds} ${sentences[n - 1]}｜理由${alias}`;
    });
    expect(promptOf(select)).toBe(renderPrompt(HIGHLIGHT_SELECT_PROMPT.text, { max_highlights: String(HIGHLIGHT_COUNT_MAX), candidates: lines.join("\n") }));
    expect(promptOf(select)).not.toContain("【逐字稿】");
    if (structured) {
      expect(select.responseFormat).toMatchObject({ type: "json_schema", schema: { type: "object", required: ["highlights"] } });
      expect(JSON.stringify(select.responseFormat)).not.toContain('"text"');
    } else {
      expect(select).not.toHaveProperty("responseFormat");
    }

    const current = currentOf(s.h, job.contentId);
    // Five candidates at 70 compete for the last four places: s63, the latest, is left out, as is s61 (55).
    const kept = ["s1", "s2", "s3", "s4", "s31", "s32", "s33", "s34", "s62", "s64"];
    expect(current?.items).toEqual(kept.map((alias) => ({ segmentId: at(job, alias), score: Math.min(100, Math.round(rescored[alias] as number)), text: `理由${alias}` })));
    expect(current?.provenance.promptRef).toEqual(HIGHLIGHT_DEFAULT_PROMPT.ref);
    expect(current?.provenance.promptRefs).toEqual([HIGHLIGHT_DEFAULT_PROMPT.ref, HIGHLIGHT_SELECT_PROMPT.ref]);
    expect(keysOf(s.h, job.taskId)).toEqual(["highlight:select", "highlight:window:0", "highlight:window:1", "highlight:window:2"]);
    const usage = s.h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId, { taskId: job.taskId }));
    expect(usage).toHaveLength(4);
    expect(new Set(usage.map((row) => `${row.feature} ${row.artifactRevisionId}`))).toEqual(new Set([`highlight ${current?.id}`]));
    expect(resultOf(s.h, job.taskId)).toEqual({ revisionId: current?.id, windows: 3, dropped: 0, selected: { candidates: 12, dropped: 0 }, reasons: [] });
  });

  it("drops selected aliases naming no candidate within CITATION_INVALID_RATIO_MAX", async () => {
    const sentences = longTexts(3 * PER_WINDOW);
    const s = setup({ contextWindowTokens: windowTokens(HIGHLIGHT_DEFAULT_PROMPT.text, sentences, PER_WINDOW) });
    const job = recompute(s, sentences);
    // 21 candidates; the answer adds s10, a sentence that is no candidate.
    answer(s.fake, firstOf(7), (candidates) => ({ highlights: [...candidates.slice(0, 20).map(({ alias }, index) => ({ alias, score: 90 - index })), { alias: "s10", score: 99 }] }));
    expect(1 / 21).toBeLessThanOrEqual(CITATION_INVALID_RATIO_MAX);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(selectCount(s)).toBe(1);
    const current = currentOf(s.h, job.contentId);
    expect(current?.items).toHaveLength(HIGHLIGHT_COUNT_MAX);
    expect(current?.items.map((item) => item.segmentId)).not.toContain(at(job, "s10"));
    expect(resultOf(s.h, job.taskId)).toMatchObject({ selected: { candidates: 21, dropped: 1 } });
  });

  it("asks a selection again when too many of its aliases name no candidate", async () => {
    const sentences = longTexts(3 * PER_WINDOW);
    const s = setup({ contextWindowTokens: windowTokens(HIGHLIGHT_DEFAULT_PROMPT.text, sentences, PER_WINDOW) });
    const job = recompute(s, sentences);
    answer(s.fake, firstOf(2), (_candidates, attempt) =>
      attempt === 1 ? { highlights: [{ alias: "s1", score: 90 }, { alias: "s5", score: 80 }] } : { highlights: [{ alias: "s32", score: 77 }] },
    );
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(selectCount(s)).toBe(2);
    expect(workUnitsOf(s.h, job.taskId).find((unit) => unit.key === "highlight:select")).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(currentOf(s.h, job.contentId)?.items).toEqual([{ segmentId: at(job, "s32"), score: 77, text: "理由s32" }]);
  });

  it("fails without publishing when every selection is unusable; the windows are not asked again", async () => {
    const sentences = longTexts(3 * PER_WINDOW);
    const s = setup({ contextWindowTokens: windowTokens(HIGHLIGHT_DEFAULT_PROMPT.text, sentences, PER_WINDOW) });
    const job = recompute(s, sentences);
    const before = s.h.newId();
    s.h.repository.withTransaction((scope) => {
      scope.highlights.insertRevision(LOCAL.userId, job.contentId, {
        id: before,
        artifactId: s.h.newId(),
        transcriptRevisionId: job.revision.id,
        items: [],
        modelRef: { ...s.modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: s.modelRef.modelId },
        promptRef: { id: "highlight.default", version: 1 },
        promptSnapshot: "x",
        quality: "normal",
        createdAt: 3,
      });
      scope.highlights.setCurrent(LOCAL.userId, job.contentId, before);
    });
    answer(s.fake, firstOf(2), () => ({ highlights: [{ alias: "s5", score: 90 }] }));
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)?.class).toBe("output_mismatch");
    expect(s.fake.calls).toHaveLength(3 + RETRY_MAX + 1);
    expect(workUnitsOf(s.h, job.taskId).filter((unit) => unit.key.startsWith("highlight:window:")).map((unit) => [unit.status, unit.attempt])).toEqual([
      ["succeeded", 1],
      ["succeeded", 1],
      ["succeeded", 1],
    ]);
    expect(currentOf(s.h, job.contentId)?.id).toBe(before);
    expect(s.h.db.prepare("SELECT COUNT(*) AS n FROM highlight_revision").get()).toEqual({ n: 1 });
  });

  it("skips the selection when no window found anything", async () => {
    const sentences = longTexts(3 * PER_WINDOW);
    const s = setup({ contextWindowTokens: windowTokens(HIGHLIGHT_DEFAULT_PROMPT.text, sentences, PER_WINDOW) });
    const job = recompute(s, sentences);
    answer(s.fake, () => ({ highlights: [] }), () => ({ highlights: [] }));
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(selectCount(s)).toBe(0);
    expect(currentOf(s.h, job.contentId)?.items).toEqual([]);
    expect(currentOf(s.h, job.contentId)?.provenance.promptRefs).toEqual([HIGHLIGHT_DEFAULT_PROMPT.ref]);
    expect(resultOf(s.h, job.taskId)).toMatchObject({ selected: { candidates: 0, dropped: 0 } });
  });

  it("fails with context_length when the candidates do not fit the budget as rendered, without a selection call", async () => {
    const sentences = ["甲甲甲甲", "乙乙乙乙", "丙丙丙丙", "丁丁丁丁"];
    const s = setup({ contextWindowTokens: windowTokens(HIGHLIGHT_DEFAULT_PROMPT.text, sentences, 2) });
    const job = recompute(s, sentences);
    answer(s.fake, (aliases) => ({ highlights: aliases.map((alias) => ({ alias, score: 80, text: "长".repeat(200) })) }), () => ({ highlights: [] }));
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)?.code).toBe("llm_capability.context_length");
    expect(selectCount(s)).toBe(0);
    expect(keysOf(s.h, job.taskId)).toEqual(["highlight:window:0", "highlight:window:1"]);
  });

  describe("versions that state no cap are sent and keyed exactly as before", () => {
    const CUSTOM = `${V2_TEXT}\n自定义：多挑几处。`;
    const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
    const windowDigest = (job: { revision: TranscriptRevision }, s: Setup, promptRef: unknown, i: number, n: number, ids: readonly string[]) =>
      sha(canonicalJson({ baseRevisionId: job.revision.id, i, n, segmentIds: ids, promptRef, modelRef: s.modelRef, outputLanguage: "zh-CN", structured: false }));

    it.each([
      ["a frozen v2", "v2"],
      ["a custom version", "custom"],
    ] as const)("%s: one window over the cap is published whole", async (_case, which) => {
      const s = setup({ contextWindowTokens: 128_000 });
      if (which === "custom") s.h.prompts.update(LOCAL, "highlight.default", { text: CUSTOM });
      const ref = which === "v2" ? V2["highlight.default"] : customPromptRef("highlight.default", 1);
      const job = recompute(s, texts(15), { "highlight.default": ref });
      answer(s.fake, firstOf(13), () => ({ highlights: [] }));
      s.h.scheduler.start();
      expect(await settled(s.h, job.taskId)).toBe("succeeded");

      expect(s.fake.calls).toHaveLength(1);
      expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toBe(
        renderPrompt(which === "v2" ? V2_TEXT : CUSTOM, {
          output_language: "简体中文",
          window_note: "",
          transcript_with_aliases: job.segments.map((segment, index) => `[[s${index + 1}]] ${segment.text}`).join("\n"),
        }),
      );
      const [unit] = workUnitsOf(s.h, job.taskId);
      expect(unit?.inputDigest).toBe(windowDigest(job, s, ref, 0, 1, job.segments.map((segment) => segment.id)));
      const current = currentOf(s.h, job.contentId);
      expect(current?.items).toHaveLength(13);
      expect(current?.provenance.promptRefs).toEqual([ref]);
      expect(resultOf(s.h, job.taskId)).toEqual({ revisionId: current?.id, windows: 1, dropped: 0, reasons: [] });
    });

    it.each([
      ["a frozen v2", "v2"],
      ["a custom version", "custom"],
    ] as const)("%s: several windows are joined in time order without a selection", async (_case, which) => {
      const sentences = longTexts(3 * PER_WINDOW);
      const s = setup({ contextWindowTokens: windowTokens(which === "v2" ? V2_TEXT : CUSTOM, sentences, PER_WINDOW) });
      if (which === "custom") s.h.prompts.update(LOCAL, "highlight.default", { text: CUSTOM });
      const ref = which === "v2" ? V2["highlight.default"] : customPromptRef("highlight.default", 1);
      const job = recompute(s, sentences, { "highlight.default": ref });
      answer(s.fake, firstOf(5), () => ({ highlights: [] }));
      s.h.scheduler.start();
      expect(await settled(s.h, job.taskId)).toBe("succeeded");

      expect(s.fake.calls).toHaveLength(3);
      expect(selectCount(s)).toBe(0);
      const units = workUnitsOf(s.h, job.taskId).sort((a, b) => a.key.localeCompare(b.key));
      expect(units.map((unit) => unit.key)).toEqual(["highlight:window:0", "highlight:window:1", "highlight:window:2"]);
      units.forEach((unit, i) =>
        expect(unit.inputDigest).toBe(windowDigest(job, s, ref, i, 3, job.segments.slice(PER_WINDOW * i, PER_WINDOW * (i + 1)).map((segment) => segment.id))),
      );
      const current = currentOf(s.h, job.contentId);
      expect(current?.items).toHaveLength(15);
      expect(current?.provenance.promptRefs).toEqual([ref]);
      expect(resultOf(s.h, job.taskId)).toEqual({ revisionId: current?.id, windows: 3, dropped: 0, reasons: [] });
    });
  });
});
