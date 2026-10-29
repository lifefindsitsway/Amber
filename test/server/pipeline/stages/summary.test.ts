import { afterEach, describe, expect, it } from "vitest";
import type { RollupPartial, SummaryRevision } from "../../../../src/server/domain/artifact.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import { deriveFreshness } from "../../../../src/server/domain/freshness.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../../src/server/domain/model-ref.ts";
import {
  BUILTIN_PROMPT_HISTORY,
  BUILTIN_SUMMARY_TEMPLATES,
  customPromptRef,
  ROLLUP_CARRY_PROMPT,
  ROLLUP_FINAL_PROMPT,
  ROLLUP_PARTIAL_PROMPT,
  SUMMARY_ENVELOPE_PROMPT,
  renderPrompt,
} from "../../../../src/server/domain/prompts.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { SummaryStageExecutor } from "../../../../src/server/pipeline/stages/summary.ts";
import { CONTEXT_SAFETY_RATIO } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import {
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  stageRunsOf,
  stageStatuses,
  taskOf,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";
import { countRows } from "../../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

const CORE = BUILTIN_SUMMARY_TEMPLATES[0] as (typeof BUILTIN_SUMMARY_TEMPLATES)[number];
const MAX_OUTPUT = 10;

type Kind = "envelope" | "partial" | "carry" | "final" | "repair";

function promptOf(request: LlmRequest): string {
  const part = request.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
}

function kindOf(request: LlmRequest): Kind {
  const prompt = promptOf(request);
  if (prompt.startsWith("以下引用标记")) return "repair";
  // The second prefix is the historical rollup.partial text, still run by Tasks frozen on it.
  if (prompt.startsWith("你在为一个合集或一段长内容做连贯的归纳") || prompt.startsWith("你在为一门课程做连贯的归纳")) return "partial";
  if (prompt.startsWith("把「已有压缩摘要」")) return "carry";
  if (prompt.startsWith("下面是一段长内容各组的归纳")) return "final";
  return "envelope";
}

/** Aliases in the section after `marker`, in order. */
function aliasesAfter(request: LlmRequest, marker: string): number[] {
  const prompt = promptOf(request);
  const at = prompt.lastIndexOf(marker);
  return [...prompt.slice(at === -1 ? 0 : at).matchAll(/\[\[s(\d+)\]\]/g)].map((match) => Number(match[1]));
}

type Answer = (kind: Kind, request: LlmRequest, signal: AbortSignal) => string | Promise<string>;

/** Default answers: every output cites the first alias it was given in its own section. */
const cite: Answer = (kind, request) => {
  switch (kind) {
    case "envelope":
      return `## 摘要\n讲了 RAG [[s${aliasesAfter(request, "【逐字稿】")[0]}]]。\n## 要点\n- 检索 [[s${aliasesAfter(request, "【逐字稿】")[1]}]]`;
    case "partial":
      return `本组讲了 [[s${aliasesAfter(request, "【本组内容】")[0]}]]`;
    case "carry":
      return `压缩 [[s${aliasesAfter(request, "【新增归纳】")[0]}]]`;
    case "final":
      return `总归纳 ${aliasesAfter(request, "【各组归纳】").map((alias) => `[[s${alias}]]`).join(" ")}`;
    case "repair":
      return "{}";
  }
};

function provider(answer: Answer = cite): FakeLlmProvider {
  const fake = new FakeLlmProvider();
  fake.script(
    ...Array.from({ length: 300 }, () => (request: LlmRequest, opts: { signal: AbortSignal }) =>
      (async function* (): AsyncGenerator<LlmStreamEvent> {
        yield* reply(await answer(kindOf(request), request, opts.signal));
      })(),
    ),
  );
  return fake;
}

interface Setup {
  h: Harness;
  fake: FakeLlmProvider;
  modelRef: ModelRef;
}

function setup(fake: FakeLlmProvider, options: { contextWindowTokens?: number; file?: string } = {}): Setup {
  const h = createHarness({ llmProviders: [fake], executors: {}, ...(options.file === undefined ? {} : { file: options.file }) });
  open.push(h);
  h.repository.withTransaction((scope) =>
    scope.summaryTemplates.syncBuiltin(
      BUILTIN_SUMMARY_TEMPLATES.map((template) => ({ id: template.id, name: template.nameKey, versions: [{ version: template.version, prompt: template.prompt }] })),
      1,
    ),
  );
  h.executors.summary = new SummaryStageExecutor({ repository: h.repository, newId: h.newId });
  let modelRef: ModelRef;
  if (options.file === undefined) {
    modelRef = configureLlm(h);
    setWindow(h, modelRef, options.contextWindowTokens);
  } else {
    const row = h.db.prepare("SELECT profile_id, model_id FROM model_capability LIMIT 1").get() as { profile_id: string; model_id: string };
    modelRef = { providerProfileId: row.profile_id, modelId: row.model_id };
  }
  return { h, fake, modelRef };
}

function setWindow(h: Harness, modelRef: ModelRef, contextWindowTokens: number | undefined): void {
  const limits = contextWindowTokens === undefined ? null : JSON.stringify({ contextWindowTokens, maxOutputTokens: MAX_OUTPUT });
  h.db.prepare("UPDATE model_capability SET limits_user_override_json = ? WHERE profile_id = ?").run(limits, modelRef.providerProfileId);
}

/** A window leaving `room` tokens of input. */
const windowFor = (room: number) => Math.ceil((room + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO);

/** An imported primary revision with one sentence per text, one second each. */
function transcript(h: Harness, contentId: string, texts: readonly string[]): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = texts.map((text, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId,
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
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

/** Platform chapters starting at the given seconds, made current. */
function chapters(h: Harness, contentId: string, startsS: readonly number[]): string {
  return h.repository.withTransaction((scope) => {
    const { revisionId } = scope.chapters.insertPlatformRevision(LOCAL.userId, contentId, {
      id: h.newId(),
      artifactId: h.newId(),
      chapters: startsS.map((start, index) => ({ startMs: start * 1000, endMs: (startsS[index + 1] ?? start + 1000) * 1000, title: `第 ${index + 1} 章` })),
      createdAt: 1,
    });
    scope.chapters.setCurrent(LOCAL.userId, contentId, revisionId);
    return revisionId;
  });
}

function regenerate(s: Setup, texts: readonly string[], request: Record<string, unknown> = {}) {
  const contentId = createLocalContent(s.h);
  const base = transcript(s.h, contentId, texts);
  const taskId = createTaskOfKind(
    s.h,
    "regenerate_summary",
    { modelRef: s.modelRef, baseRevisionId: base.revision.id, outputLanguage: "zh-CN", templateRef: { id: CORE.id, version: CORE.version }, ...request },
    { contentId },
  );
  return { contentId, taskId, ...base };
}

async function settled(h: Harness, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId)["summary"] ?? "") || taskOf(h, taskId).statusProjection === "waiting");
  return stageStatuses(h, taskId)["summary"] as string;
}

const resultOf = (h: Harness, taskId: string) =>
  JSON.parse(stageRunsOf(h, taskId).filter((run) => run.stage === "summary").at(-1)?.resultJson ?? "{}") as Record<string, unknown>;
const errorOf = (h: Harness, taskId: string) => stageRunsOf(h, taskId).filter((run) => run.stage === "summary").at(-1)?.error;
const revisionOf = (h: Harness, id: string) => h.repository.withTransaction((scope) => scope.summaries.getRevision(LOCAL.userId, id)) as SummaryRevision;
const partialsOf = (h: Harness, id: string): RollupPartial[] => h.repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision(LOCAL.userId, id));
const kinds = (fake: FakeLlmProvider) => fake.calls.map((call) => kindOf(call.request));
const keys = (h: Harness, taskId: string) => workUnitsOf(h, taskId).map((unit) => unit.key);

/** Every canonical marker names a sentence of the owner, and every citation is in the body. */
function expectResolvable(h: Harness, revision: { body: string; citations: Array<{ transcriptRevisionId: string; segmentId: string }> }): void {
  const markers = [...revision.body.matchAll(/\[\[seg:([^\]]+)\]\]/g)].map((match) => match[1] as string);
  expect(markers.length).toBeGreaterThan(0);
  for (const id of markers) {
    const segment = h.repository.withTransaction((scope) => scope.transcripts.getSegment(LOCAL.userId, id));
    expect(segment).toBeDefined();
    expect(revision.citations).toContainEqual({ transcriptRevisionId: segment?.revisionId, segmentId: id });
  }
  expect(new Set(revision.citations.map((citation) => citation.segmentId))).toEqual(new Set(markers));
}

const TEXTS = ["检索增强生成", "向量数据库", "重排序", "评估方法"];

describe("summary stage: single call", () => {
  it("writes the summary under the envelope, stores [[seg:]] markers that all resolve, becomes current and owns its usage", async () => {
    const s = setup(provider(), { contextWindowTokens: 128_000 });
    const job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    expect(kinds(s.fake)).toEqual(["envelope"]);
    const prompt = promptOf(s.fake.calls[0]?.request as LlmRequest);
    expect(prompt).toContain("输出语言：简体中文");
    expect(prompt).toContain(CORE.prompt);
    expect(prompt).toContain("[[s4]] 评估方法");
    expect(keys(s.h, job.taskId)).toEqual(["summary:generate"]);

    const result = resultOf(s.h, job.taskId);
    expect(result).toMatchObject({ mode: "single", reasons: [] });
    const revision = revisionOf(s.h, result["revisionId"] as string);
    expect(revision.body).toBe(`## 摘要\n讲了 RAG [[seg:${job.segments[0]?.id}]]。\n## 要点\n- 检索 [[seg:${job.segments[1]?.id}]]`);
    expectResolvable(s.h, revision);
    expect(revision.quality).toBe("normal");
    expect(revision.partialIds).toBeUndefined();
    expect(revision.provenance).toMatchObject({
      inputs: [{ kind: "transcriptRevision", id: job.revision.id }],
      promptRef: { id: CORE.id, version: CORE.version },
      promptSnapshot: renderPrompt(SUMMARY_ENVELOPE_PROMPT.text, { output_language: "简体中文", terms_section: "", template_body: CORE.prompt }),
    });
    const artifact = s.h.repository.withTransaction((scope) => scope.summaries.findArtifact(LOCAL.userId, job.contentId, CORE.id));
    expect(artifact?.currentRevisionId).toBe(revision.id);
    const usage = s.h.db.prepare("SELECT feature, artifact_revision_id AS owner FROM token_usage").all();
    expect(usage).toEqual([{ feature: "summary", owner: revision.id }]);
  });

  it("uses the default template's current version when the request carries no templateRef, and links current chapters", async () => {
    const s = setup(provider(), { contextWindowTokens: 128_000 });
    const job = regenerate(s, TEXTS, { templateRef: undefined });
    const chapterRevisionId = chapters(s.h, job.contentId, [0, 2]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.provenance.promptRef).toEqual({ id: CORE.id, version: CORE.version });
    // Display association only: a single-call summary does not depend on the chapters.
    expect(revision.chapterRevisionId).toBe(chapterRevisionId);
    expect(revision.provenance.inputs).toEqual([{ kind: "transcriptRevision", id: job.revision.id }]);
  });
});

describe("summary stage: citation runs", () => {
  it("cuts each run of adjacent citations to the first two before publishing, and keeps citations in step with the body", async () => {
    const answer = "甲[[s1]][[s2]][[s3]][[s4]][[s5]]。乙 [[s3]]、[[s1]] [[s2]]。丙[[s4]]，丁[[s1]]";
    const s = setup(provider(() => answer), { contextWindowTokens: 128_000 });
    const job = regenerate(s, [...TEXTS, "第五句"]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(kinds(s.fake)).toEqual(["envelope"]);
    const id = (i: number) => `[[seg:${job.segments[i]?.id}]]`;
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    // A run of five keeps two; a run separated by 「、」 and spaces is a run too; markers apart from each other stay.
    expect(revision.body).toBe(`甲${id(0)}${id(1)}。乙 ${id(2)}${id(0)}。丙${id(3)}，丁${id(0)}`);
    expect(revision.citations.map((citation) => citation.segmentId)).toEqual([0, 1, 2, 3].map((i) => job.segments[i]?.id));
    expectResolvable(s.h, revision);
    expect(revision.quality).toBe("normal");
    expect(resultOf(s.h, job.taskId)["reasons"]).toEqual([]);
  });

  it("cuts the runs of a rolling summary's final and of each partial it keeps", async () => {
    const s = setup(
      provider((kind, request, signal) => {
        const all = (marker: string) => aliasesAfter(request, marker).map((alias) => `[[s${alias}]]`);
        if (kind === "partial") return `本组讲了 ${all("【本组内容】").join("、")}`;
        if (kind === "final") return `总归纳 ${[...new Set(all("【各组归纳】"))].join(" ")}`;
        return cite(kind, request, signal);
      }),
      { contextWindowTokens: windowFor(ROOM) },
    );
    const job = regenerate(s, LONG);
    chapters(s.h, job.contentId, [0, 4, 8]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    // The model saw every partial's whole run; only what is published is cut.
    expect(promptOf(s.fake.calls[6]?.request as LlmRequest)).toContain("本组讲了 [[s5]]、[[s6]]、[[s7]]、[[s8]]");
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.body).toBe(`总归纳 [[seg:${job.segments[0]?.id}]][[seg:${job.segments[1]?.id}]]`);
    expect(revision.citations).toHaveLength(2);
    expectResolvable(s.h, revision);
    const partials = partialsOf(s.h, revision.id);
    expect(partials.map((partial) => partial.body)).toEqual([0, 4, 8].map((i) => `本组讲了 [[seg:${job.segments[i]?.id}]][[seg:${job.segments[i + 1]?.id}]]`));
    for (const partial of partials) {
      expectResolvable(s.h, partial);
      expect(partial.citations).toHaveLength(2);
    }
  });
});

describe("summary stage: base revision gone", () => {
  it("fails without publishing when its base transcript is deleted while the model answers", async () => {
    let job: ReturnType<typeof regenerate> | undefined;
    const s = setup(
      provider((kind, request, signal) => {
        const base = job as ReturnType<typeof regenerate>;
        // Another revision takes over as primary and the base goes, as a delete would leave it.
        const replacement = transcript(s.h, base.contentId, TEXTS);
        expect(replacement.revision.id).not.toBe(base.revision.id);
        s.h.repository.withTransaction((scope) => scope.transcripts.deleteRevision(LOCAL.userId, base.revision.id));
        return cite(kind, request, signal);
      }),
      { contextWindowTokens: 128_000 },
    );
    job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)?.code).toBe("not_found");
    expect(countRows(s.h.db, "summary_revision")).toBe(0);
  });
});

describe("summary stage: citation repair", () => {
  it("over the limit: exactly one repair, whose fixes make the summary normal", async () => {
    const s = setup(
      provider((kind) => (kind === "envelope" ? "甲 [[s1]] 乙 [[s42]] 丙 [[s43]]" : '{ "s42": "s2", "s43": "s3" }')),
      { contextWindowTokens: 128_000 },
    );
    const job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(kinds(s.fake)).toEqual(["envelope", "repair"]);
    const repairPrompt = promptOf(s.fake.calls[1]?.request as LlmRequest);
    expect(repairPrompt).toContain("以下引用标记在原文中不存在：s42、s43。");
    expect(repairPrompt).toContain("s42：\n[[s");
    expect(keys(s.h, job.taskId)).toEqual(["summary:generate", "summary:generate:repair"]);
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.quality).toBe("normal");
    expect(revision.body).not.toContain("unresolved");
    expectResolvable(s.h, revision);
    const usage = s.h.db.prepare("SELECT feature, artifact_revision_id AS owner FROM token_usage ORDER BY feature").all();
    expect(usage).toEqual([
      { feature: "citation_repair", owner: revision.id },
      { feature: "summary", owner: revision.id },
    ]);
  });

  it("still over the limit after the repair: degraded with the reason, unresolved markers kept visible", async () => {
    const s = setup(provider((kind) => (kind === "envelope" ? "甲 [[s1]] 乙 [[s42]]" : '{ "s42": null }')), { contextWindowTokens: 128_000 });
    const job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(kinds(s.fake)).toEqual(["envelope", "repair"]);
    expect(resultOf(s.h, job.taskId)["reasons"]).toEqual(["citation_degraded"]);
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.quality).toBe("degraded");
    expect(revision.body).toBe(`甲 [[seg:${job.segments[0]?.id}]] 乙 [[unresolved:s42]]`);
    expect(revision.citations).toHaveLength(1);
  });

  it("at or under the limit: no repair, the stray alias is marked unresolved and the summary stays normal", async () => {
    const valid = Array.from({ length: 39 }, () => "[[s1]]").join(" ");
    const s = setup(provider(() => `${valid} [[s42]]`), { contextWindowTokens: 128_000 });
    const job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(kinds(s.fake)).toEqual(["envelope"]);
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.quality).toBe("normal");
    expect(revision.body.endsWith("[[unresolved:s42]]")).toBe(true);
  });

  it("a repair whose outcome is unknown waits for the user and is re-sent alone; the paid generation is not repeated", async () => {
    let failRepair = true;
    const s = setup(
      provider((kind) => {
        if (kind === "repair" && failRepair) {
          failRepair = false;
          throw amberError("llm_outcome_unknown", "connection lost after the request was sent");
        }
        return kind === "envelope" ? "甲 [[s1]] 乙 [[s42]]" : '{ "s42": "s2" }';
      }),
      { contextWindowTokens: 128_000 },
    );
    const job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    await settled(s.h, job.taskId);
    const parked = workUnitsOf(s.h, job.taskId).find((unit) => unit.status === "waiting_user_action");
    expect(parked?.key).toBe("summary:generate:repair");
    expect(kinds(s.fake)).toEqual(["envelope", "repair"]);

    s.h.tasks.confirmResend(LOCAL, job.taskId, parked?.id as string);
    await waitFor(() => taskOf(s.h, job.taskId).statusProjection === "succeeded");
    expect(kinds(s.fake)).toEqual(["envelope", "repair", "repair"]);
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.body).toBe(`甲 [[seg:${job.segments[0]?.id}]] 乙 [[seg:${job.segments[1]?.id}]]`);
  });
});

/**
 * 12 long sentences (about 600 estimated tokens each). With `ROOM` tokens of input the
 * whole transcript does not fit one call, while one chapter of four plus the carry
 * allowance fits a partial.
 */
const LONG = Array.from({ length: 12 }, (_, i) => `第${String(i + 1).padStart(2, "0")}句${"内容".repeat(200)}`);
const ROOM = 6000;

describe("summary stage: rolling", () => {
  it("over budget with ≥ 3 chapters it rolls partial / carry / final by chapter; partials persist; a primary switch makes it stale", async () => {
    const s = setup(provider(), { contextWindowTokens: windowFor(ROOM) });
    const job = regenerate(s, LONG);
    const chapterRevisionId = chapters(s.h, job.contentId, [0, 4, 8]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    expect(kinds(s.fake)).toEqual(["partial", "carry", "partial", "carry", "partial", "carry", "final"]);
    expect(keys(s.h, job.taskId)).toEqual([
      "rollup:partial:0",
      "rollup:carry:0",
      "rollup:partial:1",
      "rollup:carry:1",
      "rollup:partial:2",
      "rollup:carry:2",
      "rollup:final",
    ]);
    // The first group is told it is the first by an empty carry.
    const firstPartial = promptOf(s.fake.calls[0]?.request as LlmRequest);
    expect(firstPartial).toContain("如果「此前内容的压缩摘要」为空，这就是第一组");
    expect(firstPartial).toMatch(/【此前内容的压缩摘要】\n+【本组内容】/);
    // Each partial sees its own chapter only, under the template.
    expect(aliasesAfter(s.fake.calls[2]?.request as LlmRequest, "【本组内容】")).toEqual([5, 6, 7, 8]);
    expect(promptOf(s.fake.calls[2]?.request as LlmRequest)).toContain(`【此前内容的压缩摘要】\n压缩 [[s1]]`);
    expect(promptOf(s.fake.calls[6]?.request as LlmRequest)).toContain(CORE.prompt);

    const result = resultOf(s.h, job.taskId);
    expect(result).toMatchObject({ mode: "rolling", groups: 3, reasons: [] });
    const revision = revisionOf(s.h, result["revisionId"] as string);
    expect(revision.provenance.inputs).toEqual([
      { kind: "transcriptRevision", id: job.revision.id },
      { kind: "chapterRevision", id: chapterRevisionId },
    ]);
    expectResolvable(s.h, revision);
    const partials = partialsOf(s.h, revision.id);
    expect(partials).toHaveLength(3);
    expect(revision.partialIds).toEqual(partials.map((partial) => partial.id));
    expect(partials.map((partial) => partial.body)).toEqual([0, 4, 8].map((i) => `本组讲了 [[seg:${job.segments[i]?.id}]]`));
    expect(partials[0]?.promptRef).toEqual({ id: "rollup.partial", version: 3 });
    expect(partials[0]?.promptRefs).toEqual([{ id: "rollup.partial", version: 3 }]);

    const usage = s.h.db.prepare("SELECT artifact_revision_id AS owner, COUNT(*) AS n FROM token_usage GROUP BY owner ORDER BY n").all();
    expect(usage).toEqual([...partials.map((partial) => ({ owner: partial.id, n: 1 })), { owner: revision.id, n: 4 }].sort((a, b) => a.n - b.n));

    // Switching the primary: the summary is stale, and nothing is called again.
    const before = s.fake.calls.length;
    transcript(s.h, job.contentId, ["新的一句"]);
    const content = s.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, job.contentId));
    expect(deriveFreshness(revision.provenance.inputs, { ...(content?.primaryTranscriptRevisionId === undefined ? {} : { primaryTranscriptRevisionId: content.primaryTranscriptRevisionId }), chapterRevisionId })).toEqual({
      stale: true,
      staleReason: "transcript_changed",
    });
    expect(s.fake.calls.length).toBe(before);
  });

  it("after a crash mid-way only the unfinished units run again; finished partial and carry are not re-sent", async () => {
    const blocking = provider((kind, request, signal) => {
      if (kind === "partial" && aliasesAfter(request, "【本组内容】")[0] === 5) {
        return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return cite(kind, request, signal);
    });
    const first = setup(blocking, { contextWindowTokens: windowFor(ROOM) });
    const job = regenerate(first, LONG);
    chapters(first.h, job.contentId, [0, 4, 8]);
    first.h.scheduler.start();
    await waitFor(() => workUnitsOf(first.h, job.taskId).filter((unit) => unit.status === "succeeded").length === 2 && blocking.calls.length === 3);
    await first.h.scheduler.stop();
    const file = first.h.file;
    await first.h.close();
    open.splice(open.indexOf(first.h), 1);
    expect(kinds(blocking)).toEqual(["partial", "carry", "partial"]);

    const second = setup(provider(), { file });
    second.h.scheduler.start();
    await settled(second.h, job.taskId);
    const parked = workUnitsOf(second.h, job.taskId).find((unit) => unit.status === "waiting_user_action");
    expect(parked?.key).toBe("rollup:partial:1");
    expect(second.fake.calls).toHaveLength(0);
    second.h.tasks.confirmResend(LOCAL, job.taskId, parked?.id as string);
    await waitFor(() => taskOf(second.h, job.taskId).statusProjection === "succeeded");

    // Only the five unfinished units: partial 1, carry 1, partial 2, carry 2, final.
    expect(kinds(second.fake)).toEqual(["partial", "carry", "partial", "carry", "final"]);
    const units = workUnitsOf(second.h, job.taskId);
    expect(units.find((unit) => unit.key === "rollup:partial:0")?.attempt).toBe(1);
    expect(units.find((unit) => unit.key === "rollup:carry:0")?.attempt).toBe(1);
    expect(partialsOf(second.h, resultOf(second.h, job.taskId)["revisionId"] as string)).toHaveLength(3);
  });

  it("a partial still over the limit after its repair degrades the revision even when the final is clean", async () => {
    const s = setup(
      provider((kind, request, signal) => {
        if (kind === "partial" && aliasesAfter(request, "【本组内容】")[0] === 1) return "本组 [[s1]] [[s900]]";
        if (kind === "repair") return "{}";
        return cite(kind, request, signal);
      }),
      { contextWindowTokens: windowFor(ROOM) },
    );
    const job = regenerate(s, LONG);
    chapters(s.h, job.contentId, [0, 4, 8]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(kinds(s.fake).filter((kind) => kind === "repair")).toHaveLength(1);
    expect(keys(s.h, job.taskId)).toContain("rollup:partial:0:repair");
    // The unresolved marker carried forward is not counted again downstream.
    expect(promptOf(s.fake.calls[2]?.request as LlmRequest)).toContain("[[unresolved:s900]]");
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.quality).toBe("degraded");
    expect(revision.body).not.toContain("unresolved");
    expect(partialsOf(s.h, revision.id)[0]?.body).toContain("[[unresolved:s900]]");
    expect(resultOf(s.h, job.taskId)["reasons"]).toEqual(["citation_degraded"]);
  });
});

describe("summary stage: windows", () => {
  it("with an unknown window it rolls by the current chapters without budget checks", async () => {
    const s = setup(provider());
    const job = regenerate(s, LONG);
    chapters(s.h, job.contentId, [0, 6]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");
    expect(kinds(s.fake)).toEqual(["partial", "carry", "partial", "carry", "final"]);
  });

  it("with an unknown window and no chapters it fails with context_window_unknown before any call", async () => {
    const s = setup(provider());
    const job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)?.code).toBe("llm_capability.context_window_unknown");
    expect(errorOf(s.h, job.taskId)?.details).toEqual({ providerProfileId: s.modelRef.providerProfileId, modelId: s.modelRef.modelId });
    expect(s.fake.calls).toHaveLength(0);
  });

  it("fails with context_length before any call when nothing fits", async () => {
    const s = setup(provider(), { contextWindowTokens: windowFor(50) });
    const job = regenerate(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("failed");
    expect(errorOf(s.h, job.taskId)?.code).toBe("llm_capability.context_length");
    expect(s.fake.calls).toHaveLength(0);
  });
});

describe("summary stage: custom prompts", () => {
  const CORE_REF = { id: CORE.id, version: CORE.version };

  /** A Content with a primary transcript (and platform chapters when given) and a summary Task created through the service. */
  async function submitted(s: Setup, texts: readonly string[], chapterStarts?: readonly number[]) {
    const contentId = createLocalContent(s.h);
    const base = transcript(s.h, contentId, texts);
    if (chapterStarts !== undefined) chapters(s.h, contentId, chapterStarts);
    const accepted = await s.h.summaries.create(LOCAL, contentId, { templateId: CORE.id, modelRef: s.modelRef, outputLanguage: "zh-CN" });
    return { contentId, taskId: accepted.body.taskId, ...base };
  }

  it("a custom summary.envelope is sent and recorded beside the template on a single-call summary", async () => {
    const custom = `${SUMMARY_ENVELOPE_PROMPT.text}\n自定义标记：多用列表。`;
    const s = setup(provider(), { contextWindowTokens: 128_000 });
    s.h.prompts.update(LOCAL, "summary.envelope", { text: custom });
    const job = await submitted(s, TEXTS);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    expect(kinds(s.fake)).toEqual(["envelope"]);
    const values = { output_language: "简体中文", terms_section: "", template_body: CORE.prompt };
    const transcriptWithAliases = TEXTS.map((text, index) => `[[s${index + 1}]] ${text}`).join("\n");
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toBe(renderPrompt(custom, { ...values, transcript_with_aliases: transcriptWithAliases }));
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.provenance.promptRef).toEqual(CORE_REF);
    expect(revision.provenance.promptRefs).toEqual([CORE_REF, customPromptRef("summary.envelope", 1)]);
    expect(revision.provenance.promptSnapshot).toBe(renderPrompt(custom, values));
    expect(revision.provenance.promptSnapshot).toContain("自定义标记：多用列表。");
  });

  it("custom partial, carry and final prompts drive a rolling summary and are all recorded", async () => {
    const custom = {
      partial: `${ROLLUP_PARTIAL_PROMPT.text}\n自定义分组标记。`,
      carry: `${ROLLUP_CARRY_PROMPT.text}\n自定义压缩标记。`,
      final: `${ROLLUP_FINAL_PROMPT.text}\n自定义总归纳标记。`,
    };
    const s = setup(provider(), { contextWindowTokens: windowFor(ROOM) });
    s.h.prompts.update(LOCAL, "rollup.partial", { text: custom.partial });
    s.h.prompts.update(LOCAL, "rollup.carry", { text: custom.carry });
    s.h.prompts.update(LOCAL, "rollup.final", { text: custom.final });
    const job = await submitted(s, LONG, [0, 4, 8]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    expect(kinds(s.fake)).toEqual(["partial", "carry", "partial", "carry", "partial", "carry", "final"]);
    const marks: Record<string, string> = { partial: "自定义分组标记。", carry: "自定义压缩标记。", final: "自定义总归纳标记。" };
    for (const call of s.fake.calls) {
      const prompt = promptOf(call.request);
      const kind = kindOf(call.request);
      expect(prompt.endsWith(marks[kind] as string)).toBe(true);
      // Each call carries its own prompt's mark only.
      expect(Object.entries(marks).filter(([other, mark]) => other !== kind && prompt.includes(mark))).toEqual([]);
    }
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    const partialRef = customPromptRef("rollup.partial", 1);
    expect(revision.provenance.promptRef).toEqual(CORE_REF);
    expect(revision.provenance.promptRefs).toEqual([CORE_REF, partialRef, customPromptRef("rollup.carry", 1), customPromptRef("rollup.final", 1)]);
    expect(revision.provenance.promptSnapshot).toContain("自定义总归纳标记。");
    const partials = partialsOf(s.h, revision.id);
    expect(partials).toHaveLength(3);
    for (const partial of partials) {
      expect(partial.promptRef).toEqual(partialRef);
      expect(partial.promptRefs).toEqual([partialRef]);
      expect(partial.promptSnapshot).toContain("自定义分组标记。");
    }
  });

  it("a Task frozen on a historical builtin rollup.partial runs that version's exact text", async () => {
    const historical = BUILTIN_PROMPT_HISTORY.find((prompt) => prompt.ref.id === "rollup.partial" && prompt.ref.version === 1);
    expect(historical).toBeDefined();
    const s = setup(provider(), { contextWindowTokens: windowFor(ROOM) });
    const job = regenerate(s, LONG, { promptRefs: { "rollup.partial": historical?.ref } });
    chapters(s.h, job.contentId, [0, 4, 8]);
    s.h.scheduler.start();
    expect(await settled(s.h, job.taskId)).toBe("succeeded");

    const partialCalls = s.fake.calls.filter((call) => kindOf(call.request) === "partial");
    expect(partialCalls).toHaveLength(3);
    for (const call of partialCalls) {
      expect(promptOf(call.request).startsWith("你在为一门课程做连贯的归纳")).toBe(true);
    }
    const revision = revisionOf(s.h, resultOf(s.h, job.taskId)["revisionId"] as string);
    expect(revision.provenance.promptRefs).toEqual([CORE_REF, historical?.ref, ROLLUP_CARRY_PROMPT.ref, ROLLUP_FINAL_PROMPT.ref]);
    expect(partialsOf(s.h, revision.id).map((partial) => partial.promptRef)).toEqual([historical?.ref, historical?.ref, historical?.ref]);
  });
});
