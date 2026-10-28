import { afterEach, describe, expect, it } from "vitest";
import type { LlmRequest } from "../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import { CHAPTER_AI_PROMPT } from "../../../src/server/domain/prompts.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { Logger } from "../../../src/server/ports/logger.ts";
import { ChapterStageExecutor } from "../../../src/server/pipeline/stages/chapter.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../fixtures/llm/fake-llm.ts";
import {
  builtinPromptRefs,
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  silentLogger,
  stageRunsOf,
  stageStatuses,
  taskOf,
  waitFor,
  type Harness,
} from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const PROSE = "只写一段散文。";
const CHAPTER = CHAPTER_AI_PROMPT.text;

interface Setup {
  h: Harness;
  fake: FakeLlmProvider;
  modelRef: ModelRef;
  warnings: Array<{ message: string; fields: unknown }>;
}

function setup(): Setup {
  const fake = new FakeLlmProvider();
  const warnings: Setup["warnings"] = [];
  const logger: Logger = { ...silentLogger, warn: (message: string, fields?: unknown) => void warnings.push({ message, fields }), child: () => logger };
  const h = createHarness({ llmProviders: [fake], logger });
  open.push(h);
  h.executors.chapter = new ChapterStageExecutor({ repository: h.repository, newId: h.newId });
  const modelRef = configureLlm(h);
  h.db
    .prepare("UPDATE model_capability SET limits_user_override_json = ?, flags_user_override_json = ? WHERE profile_id = ?")
    .run(JSON.stringify({ contextWindowTokens: 128_000, maxOutputTokens: 10 }), JSON.stringify({ structuredOutput: "unsupported" }), modelRef.providerProfileId);
  return { h, fake, modelRef, warnings };
}

/** A local Content with an imported primary of a few sentences. */
function contentWithTranscript(h: Harness): { contentId: string; revisionId: string } {
  const contentId = createLocalContent(h);
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = ["开场白", "第一部分", "第二部分", "总结"].map((text, ordinal) => ({
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
  return { contentId, revisionId };
}

const textOf = (request: LlmRequest | undefined): string => {
  const part = request?.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
};

/** Answers chapter calls: prose when the prompt asks for prose (the parser refuses it), chapters otherwise. */
function answerChapters(fake: FakeLlmProvider, calls = 12): void {
  for (let i = 0; i < calls; i += 1) {
    fake.script((request) =>
      (async function* () {
        yield* reply(textOf(request).includes(PROSE) ? "这是一段关于课程的散文。" : JSON.stringify({ chapters: [{ startAlias: "s1", title: "全部", summary: "概要" }] }));
      })(),
    );
  }
}

const currentChapters = (h: Harness, contentId: string) => h.repository.withTransaction((scope) => scope.chapters.getCurrent(LOCAL.userId, contentId));

async function settled(h: Harness, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId).chapter ?? ""));
  return stageStatuses(h, taskId).chapter as string;
}

describe("prompt versions frozen into tasks", () => {
  it("freezes the version in effect at submission; a queued task keeps it after the prompt changes", async () => {
    const s = setup();
    const { contentId } = contentWithTranscript(s.h);
    s.h.prompts.update(LOCAL, "chapter.ai", { text: `${CHAPTER}\n第一版要求。` });
    const { body } = await s.h.derivedTasks.regenerateChapters(LOCAL, contentId, { modelRef: s.modelRef });
    expect(JSON.parse(taskOf(s.h, body.taskId).requestJson).promptRefs).toEqual({ "chapter.ai": { id: "custom:chapter.ai", version: 1 } });

    s.h.prompts.update(LOCAL, "chapter.ai", { text: `${CHAPTER}\n第二版要求。` });
    answerChapters(s.fake);
    s.h.scheduler.start();
    expect(await settled(s.h, body.taskId)).toBe("succeeded");
    expect(textOf(s.fake.calls[0]?.request)).toContain("第一版要求。");
    expect(textOf(s.fake.calls[0]?.request)).not.toContain("第二版要求。");
    expect(currentChapters(s.h, contentId)?.provenance).toMatchObject({
      promptRef: { id: "custom:chapter.ai", version: 1 },
      promptRefs: [{ id: "custom:chapter.ai", version: 1 }],
    });
  });

  it("a stage failing under a broken prompt succeeds when re-run after the builtin is restored", async () => {
    const s = setup();
    const { contentId } = contentWithTranscript(s.h);
    // Keeps every slot and protocol fragment, yet makes the model answer in prose.
    s.h.prompts.update(LOCAL, "chapter.ai", { text: `${CHAPTER}\n${PROSE}` });
    const { body } = await s.h.derivedTasks.regenerateChapters(LOCAL, contentId, { modelRef: s.modelRef });
    answerChapters(s.fake);
    s.h.scheduler.start();
    expect(await settled(s.h, body.taskId)).toBe("failed");
    expect(s.fake.calls.every((call) => textOf(call.request).includes(PROSE))).toBe(true);
    expect(currentChapters(s.h, contentId)).toBeUndefined();

    s.h.prompts.restore(LOCAL, "chapter.ai");
    const sentBefore = s.fake.calls.length;
    s.h.tasks.retryStage(LOCAL, body.taskId, { stage: "chapter" });
    expect(await settled(s.h, body.taskId)).toBe("succeeded");
    const attempts = stageRunsOf(s.h, body.taskId).filter((run) => run.stage === "chapter");
    expect(attempts.map((run) => run.attempt)).toEqual([1, 2]);
    expect(attempts[0]?.inputJson).toBeUndefined();
    expect(JSON.parse(attempts[1]?.inputJson ?? "{}")).toEqual({ promptRefs: builtinPromptRefs("regenerate_chapters") });
    // The request itself stays as submitted.
    expect(JSON.parse(taskOf(s.h, body.taskId).requestJson).promptRefs).toEqual({ "chapter.ai": { id: "custom:chapter.ai", version: 1 } });
    const resent = s.fake.calls.slice(sentBefore).map((call) => textOf(call.request));
    expect(resent).toHaveLength(1);
    expect(resent[0]).not.toContain(PROSE);
    expect(resent[0]?.startsWith(CHAPTER.split("{{window_note}}")[0] as string)).toBe(true);
    expect(currentChapters(s.h, contentId)?.provenance).toMatchObject({ promptRef: CHAPTER_AI_PROMPT.ref, promptRefs: [CHAPTER_AI_PROMPT.ref] });
  });

  it("a task stored before prompts were frozen uses the version in effect when it runs", async () => {
    const s = setup();
    const { contentId, revisionId } = contentWithTranscript(s.h);
    const taskId = createTaskOfKind(s.h, "regenerate_chapters", { modelRef: s.modelRef, baseRevisionId: revisionId, outputLanguage: "zh-CN" }, { contentId });
    s.h.prompts.update(LOCAL, "chapter.ai", { text: `${CHAPTER}\n运行时生效。` });
    answerChapters(s.fake);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(textOf(s.fake.calls[0]?.request)).toContain("运行时生效。");
    expect(currentChapters(s.h, contentId)?.provenance.promptRef).toEqual({ id: "custom:chapter.ai", version: 1 });
  });

  it("a frozen version that no longer resolves falls back to the current builtin text with a warning", async () => {
    const s = setup();
    const { contentId, revisionId } = contentWithTranscript(s.h);
    const taskId = createTaskOfKind(
      s.h,
      "regenerate_chapters",
      {
        modelRef: s.modelRef,
        baseRevisionId: revisionId,
        outputLanguage: "zh-CN",
        promptRefs: { "chapter.ai": { id: "chapter.ai", version: 99 } },
      },
      { contentId },
    );
    answerChapters(s.fake);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(textOf(s.fake.calls[0]?.request).startsWith(CHAPTER.split("{{window_note}}")[0] as string)).toBe(true);
    expect(currentChapters(s.h, contentId)?.provenance.promptRef).toEqual(CHAPTER_AI_PROMPT.ref);
    expect(s.warnings.map((warning) => warning.message)).toContain("prompt_version_unresolved");
    expect(s.warnings.find((warning) => warning.message === "prompt_version_unresolved")?.fields).toMatchObject({ taskId, promptId: "chapter.ai", ref: "chapter.ai@99" });
  });

  it("freezes the prompts of every kind at submission, the user's own versions included", async () => {
    const s = setup();
    const { contentId } = contentWithTranscript(s.h);
    s.h.prompts.update(LOCAL, "summary.envelope", { text: `${s.h.prompts.list(LOCAL).items.find((item) => item.id === "summary.envelope")?.builtin.text}\n多用列表。` });
    const proofread = await s.h.derivedTasks.proofread(LOCAL, contentId, { modelRef: s.modelRef });
    expect(JSON.parse(taskOf(s.h, proofread.body.taskId).requestJson).promptRefs).toEqual(builtinPromptRefs("reproofread"));
    await s.h.scheduler.stop();
    const imported = await s.h.importContent.import(LOCAL, { items: [{ url: "https://www.bilibili.com/video/BV1xx411c7mD" }], settings: { modelRef: s.modelRef, autoProofread: true } });
    expect(JSON.parse(taskOf(s.h, imported.body.taskIds[0] as string).requestJson).promptRefs).toEqual({
      ...builtinPromptRefs("process_content"),
      "summary.envelope": { id: "custom:summary.envelope", version: 1 },
    });
  });
});
