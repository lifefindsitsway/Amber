import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { summarySpeakerContext } from "../../../src/server/application/artifact-speakers.ts";
import { resolveSpeakerContext } from "../../../src/server/application/speaker-context.ts";
import { SpeakerLineageReader } from "../../../src/server/application/speaker-lineage.ts";
import type { SummaryRevision } from "../../../src/server/domain/artifact.ts";
import type { ChatMessage, ChatSpeakerBasis } from "../../../src/server/domain/chat.ts";
import type { LlmRequest } from "../../../src/server/domain/llm.ts";
import { SPEAKER_CAUTION_FRAGMENT, SPEAKER_RULES_FRAGMENT, SPEAKER_UNVERIFIED_FRAGMENT } from "../../../src/server/domain/prompts.ts";
import type { SpeakerContextSnapshot } from "../../../src/server/domain/speaker-context.ts";
import type { TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { ChatMessageRequest, ChatStreamEvent } from "../../../src/shared/dto/chat.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { reply } from "../../fixtures/llm/fake-llm.ts";
import { drain, runGoldenScenario, type GoldenOptions, type GoldenScenario, type GoldenSpeakers } from "../../fixtures/pipeline/chat-golden.ts";
import { LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { FIXED_CONTENT_ID, FIXED_REVISION_ID, fixedSegmentId, fixedSpeakerId } from "../../fixtures/pipeline/speaker-context.ts";
import { MODEL_SNAPSHOT } from "../../fixtures/pipeline/summary-data.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function scenario(name: GoldenScenario, speakers: GoldenSpeakers, options: GoldenOptions = {}) {
  const outcome = await runGoldenScenario(name, speakers, options);
  open.push(outcome.h);
  return outcome;
}

const THREAD = "01JTHREAD00000000000000000";
const owner = LOCAL.userId;

const systemOf = (request: LlmRequest | undefined): string => request?.system ?? "";
const lastRequest = (fake: { calls: Array<{ request: LlmRequest }> }): LlmRequest => fake.calls.at(-1)?.request as LlmRequest;
const messages = (h: Harness): ChatMessage[] => h.repository.withTransaction((scope) => scope.chat.listMessages(owner, THREAD));
const lastAnswer = (h: Harness): ChatMessage => messages(h).filter((message) => message.role === "assistant").at(-1) as ChatMessage;
const snapshotNow = (h: Harness, revisionId = FIXED_REVISION_ID): SpeakerContextSnapshot | undefined =>
  h.repository.withTransaction((scope) => resolveSpeakerContext(scope, owner, FIXED_CONTENT_ID, revisionId, "transcript"));

function rename(h: Harness, name = "王五"): void {
  h.repository.withTransaction((scope) => scope.speakers.update(owner, FIXED_CONTENT_ID, fixedSpeakerId(0), { name, nameConfirmedAt: 9 }, 9));
}

function withdrawReview(h: Harness, revisionId = FIXED_REVISION_ID): void {
  h.repository.withTransaction((scope) => scope.speakerConfirmations.set(owner, FIXED_CONTENT_ID, revisionId, undefined));
}

let children = 0;
/**
 * A child of the fixed revision made the primary: every sentence comes from its counterpart
 * unless `edit` changes the list. Reviewed unless told otherwise; projected into the index.
 */
function child(h: Harness, edit: (segments: TranscriptSegment[]) => TranscriptSegment[] = (segments) => segments, reviewed = true): string {
  children += 1;
  const id = `01JREVCH1LD${String(children).padStart(15, "0")}`;
  const root = h.repository.withTransaction((scope) => scope.transcripts.listSegments(owner, FIXED_REVISION_ID));
  const copied = root.map((segment, index): TranscriptSegment => ({
    ...segment,
    id: `01JSEH${String(children * 1000 + index).padStart(20, "0")}` as SegmentId,
    revisionId: id,
    sourceSegmentIds: [segment.id],
  }));
  const segments = edit(copied).map((segment, ordinal) => ({ ...segment, ordinal }));
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(
      owner,
      {
        id,
        contentId: FIXED_CONTENT_ID,
        kind: "manual",
        parentRevisionId: FIXED_REVISION_ID,
        language: "zh-CN",
        timingFidelity: "inherited_segment",
        generation: { kind: "manual" },
        segmentCount: segments.length,
        createdAt: 20,
      },
      segments,
    );
    scope.contents.setPrimaryTranscript(owner, FIXED_CONTENT_ID, id, 21);
    if (reviewed) scope.speakerConfirmations.set(owner, FIXED_CONTENT_ID, id, 22);
    scope.search.syncContent(owner, FIXED_CONTENT_ID);
  });
  return id;
}

/** After the question was stored: another primary (every sentence now the second speaker's) and a renamed first speaker. */
function switchAndRename(h: Harness): void {
  rename(h);
  child(h, (segments) => segments.map((segment) => ({ ...segment, speakerId: fixedSpeakerId(1) })));
}

/** The default summary written with the speakers of the fixed revision, citing its first and 61st sentences. */
function speakerSummaryOf(h: Harness, body = "带发言人的总结"): void {
  h.repository.withTransaction((scope) => {
    const snapshot = resolveSpeakerContext(scope, owner, FIXED_CONTENT_ID, FIXED_REVISION_ID, "transcript") as SpeakerContextSnapshot;
    const { artifactId } = scope.summaries.insertRevision(owner, {
      contentId: FIXED_CONTENT_ID,
      templateId: "summary.core",
      artifactId: "01JSUMART00000000000000000",
      revision: {
        id: "01JSUMREVSPK00000000000000",
        provenance: {
          inputs: [{ kind: "transcriptRevision", id: FIXED_REVISION_ID }],
          modelRef: MODEL_SNAPSHOT,
          promptRef: { id: "summary.core", version: 1 },
          promptSnapshot: "<summary prompt>",
          speakerContext: snapshot,
          createdAt: 11,
        },
        quality: "normal",
        body: `## 摘要\n${body} [[seg:${fixedSegmentId(1)}]] [[seg:${fixedSegmentId(60)}]]`,
        citations: [
          { transcriptRevisionId: FIXED_REVISION_ID, segmentId: fixedSegmentId(1) },
          { transcriptRevisionId: FIXED_REVISION_ID, segmentId: fixedSegmentId(60) },
        ],
      },
    });
    scope.summaries.setCurrent(owner, artifactId, "01JSUMREVSPK00000000000000");
  });
}

describe("chat requests without speakers", () => {
  const golden = JSON.parse(readFileSync(new URL("../../fixtures/pipeline/chat-requests-golden.json", import.meta.url), "utf8")) as Record<
    string,
    { requests: string; chars: number; context: { mode: string; estimatedTokens?: number }; calls: number }
  >;

  for (const [key, expected] of Object.entries(golden)) {
    it(`sends exactly what it sent before: ${key}`, async () => {
      const [name, speakers] = key.split("/") as [GoldenScenario, GoldenSpeakers | undefined];
      const outcome = await scenario(name, speakers ?? "none");
      expect({ requests: outcome.requests, chars: outcome.chars, context: outcome.context, calls: outcome.fake.calls.length }).toEqual(expected);
      expect(outcome.events.some((event) => event.type === "context")).toBe(false);
      expect(lastAnswer(outcome.h).speakerContext).toBeUndefined();
      expect(lastAnswer(outcome.h).contextUsed).toBeUndefined();
    });
  }
});

describe("chat answers that read speakers", () => {
  it("frames the transcript, stores the snapshot on the answer and reports the mode", async () => {
    const { h, fake, events } = await scenario("full", "reviewed");
    const system = systemOf(lastRequest(fake));
    expect(system).toContain(`【资料】\n${SPEAKER_RULES_FRAGMENT.text}\n`);
    expect(system).toContain("【发言人】张三\n");
    expect(system).toContain("【发言人】李四\n");
    expect(system).toContain("【发言人】未分配\n");
    const answer = lastAnswer(h);
    expect(answer.speakerContext).toEqual(snapshotNow(h));
    expect(answer.speakerContext?.speakers.map((speaker) => speaker.label)).toEqual(["张三", "李四"]);
    expect(events.find((event) => event.type === "context")).toEqual({ type: "context", data: { mode: "full" } });
    expect(answer.contextUsed).toEqual({ mode: "full" });
    // The quoted sentence belongs to the revision read: it carries its header.
    const question = lastRequest(fake).messages.at(-1)?.content[0];
    expect(question?.type === "text" && question.text).toMatch(/^【用户选中的原文】\n【发言人】(张三|李四|未分配)\n\[\[s65\]\] /);
  });

  for (const branch of ["web", "compaction"] as const) {
    it(`keeps the transcript, labels and candidates it was sent with when the primary switches or a speaker is renamed mid-answer (${branch})`, async () => {
      const options: GoldenOptions = branch === "web" ? { window: 4_000 } : {};
      const control = await scenario(branch, "reviewed", options);
      const hook = (h: Harness) => {
        switchAndRename(h);
        // What the race used to do: the index now only knows the new primary.
        expect(h.repository.withTransaction((scope) => scope.search.matchSegments(owner, FIXED_REVISION_ID, "第5个要点讲了什么", 5))).toEqual([]);
      };
      const raced = await scenario(branch, "reviewed", branch === "web" ? { ...options, onSearch: hook } : { onCompaction: hook });
      expect(raced.fake.calls.length).toBe(control.fake.calls.length);
      const request = lastRequest(raced.fake);
      expect(JSON.stringify([request.system, request.messages])).toBe(JSON.stringify([lastRequest(control.fake).system, lastRequest(control.fake).messages]));
      expect(request.system).toContain("【相关片段】");
      expect(request.system).toContain("【发言人】张三");
      expect(request.system).not.toContain("王五");
      const answer = lastAnswer(raced.h);
      expect(answer.contextTranscriptRevisionId).toBe(FIXED_REVISION_ID);
      expect(answer.speakerContext).toEqual(lastAnswer(control.h).speakerContext);
      expect(answer.speakerContext?.speakers[0]?.label).toBe("张三");
    });
  }

  it("keeps the snapshot of a failed or interrupted answer; a retry takes a fresh one", async () => {
    const { h, fake, chat, contentId, modelRef } = await scenario("full", "reviewed");
    const before = snapshotNow(h);
    const body: ChatMessageRequest = { text: "再讲讲？", modelRef };

    fake.script({ events: [{ type: "done", stopReason: "error" }] });
    await drain(chat.send(LOCAL, contentId, body, undefined, new AbortController().signal));
    const failed = lastAnswer(h);
    expect(failed.status).toBe("failed");
    expect(failed.speakerContext).toEqual(before);

    const controller = new AbortController();
    fake.script({ events: reply("一段会被打断的很长的回答"), delayMs: 5 });
    const result = chat.send(LOCAL, contentId, { text: "还有呢？", modelRef }, undefined, controller.signal);
    if (result.kind !== "stream") throw new Error("expected a stream");
    for await (const event of result.events) {
      if (event.type === "answer.delta") controller.abort();
    }
    const interrupted = lastAnswer(h);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.speakerContext).toEqual(before);

    rename(h);
    await drain(chat.retry(LOCAL, contentId, interrupted.id, {}, "retry-key-1", new AbortController().signal));
    const retried = lastAnswer(h);
    expect(retried.replacesMessageId).toBe(interrupted.id);
    expect(retried.speakerContext).toEqual(snapshotNow(h));
    expect(retried.speakerContext?.speakers[0]?.label).toBe("王五");
    expect(systemOf(lastRequest(fake))).toContain("【发言人】王五");
  });

  it("asks about a named person in retrieval: speaker clips with a coverage line", async () => {
    const { fake, events } = await scenario("retrieval", "reviewed", { question: "张三怎么讲第5个要点？" });
    const system = systemOf(lastRequest(fake));
    expect(system).toMatch(/【发言人片段】张三 共 \d+ 轮发言，以下(为全部|选取 \d+ 轮，不是全部)/);
    const context = events.find((event): event is Extract<ChatStreamEvent, { type: "context" }> => event.type === "context");
    expect(context?.data.mode).toBe("retrieval");
    expect(context?.data.speakerClips === true).toBe(!system.includes("以下为全部"));
  });

  it("names nobody and hits are found: retrieves the same sentences as without speakers", async () => {
    /** Sentence texts under `from` up to `to`, aliases and header lines aside. */
    const sentences = (system: string, from: string, to: string): string[] => {
      const at = system.indexOf(from);
      const end = system.indexOf(to, at);
      return system
        .slice(at, end < 0 ? undefined : end)
        .split("\n")
        .filter((line) => line.startsWith("[[s"))
        .map((line) => line.replace(/^\[\[s\d+\]\] /, ""));
    };
    const options: GoldenOptions = { window: 7_000, question: "第37句讲了什么？" };
    const plain = systemOf(lastRequest((await scenario("retrieval", "none", options)).fake));
    const framed = await scenario("retrieval", "reviewed", options);
    const system = systemOf(lastRequest(framed.fake));
    expect(system).not.toContain("【发言人片段】");
    expect(framed.events.find((event) => event.type === "context")).toEqual({ type: "context", data: { mode: "retrieval" } });
    const hits = sentences(plain, "【相关片段】\n", "\n\n");
    expect(hits.length).toBeGreaterThan(10);
    expect(sentences(system, "【相关片段】\n", "\n\n")).toEqual(hits);
    // The current chapter's sentences are taken nearest first in both; header lines leave room for fewer.
    const chapter = sentences(plain, "【当前章节】", "【相关片段】");
    const framedChapter = sentences(system, "【当前章节】", "【相关片段】");
    expect(framedChapter.length).toBeGreaterThan(0);
    expect(framedChapter.every((line) => chapter.includes(line))).toBe(true);
  });

  it("shows under an answer who the speakers were once that no longer matches now", async () => {
    const { h, chat, contentId, modelRef } = await scenario("full", "reviewed");
    const shown = () => chat.get(LOCAL, contentId, modelRef).messages.filter((message) => message.role === "assistant");
    expect(shown().every((message) => message.speakerContext === undefined)).toBe(true);
    rename(h);
    const answer = shown().at(-1);
    expect(answer?.speakerContext).toEqual({
      state: "names_changed",
      speakers: [
        { id: fixedSpeakerId(0), label: "张三" },
        { id: fixedSpeakerId(1), label: "李四" },
      ],
      renamed: [{ id: fixedSpeakerId(0), was: "张三", now: "王五" }],
    });
    // Seeded answers read no speakers: nothing to show.
    expect(shown().slice(0, -1).every((message) => message.speakerContext === undefined)).toBe(true);
    child(h, (segments) => segments.map((segment, index) => (index === 1 ? { ...segment, speakerId: fixedSpeakerId(1) } : segment)));
    expect(shown().at(-1)?.speakerContext?.state).toBe("attribution_changed");
  });
});

describe("carrying the default summary", () => {
  const BODY = "带发言人的总结";

  const speakerSummary = (h: Harness): void => speakerSummaryOf(h, BODY);

  async function carried(change: (h: Harness) => void) {
    const outcome = await scenario("full", "reviewed", {
      wire: (h) => {
        speakerSummary(h);
        change(h);
      },
    });
    const system = systemOf(lastRequest(outcome.fake));
    const at = system.indexOf("【总结】\n");
    return { system, summary: at < 0 ? undefined : system.slice(at + "【总结】\n".length, system.indexOf("【逐字稿】")), context: outcome.context, outcome };
  }

  it("carries it as it is while its speakers hold", async () => {
    const { summary } = await carried(() => undefined);
    expect(summary).toMatch(new RegExp(`^## 摘要\\n${BODY} \\[\\[s2\\]\\] \\[\\[s61\\]\\]\\n$`));
  });

  it("names a renamed speaker before it", async () => {
    const { summary } = await carried(rename);
    expect(summary?.startsWith(`【改名】生成时为张三，现为王五\n## 摘要\n${BODY}`)).toBe(true);
  });

  it("puts the caution before it while the current primary is not reviewed (this answer reading no speakers)", async () => {
    const { summary, system } = await carried((h) => withdrawReview(h));
    expect(summary?.startsWith(`${SPEAKER_CAUTION_FRAGMENT.text}\n## 摘要\n${BODY}`)).toBe(true);
    expect(system).not.toContain(SPEAKER_RULES_FRAGMENT.text);
  });

  const omitted: Array<[string, (segments: TranscriptSegment[]) => TranscriptSegment[]]> = [
    ["a sentence changed hands", (segments) => segments.map((segment, index) => (index === 2 ? { ...segment, speakerId: fixedSpeakerId(1) } : segment))],
    ["a cited sentence was removed", (segments) => segments.filter((_segment, index) => index !== 60)],
    [
      "a sentence with a speaker has no source",
      (segments) => [...segments, { ...(segments.at(-1) as TranscriptSegment), id: "01JSEHNEW00000000000000000" as SegmentId, sourceSegmentIds: [], speakerId: fixedSpeakerId(0), startMs: 200_000, endMs: 200_500 }],
    ],
  ];
  for (const [why, edit] of omitted) {
    it(`leaves it out and says so when ${why}`, async () => {
      const { system, outcome } = await carried((h) => {
        child(h, edit);
      });
      expect(system).not.toContain(BODY);
      expect(system).not.toContain("【总结】");
      expect(outcome.chat.get(LOCAL, outcome.contentId, outcome.modelRef).context.summaryOmitted).toBe(true);
    });
  }

  it("judges a long summary by the sentences its partials cite too, exactly as the summary itself shows its state", async () => {
    const outcome = await scenario("full", "reviewed", {
      wire: (h) => {
        h.repository.withTransaction((scope) => {
          const snapshot = resolveSpeakerContext(scope, owner, FIXED_CONTENT_ID, FIXED_REVISION_ID, "transcript") as SpeakerContextSnapshot;
          const provenance = {
            inputs: [{ kind: "transcriptRevision" as const, id: FIXED_REVISION_ID }],
            modelRef: MODEL_SNAPSHOT,
            promptRef: { id: "summary.core", version: 1 },
            promptSnapshot: "<summary prompt>",
            speakerContext: snapshot,
            createdAt: 11,
          };
          const { artifactId } = scope.summaries.insertRevision(owner, {
            contentId: FIXED_CONTENT_ID,
            templateId: "summary.core",
            artifactId: "01JSUMART00000000000000000",
            revision: {
              id: "01JSUMREVL0NG0000000000000",
              provenance,
              quality: "normal",
              // The body cites only the first sentence; the partial it was folded from cites the 61st.
              body: `## 摘要\n${BODY} [[seg:${fixedSegmentId(1)}]]`,
              citations: [{ transcriptRevisionId: FIXED_REVISION_ID, segmentId: fixedSegmentId(1) }],
              partialIds: ["01JPART1AL0000000000000000"],
            },
          });
          scope.rollupPartials.insertMany(owner, "summary", [
            {
              id: "01JPART1AL0000000000000000",
              ownerRevisionId: "01JSUMREVL0NG0000000000000",
              index: 0,
              inputs: [],
              body: `部分 [[seg:${fixedSegmentId(60)}]]`,
              citations: [{ transcriptRevisionId: FIXED_REVISION_ID, segmentId: fixedSegmentId(60) }],
              modelRef: MODEL_SNAPSHOT,
              promptRef: { id: "rollup.partial", version: 1 },
              promptSnapshot: "<partial prompt>",
              speakerContext: snapshot,
              createdAt: 11,
            },
          ]);
          scope.summaries.setCurrent(owner, artifactId, "01JSUMREVL0NG0000000000000");
        });
        child(h, (segments) => segments.filter((_segment, index) => index !== 60));
      },
    });
    expect(systemOf(lastRequest(outcome.fake))).not.toContain(BODY);
    expect(outcome.chat.get(LOCAL, outcome.contentId, outcome.modelRef).context.summaryOmitted).toBe(true);
    const shown = outcome.h.repository.withTransaction((scope) => {
      const revision = scope.summaries.getRevision(owner, "01JSUMREVL0NG0000000000000") as SummaryRevision;
      return summarySpeakerContext(scope, owner, new SpeakerLineageReader(), FIXED_CONTENT_ID, revision);
    });
    expect(shown?.state).toBe("evidence_removed");
  });

  it("leaves the context label alone for a summary written without speakers", async () => {
    const outcome = await scenario("full", "reviewed", { wire: (h) => child(h, (segments) => segments.filter((_segment, index) => index !== 60)) });
    expect(systemOf(lastRequest(outcome.fake))).toContain("【总结】");
    expect(outcome.chat.get(LOCAL, outcome.contentId, outcome.modelRef).context.summaryOmitted).toBeUndefined();
  });
});

describe("carrying earlier answers and compactions", () => {
  /** The whole request as sent: the system prompt, then every message. */
  const sent = (request: LlmRequest): string =>
    [request.system ?? "", ...request.messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""))].join("\n\n");
  async function ask(outcome: Awaited<ReturnType<typeof scenario>>, text: string): Promise<string> {
    await drain(outcome.chat.send(LOCAL, outcome.contentId, { text, modelRef: outcome.modelRef }, undefined, new AbortController().signal));
    return sent(lastRequest(outcome.fake));
  }
  const cautions = (request: string) => request.split(SPEAKER_CAUTION_FRAGMENT.text).length - 1;
  const unverified = (request: string) => request.split(SPEAKER_UNVERIFIED_FRAGMENT.text).length - 1;
  /** The first history message of the last request. */
  const firstHistory = (outcome: Awaited<ReturnType<typeof scenario>>): string => {
    const part = lastRequest(outcome.fake).messages[0]?.content[0];
    return part?.type === "text" ? part.text : "";
  };

  it("puts one caution before the history once an earlier answer's speakers were renamed, also when this answer reads none", async () => {
    const outcome = await scenario("full", "reviewed");
    expect(cautions(sent(lastRequest(outcome.fake)))).toBe(0);
    expect(cautions(await ask(outcome, "同样的发言人再问一次"))).toBe(0);
    rename(outcome.h);
    expect(cautions(await ask(outcome, "改名之后"))).toBe(1);
    // No compaction: the caution opens the oldest history message, and the material is not behind it.
    const request = lastRequest(outcome.fake);
    expect(request.system).not.toContain(SPEAKER_CAUTION_FRAGMENT.text);
    expect(firstHistory(outcome).startsWith(`${SPEAKER_CAUTION_FRAGMENT.text}\n【用户选中的原文】`)).toBe(true);
    withdrawReview(outcome.h);
    // This answer reads no speakers, the earlier ones did.
    const system = await ask(outcome, "取消核对之后");
    expect(cautions(system)).toBe(1);
    expect(unverified(system)).toBe(0);
    expect(system).not.toContain(SPEAKER_RULES_FRAGMENT.text);
  });

  it("does not caution when only the version changed and every sentence kept its speaker", async () => {
    const outcome = await scenario("full", "reviewed");
    // A child revision: every sentence has a new id, the speakers are the same, reviewed and made the primary.
    child(outcome.h);
    const request = await ask(outcome, "换了版本之后");
    expect(lastAnswer(outcome.h).contextTranscriptRevisionId).not.toBe(FIXED_REVISION_ID);
    // The earlier answer read the old revision with a snapshot of other sentence ids.
    const earlier = messages(outcome.h).filter((message) => message.role === "assistant").at(-2) as ChatMessage;
    expect(earlier.speakerContext?.attributionDigest).not.toBe(lastAnswer(outcome.h).speakerContext?.attributionDigest);
    expect([cautions(request), unverified(request)]).toEqual([0, 0]);
  });

  it("cautions when a sentence of the earlier answer's revision changed hands", async () => {
    const outcome = await scenario("full", "reviewed");
    child(outcome.h, (segments) => segments.map((segment, index) => (index === 2 ? { ...segment, speakerId: fixedSpeakerId(1) } : segment)));
    const request = await ask(outcome, "改了归属之后");
    expect([cautions(request), unverified(request)]).toEqual([1, 0]);
    expect(firstHistory(outcome).startsWith(`${SPEAKER_CAUTION_FRAGMENT.text}\n`)).toBe(true);
  });

  it("says the earlier answer cannot be checked when its revision is no longer in the primary's lineage, and cautions alone once something changed too", async () => {
    const outcome = await scenario("full", "reviewed");
    // A transcript of its own (not derived from the one the first answer read) becomes the reviewed primary.
    const other = unrelated(outcome.h);
    const request = await ask(outcome, "换了字幕之后");
    expect(lastAnswer(outcome.h).contextTranscriptRevisionId).toBe(other);
    expect([cautions(request), unverified(request)]).toEqual([0, 1]);
    // Before the history, never before this turn's material.
    expect(lastRequest(outcome.fake).system).not.toContain(SPEAKER_UNVERIFIED_FRAGMENT.text);
    expect(firstHistory(outcome).startsWith(`${SPEAKER_UNVERIFIED_FRAGMENT.text}\n【用户选中的原文】`)).toBe(true);
    // The second answer read the new primary; renaming makes it changed. Mixed: the caution alone.
    rename(outcome.h);
    const mixed = await ask(outcome, "改名之后");
    expect([cautions(mixed), unverified(mixed)]).toEqual([1, 0]);
  });

  it("says the earlier answer cannot be checked when a sentence with a speaker has no source to compare with", async () => {
    const outcome = await scenario("full", "reviewed");
    child(outcome.h, (segments) => [
      ...segments,
      { ...(segments.at(-1) as TranscriptSegment), id: "01JSEHNEW00000000000000000" as SegmentId, sourceSegmentIds: [], speakerId: fixedSpeakerId(0), startMs: 200_000, endMs: 200_500 },
    ]);
    const request = await ask(outcome, "加了一句之后");
    expect([cautions(request), unverified(request)]).toEqual([0, 1]);
  });

  it("records the absorbed answers' bases in the compaction, merged with the previous one's, and still judges by them after those answers are deleted", async () => {
    const other: SpeakerContextSnapshot = {
      version: 1,
      rules: SPEAKER_RULES_FRAGMENT.ref,
      attributionDigest: "sha256:old",
      speakers: [{ id: fixedSpeakerId(0), ordinal: 1, name: "旧名", label: "旧名" }],
    };
    const previous: ChatSpeakerBasis = { transcriptRevisionId: FIXED_REVISION_ID, speakerContext: other, citedSegmentIds: [fixedSegmentId(50)] };
    const outcome = await scenario("compaction", "reviewed", {
      turnSpeakers: (index) => (index === 1 ? other : undefined),
      // An earlier compaction that absorbed the first turn and an answer on the same basis.
      wire: (h) =>
        h.repository.withTransaction((scope) =>
          scope.chat.insertCompaction(owner, {
            id: "01JC0MPACT10N0000000000000",
            threadId: THREAD,
            throughMessageId: `01JA${String(0).padStart(22, "0")}`,
            body: "更早的压缩摘要",
            modelRef: MODEL_SNAPSHOT,
            promptRef: { id: "chat.compaction", version: 1 },
            promptSnapshot: "<compaction prompt>",
            speakerBases: [previous],
            createdAt: 30,
          }),
        ),
    });
    const { h } = outcome;
    expect(outcome.fake.calls).toHaveLength(2);
    const compaction = h.repository.withTransaction((scope) => {
      const thread = scope.chat.getThread(owner, THREAD);
      return thread?.currentCompactionId === undefined ? undefined : scope.chat.getCompaction(owner, thread.currentCompactionId);
    });
    expect(compaction?.id).not.toBe("01JC0MPACT10N0000000000000");
    // Same revision and snapshot: one basis citing what either cited.
    expect(compaction?.speakerBases).toEqual([{ transcriptRevisionId: FIXED_REVISION_ID, speakerContext: other, citedSegmentIds: [fixedSegmentId(50), fixedSegmentId(3)] }]);
    expect(cautions(sent(lastRequest(outcome.fake)))).toBe(1);
    // With a compaction the caution stands right before it.
    expect(systemOf(lastRequest(outcome.fake))).toContain(`${SPEAKER_CAUTION_FRAGMENT.text}\n【此前对话的压缩摘要】\n`);

    // The answer that read the other speakers goes; the compaction keeps saying what it absorbed.
    outcome.chat.deleteTurns(LOCAL, outcome.contentId, { messageIds: [`01JA${String(1).padStart(22, "0")}`] });
    expect(h.repository.withTransaction((scope) => scope.chat.getThread(owner, THREAD)?.currentCompactionId)).toBe(compaction?.id);
    expect(cautions(await ask(outcome, "删除之后"))).toBe(1);
  });

  it("judges a compaction by its bases: one read from a revision that no longer exists gives the unverified notice before the compaction", async () => {
    const outcome = await scenario("full", "reviewed", {
      wire: (h) => {
        const snapshot = snapshotNow(h) as SpeakerContextSnapshot;
        h.repository.withTransaction((scope) =>
          scope.chat.insertCompaction(owner, {
            id: "01JC0MPACT10N0000000000000",
            threadId: THREAD,
            throughMessageId: `01JA${String(0).padStart(22, "0")}`,
            body: "旧的压缩摘要",
            modelRef: MODEL_SNAPSHOT,
            promptRef: { id: "chat.compaction", version: 1 },
            promptSnapshot: "<compaction prompt>",
            // Read from a revision that no longer exists.
            speakerBases: [{ transcriptRevisionId: "01JREVG0NE0000000000000000", speakerContext: snapshot, citedSegmentIds: [fixedSegmentId(1)] }],
            createdAt: 30,
          }),
        );
      },
    });
    const request = sent(lastRequest(outcome.fake));
    expect([cautions(request), unverified(request)]).toEqual([0, 1]);
    expect(systemOf(lastRequest(outcome.fake))).toContain(`${SPEAKER_UNVERIFIED_FRAGMENT.text}\n【此前对话的压缩摘要】\n旧的压缩摘要`);
  });

  it("does not caution over a compaction whose absorbed answers read no speakers", async () => {
    const outcome = await scenario("full", "reviewed", {
      wire: (h) =>
        h.repository.withTransaction((scope) =>
          scope.chat.insertCompaction(owner, {
            id: "01JC0MPACT10N0000000000000",
            threadId: THREAD,
            throughMessageId: `01JA${String(0).padStart(22, "0")}`,
            body: "旧的压缩摘要",
            modelRef: MODEL_SNAPSHOT,
            promptRef: { id: "chat.compaction", version: 1 },
            promptSnapshot: "<compaction prompt>",
            createdAt: 30,
          }),
        ),
    });
    expect(systemOf(lastRequest(outcome.fake))).toContain("旧的压缩摘要");
    const request = sent(lastRequest(outcome.fake));
    expect([cautions(request), unverified(request)]).toEqual([0, 0]);
  });
});

describe("what an answer actually used", () => {
  const contextEvents = (events: readonly ChatStreamEvent[]) => events.filter((event): event is Extract<ChatStreamEvent, { type: "context" }> => event.type === "context");

  it("is sent once planning is done and before the first delta, and kept on the answer", async () => {
    const { h, events, chat, contentId, modelRef } = await scenario("full", "reviewed");
    const types = events.map((event) => event.type);
    expect(types.indexOf("context")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("context")).toBeLessThan(types.indexOf("answer.delta"));
    expect(contextEvents(events)).toEqual([{ type: "context", data: { mode: "full" } }]);
    expect(lastAnswer(h).contextUsed).toEqual({ mode: "full" });
    // The questions and answers read no speakers before: nothing recorded on them.
    expect(messages(h).filter((message) => message.id !== lastAnswer(h).id).every((message) => message.contextUsed === undefined)).toBe(true);
    // A reload shows it.
    expect(chat.get(LOCAL, contentId, modelRef).messages.at(-1)?.contextUsed).toEqual({ mode: "full" });
  });

  it("reports retrieval when the web material pushed the full text out, after the search", async () => {
    // Header lines lengthen the transcript: a window where it still fits before the search.
    const outcome = await scenario("web_retrieval", "reviewed", { window: 9_550 });
    expect(outcome.context.mode).toBe("full");
    const types = outcome.events.map((event) => event.type);
    expect(types.indexOf("search.done")).toBeLessThan(types.indexOf("context"));
    expect(contextEvents(outcome.events).map((event) => event.data.mode)).toEqual(["retrieval"]);
    expect(lastAnswer(outcome.h).contextUsed?.mode).toBe("retrieval");
    expect(systemOf(lastRequest(outcome.fake))).toContain("【相关片段】");
  });

  it("reports a summary left out even when the answer reads no speakers", async () => {
    const outcome = await scenario("full", "reviewed", {
      wire: (h) => {
        speakerSummaryOf(h);
        // The speakers of the new primary are not reviewed, and one of its sentences changed hands.
        child(h, (segments) => segments.map((segment, index) => (index === 2 ? { ...segment, speakerId: fixedSpeakerId(1) } : segment)), false);
      },
    });
    expect(lastAnswer(outcome.h).speakerContext).toBeUndefined();
    expect(contextEvents(outcome.events)).toEqual([{ type: "context", data: { mode: "full", summaryOmitted: true } }]);
    expect(lastAnswer(outcome.h).contextUsed).toEqual({ mode: "full", summaryOmitted: true });
  });

  it("is kept by failed and interrupted answers; a retry records its own", async () => {
    const { h, fake, chat, contentId, modelRef } = await scenario("full", "reviewed");
    fake.script({ events: [{ type: "done", stopReason: "error" }] });
    const failedEvents = await drain(chat.send(LOCAL, contentId, { text: "再讲讲？", modelRef }, undefined, new AbortController().signal));
    expect(contextEvents(failedEvents)).toHaveLength(1);
    expect(lastAnswer(h)).toMatchObject({ status: "failed", contextUsed: { mode: "full" } });

    const controller = new AbortController();
    fake.script({ events: reply("一段会被打断的很长的回答"), delayMs: 5 });
    const result = chat.send(LOCAL, contentId, { text: "还有呢？", modelRef }, undefined, controller.signal);
    if (result.kind !== "stream") throw new Error("expected a stream");
    for await (const event of result.events) {
      if (event.type === "answer.delta") controller.abort();
    }
    const interrupted = lastAnswer(h);
    expect(interrupted).toMatchObject({ status: "interrupted", contextUsed: { mode: "full" } });

    // Retried after the review was withdrawn: the new attempt reads no speakers, so it reports and keeps nothing.
    withdrawReview(h);
    const retried = await drain(chat.retry(LOCAL, contentId, interrupted.id, {}, "retry-key-context", new AbortController().signal));
    expect(contextEvents(retried)).toEqual([]);
    const attempt = lastAnswer(h);
    expect(attempt.replacesMessageId).toBe(interrupted.id);
    expect(attempt.status).toBe("complete");
    expect(attempt.contextUsed).toBeUndefined();
  });

  it("a retry that reads speakers sends and keeps its own, leaving the failed attempt's as it was", async () => {
    const { h, fake, chat, contentId, modelRef } = await scenario("full", "reviewed", { wire: (h) => speakerSummaryOf(h) });
    fake.script({ events: [{ type: "done", stopReason: "error" }] });
    const failedEvents = await drain(chat.send(LOCAL, contentId, { text: "再讲讲？", modelRef }, undefined, new AbortController().signal));
    expect(contextEvents(failedEvents)).toEqual([{ type: "context", data: { mode: "full" } }]);
    const failed = lastAnswer(h);
    expect(failed).toMatchObject({ status: "failed", contextUsed: { mode: "full" } });
    expect(failed.speakerContext).toBeDefined();

    // A reviewed primary where a sentence changed hands: the retry still reads speakers, but
    // the summary written with the old ones is left out this time.
    child(h, (segments) => segments.map((segment, index) => (index === 2 ? { ...segment, speakerId: fixedSpeakerId(1) } : segment)));
    // The retry fails as well, so the attempt it replaces stays stored next to it.
    fake.script({ events: [{ type: "text_delta", delta: "半句" }, { type: "done", stopReason: "error" }] });
    const retriedEvents = await drain(chat.retry(LOCAL, contentId, failed.id, {}, "retry-key-own-context", new AbortController().signal));
    const types = retriedEvents.map((event) => event.type);
    expect(contextEvents(retriedEvents)).toEqual([{ type: "context", data: { mode: "full", summaryOmitted: true } }]);
    expect(types.indexOf("context")).toBeLessThan(types.indexOf("answer.delta"));
    const attempt = lastAnswer(h);
    expect(attempt.replacesMessageId).toBe(failed.id);
    expect(attempt.status).toBe("failed");
    expect(attempt.speakerContext).toBeDefined();
    expect(attempt.contextUsed).toEqual({ mode: "full", summaryOmitted: true });
    expect(messages(h).find((message) => message.id === failed.id)?.contextUsed).toEqual({ mode: "full" });
    const shown = chat.get(LOCAL, contentId, modelRef).messages;
    expect(shown.find((message) => message.id === failed.id)?.contextUsed).toEqual({ mode: "full" });
    expect(shown.at(-1)?.contextUsed).toEqual({ mode: "full", summaryOmitted: true });
  });
});

/**
 * A transcript of its own made the reviewed primary: the same sentences and speakers, but
 * imported, so no sentence descends from the fixed revision.
 */
function unrelated(h: Harness): string {
  const id = "01JREVR00T0000000000000000";
  const root = h.repository.withTransaction((scope) => scope.transcripts.listSegments(owner, FIXED_REVISION_ID));
  const segments = root.map((segment, index): TranscriptSegment => ({
    ...segment,
    id: `01JSEK${String(index).padStart(20, "0")}` as SegmentId,
    revisionId: id,
    sourceSegmentIds: [],
  }));
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(
      owner,
      {
        id,
        contentId: FIXED_CONTENT_ID,
        kind: "imported",
        language: "zh-CN",
        timingFidelity: "segment_only",
        generation: { kind: "imported", format: "srt" },
        segmentCount: segments.length,
        createdAt: 20,
      },
      segments,
    );
    scope.contents.setPrimaryTranscript(owner, FIXED_CONTENT_ID, id, 21);
    scope.speakerConfirmations.set(owner, FIXED_CONTENT_ID, id, 22);
    scope.search.syncContent(owner, FIXED_CONTENT_ID);
  });
  return id;
}
