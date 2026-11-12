import { ChatService, type ChatSendResult } from "../../../src/server/application/chat.ts";
import type { ChatSearchPlan, ChatSearchPlanRequest, ChatWebSearcher } from "../../../src/server/application/web-search.ts";
import type { ChatMessage } from "../../../src/server/domain/chat.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import type { SpeakerContextSnapshot } from "../../../src/server/domain/speaker-context.ts";
import type { ChatWebSearch } from "../../../src/server/domain/web-search.ts";
import type { ChatMessageRequest, ChatStreamEvent } from "../../../src/shared/dto/chat.ts";
import { FakeLlmProvider, reply } from "../llm/fake-llm.ts";
import { configureChatModel } from "./chat-data.ts";
import { createHarness, createLocalContent, LOCAL, silentLogger, type Harness } from "./harness.ts";
import { fixedSegmentId, fixedSpeakerId, seedContent, sha256, type SeedOptions } from "./speaker-context.ts";
import { MODEL_SNAPSHOT } from "./summary-data.ts";

/**
 * Chat requests built from fixed data, for checking that reading speakers changes nothing
 * for a Content whose speakers are not given to the model. Each scenario sends one question
 * and reports what reached the model (system prompt and messages of every call, hashed) and
 * the context estimate `GET chat` shows beforehand.
 */

/** A fixed clock: the system prompt names today's date. */
export const GOLDEN_NOW = Date.UTC(2026, 10, 11, 4, 0, 0);

export interface GoldenOutcome {
  /** sha256 over the JSON of `[system, messages]` of every call, in order. */
  requests: string;
  /** Characters of those requests, to tell a size change from a wording change at a glance. */
  chars: number;
  /** `GET chat` context before the question. */
  context: { mode: string; estimatedTokens?: number };
}

/**
 * `retry`: the question's first answer fails and is retried (retrieval-sized window).
 * `web_retrieval`: the transcript fits as full text before the search, and the web material
 * pushes the answer into retrieval.
 */
export type GoldenScenario = "full" | "retrieval" | "metadata" | "web" | "compaction" | "retry" | "web_retrieval";

/** A window where the full transcript fits the estimate shown before asking, but not beside the web material. */
export const WEB_RETRIEVAL_WINDOW = 8_550;

/**
 * How a scenario's Content carries speakers: none, assigned but not reviewed, reviewed yet
 * not read by speaker, or reviewed and read by speaker (the only one whose requests change).
 */
export type GoldenSpeakers = "none" | "unreviewed" | "single_unnamed" | "reviewed";

const NAMED: NonNullable<SeedOptions["speakers"]> = [
  { name: "张三", confirmed: true },
  { name: "李四", confirmed: true },
];

function speakerOptions(kind: GoldenSpeakers): SeedOptions {
  switch (kind) {
    case "none":
      return {};
    case "unreviewed":
      return { speakers: NAMED, assign: (position) => (position % 7 < 3 ? 0 : position % 11 === 0 ? undefined : 1), reviewed: false };
    case "single_unnamed":
      return { speakers: [{}], assign: () => 0, reviewed: true };
    case "reviewed":
      return { ...speakerOptions("unreviewed"), reviewed: true };
  }
}

class GoldenSearcher implements ChatWebSearcher {
  private readonly onPlan: (() => void) | undefined;
  constructor(onPlan?: () => void) {
    this.onPlan = onPlan;
  }
  isConfigured(): boolean {
    return true;
  }
  async plan(request: ChatSearchPlanRequest): Promise<ChatSearchPlan> {
    this.onPlan?.();
    return { mode: request.mode, queries: [request.question] };
  }
  async search(_owner: string, plan: ChatSearchPlan): Promise<ChatWebSearch> {
    return {
      mode: plan.mode,
      status: "searched",
      planned: plan.queries.length,
      requested: plan.queries.length,
      succeeded: plan.queries.length,
      queries: plan.queries,
      sources: [
        { id: "01J0000000000000000000WEB1", index: 1, url: "https://example.com/a", title: "来源一", excerpt: "摘录一", publishedAt: Date.UTC(2026, 9, 1), fetchedAt: 1 },
        { id: "01J0000000000000000000WEB2", index: 2, url: "https://example.org/b", title: "来源二", excerpt: "摘录二", fetchedAt: 1 },
      ],
    };
  }
}

/**
 * Earlier turns stored directly: `long` answers fill a small window so that compaction is
 * due; `speakers` gives an answer the speakers it was given.
 */
function seedTurns(
  h: Harness,
  contentId: string,
  count: number,
  long: boolean,
  transcript: boolean,
  speakers?: (index: number) => SpeakerContextSnapshot | undefined,
): void {
  h.repository.withTransaction((scope) => {
    scope.chat.insertThread(LOCAL.userId, { id: "01JTHREAD00000000000000000", contentId, createdAt: 3 });
    for (let index = 0; index < count; index += 1) {
      const user: ChatMessage = {
        id: `01JU${String(index).padStart(22, "0")}`,
        threadId: "01JTHREAD00000000000000000",
        role: "user",
        text: `第 ${index + 1} 问：讲到哪了？`,
        status: "complete",
        citations: index === 0 ? [{ transcriptRevisionId: "01JREV1S10N000000000000000", segmentId: fixedSegmentId(4) }] : [],
        createdAt: 10 + index * 2,
      };
      const answer: ChatMessage = {
        id: `01JA${String(index).padStart(22, "0")}`,
        threadId: "01JTHREAD00000000000000000",
        role: "assistant",
        text: `第 ${index + 1} 答 [[seg:${fixedSegmentId(index * 3)}]]${long ? "长".repeat(500) : ""}`,
        status: "complete",
        modelRef: MODEL_SNAPSHOT,
        ...(transcript ? { contextTranscriptRevisionId: "01JREV1S10N000000000000000" } : {}),
        ...(speakers?.(index) === undefined ? {} : { speakerContext: speakers(index) as SpeakerContextSnapshot }),
        citations: [{ transcriptRevisionId: "01JREV1S10N000000000000000", segmentId: fixedSegmentId(index * 3) }],
        createdAt: 11 + index * 2,
      };
      scope.chat.insertMessage(LOCAL.userId, user);
      scope.chat.insertMessage(LOCAL.userId, answer);
    }
  });
}

/** The default summary, citing two sentences, and two platform chapters. */
function seedSummaryAndChapters(h: Harness, contentId: string): void {
  h.repository.withTransaction((scope) => {
    const inserted = scope.summaries.insertRevision(LOCAL.userId, {
      contentId,
      templateId: "summary.core",
      artifactId: "01JSUMART00000000000000000",
      revision: {
        id: "01JSUMREV00000000000000000",
        provenance: {
          inputs: [{ kind: "transcriptRevision", id: "01JREV1S10N000000000000000" }],
          modelRef: MODEL_SNAPSHOT,
          promptRef: { id: "summary.core", version: 1 },
          promptSnapshot: "<summary prompt>",
          createdAt: 10,
        },
        quality: "normal",
        body: `## 摘要\n讲了检索增强 [[seg:${fixedSegmentId(1)}]] 与要点 [[seg:${fixedSegmentId(60)}]]。`,
        citations: [
          { transcriptRevisionId: "01JREV1S10N000000000000000", segmentId: fixedSegmentId(1) },
          { transcriptRevisionId: "01JREV1S10N000000000000000", segmentId: fixedSegmentId(60) },
        ],
      },
    });
    scope.summaries.setCurrent(LOCAL.userId, inserted.artifactId, "01JSUMREV00000000000000000");
    scope.chapters.insertPlatformRevision(LOCAL.userId, contentId, {
      id: "01JCHAPREV0000000000000000",
      artifactId: "01JCHAPART0000000000000000",
      chapters: [
        { startMs: 0, endMs: 60_000, title: "开场" },
        { startMs: 60_000, endMs: 120_000, title: "要点" },
      ],
      createdAt: 9,
    });
    scope.chapters.setCurrent(LOCAL.userId, contentId, "01JCHAPREV0000000000000000");
  });
}

export async function drain(result: ChatSendResult): Promise<ChatStreamEvent[]> {
  if (result.kind !== "stream") {
    throw new Error("expected a stream");
  }
  const events: ChatStreamEvent[] = [];
  for await (const event of result.events) {
    events.push(event);
  }
  return events;
}

function hashRequests(requests: readonly LlmRequest[]): { requests: string; chars: number } {
  const json = JSON.stringify(requests.map((request) => [request.system, request.messages]));
  return { requests: sha256(json), chars: json.length };
}

export interface GoldenOptions {
  /** Changes the store before the question is sent. */
  wire?: (h: Harness, chat: ChatService) => void;
  /** Overrides the scenario's context window. */
  window?: number;
  /** Runs while the web search is planned, after the question was stored. */
  onSearch?: (h: Harness) => void;
  /** Runs when the compaction call starts, after the question was stored. */
  onCompaction?: (h: Harness) => void;
  /** The speakers each seeded earlier answer was given. */
  turnSpeakers?: (index: number) => SpeakerContextSnapshot | undefined;
  /** Replaces the scenario's question. */
  question?: string;
}

/** Runs one scenario on a fresh harness. */
export async function runGoldenScenario(
  scenario: GoldenScenario,
  speakers: GoldenSpeakers = "none",
  options: GoldenOptions = {},
): Promise<GoldenOutcome & { h: Harness; fake: FakeLlmProvider; chat: ChatService; contentId: string; modelRef: ModelRef; events: ChatStreamEvent[] }> {
  const fake = new FakeLlmProvider();
  const h = createHarness({ llmProviders: [fake] });
  const chat = new ChatService({
    repository: h.repository,
    llm: h.llm,
    logger: silentLogger,
    newId: h.newId,
    now: () => GOLDEN_NOW,
    ...(scenario === "web" || scenario === "web_retrieval" ? { webSearch: new GoldenSearcher(options.onSearch === undefined ? undefined : () => options.onSearch?.(h)) } : {}),
  });
  const window =
    options.window ??
    (scenario === "retrieval" || scenario === "retry" ? 4_000 : scenario === "compaction" ? 9_000 : scenario === "web_retrieval" ? WEB_RETRIEVAL_WINDOW : 128_000);
  const modelRef = configureChatModel(h, window);
  let contentId: string;
  if (scenario === "metadata") {
    contentId = createLocalContent(h);
    h.repository.withTransaction((scope) => {
      scope.contents.setMetadata(LOCAL.userId, contentId, { title: "第一讲：检索增强", durationMs: 3_725_000 }, 2);
      scope.referenceTexts.insert(LOCAL.userId, { id: "01JREFTEXT0000000000000000", contentId, origin: "txt_import", text: "讲义：检索增强把外部知识接入模型。", createdAt: 3 });
    });
  } else {
    contentId = seedContent(h, speakerOptions(speakers)).contentId;
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, contentId));
    seedSummaryAndChapters(h, contentId);
  }
  seedTurns(h, contentId, scenario === "compaction" ? 8 : 2, scenario === "compaction", scenario !== "metadata", options.turnSpeakers);
  options.wire?.(h, chat);
  const context = chat.get(LOCAL, contentId, modelRef).context;
  const onCompaction = options.onCompaction;
  if (scenario === "retry") {
    fake.script({ events: [{ type: "done", stopReason: "error" }] });
  }
  fake.script(
    onCompaction === undefined
      ? { events: reply("好的 [[s1]]。") }
      : () =>
          (async function* (): AsyncGenerator<LlmStreamEvent> {
            onCompaction(h);
            yield* reply("好的 [[s1]]。");
          })(),
  );
  const body: ChatMessageRequest = {
    text: options.question ?? "第5个要点讲了什么？",
    modelRef,
    positionMs: 65_000,
    ...(scenario === "metadata" ? {} : { quote: { transcriptRevisionId: "01JREV1S10N000000000000000", segmentId: fixedSegmentId(64) } }),
    ...(scenario === "web" || scenario === "web_retrieval" ? { webSearch: "force" as const } : {}),
  };
  let events = await drain(chat.send(LOCAL, contentId, body, undefined, new AbortController().signal));
  if (scenario === "retry") {
    const failed = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");
    if (failed === undefined) {
      throw new Error("expected the first answer to finish");
    }
    events = await drain(chat.retry(LOCAL, contentId, failed.data.messageId, { positionMs: 65_000 }, "golden-retry", new AbortController().signal));
  }
  return {
    ...hashRequests(fake.calls.map((call) => call.request)),
    context: { mode: context.mode, ...(context.estimatedTokens === undefined ? {} : { estimatedTokens: context.estimatedTokens }) },
    h,
    fake,
    chat,
    contentId,
    modelRef,
    events,
  };
}

export { fixedSpeakerId };
