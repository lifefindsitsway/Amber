import { afterEach, describe, expect, it } from "vitest";
import { resolveSpeakerContext } from "../../../src/server/application/speaker-context.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import {
  CHAPTER_AI_PROMPT,
  ROLLUP_PARTIAL_PROMPT,
  SPEAKER_LINES_FRAGMENT,
  SPEAKER_RULES_FRAGMENT,
  SUMMARY_ENVELOPE_PROMPT,
} from "../../../src/server/domain/prompts.ts";
import { attributionDigest } from "../../../src/server/domain/speaker-context.ts";
import { estimateTokens } from "../../../src/server/domain/token-estimate.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import { CONTEXT_SAFETY_RATIO, SPEAKER_NAME_MAX_GRAPHEMES } from "../../../src/shared/defaults.ts";
import type { FakeLlmProvider } from "../../fixtures/llm/fake-llm.ts";
import { createTaskOfKind, LOCAL, stageRunsOf, workUnitsOf, type Harness } from "../../fixtures/pipeline/harness.ts";
import {
  FIXED_CONTENT_ID,
  FIXED_REVISION_ID,
  fixedSpeakerId,
  kindOf,
  lineAliases,
  MAX_OUTPUT,
  promptOf,
  scriptedProvider,
  seedContent,
  setRoom,
  settle,
  sha256,
  speakerHarness,
  traffic,
  validAnswer,
  windowFor,
  type Answer,
  type SeedOptions,
} from "../../fixtures/pipeline/speaker-context.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

type Scenario = "summary_single" | "summary_rolling" | "chapters" | "highlights";

/** Input rooms that make each scenario take its intended shape on the fixed lecture. */
const ROOMS: Record<Scenario, number> = { summary_single: 100_000, summary_rolling: 5_000, chapters: 2_500, highlights: 2_500 };
const STAGES: Record<Scenario, string> = { summary_single: "summary", summary_rolling: "summary", chapters: "chapter", highlights: "highlight" };

/** Submits the scenario's Task through its service, as the API does. */
async function submit(h: Harness, scenario: Scenario, contentId: string, modelRef: ModelRef): Promise<string> {
  switch (scenario) {
    case "summary_single":
    case "summary_rolling":
      return (await h.summaries.create(LOCAL, contentId, { templateId: "summary.core", modelRef })).body.taskId;
    case "chapters":
      return (await h.derivedTasks.regenerateChapters(LOCAL, contentId, { modelRef })).body.taskId;
    case "highlights":
      return (await h.derivedTasks.recomputeHighlights(LOCAL, contentId, { modelRef })).body.taskId;
  }
}

/** A Task queued before speakers were read: its request has no `speakerContext`, whatever the transcript's state now. */
function submitLegacy(h: Harness, scenario: Scenario, contentId: string, modelRef: ModelRef, frozen?: Record<string, { id: string; version: number }>): string {
  const base = { modelRef, baseRevisionId: FIXED_REVISION_ID, outputLanguage: "zh-CN", ...(frozen === undefined ? {} : { promptRefs: frozen }) };
  switch (scenario) {
    case "summary_single":
    case "summary_rolling":
      return createTaskOfKind(h, "regenerate_summary", { ...base, templateRef: { id: "summary.core", version: templateVersion(h) } }, { contentId });
    case "chapters":
      return createTaskOfKind(h, "regenerate_chapters", base, { contentId });
    case "highlights":
      return createTaskOfKind(h, "recompute_highlights", base, { contentId });
  }
}

function templateVersion(h: Harness): number {
  return h.repository.withTransaction((scope) => scope.summaryTemplates.get(LOCAL.userId, "summary.core")?.currentVersion as number);
}

/** What a run changes besides the seed: the model's answers, and anything set up on the Content before submission. */
interface Variant {
  answer?: Answer;
  setup?: (h: Harness) => void;
  room?: number;
}

async function run(
  scenario: Scenario,
  seed: SeedOptions,
  how: "service" | "legacy" | "v2" = "service",
  variant: Variant = {},
): Promise<{ hash: string; fake: FakeLlmProvider; requests: string[] }> {
  const fake = scriptedProvider(variant.answer);
  const { h, modelRef } = speakerHarness(fake, variant.room ?? ROOMS[scenario]);
  open.push(h);
  const { contentId } = seedContent(h, seed);
  variant.setup?.(h);
  const taskId = how === "service" ? await submit(h, scenario, contentId, modelRef) : submitLegacy(h, scenario, contentId, modelRef, how === "v2" ? V2_PROMPTS : undefined);
  h.scheduler.kick();
  expect(await settle(h, taskId, STAGES[scenario])).toBe("succeeded");
  const sent = traffic(h, fake, taskId);
  return { hash: sha256(JSON.stringify(sent)), fake, requests: sent.requests };
}

/**
 * The chapter and highlight prompts as they were before their counts were capped: a Task that
 * froze them must send exactly what it always did, so their old traffic stays pinned below.
 */
const V2_PROMPTS = { "chapter.ai": { id: "chapter.ai", version: 2 }, "highlight.default": { id: "highlight.default", version: 2 } };

const NONE: SeedOptions = {};
/** Two named speakers (one name confirmed) and unassigned sentences, never reviewed. */
const UNREVIEWED: SeedOptions = {
  speakers: [{ name: "蒋炎岩", confirmed: true }, { name: "张伟" }],
  assign: (position) => (position % 7 === 6 ? undefined : Math.floor(position / 5) % 2),
};
/** Reviewed, but one anonymous speaker is not speaker mode. */
const REVIEWED_NOT_SPEAKER_MODE: SeedOptions = { speakers: [{}], assign: () => 0, reviewed: true };
const REVIEWED: SeedOptions = { ...UNREVIEWED, reviewed: true };

/**
 * The exact traffic of each scenario on the fixed lecture without speakers, captured from
 * the stages before they could read speakers: a request that reads none must stay
 * byte-identical to it, units digests included.
 */
const BASELINE: Record<Scenario, string> = {
  summary_single: "52179be9deb09b8d93352323e47e443f721ec859a7ca28bab67b2a4bfd36c0d2",
  summary_rolling: "6692027f6154624e9eef08c7a310065ac8c3a075c5db2b907dbb7ba7bc077d55",
  chapters: "573cf23d3d750f7a205220863d7cd2e33ca3f4e553348b7d709814165678ce29",
  highlights: "21be89339100534524481e9bb276a841b00b5f5b98e3946b6cdcc2bc91d2041c",
};

/** The same traffic for chapters and highlights frozen on their earlier prompts, captured before the counts were capped. */
const V2_BASELINE: Partial<Record<Scenario, string>> = {
  chapters: "832beeda1324080ed437ffd28192d6dd1634dcb24a8c9016b72f6fc09bf44253",
  highlights: "253319a2ecc7f9d3523be60790d80f2103c78f7ebc0693e903e23a3fe448c814",
};

describe("requests that read no speakers", () => {
  for (const scenario of ["summary_single", "summary_rolling", "chapters", "highlights"] as const) {
    it(`${scenario}: byte-identical without speakers, unreviewed, outside speaker mode and for a request queued without a snapshot`, async () => {
      const none = await run(scenario, NONE);
      if (scenario === "summary_rolling") {
        expect(none.fake.calls.map((call) => kindOf(call.request)).filter((kind) => kind === "partial").length).toBeGreaterThan(1);
      }
      if (scenario === "chapters" || scenario === "highlights") {
        expect(none.requests.length).toBeGreaterThan(1);
        // Several windows under the capped prompts end in one merge or selection over the candidates.
        expect(none.requests.filter((request) => request.includes(scenario === "chapters" ? "【候选章节】" : "【候选片段】"))).toHaveLength(1);
      }
      expect(none.requests.join("\n")).not.toContain("【发言人");
      expect((await run(scenario, UNREVIEWED)).hash).toBe(none.hash);
      expect((await run(scenario, REVIEWED_NOT_SPEAKER_MODE)).hash).toBe(none.hash);
      expect((await run(scenario, REVIEWED, "legacy")).hash).toBe(none.hash);
      expect(none.hash).toBe(BASELINE[scenario]);
      const v2 = V2_BASELINE[scenario];
      if (v2 !== undefined) expect((await run(scenario, NONE, "v2")).hash).toBe(v2);
    });
  }
});

/** Platform chapters over the fixed lecture, current for the Content: the rolling summary then groups by them. */
function platformChapters(h: Harness): void {
  h.repository.withTransaction((scope) => {
    const { revisionId } = scope.chapters.insertPlatformRevision(LOCAL.userId, FIXED_CONTENT_ID, {
      id: "01JCHAPTERREV0000000000000",
      artifactId: "01JCHAPTERART0000000000000",
      chapters: [
        { startMs: 0, endMs: 40_000, title: "检索增强生成的动机" },
        { startMs: 40_000, endMs: 80_000, title: "索引与召回" },
        { startMs: 80_000, endMs: 120_000, title: "生成与引用" },
      ],
      createdAt: 3,
    });
    scope.chapters.setCurrent(LOCAL.userId, FIXED_CONTENT_ID, revisionId);
  });
}

/** The model supports structured output: chapters and highlights then ask for their JSON schema. */
function structuredOutput(h: Harness): void {
  const flags = { stream: "unknown", tools: "unknown", structuredOutput: "supported", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
  h.db.prepare("UPDATE model_capability SET flags_declared_json = ?").run(JSON.stringify(flags));
}

/** Summaries and partials that cite sentences that do not exist, so every one of them goes through a citation repair. */
const uncitable: Answer = (kind, request) => {
  switch (kind) {
    case "envelope":
      return "## 摘要\n讲了 RAG [[s9001]] [[s9002]]。";
    case "partial":
      return "本组讲了 [[s9001]]";
    default:
      return validAnswer(kind, request);
  }
};

/** Three platform chapters whose titles are long enough to matter near the budget's edge. */
function longTitledChapters(h: Harness): void {
  h.repository.withTransaction((scope) => {
    const { revisionId } = scope.chapters.insertPlatformRevision(LOCAL.userId, FIXED_CONTENT_ID, {
      id: "01JCHAPTERREV0000000000000",
      artifactId: "01JCHAPTERART0000000000000",
      chapters: [0, 1, 2].map((index) => ({ startMs: index * 40_000, endMs: (index + 1) * 40_000, title: `${index}${"长".repeat(40)}` })),
      createdAt: 3,
    });
    scope.chapters.setCurrent(LOCAL.userId, FIXED_CONTENT_ID, revisionId);
  });
}

type ExtraScenario =
  | "chapters_structured"
  | "highlights_structured"
  | "summary_rolling_by_chapters"
  | "summary_single_repaired"
  | "summary_rolling_repaired"
  | "summary_rolling_long_titles_tight"
  | "summary_rolling_long_titles_edge";

const EXTRA: Record<ExtraScenario, { scenario: Scenario; variant: Variant }> = {
  chapters_structured: { scenario: "chapters", variant: { setup: structuredOutput } },
  highlights_structured: { scenario: "highlights", variant: { setup: structuredOutput } },
  summary_rolling_by_chapters: { scenario: "summary_rolling", variant: { setup: platformChapters } },
  summary_single_repaired: { scenario: "summary_single", variant: { answer: uncitable } },
  summary_rolling_repaired: { scenario: "summary_rolling", variant: { answer: uncitable } },
  // Rooms where pricing the chapter titles would split chapters into more groups: without
  // speakers the titles are not priced, so the groups stay as they always were.
  summary_rolling_long_titles_tight: { scenario: "summary_rolling", variant: { setup: longTitledChapters, room: 3_200 } },
  summary_rolling_long_titles_edge: { scenario: "summary_rolling", variant: { setup: longTitledChapters, room: 3_600 } },
};

/**
 * The exact traffic of structured output, rolling by chapters and citation repair without
 * speakers, captured before the stages' budget re-check moved ahead of every call: it must
 * stay byte-identical, units digests included.
 */
const EXTRA_BASELINE: Record<ExtraScenario, string> = {
  chapters_structured: "fe3e7db4cc72207dfa740d9a9131b7b6ecade36a5f7dbb173ee3a9045d14f886",
  highlights_structured: "a6dbf39f125adec2b293223b8849621462d8f3ee90838a7be39832f11cc9bafe",
  summary_rolling_by_chapters: "db821ceb77da39f7898d72045669a0590d1399033bfdfacc59061e2bf86c8c6a",
  summary_single_repaired: "d39f5d4b2d3065a3f632253c03262b5c533b93a7f786f740b53d64a23b8160e5",
  summary_rolling_repaired: "3325cb5cabe56c55ce2cdfe26656697ad7d90a9170238d13575d0ff278477706",
  summary_rolling_long_titles_tight: "ea2a0e82893466aaab82eef6617853c3b84a0644e3d65460ec017d420760236f",
  summary_rolling_long_titles_edge: "10880aef03537961c3e999970ef3b6b9353398c36111a14b8252c9af09a819fe",
};

/** Structured chapters and highlights frozen on their earlier prompts, captured before the counts were capped. */
const V2_EXTRA_BASELINE: Partial<Record<ExtraScenario, string>> = {
  chapters_structured: "b6b97183094c5ddbf171c8ba7cb6f273d74b424b7b940f8612a7ccfebccb7026",
  highlights_structured: "020c04c231ef2859f38aa12949e33840484fb04ac856836b387866acfb0f8c7a",
};

describe("more requests that read no speakers", () => {
  for (const [name, { scenario, variant }] of Object.entries(EXTRA) as Array<[ExtraScenario, (typeof EXTRA)[ExtraScenario]]>) {
    it(`${name}: byte-identical without speakers, unreviewed, outside speaker mode and for a request queued without a snapshot`, async () => {
      const none = await run(scenario, NONE, "service", variant);
      const prompts = none.fake.calls.map((call) => kindOf(call.request));
      if (name.endsWith("_structured")) {
        expect(none.fake.calls.every((call) => call.request.responseFormat?.type === "json_schema")).toBe(true);
      }
      if (name.endsWith("_repaired")) {
        expect(prompts).toContain("repair");
      }
      if (name === "summary_rolling_by_chapters") {
        expect(none.requests.join("\n")).toContain("【章节】索引与召回");
        expect(prompts.filter((kind) => kind === "partial").length).toBeGreaterThan(1);
      }
      expect(none.requests.join("\n")).not.toContain("【发言人");
      expect((await run(scenario, UNREVIEWED, "service", variant)).hash).toBe(none.hash);
      expect((await run(scenario, REVIEWED_NOT_SPEAKER_MODE, "service", variant)).hash).toBe(none.hash);
      expect((await run(scenario, REVIEWED, "legacy", variant)).hash).toBe(none.hash);
      expect(none.hash).toBe(EXTRA_BASELINE[name]);
      const v2 = V2_EXTRA_BASELINE[name];
      if (v2 !== undefined) expect((await run(scenario, NONE, "v2", variant)).hash).toBe(v2);
    });
  }
});

const ALL: SeedOptions = {
  // Speaker 3 is registered on the Content but named by no sentence of the revision.
  speakers: [{ name: "蒋炎岩", confirmed: true }, { name: "张伟" }, { name: "王五", confirmed: true }],
  assign: (position) => (position % 7 === 6 ? undefined : Math.floor(position / 5) % 2),
  reviewed: true,
};

function idle(seed: SeedOptions): { h: Harness; modelRef: ModelRef; fake: FakeLlmProvider; segments: TranscriptSegment[] } {
  const fake = scriptedProvider();
  const { h, modelRef } = speakerHarness(fake, ROOMS.chapters, { start: false });
  open.push(h);
  const { segments } = seedContent(h, seed);
  return { h, modelRef, fake, segments };
}

const resolve = (h: Harness, reading: "transcript" | "lines" = "transcript") =>
  h.repository.withTransaction((scope) => resolveSpeakerContext(scope, LOCAL.userId, FIXED_CONTENT_ID, FIXED_REVISION_ID, reading));

describe("resolveSpeakerContext", () => {
  it("gives the reviewed revision's speakers in speaker mode: only those it names, by ordinal, with their labels and digest", () => {
    const { h, segments } = idle(ALL);
    expect(resolve(h)).toEqual({
      version: 1,
      rules: SPEAKER_RULES_FRAGMENT.ref,
      attributionDigest: attributionDigest(segments),
      speakers: [
        { id: fixedSpeakerId(0), ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" },
        { id: fixedSpeakerId(1), ordinal: 2, label: "发言人 2" },
      ],
    });
    expect(resolve(h, "lines")?.rules).toEqual(SPEAKER_LINES_FRAGMENT.ref);
  });

  it("gives nothing for an unreviewed revision or outside speaker mode", () => {
    expect(resolve(idle(UNREVIEWED).h)).toBeUndefined();
    expect(resolve(idle(REVIEWED_NOT_SPEAKER_MODE).h)).toBeUndefined();
    expect(resolve(idle({ ...NONE, reviewed: true }).h)).toBeUndefined();
  });

  it("reads a single named speaker by speaker, as the reading view does, with its number while the name is unconfirmed", () => {
    const { h } = idle({ speakers: [{ name: "蒋炎岩" }], assign: () => 0, reviewed: true });
    expect(resolve(h)?.speakers).toEqual([{ id: fixedSpeakerId(0), ordinal: 1, label: "发言人 1" }]);
  });
});

function requestOf(h: Harness, taskId: string): Record<string, unknown> {
  return JSON.parse(h.repository.withTransaction((scope) => scope.tasks.get(LOCAL.userId, taskId)?.requestJson) as string) as Record<string, unknown>;
}

describe("freezing at submission", () => {
  it("puts the snapshot into every derived Task that reads the reviewed primary, with the rules its stages use", async () => {
    const { h, modelRef } = idle(ALL);
    const transcript = resolve(h);
    const lines = resolve(h, "lines");
    expect(transcript).toBeDefined();
    const summary = (await h.summaries.create(LOCAL, FIXED_CONTENT_ID, { templateId: "summary.core", modelRef })).body.taskId;
    const chapters = (await h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    const highlights = (await h.derivedTasks.recomputeHighlights(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    const proofread = (await h.derivedTasks.proofread(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    const translate = (await h.derivedTasks.translate(LOCAL, FIXED_CONTENT_ID, { targetLanguages: ["en"], modelRef })).body.taskId;
    expect(requestOf(h, summary)["speakerContext"]).toEqual(transcript);
    expect(requestOf(h, chapters)["speakerContext"]).toEqual(transcript);
    expect(requestOf(h, highlights)["speakerContext"]).toEqual(transcript);
    expect(requestOf(h, proofread)["speakerContext"]).toEqual(lines);
    expect(requestOf(h, translate)["speakerContext"]).toEqual(lines);
  });

  it("adds nothing to the request when the primary is not reviewed", async () => {
    const { h, modelRef } = idle(UNREVIEWED);
    const tasks = [
      (await h.summaries.create(LOCAL, FIXED_CONTENT_ID, { templateId: "summary.core", modelRef })).body.taskId,
      (await h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId,
      (await h.derivedTasks.recomputeHighlights(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId,
      (await h.derivedTasks.proofread(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId,
      (await h.derivedTasks.translate(LOCAL, FIXED_CONTENT_ID, { targetLanguages: ["en"], modelRef })).body.taskId,
    ];
    for (const taskId of tasks) {
      expect(requestOf(h, taskId)).not.toHaveProperty("speakerContext");
    }
  });

  it("refuses a Task whose frozen prompt lost the slot the speakers ride in, only when it would read speakers", async () => {
    for (const [seed, refused] of [
      [ALL, true],
      [UNREVIEWED, false],
    ] as const) {
      const { h, modelRef } = idle(seed);
      h.repository.withTransaction((scope) =>
        scope.promptOverrides.addVersion({
          userId: LOCAL.userId,
          promptId: "chapter.ai",
          version: 1,
          text: CHAPTER_AI_PROMPT.text.replace("{{transcript_with_aliases}}", ""),
          createdAt: 1,
        }),
      );
      const attempt = h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef });
      if (refused) {
        await expect(attempt).rejects.toMatchObject({
          appError: { code: "invalid_request.prompt_protocol", details: { missing: ["{{transcript_with_aliases}}"], unknown: [] } },
        });
      } else {
        await expect(attempt).resolves.toMatchObject({ status: 202 });
      }
    }
  });

  it("refuses a summary whose frozen envelope or rolling partial prompt lost its transcript slot, naming each", async () => {
    for (const [promptId, text, slot] of [
      ["summary.envelope", SUMMARY_ENVELOPE_PROMPT.text, "{{transcript_with_aliases}}"],
      ["rollup.partial", ROLLUP_PARTIAL_PROMPT.text, "{{group_content}}"],
    ] as const) {
      for (const [seed, refused] of [
        [ALL, true],
        [UNREVIEWED, false],
      ] as const) {
        const { h, modelRef } = idle(seed);
        h.repository.withTransaction((scope) =>
          scope.promptOverrides.addVersion({ userId: LOCAL.userId, promptId, version: 1, text: text.replace(slot, ""), createdAt: 1 }),
        );
        const attempt = h.summaries.create(LOCAL, FIXED_CONTENT_ID, { templateId: "summary.core", modelRef });
        if (refused) {
          await expect(attempt).rejects.toMatchObject({ appError: { code: "invalid_request.prompt_protocol", details: { missing: [slot], unknown: [] } } });
        } else {
          await expect(attempt).resolves.toMatchObject({ status: 202 });
        }
      }
    }
  });

  it("keeps the labels of submission: a rename and a withdrawn review before the run change nothing that is sent or recorded", async () => {
    const { h, modelRef, fake } = idle(ALL);
    const frozen = resolve(h);
    const taskId = (await h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    h.repository.withTransaction((scope) => {
      scope.speakers.update(LOCAL.userId, FIXED_CONTENT_ID, fixedSpeakerId(0), { name: "新名字", nameConfirmedAt: 99 }, 99);
      scope.speakers.update(LOCAL.userId, FIXED_CONTENT_ID, fixedSpeakerId(1), { name: "改名", nameConfirmedAt: 99 }, 99);
      scope.speakerConfirmations.set(LOCAL.userId, FIXED_CONTENT_ID, FIXED_REVISION_ID, undefined);
    });
    h.scheduler.start();
    expect(await settle(h, taskId, "chapter")).toBe("succeeded");
    const sent = fake.calls.map((call) => JSON.stringify(call.request)).join("\n");
    expect(sent).toContain("【发言人】蒋炎岩");
    expect(sent).toContain("【发言人】发言人 2");
    expect(sent).not.toContain("新名字");
    expect(sent).not.toContain("改名");
    const current = h.repository.withTransaction((scope) => scope.chapters.getCurrent(LOCAL.userId, FIXED_CONTENT_ID));
    expect(current?.provenance.speakerContext).toEqual(frozen);
    // The rename did not reach the frozen snapshot: the request still holds it as submitted.
    expect(requestOf(h, taskId)["speakerContext"]).toEqual(frozen);
    expect(frozen?.speakers.find((speaker) => speaker.id === fixedSpeakerId(0))).toEqual({ id: fixedSpeakerId(0), ordinal: 1, name: "蒋炎岩", label: "蒋炎岩" });
  });

  it("reads the revision and speakers of submission after the primary moved to another reviewed revision", async () => {
    const { h, modelRef, fake } = idle(ALL);
    setRoom(h, ROOMS.summary_rolling);
    const frozen = resolve(h);
    const summary = (await h.summaries.create(LOCAL, FIXED_CONTENT_ID, { templateId: "summary.core", modelRef })).body.taskId;
    const chapters = (await h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    const highlights = (await h.derivedTasks.recomputeHighlights(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    const other = anotherReviewedPrimary(h);
    expect(h.repository.withTransaction((scope) => resolveSpeakerContext(scope, LOCAL.userId, FIXED_CONTENT_ID, other, "transcript"))?.speakers.map((speaker) => speaker.label)).toEqual([
      "王五",
    ]);
    h.scheduler.start();
    expect(await settle(h, summary, "summary")).toBe("succeeded");
    expect(await settle(h, chapters, "chapter")).toBe("succeeded");
    expect(await settle(h, highlights, "highlight")).toBe("succeeded");

    const sent = fake.calls.map((call) => promptOf(call.request)).join("\n");
    expect(sent).toContain("【发言人】蒋炎岩");
    expect(sent).not.toContain("另一版");
    expect(sent).not.toContain("王五");
    const summaryRevisionId = JSON.parse(stageRunsOf(h, summary).at(-1)?.resultJson ?? "{}").revisionId as string;
    const read = h.repository.withTransaction((scope) => {
      const highlightArtifact = scope.highlights.getArtifact(LOCAL.userId, FIXED_CONTENT_ID);
      return {
        summary: scope.summaries.getRevision(LOCAL.userId, summaryRevisionId),
        chapters: scope.chapters.getCurrent(LOCAL.userId, FIXED_CONTENT_ID),
        highlights: scope.highlights.getRevision(LOCAL.userId, highlightArtifact?.currentRevisionId as string),
      };
    });
    for (const revision of [read.summary, read.chapters, read.highlights]) {
      expect(revision?.provenance.speakerContext).toEqual(frozen);
      expect(revision?.provenance.inputs[0]).toEqual({ kind: "transcriptRevision", id: FIXED_REVISION_ID });
    }
  });
});

/**
 * A second revision of the fixed Content, its sentences all by a third speaker whose name is
 * confirmed, reviewed and made primary; returns its id.
 */
function anotherReviewedPrimary(h: Harness): string {
  const id = h.newId();
  const speakerId = fixedSpeakerId(2);
  const segments: TranscriptSegment[] = Array.from({ length: 10 }, (_, ordinal) => ({
    id: h.newId() as TranscriptSegment["id"],
    revisionId: id,
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text: `另一版第${ordinal + 1}句。`,
    sourceSegmentIds: [],
    speakerId,
  }));
  const revision: TranscriptRevision = {
    id,
    contentId: FIXED_CONTENT_ID,
    kind: "imported",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "imported", format: "srt" },
    segmentCount: segments.length,
    createdAt: 50,
  };
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, FIXED_CONTENT_ID, id, 51);
    scope.speakerConfirmations.set(LOCAL.userId, FIXED_CONTENT_ID, id, 52);
  });
  return id;
}

describe("retrying a Task that reads speakers", () => {
  /** Chapter windows after the first answer in prose while `broken`, so the stage fails with only its first window done. */
  function brokenAfterFirst(): { answer: Answer; fix: () => void } {
    let broken = true;
    return {
      answer: (kind, request) => (kind === "chapter" && broken && lineAliases(request)[0] !== 1 ? "好的，以下是章节划分" : validAnswer(kind, request)),
      fix: () => {
        broken = false;
      },
    };
  }

  async function failedOnce(): Promise<{ h: Harness; modelRef: ModelRef; fake: FakeLlmProvider; taskId: string; fix: () => void }> {
    const { answer, fix } = brokenAfterFirst();
    const fake = scriptedProvider(answer);
    const { h, modelRef } = speakerHarness(fake, ROOMS.chapters, { start: false });
    open.push(h);
    seedContent(h, ALL);
    const taskId = (await h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    h.scheduler.start();
    expect(await settle(h, taskId, "chapter")).toBe("failed");
    return { h, modelRef, fake, taskId, fix };
  }

  /** Calls that sent the first window with the name frozen at submission. */
  const firstWindowCalls = (fake: FakeLlmProvider) =>
    fake.calls.filter((call) => lineAliases(call.request)[0] === 1 && promptOf(call.request).includes("【发言人】蒋炎岩")).length;
  const firstWindowUnits = (h: Harness, taskId: string) => workUnitsOf(h, taskId).filter((unit) => unit.key === "chapter:window:0");

  it("reuses a window done under the same snapshot without sending it again", async () => {
    const { h, fake, taskId, fix } = await failedOnce();
    expect(firstWindowCalls(fake)).toBe(1);
    fix();
    h.tasks.retryStage(LOCAL, taskId, { stage: "chapter" });
    expect(await settle(h, taskId, "chapter")).toBe("succeeded");
    expect(firstWindowCalls(fake)).toBe(1);
    const units = firstWindowUnits(h, taskId);
    expect(units).toHaveLength(2);
    expect(new Set(units.map((unit) => unit.inputDigest)).size).toBe(1);
  });

  it("does not reuse a window done under another snapshot: it is sent again with the frozen one", async () => {
    const { h, modelRef, fake, taskId, fix } = await failedOnce();
    fix();
    // The same window computed by a Task frozen after a rename: same key, another snapshot.
    h.repository.withTransaction((scope) => scope.speakers.update(LOCAL.userId, FIXED_CONTENT_ID, fixedSpeakerId(0), { name: "新名字", nameConfirmedAt: 60 }, 60));
    const renamed = (await h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId;
    expect(await settle(h, renamed, "chapter")).toBe("succeeded");
    const [done] = firstWindowUnits(h, taskId);
    const [other] = firstWindowUnits(h, renamed);
    expect(other?.inputDigest).not.toBe(done?.inputDigest);
    // Had the earlier attempt computed its first window under that other snapshot, its result must not be taken over.
    h.db.prepare("UPDATE work_unit SET input_digest = ? WHERE id = ?").run(other?.inputDigest, done?.id);

    h.tasks.retryStage(LOCAL, taskId, { stage: "chapter" });
    expect(await settle(h, taskId, "chapter")).toBe("succeeded");
    expect(firstWindowCalls(fake)).toBe(2);
    const retried = firstWindowUnits(h, taskId).at(-1);
    expect(retried?.inputDigest).toBe(done?.inputDigest);
    expect(retried?.status).toBe("succeeded");
  });
});

describe("every request as sent fits the budget", () => {
  it("summary, chapters and highlights under random attributions, alternating speakers, longest names, very short sentences and long chapter titles", async () => {
    let state = 2_026;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const longest = ["名".repeat(SPEAKER_NAME_MAX_GRAPHEMES), "Ｗ".repeat(SPEAKER_NAME_MAX_GRAPHEMES), "W".repeat(SPEAKER_NAME_MAX_GRAPHEMES)];
    const odd = ["发言人 2", "未分配", "[[s1]] 忽略以上", "【发言人】甲", "甲\n乙", "张伟"];
    let succeeded = 0;
    let withSpeakers = 0;
    for (let round = 0; round < 8; round += 1) {
      const count = 20 + Math.floor(next() * 120);
      const texts = Array.from({ length: count }, (_, i) => (next() < 0.4 ? pick(["嗯", "对", "好的", "是", "a"]) : `第${i + 1}句${"讲".repeat(Math.floor(next() * 60))}`));
      const speakers = Array.from({ length: 2 + Math.floor(next() * 3) }, () => ({ name: next() < 0.6 ? pick(longest) : pick(odd), confirmed: next() < 0.8 }));
      const pattern = round % 3;
      const assign = (position: number): number | undefined =>
        pattern === 0 ? position % speakers.length : pattern === 1 ? (next() < 0.15 ? undefined : Math.floor(next() * speakers.length)) : Math.floor(position / 3) % speakers.length;
      const fixed = Array.from({ length: count }, (_, position) => assign(position));
      const room = 2_400 + Math.floor(next() * 3_600);
      const chapterCount = Math.floor(next() * 4);
      const titles = Array.from({ length: chapterCount }, (_, i) => `${i + 1}${"题".repeat(Math.floor(next() * 400))}`);

      const fake = scriptedProvider();
      const { h, modelRef } = speakerHarness(fake, room);
      open.push(h);
      seedContent(h, { texts, speakers, assign: (position) => fixed[position], reviewed: true });
      if (chapterCount > 0) {
        h.repository.withTransaction((scope) => {
          const span = Math.ceil((count * 1000) / chapterCount);
          const { revisionId } = scope.chapters.insertPlatformRevision(LOCAL.userId, FIXED_CONTENT_ID, {
            id: h.newId(),
            artifactId: h.newId(),
            chapters: titles.map((title, i) => ({ startMs: i * span, endMs: (i + 1) * span, title })),
            createdAt: 1,
          });
          scope.chapters.setCurrent(LOCAL.userId, FIXED_CONTENT_ID, revisionId);
        });
      }
      const snapshot = resolve(h);
      if (snapshot !== undefined) withSpeakers += 1;
      // The summary runs first, against the platform chapters; the windows then read the same revision.
      const runs: Array<[string, string]> = [["summary", (await h.summaries.create(LOCAL, FIXED_CONTENT_ID, { templateId: "summary.core", modelRef })).body.taskId]];
      expect(["succeeded", "failed"]).toContain(await settle(h, runs[0]?.[1] as string, "summary"));
      runs.push(["chapter", (await h.derivedTasks.regenerateChapters(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId]);
      runs.push(["highlight", (await h.derivedTasks.recomputeHighlights(LOCAL, FIXED_CONTENT_ID, { modelRef })).body.taskId]);
      for (const [stage, taskId] of runs) {
        const status = await settle(h, taskId, stage);
        if (status === "succeeded") {
          succeeded += 1;
        } else {
          expect(stageRunsOf(h, taskId).at(-1)?.error?.code).toBe("llm_capability.context_length");
        }
      }
      const budget = Math.floor(windowFor(room) * CONTEXT_SAFETY_RATIO) - MAX_OUTPUT;
      for (const call of fake.calls) {
        const prompt = promptOf(call.request);
        expect(estimateTokens(prompt)).toBeLessThanOrEqual(budget);
        // A repair, a chapter merge and a highlight selection carry candidates, not the transcript, and so no speaker lines.
        const candidates = prompt.includes("【候选章节】") || prompt.includes("【候选片段】");
        if (snapshot !== undefined && /^\[\[s\d+\]\] /m.test(prompt) && kindOf(call.request) !== "repair" && !candidates) {
          expect(prompt).toContain(SPEAKER_RULES_FRAGMENT.text);
          expect(prompt).toMatch(/^【发言人】/m);
        }
      }
    }
    expect(withSpeakers).toBe(8);
    expect(succeeded).toBeGreaterThanOrEqual(16);
  }, 60_000);
});
