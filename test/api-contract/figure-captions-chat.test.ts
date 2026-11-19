import { afterEach, describe, expect, it } from "vitest";
import type { ChatSendResult } from "../../src/server/application/chat.ts";
import { chatCandidates } from "../../src/server/application/chat-speakers.ts";
import type { ContentFigure } from "../../src/server/domain/figure.ts";
import { PipelineLlmProvider } from "../fixtures/llm/pipeline-llm.ts";
import { configureChatModel, seedChatContent } from "../fixtures/pipeline/chat-data.ts";
import { createHarness, LOCAL, type Harness } from "../fixtures/pipeline/harness.ts";

/**
 * Figure captions share the search projection with transcript sentences, yet chat reads
 * sentences only: neither retrieval's candidates nor any prompt may carry a caption, however
 * well it matches the question.
 */

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

/** Words the lecture fixture never uses, so finding them anywhere in a prompt can only mean a caption leaked. */
const MARK = "琥珀插图专用标记";
const never = () => new AbortController().signal;

function addFigure(h: Harness, contentId: string, caption: string): ContentFigure {
  const figure: ContentFigure = {
    id: h.newId(),
    contentId,
    userId: LOCAL.userId,
    source: "upload",
    displayMs: 0,
    sortKey: 0,
    widthRatio: 0.7,
    caption,
    image: { width: 4, height: 3, bytes: 3, sha256: "a".repeat(64) },
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  h.repository.withTransaction((scope) => {
    scope.figures.insert(figure, new Uint8Array([1, 2, 3]));
    scope.search.syncFigure(LOCAL.userId, contentId, figure.id);
  });
  return figure;
}

async function drain(result: ChatSendResult): Promise<void> {
  if (result.kind !== "stream") throw new Error("expected a stream");
  for await (const event of result.events) void event;
}

describe("figure captions stay out of chat", () => {
  it("are never retrieval candidates, nor in the prompt of a retrieval-mode answer", async () => {
    const provider = new PipelineLlmProvider();
    const h = createHarness({ llmProviders: [provider] });
    open.push(h);
    const { contentId, revisionId, segments } = seedChatContent(h, 1_800);
    // A caption that matches the question far better than any sentence does.
    const caption = `反向传播的要点 反向传播的要点 反向传播的要点 ${MARK}`;
    const figure = addFigure(h, contentId, caption);
    expect(h.search.search(LOCAL, { q: "反向传播的要点" }).figures.map((hit) => hit.figureId)).toEqual([figure.id]);

    const candidates = h.repository.withTransaction((scope) => chatCandidates(scope, LOCAL.userId, revisionId, "反向传播的要点是什么？", undefined));
    const sentenceIds = new Set(segments.map((segment) => segment.id as string));
    expect(candidates.hits.length).toBeGreaterThan(0);
    expect(candidates.hits.every((id) => sentenceIds.has(id))).toBe(true);
    expect(candidates.hits).not.toContain(figure.id);

    const modelRef = configureChatModel(h, 8_000);
    expect(h.chat.get(LOCAL, contentId, modelRef).context.mode).toBe("retrieval");
    await drain(h.chat.send(LOCAL, contentId, { text: "反向传播的要点是什么？", modelRef }, undefined, never()));
    const request = provider.calls[0]?.request;
    expect(request?.system).toContain("【相关片段】");
    expect(JSON.stringify(request)).not.toContain(MARK);
  });

  it("are not in the prompt of a whole-transcript answer either", async () => {
    const provider = new PipelineLlmProvider();
    const h = createHarness({ llmProviders: [provider] });
    open.push(h);
    const { contentId } = seedChatContent(h, 10);
    addFigure(h, contentId, `学习率的示意图 ${MARK}`);
    const modelRef = configureChatModel(h, 128_000);
    expect(h.chat.get(LOCAL, contentId, modelRef).context.mode).not.toBe("retrieval");
    await drain(h.chat.send(LOCAL, contentId, { text: "学习率怎么选？", modelRef }, undefined, never()));
    expect(provider.calls).toHaveLength(1);
    expect(JSON.stringify(provider.calls[0]?.request)).not.toContain(MARK);
  });
});
