import { afterEach, describe, expect, it } from "vitest";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../../src/server/domain/model-ref.ts";
import { customPromptRef, renderPrompt, TRANSLATE_SUBTITLES_PROMPT } from "../../../../src/server/domain/prompts.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { TranslateStageExecutor } from "../../../../src/server/pipeline/stages/translate.ts";
import type { LlmLanes } from "../../../../src/server/application/llm-lanes.ts";
import { LLM_WINDOW_INITIAL, TRANSLATE_BATCH_LINES } from "../../../../src/shared/defaults.ts";
import type { InstanceSettingsFields } from "../../../../src/shared/dto/instance-settings.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import { pipelineAnswer, promptText } from "../../../fixtures/llm/pipeline-llm.ts";
import {
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  gate,
  LOCAL,
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

interface Setup {
  h: Harness;
  fake: FakeLlmProvider;
  modelRef: ModelRef;
}

/**
 * A harness with the translate stage and a model whose context window was never stated:
 * translation must not depend on it.
 */
function setup(overrides: Partial<InstanceSettingsFields> = {}): Setup {
  const fake = new FakeLlmProvider();
  const h = createHarness({ llmProviders: [fake], overrides });
  open.push(h);
  h.executors.translate = new TranslateStageExecutor({ repository: h.repository, newId: h.newId });
  const modelRef = configureLlm(h);
  h.scheduler.start();
  return { h, fake, modelRef };
}

/** An imported zh-CN revision with one sentence per text, made primary. */
function transcript(
  h: Harness,
  contentId: string,
  texts: readonly string[],
  paragraphStarts?: readonly boolean[],
): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = texts.map((text, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId,
    ordinal,
    startMs: 1000 + ordinal * 1000,
    endMs: 1900 + ordinal * 1000,
    text,
    ...(ordinal % 2 === 0 ? { speakerId: "A" } : {}),
    ...(paragraphStarts === undefined ? {} : { paragraphStart: paragraphStarts[ordinal] as boolean }),
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

const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `第 ${index + 1} 句\n换行`);

function translate(s: Setup, contentId: string, baseRevisionId: string, targetLanguages: string[]): string {
  const taskId = createTaskOfKind(s.h, "translate", { targetLanguages, modelRef: s.modelRef, baseRevisionId }, { contentId });
  s.h.scheduler.kick();
  return taskId;
}

async function settled(h: Harness, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId).translate ?? ""));
  return stageStatuses(h, taskId).translate as string;
}

/** Answers with the fixture's well-formed numbered translation. */
function good(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
  return (async function* () {
    yield* reply(pipelineAnswer(request));
  })();
}

function answerAll(fake: FakeLlmProvider, calls: number): void {
  for (let i = 0; i < calls; i += 1) fake.script(good);
}

/** Every call waits on `held` while counting how many are in flight at once. */
function counting(fake: FakeLlmProvider, calls: number): { max: () => number; active: () => number; release: () => void } {
  const held = gate();
  let active = 0;
  let max = 0;
  for (let i = 0; i < calls; i += 1) {
    fake.script((request) =>
      (async function* () {
        active += 1;
        max = Math.max(max, active);
        try {
          await held.promise;
          yield* reply(pipelineAnswer(request));
        } finally {
          active -= 1;
        }
      })(),
    );
  }
  return { max: () => max, active: () => active, release: held.open };
}

function translatedSegments(h: Harness, revisionId: string): TranscriptSegment[] {
  return h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revisionId));
}

describe("translate stage", () => {
  it("two languages keep zero line drift, every batch queued at once and as many in flight as the model lane admits", async () => {
    const s = setup();
    const contentId = createLocalContent(s.h);
    // More batches than a new lane's window, the last one shorter than the rest.
    const count = TRANSLATE_BATCH_LINES * 4 + 7;
    const base = transcript(s.h, contentId, lines(count));
    const batchesPerLanguage = Math.ceil(count / TRANSLATE_BATCH_LINES);
    const total = batchesPerLanguage * 2;
    expect(total).toBeGreaterThan(LLM_WINDOW_INITIAL);
    const probe = counting(s.fake, total);
    const taskId = translate(s, contentId, base.revision.id, ["en", "ja"]);

    await waitFor(() => probe.active() === LLM_WINDOW_INITIAL);
    // A new lane admits LLM_WINDOW_INITIAL until an answer comes back.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.fake.calls).toHaveLength(LLM_WINDOW_INITIAL);
    probe.release();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(probe.max()).toBeGreaterThanOrEqual(LLM_WINDOW_INITIAL);

    const units = workUnitsOf(s.h, taskId).map((unit) => unit.key).sort();
    expect(units).toEqual(
      ["en", "ja"].flatMap((language) => Array.from({ length: batchesPerLanguage }, (_, i) => `translate:${language}:batch:${i}`)).sort(),
    );
    expect(workUnitsOf(s.h, taskId).every((unit) => unit.billing === "llm")).toBe(true);

    const dto = s.h.translations.get(LOCAL, contentId);
    expect(dto.translations.map((entry) => entry.targetLanguage)).toEqual(["en", "ja"]);
    for (const entry of dto.translations) {
      const current = entry.current as NonNullable<typeof entry.current>;
      expect(current).toMatchObject({ kind: "translated", parentRevisionId: base.revision.id, language: entry.targetLanguage, timingFidelity: "segment_only", segmentCount: count });
      expect(current.generation).toMatchObject({ kind: "llm", promptRef: { id: "translate.subtitles", version: 1 } });
      expect(entry.stale).toBe(false);
      const segments = translatedSegments(s.h, current.id);
      // Zero drift: one translated sentence per source sentence, each pointing at exactly its parent.
      expect(segments).toHaveLength(base.segments.length);
      segments.forEach((segment, index) => {
        const parent = base.segments[index] as TranscriptSegment;
        expect(segment.sourceSegmentIds).toEqual([parent.id]);
        expect([segment.ordinal, segment.startMs, segment.endMs, segment.speakerId]).toEqual([parent.ordinal, parent.startMs, parent.endMs, parent.speakerId]);
        expect(segment.text).toContain(`第 ${index + 1} 句 换行`);
      });
    }
    // The primary never moves to a translation.
    expect(s.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId))?.primaryTranscriptRevisionId).toBe(base.revision.id);
    // Each language's calls are attributed to its own revision.
    const usage = s.h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
    expect(usage).toHaveLength(total);
    expect(usage.every((row) => row.feature === "translate")).toBe(true);
    for (const entry of dto.translations) {
      expect(usage.filter((row) => row.artifactRevisionId === entry.current?.id)).toHaveLength(batchesPerLanguage);
    }
  });

  it("has no batch limit of its own: a lane admitting ten has ten batches in flight", async () => {
    const s = setup();
    const lane = (s.h.llm as unknown as { lanes: LlmLanes }).lanes.get(s.modelRef);
    lane.window = 10;
    const contentId = createLocalContent(s.h);
    const base = transcript(s.h, contentId, lines(TRANSLATE_BATCH_LINES * 6));
    const probe = counting(s.fake, 12);
    const taskId = translate(s, contentId, base.revision.id, ["en", "fr"]);
    await waitFor(() => probe.active() === 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.fake.calls).toHaveLength(10);
    probe.release();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(probe.max()).toBe(10);
  });

  it("translates with a model whose context window is unknown, sending numbered lines and the terminology", async () => {
    const s = setup();
    const contentId = createLocalContent(s.h);
    const base = transcript(s.h, contentId, ["第一句", "第二句"]);
    s.h.repository.withTransaction((scope) =>
      scope.terminology.put({
        id: s.h.newId(),
        userId: LOCAL.userId,
        scope: { kind: "global" },
        entries: [{ id: s.h.newId(), ordinal: 0, term: "RAG", normalizedKey: "rag", rule: "keep_original" }],
      }),
    );
    answerAll(s.fake, 1);
    const taskId = translate(s, contentId, base.revision.id, ["en"]);
    expect(await settled(s.h, taskId)).toBe("succeeded");
    const prompt = promptText(s.fake.calls[0]?.request as LlmRequest);
    expect(prompt).toContain("请将以下字幕翻译成 英语。");
    expect(prompt).toContain("输入 2 行，输出必须恰好 2 行");
    expect(prompt).toContain("【术语表】");
    expect(prompt.endsWith("1. 第一句\n2. 第二句")).toBe(true);
    const current = s.h.translations.get(LOCAL, contentId).translations[0]?.current;
    expect(current?.generation).toMatchObject({ promptSnapshot: expect.stringContaining("请将以下字幕翻译成 英语。") });
    expect(translatedSegments(s.h, current?.id as string).map((segment) => segment.text)).toEqual(["[英语] 第一句", "[英语] 第二句"]);
  });

  it("inherits the parent's paragraph marks sentence for sentence, and none when the parent has none", async () => {
    const s = setup();
    const contentId = createLocalContent(s.h);
    const marked = transcript(s.h, contentId, ["第一句", "第二句", "第三句"], [true, false, true]);
    answerAll(s.fake, 1);
    expect(await settled(s.h, translate(s, contentId, marked.revision.id, ["en"]))).toBe("succeeded");
    const current = s.h.translations.get(LOCAL, contentId).translations[0]?.current;
    expect(translatedSegments(s.h, current?.id as string).map((segment) => segment.paragraphStart)).toEqual([true, false, true]);

    const plain = transcript(s.h, contentId, ["第一句", "第二句"]);
    answerAll(s.fake, 1);
    expect(await settled(s.h, translate(s, contentId, plain.revision.id, ["ja"]))).toBe("succeeded");
    const japanese = s.h.translations.get(LOCAL, contentId).translations.find((entry) => entry.targetLanguage === "ja")?.current;
    expect(translatedSegments(s.h, japanese?.id as string).map((segment) => segment.paragraphStart)).toEqual([undefined, undefined]);
  });

  it("re-asks a batch whose answer has a wrong count, a duplicate number or an empty line, then succeeds", async () => {
    const s = setup();
    const contentId = createLocalContent(s.h);
    const base = transcript(s.h, contentId, ["一", "二", "三"]);
    s.fake.script(
      { events: reply("1. one\n2. two") },
      { events: reply("1. one\n1. one\n3. three") },
      { events: reply("1. one\n2. \n3. three") },
      { events: reply("1. one\n\n2. two\n3. three\n") },
    );
    const taskId = translate(s, contentId, base.revision.id, ["en"]);
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(s.fake.calls).toHaveLength(4);
    expect(workUnitsOf(s.h, taskId)[0]).toMatchObject({ key: "translate:en:batch:0", status: "succeeded" });
    const current = s.h.translations.get(LOCAL, contentId).translations[0]?.current;
    expect(translatedSegments(s.h, current?.id as string).map((segment) => segment.text)).toEqual(["one", "two", "three"]);
  });

  it("fails the stage with output_mismatch once retries are used up", async () => {
    const s = setup();
    const contentId = createLocalContent(s.h);
    const base = transcript(s.h, contentId, ["一", "二"]);
    for (let i = 0; i < 10; i += 1) s.fake.script({ events: reply("1. only one") });
    const taskId = translate(s, contentId, base.revision.id, ["en"]);
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(stageRunsOf(s.h, taskId).at(-1)?.error).toMatchObject({ class: "output_mismatch" });
    expect(s.h.translations.get(LOCAL, contentId).translations).toEqual([]);
  });

  it("makes a new translation of the same language current, keeps the old one and turns stale when the primary moves", async () => {
    const s = setup();
    const contentId = createLocalContent(s.h);
    const base = transcript(s.h, contentId, ["一", "二"]);
    answerAll(s.fake, 2);
    expect(await settled(s.h, translate(s, contentId, base.revision.id, ["en"]))).toBe("succeeded");
    const first = s.h.translations.get(LOCAL, contentId).translations[0]?.current?.id;
    expect(await settled(s.h, translate(s, contentId, base.revision.id, ["en"]))).toBe("succeeded");
    const entry = s.h.translations.get(LOCAL, contentId).translations[0];
    expect(entry?.current?.id).not.toBe(first);
    expect(entry?.revisions.map((revision) => revision.id)).toEqual([first, entry?.current?.id]);
    expect(entry?.stale).toBe(false);

    const next = transcript(s.h, contentId, ["新一", "新二"]);
    expect(s.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId))?.primaryTranscriptRevisionId).toBe(next.revision.id);
    expect(s.h.translations.get(LOCAL, contentId).translations[0]).toMatchObject({ stale: true, staleReason: "transcript_changed" });
  });

  it("refuses a translated base revision and waits for a model when none was chosen", async () => {
    const s = setup();
    const contentId = createLocalContent(s.h);
    const base = transcript(s.h, contentId, ["一"]);
    answerAll(s.fake, 1);
    expect(await settled(s.h, translate(s, contentId, base.revision.id, ["en"]))).toBe("succeeded");
    const translated = s.h.translations.get(LOCAL, contentId).translations[0]?.current?.id as string;
    const bad = translate(s, contentId, translated, ["fr"]);
    expect(await settled(s.h, bad)).toBe("failed");
    expect(stageRunsOf(s.h, bad).at(-1)?.error).toMatchObject({ class: "internal" });

    const unbound = createTaskOfKind(s.h, "translate", { targetLanguages: ["fr"], baseRevisionId: base.revision.id }, { contentId });
    s.h.scheduler.kick();
    await waitFor(() => stageStatuses(s.h, unbound).translate === "waiting_configuration");
  });

  describe("custom prompts", () => {
    const CUSTOM = `${TRANSLATE_SUBTITLES_PROMPT.text}\n自定义标记：译文口语化。`;

    it("a custom translate.subtitles prompt is sent, its numbered answer parsed, and recorded on the generation", async () => {
      const s = setup();
      s.h.prompts.update(LOCAL, "translate.subtitles", { text: CUSTOM });
      const contentId = createLocalContent(s.h);
      transcript(s.h, contentId, ["第一句", "第二句"]);
      s.fake.script({ events: reply("1. first\n2. second") });
      const accepted = await s.h.derivedTasks.translate(LOCAL, contentId, { modelRef: s.modelRef, targetLanguages: ["en"] });
      expect(await settled(s.h, accepted.body.taskId)).toBe("succeeded");

      const current = s.h.translations.get(LOCAL, contentId).translations[0]?.current;
      const generation = current?.generation as { promptRef: unknown; promptRefs: unknown; promptSnapshot: string };
      const ref = customPromptRef("translate.subtitles", 1);
      expect(generation.promptRef).toEqual(ref);
      expect(generation.promptRefs).toEqual([ref]);
      expect(generation.promptSnapshot).toContain("自定义标记：译文口语化。");
      expect(generation.promptSnapshot.startsWith("请将以下字幕翻译成 英语。")).toBe(true);
      const sent = promptText(s.fake.calls[0]?.request as LlmRequest);
      expect(sent).toBe(renderPrompt(generation.promptSnapshot, { count: "2", subtitles: "1. 第一句\n2. 第二句" }));
      expect(sent).toContain("自定义标记：译文口语化。");
      expect(translatedSegments(s.h, current?.id as string).map((segment) => segment.text)).toEqual(["first", "second"]);
    });
  });
});
