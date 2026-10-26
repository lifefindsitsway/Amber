import type { LlmRequest, LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { LlmStreamOptions } from "../../../src/server/ports/llm-provider.ts";
import { FakeLlmProvider, reply } from "./fake-llm.ts";

/** The built-in prompt a request was rendered from, told apart by its opening words. */
export type PipelinePromptKind =
  | "proofread"
  | "chapter"
  | "highlight"
  | "translate"
  | "envelope"
  | "partial"
  | "carry"
  | "final"
  | "final_collection"
  | "repair"
  | "chat"
  | "chat_compaction"
  | "chat_search_plan";

export function promptText(request: LlmRequest): string {
  return request.messages
    .flatMap((message) => message.content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

export function pipelinePromptKind(request: LlmRequest): PipelinePromptKind {
  if (request.system.startsWith("你是这段课程内容的学习助手")) return "chat";
  const text = promptText(request);
  if (text.startsWith("把「已有压缩摘要」与「新增对话」")) return "chat_compaction";
  if (text.startsWith("你负责判断回答用户的当前问题是否需要联网搜索")) return "chat_search_plan";
  if (text.startsWith("你是字幕校对员") || text.startsWith("我会同时提供这段字幕对应的音频")) return "proofread";
  if (text.startsWith("下面是一段课程逐字稿") && text.includes("最值得回看")) return "highlight";
  if (text.startsWith("下面是一段课程逐字稿")) return "chapter";
  if (text.startsWith("请将以下字幕翻译成")) return "translate";
  if (text.startsWith("下面是一段课程音视频的逐字稿")) return "envelope";
  if (text.startsWith("你在为一门课程做连贯的归纳")) return "partial";
  if (text.startsWith("把「已有压缩摘要」")) return "carry";
  if (text.startsWith("下面是一段课程各组内容")) return "final";
  if (text.startsWith("下面是一门课程各组内容")) return "final_collection";
  if (text.startsWith("以下引用标记")) return "repair";
  throw new Error(`unrecognised prompt: ${text.slice(0, 40)}`);
}

/** The `[[s<n>]]` aliases after the last `marker` (up to `until`, when given), deduplicated in order. */
function aliasesIn(text: string, marker: string, until?: string): number[] {
  const from = text.lastIndexOf(marker);
  const section = text.slice(from === -1 ? 0 : from);
  const end = until === undefined ? -1 : section.indexOf(until);
  const scoped = end === -1 ? section : section.slice(0, end);
  return [...new Set([...scoped.matchAll(/\[\[s(\d+)\]\]/g)].map((match) => Number(match[1])))];
}

const cite = (aliases: readonly number[]): string => aliases.map((alias) => `[[s${alias}]]`).join(" ");

/**
 * A well-formed answer to every prompt of the processing pipeline: proofreading echoes the
 * target lines, chapters start one chapter at the window's first sentence, highlights pick
 * the window's first, middle and last sentences, translation tags every numbered line with
 * its target language, and every
 * summary-like output (chat answers included, with their control section) cites the aliases
 * it was given — so the pipeline's checks pass and its citations stay resolvable, without
 * any model.
 */
export function pipelineAnswer(request: LlmRequest): string {
  const text = promptText(request);
  switch (pipelinePromptKind(request)) {
    case "proofread": {
      const start = text.indexOf("【待校对");
      const end = text.indexOf("【只读上下文（后）】");
      const section = text.slice(text.indexOf("\n", start) + 1, end === -1 ? undefined : end);
      return section
        .split("\n")
        .filter((line) => /^\[s\d+\]/.test(line))
        .join("\n");
    }
    case "chapter": {
      const [first] = aliasesIn(text, "【逐字稿】");
      return JSON.stringify({ chapters: [{ startAlias: `s${first}`, title: "全部内容", summary: "本段的全部内容" }] });
    }
    case "highlight": {
      const aliases = aliasesIn(text, "【逐字稿】");
      const picks = [...new Set([aliases[0], aliases[Math.floor(aliases.length / 2)], aliases.at(-1)])].filter((alias) => alias !== undefined);
      const scores = [92, 85, 70];
      return JSON.stringify({
        highlights: picks.map((alias, index) => ({ alias: `s${alias}`, score: scores[index], text: `第 ${alias} 句是本段的关键` })),
      });
    }
    case "translate": {
      const language = /翻译成 (.+?)。/.exec(text)?.[1] ?? "";
      return text
        .slice(text.lastIndexOf("：\n") + 2)
        .split("\n")
        .map((line) => /^(\d+)\. (.*)$/.exec(line))
        .filter((match) => match !== null)
        .map((match) => `${match[1]}. [${language}] ${match[2]}`)
        .join("\n");
    }
    case "envelope":
      return `## 摘要\n本讲内容 ${cite(aliasesIn(text, "【逐字稿】").slice(0, 2))}\n## 要点\n- 要点 ${cite(aliasesIn(text, "【逐字稿】").slice(-1))}`;
    case "partial":
      return `本组归纳 ${cite(aliasesIn(text, "【本组内容】"))}`;
    case "carry":
      return `压缩摘要 ${cite(aliasesIn(text, "【新增归纳】"))}`;
    case "final":
    case "final_collection":
      return `## 总归纳\n${cite(aliasesIn(text, "【各组归纳】", "【整体压缩摘要】"))}`;
    case "repair":
      return "{}";
    case "chat":
      if (request.system.includes("【基本信息】")) {
        // The metadata mode (the `chat.system.metadata` prompt): no transcript, nothing to cite.
        return [
          "字幕尚未就绪，以下回答未依据视频原文。从标题看，这一讲介绍课程的整体安排。",
          "<<<suggestions>>>",
          "- 字幕就绪后能总结一下吗？",
          "- 这门课适合什么基础的人？",
          "<<<end>>>",
        ].join("\n");
      }
      return [
        `根据视频内容，这部分讲的是课程的核心要点 ${cite(aliasesIn(request.system, "【资料】").slice(0, 2))}。`,
        "<<<suggestions>>>",
        "- 能再举一个例子吗？",
        "- 这和前面讲的内容有什么关系？",
        "<<<end>>>",
      ].join("\n");
    case "chat_compaction":
      return `此前对话的压缩摘要 ${cite(aliasesIn(text, "【新增对话】"))}`;
    case "chat_search_plan":
      // No search unless asked: a forced search then falls back to the question's first line.
      return '{"search":false,"queries":[]}';
  }
}

/** A FakeLlmProvider whose every call answers `pipelineAnswer`; `calls` records each request. */
export class PipelineLlmProvider extends FakeLlmProvider {
  override stream(request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.calls.push({ request, opts });
    const events = reply(pipelineAnswer(request));
    return (async function* () {
      yield* events;
    })();
  }

  kinds(): PipelinePromptKind[] {
    return this.calls.map((call) => pipelinePromptKind(call.request));
  }
}
