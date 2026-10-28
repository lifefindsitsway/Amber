import { afterEach, describe, expect, it } from "vitest";
import type { CollectionSummaryRevision } from "../../../../src/server/domain/artifact.ts";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../../src/server/domain/model-ref.ts";
import { normalizeTermKey } from "../../../../src/server/domain/terminology.ts";
import {
  BUILTIN_PROMPT_HISTORY,
  BUILTIN_SUMMARY_TEMPLATES,
  CITATION_NONE_FRAGMENT,
  CITATION_RULES_FRAGMENT,
  customPromptRef,
  ROLLUP_CARRY_PROMPT,
  ROLLUP_FINAL_COLLECTION_PROMPT,
  ROLLUP_GOAL_COLLECTION_PROMPT,
  ROLLUP_PARTIAL_PROMPT,
} from "../../../../src/server/domain/prompts.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { transact } from "../../../../src/server/pipeline/publish.ts";
import { CollectionSummaryStageExecutor } from "../../../../src/server/pipeline/stages/collection-summary.ts";
import { createTask } from "../../../../src/server/pipeline/task-state.ts";
import { COLLECTION_PARTIAL_SIZE, CONTEXT_SAFETY_RATIO } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import {
  configureLlm,
  createHarness,
  createLocalContent,
  LOCAL,
  stageRunsOf,
  stageStatuses,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

const CORE = BUILTIN_SUMMARY_TEMPLATES[0] as (typeof BUILTIN_SUMMARY_TEMPLATES)[number];

function promptOf(request: LlmRequest): string {
  const part = request.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
}

type Kind = "partial" | "carry" | "final" | "repair";

function kindOf(request: LlmRequest): Kind {
  const prompt = promptOf(request);
  if (prompt.startsWith("以下引用标记")) return "repair";
  // The second prefix is the historical rollup.partial text, still run by Tasks frozen on it.
  if (prompt.startsWith("你在为一个合集或一段长内容做连贯的归纳") || prompt.startsWith("你在为一门课程做连贯的归纳")) return "partial";
  if (prompt.startsWith("把「已有压缩摘要」")) return "carry";
  return "final";
}

/** The section of a prompt after `marker`. */
function sectionAfter(request: LlmRequest, marker: string): string {
  const prompt = promptOf(request);
  return prompt.slice(prompt.lastIndexOf(marker));
}

/** What the model answers although asked not to cite: aliases in every form models write, and stored markers. */
const PARTIAL_ANSWER = "本组归纳[[s3]] [s4]]，见第 1 项[[s99]";
const CARRY_ANSWER = "压缩[[s1]]";
const FINAL_ANSWER = "## 这个合集在讲什么\n跨项结论[[s3]][[s7]]、[[seg:01J000000000000000000000AA]] [[unresolved:s9]]。";

/**
 * Every output cites although the collection summary asks it not to. `fail` may turn a call
 * into an error the stage cannot retry by itself.
 */
function provider(fail?: (kind: Kind) => boolean): FakeLlmProvider {
  const fake = new FakeLlmProvider();
  fake.script(
    ...Array.from({ length: 100 }, () => (request: LlmRequest) =>
      (async function* (): AsyncGenerator<LlmStreamEvent> {
        const kind = kindOf(request);
        if (fail?.(kind) === true) throw amberError("llm_capability", "scripted failure");
        if (kind === "partial") yield* reply(PARTIAL_ANSWER);
        else if (kind === "carry") yield* reply(CARRY_ANSWER);
        else if (kind === "final") yield* reply(FINAL_ANSWER);
        else yield* reply("{}");
      })(),
    ),
  );
  return fake;
}

interface Lecture {
  contentId: string;
  itemId: string;
  revision: TranscriptRevision;
  segments: TranscriptSegment[];
  summaryRevisionId: string;
}

interface Setup {
  h: Harness;
  fake: FakeLlmProvider;
  modelRef: ModelRef;
  collectionId: string;
  lectures: Lecture[];
}

/** A collection of `count` lectures, each with a 3-sentence primary and a `summary.core` current citing two of them. */
function setup(count: number, options: { contextWindowTokens?: number; fake?: FakeLlmProvider } = {}): Setup {
  const fake = options.fake ?? provider();
  const h = createHarness({ llmProviders: [fake], executors: {} });
  open.push(h);
  h.executors.collection_summary = new CollectionSummaryStageExecutor({ repository: h.repository, newId: h.newId });
  const modelRef = configureLlm(h);
  if (options.contextWindowTokens !== undefined) {
    h.db
      .prepare("UPDATE model_capability SET limits_user_override_json = ? WHERE profile_id = ?")
      .run(JSON.stringify({ contextWindowTokens: options.contextWindowTokens, maxOutputTokens: 10 }), modelRef.providerProfileId);
  }
  const collectionId = h.newId();
  const lectures: Lecture[] = [];
  h.repository.withTransaction((scope) => {
    scope.summaryTemplates.syncBuiltin(
      BUILTIN_SUMMARY_TEMPLATES.map((template) => ({ id: template.id, name: template.nameKey, versions: [{ version: template.version, prompt: template.prompt }] })),
      1,
    );
    scope.collections.insert({ id: collectionId, userId: LOCAL.userId, name: "生成式软件工程", createdAt: 1, updatedAt: 1 });
  });
  for (let k = 0; k < count; k += 1) {
    const contentId = createLocalContent(h);
    const revisionId = h.newId();
    const segments: TranscriptSegment[] = [0, 1, 2].map((ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text: `第 ${k + 1} 讲第 ${ordinal + 1} 句`,
      sourceSegmentIds: [],
    }));
    const revision: TranscriptRevision = {
      id: revisionId,
      contentId,
      kind: "imported",
      language: "zh-CN",
      timingFidelity: "segment_only",
      generation: { kind: "imported", format: "srt" },
      segmentCount: 3,
      createdAt: 1,
    };
    const summaryRevisionId = h.newId();
    const itemId = h.newId();
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
      scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 2);
      const { artifactId } = scope.summaries.insertRevision(LOCAL.userId, {
        contentId,
        templateId: CORE.id,
        artifactId: h.newId(),
        revision: {
          id: summaryRevisionId,
          provenance: { inputs: [{ kind: "transcriptRevision", id: revisionId }], promptRef: { id: CORE.id, version: CORE.version }, createdAt: 1 },
          quality: "normal",
          body: `## 摘要\n要点一 [[seg:${segments[0]?.id}]]，要点二 [[seg:${segments[2]?.id}]]`,
          citations: [0, 2].map((i) => ({ transcriptRevisionId: revisionId, segmentId: segments[i]?.id as SegmentId })),
        },
      });
      scope.summaries.setCurrent(LOCAL.userId, artifactId, summaryRevisionId);
      scope.collections.addItem(LOCAL.userId, { id: itemId, collectionId, contentId, position: k, addedAt: 1 });
    });
    lectures.push({ contentId, itemId, revision, segments, summaryRevisionId });
  }
  return { h, fake, modelRef, collectionId, lectures };
}

function summarize(s: Setup, extra: Record<string, unknown> = {}): string {
  const request = {
    requestSchemaVersion: 1,
    kind: "summarize_collection",
    modelRef: s.modelRef,
    outputLanguage: "zh-CN",
    ...extra,
    inputItems: s.lectures.map((lecture, position) => ({
      collectionItemId: lecture.itemId,
      contentId: lecture.contentId,
      summaryRevisionId: lecture.summaryRevisionId,
      transcriptRevisionId: lecture.revision.id,
      position,
    })),
  };
  return transact(s.h.repository, s.h.bus, (scope, outbox) =>
    createTask(scope, outbox, {
      task: { id: s.h.newId(), userId: LOCAL.userId, collectionId: s.collectionId, kind: "summarize_collection", requestJson: canonicalJson(request), createdAt: 1 },
      sourceKind: undefined,
      newId: s.h.newId,
    }).id,
  );
}

async function settled(h: Harness, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId)["collection_summary"] ?? ""));
  return stageStatuses(h, taskId)["collection_summary"] as string;
}

const resultOf = (h: Harness, taskId: string) =>
  JSON.parse(stageRunsOf(h, taskId).at(-1)?.resultJson ?? "{}") as Record<string, unknown>;

describe("collection summary stage", () => {
  it("twelve lectures roll in three groups without citations: members' markers are stripped, the calls asked not to cite, and stray markers dropped", async () => {
    const s = setup(12);
    s.h.repository.withTransaction((scope) =>
      scope.terminology.put({
        id: s.h.newId(),
        userId: LOCAL.userId,
        scope: { kind: "collection", collectionId: s.collectionId },
        entries: [{ id: s.h.newId(), ordinal: 0, term: "RAG", normalizedKey: normalizeTermKey("RAG"), translation: "检索增强生成" }],
      }),
    );
    const taskId = summarize(s);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    expect(Math.ceil(12 / COLLECTION_PARTIAL_SIZE)).toBe(3);
    const keys = ["rollup:partial:0", "rollup:carry:0", "rollup:partial:1", "rollup:carry:1", "rollup:partial:2", "rollup:carry:2", "rollup:final"];
    expect(workUnitsOf(s.h, taskId).map((unit) => unit.key)).toEqual(keys);
    // Every output cited, yet nothing was repaired.
    expect(s.fake.calls.map((call) => kindOf(call.request))).toEqual(["partial", "carry", "partial", "carry", "partial", "carry", "final"]);
    const firstPartial = promptOf(s.fake.calls[0]?.request as LlmRequest);
    expect(firstPartial).toContain(ROLLUP_GOAL_COLLECTION_PROMPT.text);
    expect(firstPartial).toContain("【术语表】\nRAG = 检索增强生成");
    // Members are numbered across the collection and sent without their citation markers.
    expect(firstPartial).toContain("【第 1 项】\n## 摘要\n要点一，要点二");
    expect(promptOf(s.fake.calls[2]?.request as LlmRequest)).toContain("【第 6 项】\n## 摘要\n要点一，要点二");
    for (const call of s.fake.calls) {
      const kind = kindOf(call.request);
      if (kind === "partial") expect(sectionAfter(call.request, "【本组内容】")).not.toContain("[[");
      if (kind === "partial" || kind === "final") {
        expect(promptOf(call.request)).toContain(`\n${CITATION_NONE_FRAGMENT.text}\n输出语言：`);
        expect(promptOf(call.request)).not.toContain(CITATION_RULES_FRAGMENT.text);
      }
      // What is fed forward carries no marker either.
      if (kind === "carry") expect(sectionAfter(call.request, "【已有压缩摘要】")).not.toContain("[");
    }
    const final = promptOf(s.fake.calls[6]?.request as LlmRequest);
    expect(final.startsWith("下面是一个合集各组内容的归纳与整体压缩摘要")).toBe(true);
    expect(final).toContain("【第 1 组】\n本组归纳，见第 1 项");
    expect(final).toContain("【整体压缩摘要】\n压缩");

    const result = resultOf(s.h, taskId);
    expect(result).toMatchObject({ groups: 3, reasons: [] });
    const revision = s.h.repository.withTransaction((scope) => scope.collectionSummaries.getCurrent(LOCAL.userId, s.collectionId)) as CollectionSummaryRevision;
    expect(revision.id).toBe(result["revisionId"]);
    expect(revision.body).toBe("## 这个合集在讲什么\n跨项结论。");
    expect(revision.citations).toEqual([]);
    expect(revision.quality).toBe("normal");
    expect(revision.provenance.promptRef).toEqual({ id: "rollup.final.collection", version: 3 });
    expect(revision.provenance.promptRefs).toEqual([
      { id: "rollup.goal.collection", version: 3 },
      { id: "rollup.partial", version: 2 },
      { id: "rollup.carry", version: 1 },
      { id: "rollup.final.collection", version: 3 },
    ]);
    expect(revision.provenance.promptSnapshot).toContain(CITATION_NONE_FRAGMENT.text);
    // A published rollup summary counts as a change of the collection.
    expect(s.h.repository.withTransaction((scope) => scope.collections.get(LOCAL.userId, s.collectionId))?.updatedAt).toBe(revision.provenance.createdAt);
    expect(revision.inputItems).toHaveLength(12);
    expect(revision.provenance.inputs[0]).toEqual({
      kind: "collectionItemSnapshot",
      collectionItemId: s.lectures[0]?.itemId,
      contentId: s.lectures[0]?.contentId,
      summaryRevisionId: s.lectures[0]?.summaryRevisionId,
      transcriptRevisionId: s.lectures[0]?.revision.id,
      position: 0,
    });

    const partials = s.h.repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision(LOCAL.userId, revision.id));
    expect(partials).toHaveLength(3);
    expect(revision.partialIds).toEqual(partials.map((partial) => partial.id));
    expect(partials.map((partial) => partial.inputs.length)).toEqual([5, 5, 2]);
    expect(partials.map((partial) => [partial.body, partial.citations])).toEqual(Array.from({ length: 3 }, () => ["本组归纳，见第 1 项", []]));
    const usage = s.h.db.prepare("SELECT feature, COUNT(*) AS n FROM token_usage WHERE artifact_revision_id IS NOT NULL GROUP BY feature").all();
    expect(usage).toEqual([{ feature: "collection_summary", n: 7 }]);
  });

  it("fails with context_length when a group of lectures does not fit, without splitting it further", async () => {
    // Room for the partial prompt skeleton but not for five lectures plus the goal.
    const s = setup(6, { contextWindowTokens: Math.ceil((400 + 10) / CONTEXT_SAFETY_RATIO) });
    const taskId = summarize(s);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(stageRunsOf(s.h, taskId).at(-1)?.error?.code).toBe("llm_capability.context_length");
    expect(s.fake.calls).toHaveLength(0);
    // Nothing was published, so the collection has not changed.
    expect(s.h.repository.withTransaction((scope) => scope.collections.get(LOCAL.userId, s.collectionId))?.updatedAt).toBe(1);
  });
});

describe("collection summary stage: custom prompts", () => {
  const GOAL = "## 自定义目标：列出全部核心术语\n## 给出学习路线";
  const currentRevision = (s: Setup) =>
    s.h.repository.withTransaction((scope) => scope.collectionSummaries.getCurrent(LOCAL.userId, s.collectionId)) as CollectionSummaryRevision;

  it("a custom rollup.goal.collection is the task of every partial, carry and final call and is recorded first", async () => {
    const s = setup(12);
    s.h.prompts.update(LOCAL, "rollup.goal.collection", { text: GOAL });
    const taskId = summarize(s);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    expect(s.fake.calls.map((call) => kindOf(call.request))).toEqual(["partial", "carry", "partial", "carry", "partial", "carry", "final"]);
    for (const call of s.fake.calls) {
      const prompt = promptOf(call.request);
      expect(prompt).toContain(`【任务】\n${GOAL}\n【`);
      expect(prompt).not.toContain(ROLLUP_GOAL_COLLECTION_PROMPT.text);
    }
    // Members are labelled by their position in the collection.
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toContain("【第 1 项】\n## 摘要");
    expect(promptOf(s.fake.calls[4]?.request as LlmRequest)).toContain("【第 11 项】\n## 摘要");

    const revision = currentRevision(s);
    expect(revision.provenance.promptRef).toEqual(ROLLUP_FINAL_COLLECTION_PROMPT.ref);
    expect(revision.provenance.promptRefs).toEqual([
      customPromptRef("rollup.goal.collection", 1),
      ROLLUP_PARTIAL_PROMPT.ref,
      ROLLUP_CARRY_PROMPT.ref,
      ROLLUP_FINAL_COLLECTION_PROMPT.ref,
    ]);
    expect(revision.provenance.promptSnapshot).toContain(GOAL);
  });

  it.each([
    ["an unchanged goal reuses the finished partials and carries", false],
    ["a changed goal changes every partial's digest, so each is asked again", true],
  ])("re-running a failed stage: %s", async (_case, changeGoal) => {
    let failFinal = true;
    const fake = provider((kind) => {
      if (kind !== "final" || !failFinal) return false;
      failFinal = false;
      return true;
    });
    const s = setup(12, { fake });
    const taskId = summarize(s);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    const firstRun = stageRunsOf(s.h, taskId).at(-1)?.id;
    const before = s.fake.calls.length;
    const partialDigests = (runId: string | undefined) =>
      workUnitsOf(s.h, taskId)
        .filter((unit) => unit.stageRunId === runId && unit.key.startsWith("rollup:partial:"))
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((unit) => unit.inputDigest);
    const firstDigests = partialDigests(firstRun);
    expect(firstDigests).toHaveLength(3);

    if (changeGoal) s.h.prompts.update(LOCAL, "rollup.goal.collection", { text: GOAL });
    s.h.tasks.retryStage(LOCAL, taskId, { stage: "collection_summary" });
    await waitFor(() => stageRunsOf(s.h, taskId).at(-1)?.id !== firstRun);
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const again = s.fake.calls.slice(before).map((call) => kindOf(call.request));
    const secondDigests = partialDigests(stageRunsOf(s.h, taskId).at(-1)?.id);
    if (changeGoal) {
      expect(again).toEqual(["partial", "carry", "partial", "carry", "partial", "carry", "final"]);
      expect(secondDigests.every((digest, index) => digest !== firstDigests[index])).toBe(true);
      expect(s.fake.calls.slice(before).every((call) => promptOf(call.request).includes(GOAL))).toBe(true);
      expect(currentRevision(s).provenance.promptRefs?.[0]).toEqual(customPromptRef("rollup.goal.collection", 1));
    } else {
      expect(again).toEqual(["final"]);
      expect(secondDigests).toEqual(firstDigests);
      expect(currentRevision(s).provenance.promptRefs?.[0]).toEqual(ROLLUP_GOAL_COLLECTION_PROMPT.ref);
    }
  });

  it("a Task frozen on a historical builtin rollup.partial runs that version's exact text", async () => {
    const historical = BUILTIN_PROMPT_HISTORY.find((prompt) => prompt.ref.id === "rollup.partial" && prompt.ref.version === 1);
    expect(historical).toBeDefined();
    const s = setup(6);
    const taskId = summarize(s, { promptRefs: { "rollup.partial": historical?.ref } });
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    const partialCalls = s.fake.calls.filter((call) => kindOf(call.request) === "partial");
    expect(partialCalls).toHaveLength(2);
    for (const call of partialCalls) {
      expect(promptOf(call.request).startsWith("你在为一门课程做连贯的归纳")).toBe(true);
    }
    expect(currentRevision(s).provenance.promptRefs?.[1]).toEqual(historical?.ref);
  });

  it("a summary created through the service keeps the goal in effect at submission", async () => {
    const s = setup(3);
    s.h.prompts.update(LOCAL, "rollup.goal.collection", { text: GOAL });
    const accepted = await s.h.collections.createSummary(LOCAL, s.collectionId, { modelRef: s.modelRef, outputLanguage: "zh-CN" });
    s.h.prompts.restore(LOCAL, "rollup.goal.collection");
    s.h.scheduler.start();
    expect(await settled(s.h, accepted.body.taskId)).toBe("succeeded");
    expect(s.fake.calls.every((call) => promptOf(call.request).includes(`【任务】\n${GOAL}\n`))).toBe(true);
    expect(currentRevision(s).provenance.promptRefs?.[0]).toEqual(customPromptRef("rollup.goal.collection", 1));
  });
});
