import {
  CHAT_COMPACTION_BUDGET_CHARS,
  CHAT_RECENT_TURNS,
  CHAT_RECENT_TURNS_MIN,
  CHAT_RETRIEVAL_HITS_MAX,
  CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS,
  CONTEXT_SAFETY_RATIO,
  WEB_SEARCH_CONTEXT_MAX_TOKENS,
} from "../../shared/defaults.ts";
import type { ContentSourceKind, LlmProtocol } from "../../shared/enums.ts";
import { AliasTable, type AliasEntry } from "./citations.ts";
import { amberError } from "./errors.ts";
import type { LlmRequest } from "./llm.ts";
import {
  CHAT_COMPACTION_HEADING,
  CHAT_COMPACTION_PROMPT,
  CHAT_QUOTE_HEADING,
  CHAT_REFERENCE_HEADING,
  CHAT_SYSTEM_METADATA_PROMPT,
  CHAT_SYSTEM_PROMPT,
  CHAT_WEB_HEADING,
  CHAT_WEB_NONE,
  chatModelSection,
  outputLanguageName,
  renderPrompt,
} from "./prompts.ts";
import { estimateTokens } from "./token-estimate.ts";
import type { TranscriptSegment } from "./transcript.ts";
import type { WebSource } from "./web-search.ts";

/**
 * The chat context policy as pure functions: which mode a request runs in,
 * what it carries, and when older turns are due for compaction. Stored texts use canonical
 * `[[seg:<id>]]` markers; each request renumbers the sentences it shows as `[[s<n>]]`, and
 * a marker naming a sentence the request does not show is dropped rather than invented.
 * Web citations (`[[web:<id>]]`) are valid only in the answer that produced them, so they
 * are dropped from every stored text that goes back into a request.
 */

/** Section headings of `{{context_section}}`; model input, not UI copy. */
const SECTION = {
  summary: "【总结】",
  transcript: "【逐字稿】",
  chapters: "【章节目录】",
  currentChapter: "【当前章节】",
  hits: "【相关片段】",
  turnUser: "用户：",
  turnAssistant: "助手：",
  title: "标题：",
  source: "来源：",
  duration: "时长：",
  published: "发布日期：",
} as const;

/** How `{{metadata_section}}` names a source; model input, not UI copy. */
const SOURCE_NAMES: Readonly<Record<ContentSourceKind, string>> = {
  youtube: "YouTube",
  bilibili: "哔哩哔哩",
  local: "本地文件",
};

const CANONICAL = /\[\[seg:([^\]\s]+)\]\]/g;
const UNRESOLVED = /\[\[unresolved:[^\]]*\]\]/g;
/** A stored web citation, and a web alias that slipped into stored text. */
const WEB_MARKER = /\[\[(?:web:[^\]]*|w\d+)\]\]/g;

/** `metadata`: the Content has no primary revision yet. */
export type ChatMode = "full" | "retrieval" | "metadata";

/** What is known about a Content before it has a transcript: the `{{metadata_section}}` of the `chat.system.metadata` prompt. */
export interface ChatMetadata {
  title?: string;
  source: ContentSourceKind;
  channelTitle?: string;
  durationMs?: number;
  publishedAt?: number;
  /** Imported reference texts, oldest first. */
  references: readonly string[];
}

/** A sentence a user turn quoted, with its text read from the store. */
export interface ChatQuoteText {
  segmentId: string;
  text: string;
}

/** One finished turn of the history, oldest first; texts are as stored. */
export interface ChatTurnText {
  question: string;
  quote?: ChatQuoteText;
  /** Empty when the answer failed before any text. */
  answer: string;
}

export interface ChatChapter {
  startMs: number;
  endMs: number;
  title: string;
}

/** Who answers, as the model is told; taken from the answer's ModelRefSnapshot. */
export interface ChatModelIdentity {
  profileName: string;
  modelId: string;
  /** Absent on snapshots stored before the protocol was kept. */
  protocol?: LlmProtocol;
}

/** This answer's web material: the sources it was given, possibly none after a search that found nothing usable. */
export interface ChatWebMaterial {
  sources: readonly WebSource[];
}

export interface ChatPlanInput {
  contextWindowTokens: number;
  /** BCP-47 tag of the answer language. */
  outputLanguage: string;
  /** The primary revision the answer is grounded in; absent means the metadata mode. */
  revisionId?: string;
  /** Used only in the metadata mode. */
  metadata?: ChatMetadata;
  segments: readonly TranscriptSegment[];
  /** The default template's current summary body, if any. */
  summary?: string;
  chapters: readonly ChatChapter[];
  /** The thread's current compaction body, if any. */
  compaction?: string;
  /** Turns after the current compaction, oldest first. */
  turns: readonly ChatTurnText[];
  /** The question being asked; empty when only the context is being shown. */
  question: string;
  quote?: ChatQuoteText;
  positionMs?: number;
  /** The answering model, so it can say which model it is. */
  model?: ChatModelIdentity;
  /** Today in Beijing time, `YYYY-MM-DD`. */
  today?: string;
  /** Absent: no web search for this answer. */
  web?: ChatWebMaterial;
}

export interface ChatRequestPlan {
  mode: ChatMode;
  table: AliasTable;
  system: string;
  messages: LlmRequest["messages"];
  estimatedTokens: number;
  /** How many of the most recent input turns the request carries. */
  carriedTurns: number;
  /** All uncompacted turns did not fit: compaction is due. */
  overBudget: boolean;
}

/** A date as `YYYY-MM-DD` in Beijing time (UTC+8), whatever the host's time zone. */
export function beijingDate(ms: number): string {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The web sources that fit this request, kept from the front (they come ranked best first)
 * and numbered 1..k, and whether none did (the search's `dropped (budget)`). What is left
 * for material is the budget minus the request's fixed part without web material (the
 * system prompt with no transcript lines, or with the basic facts only, and the question)
 * and the last `CHAT_RECENT_TURNS_MIN` turns; the web section may take half of it, at most
 * `WEB_SEARCH_CONTEXT_MAX_TOKENS`. The request is planned afterwards with the kept sources,
 * so its mode, retrieved sentences and history are chosen around them.
 */
export function fitWebSources(input: ChatPlanInput, sources: readonly WebSource[]): { sources: WebSource[]; dropped: boolean } {
  if (sources.length === 0) {
    return { sources: [], dropped: false };
  }
  const { web: _web, ...bare } = input;
  const table = new AliasTable([]);
  const system = bare.revisionId === undefined ? metadataSystem(bare, metadataFacts(bare.metadata), table) : systemText(bare, retrievalContext(bare, table, [], []), table);
  const recent = bare.turns.slice(-CHAT_RECENT_TURNS_MIN).reduce((sum, turn) => sum + turnTokens(turn), 0);
  const avail = chatBudget(bare.contextWindowTokens) - estimateTokens(system) - estimateTokens(currentTurnText(bare, table)) - quoteAllowance(bare) - recent;
  const webBudget = Math.min(WEB_SEARCH_CONTEXT_MAX_TOKENS, Math.floor(avail / 2));
  for (let count = sources.length; count > 0; count -= 1) {
    const kept = sources.slice(0, count).map((source, index) => ({ ...source, index: index + 1 }));
    if (estimateTokens(webSection({ sources: kept })) <= webBudget) {
      return { sources: kept, dropped: false };
    }
  }
  return { sources: [], dropped: true };
}

/**
 * The `{{web_section}}`: empty without a search; a fixed line when the search left nothing
 * usable; else the heading and each source as `[[w<n>]] title — domain（date）` with its
 * excerpt on the next line, `n` being its position, which is how the answer's aliases are
 * resolved.
 */
function webSection(web: ChatWebMaterial | undefined): string {
  if (web === undefined) {
    return "";
  }
  if (web.sources.length === 0) {
    return CHAT_WEB_NONE;
  }
  const entries = web.sources.map((source, index) => {
    const date = source.publishedAt === undefined ? "" : `（${beijingDate(source.publishedAt)}）`;
    return `[[w${index + 1}]] ${oneLine(source.title)} — ${domainOf(source.url)}${date}\n${oneLine(source.excerpt)}`;
  });
  return [CHAT_WEB_HEADING, ...entries].join("\n");
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The slots every chat system prompt shares besides its material. */
function commonSlots(input: ChatPlanInput, table: AliasTable): Record<string, string> {
  return {
    today: input.today ?? beijingDate(Date.now()),
    output_language: outputLanguageName(input.outputLanguage),
    model_section: input.model === undefined ? "" : chatModelSection({ ...input.model, profileName: oneLine(input.model.profileName) }),
    compaction_section: input.compaction === undefined || input.compaction === "" ? "" : `${CHAT_COMPACTION_HEADING}\n${aliased(input.compaction, table)}`,
    web_section: webSection(input.web),
  };
}

/** The chat budget: the safe share of the context window. */
export function chatBudget(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * CONTEXT_SAFETY_RATIO);
}

/**
 * Full text when system + summary + the whole aliased primary revision + compaction + the
 * last `CHAT_RECENT_TURNS_MIN` turns + the question fit the budget; retrieval otherwise;
 * metadata while there is no primary revision.
 */
export function chooseChatMode(input: ChatPlanInput): ChatMode {
  if (input.revisionId === undefined) {
    return "metadata";
  }
  const table = tableOf(input.revisionId, input.segments);
  const fixed = estimateTokens(systemText(input, fullContext(input, table), table)) + estimateTokens(currentTurnText(input, table));
  const recent = input.turns.slice(-CHAT_RECENT_TURNS_MIN).reduce((sum, turn) => sum + turnTokens(turn), 0);
  return fixed + recent <= chatBudget(input.contextWindowTokens) ? "full" : "retrieval";
}

/**
 * The request for one answer. In retrieval mode `hits` are segment ids ranked best first
 * (at most `CHAT_RETRIEVAL_HITS_MAX` are used); each brings `CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS`
 * neighbours on either side. Retrieved material may take up to half of what the fixed part
 * leaves; history gets the rest. When even the fixed part exceeds the budget the request
 * cannot be made: `llm_capability.context_length`.
 */
export function planChatRequest(input: ChatPlanInput, hits: readonly string[] = []): ChatRequestPlan {
  const mode = chooseChatMode(input);
  const budget = chatBudget(input.contextWindowTokens);
  const allTurns = input.turns.reduce((sum, turn) => sum + turnTokens(turn), 0);
  if (input.revisionId === undefined) {
    return planMetadataRequest(input, budget, allTurns);
  }
  if (mode === "full") {
    const table = tableOf(input.revisionId, input.segments);
    const system = systemText(input, fullContext(input, table), table);
    const current = currentTurnText(input, table);
    const avail = budget - estimateTokens(system) - estimateTokens(current);
    const carried = fitTurns(input.turns, avail);
    return finish(mode, table, system, current, input, carried, allTurns > avail);
  }

  const ordered = [...input.segments].sort((a, b) => a.ordinal - b.ordinal);
  const shellTable = new AliasTable([]);
  const shellSystem = systemText(input, retrievalContext(input, shellTable, [], []), shellTable);
  const avail = budget - estimateTokens(shellSystem) - estimateTokens(currentTurnText(input, shellTable)) - quoteAllowance(input);
  if (avail <= 0) {
    throw amberError("llm_capability", "the fixed part of a chat request exceeds the model's budget", { code: "llm_capability.context_length" });
  }
  const chapterSegments = currentChapterSegments(input, ordered);
  const groups = hitGroups(ordered, hits);
  const material = [...chapterSegments, ...groups.flat()].reduce((sum, segment) => sum + lineTokens(segment), 0);
  const turnsBudget = avail - Math.min(material, Math.floor(avail / 2));
  const carried = fitTurns(input.turns, turnsBudget);
  const used = input.turns.slice(input.turns.length - carried).reduce((sum, turn) => sum + turnTokens(turn), 0);
  let room = avail - used;

  const included = new Set<string>();
  const chapterPart: TranscriptSegment[] = [];
  let chapterRoom = Math.floor(room / 2);
  for (const segment of byDistance(chapterSegments, anchorMs(input, ordered))) {
    const cost = lineTokens(segment);
    if (cost > chapterRoom) {
      break;
    }
    chapterRoom -= cost;
    room -= cost;
    chapterPart.push(segment);
    included.add(segment.id);
  }
  const hitPart: TranscriptSegment[] = [];
  for (const group of groups) {
    const fresh = group.filter((segment) => !included.has(segment.id));
    const cost = fresh.reduce((sum, segment) => sum + lineTokens(segment), 0);
    if (cost > room) {
      continue;
    }
    room -= cost;
    for (const segment of fresh) {
      hitPart.push(segment);
      included.add(segment.id);
    }
  }
  const quoted = input.quote === undefined ? undefined : ordered.find((segment) => segment.id === input.quote?.segmentId);
  const shown = ordered.filter((segment) => included.has(segment.id) || segment.id === quoted?.id);
  const table = tableOf(input.revisionId, shown);
  const system = systemText(input, retrievalContext(input, table, byTime(chapterPart), byTime(hitPart)), table);
  return finish(mode, table, system, currentTurnText(input, table), input, carried, allTurns > turnsBudget);
}

/**
 * The metadata mode: the Content's basic facts always go in; imported reference
 * texts may take up to half of what the fixed part leaves, the last one cut to fit, and
 * history gets the rest. Nothing can be cited, so the alias table is empty.
 */
function planMetadataRequest(input: ChatPlanInput, budget: number, allTurns: number): ChatRequestPlan {
  const table = new AliasTable([]);
  const facts = metadataFacts(input.metadata);
  const current = currentTurnText(input, table);
  const avail = budget - estimateTokens(metadataSystem(input, facts, table)) - estimateTokens(current);
  if (avail <= 0) {
    throw amberError("llm_capability", "the fixed part of a chat request exceeds the model's budget", { code: "llm_capability.context_length" });
  }
  const references = input.metadata?.references ?? [];
  const material = references.reduce((sum, text) => sum + estimateTokens(`${text}\n`), estimateTokens(`${CHAT_REFERENCE_HEADING}\n`));
  const turnsBudget = avail - (references.length === 0 ? 0 : Math.min(material, Math.floor(avail / 2)));
  const carried = fitTurns(input.turns, turnsBudget);
  const used = input.turns.slice(input.turns.length - carried).reduce((sum, turn) => sum + turnTokens(turn), 0);
  let room = avail - used - estimateTokens(`${CHAT_REFERENCE_HEADING}\n`);
  const kept: string[] = [];
  for (const text of references) {
    const cost = estimateTokens(`${text}\n`);
    if (cost <= room) {
      kept.push(text);
      room -= cost;
      continue;
    }
    const cut = prefixWithin(text, room);
    if (cut !== "") {
      kept.push(cut);
    }
    break;
  }
  const section = kept.length === 0 ? facts : [...facts, CHAT_REFERENCE_HEADING, ...kept];
  return finish("metadata", table, metadataSystem(input, section, table), current, input, carried, allTurns > turnsBudget);
}

function metadataSystem(input: ChatPlanInput, section: readonly string[], table: AliasTable): string {
  return renderPrompt(CHAT_SYSTEM_METADATA_PROMPT.text, { ...commonSlots(input, table), metadata_section: section.join("\n") });
}

/** Title, source and channel, duration and publication date, each when known. */
function metadataFacts(metadata: ChatMetadata | undefined): string[] {
  if (metadata === undefined) {
    return [];
  }
  const facts: string[] = [];
  if (metadata.title !== undefined) facts.push(`${SECTION.title}${oneLine(metadata.title)}`);
  facts.push(`${SECTION.source}${SOURCE_NAMES[metadata.source]}${metadata.channelTitle === undefined ? "" : ` · ${oneLine(metadata.channelTitle)}`}`);
  if (metadata.durationMs !== undefined) facts.push(`${SECTION.duration}${clock(metadata.durationMs)}`);
  if (metadata.publishedAt !== undefined) facts.push(`${SECTION.published}${new Date(metadata.publishedAt).toISOString().slice(0, 10)}`);
  return facts;
}

/** The longest prefix of `text` whose estimate fits `room`; empty when nothing does. */
function prefixWithin(text: string, room: number): string {
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(`${chars.slice(0, mid).join("")}\n`) <= room) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return chars.slice(0, low).join("");
}

/**
 * The turns a compaction folds in: every uncompacted turn except the most recent
 * `CHAT_RECENT_TURNS`; empty when there is nothing older to fold.
 */
export function turnsToCompact<T>(turns: readonly T[]): T[] {
  return turns.slice(0, Math.max(0, turns.length - CHAT_RECENT_TURNS));
}

/**
 * The `chat.compaction` prompt over the current compaction and the turns to fold. Canonical markers are
 * renumbered `[[s<n>]]` across both by `table` (see `compactionAliasTable`).
 */
export function compactionPrompt(input: { compaction?: string; turns: readonly ChatTurnText[]; outputLanguage: string }, table: AliasTable): string {
  const turns = input.turns
    .map((turn) => {
      const user = `${SECTION.turnUser}${userText(turn.question, turn.quote, table)}`;
      return turn.answer === "" ? user : `${user}\n${SECTION.turnAssistant}${aliased(turn.answer, table)}`;
    })
    .join("\n\n");
  return renderPrompt(CHAT_COMPACTION_PROMPT.text, {
    carry_budget: String(CHAT_COMPACTION_BUDGET_CHARS),
    output_language: outputLanguageName(input.outputLanguage),
    compaction: input.compaction === undefined ? "" : aliased(input.compaction, table),
    turns,
  });
}

/** The segment ids a set of stored texts cites, in order of first appearance. */
export function citedSegmentIds(texts: readonly string[]): string[] {
  const ids: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(CANONICAL)) {
      const id = match[1] as string;
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/** An alias table over sentences known only by their citation (compaction input). */
export function citationAliasTable(sentences: ReadonlyArray<{ transcriptRevisionId: string; segmentId: string; text: string }>): AliasTable {
  return new AliasTable(
    sentences.map(
      (sentence, index): AliasEntry => ({
        alias: index + 1,
        citation: { transcriptRevisionId: sentence.transcriptRevisionId, segmentId: sentence.segmentId as AliasEntry["citation"]["segmentId"] },
        text: sentence.text,
      }),
    ),
  );
}

/**
 * Canonical markers → the request's aliases; markers of sentences not shown are dropped,
 * and so are web citations, which belong to the answer that made them.
 */
export function aliased(text: string, table: AliasTable): string {
  return text
    .replace(CANONICAL, (_marker, id: string) => {
      const alias = table.aliasOf(id);
      return alias === undefined ? "" : `[[s${alias}]]`;
    })
    .replace(UNRESOLVED, "")
    .replace(WEB_MARKER, "");
}

function finish(
  mode: ChatMode,
  table: AliasTable,
  system: string,
  current: string,
  input: ChatPlanInput,
  carried: number,
  overBudget: boolean,
): ChatRequestPlan {
  const messages: LlmRequest["messages"] = [];
  let estimated = estimateTokens(system) + estimateTokens(current);
  for (const turn of input.turns.slice(input.turns.length - carried)) {
    if (turn.answer === "") {
      continue;
    }
    const user = userText(turn.question, turn.quote, table);
    const answer = aliased(turn.answer, table);
    estimated += estimateTokens(user) + estimateTokens(answer);
    messages.push({ role: "user", content: [{ type: "text", text: user }] }, { role: "assistant", content: [{ type: "text", text: answer }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: current }] });
  return { mode, table, system, messages, estimatedTokens: estimated, carriedTurns: carried, overBudget };
}

/** The most recent turns that fit `room`, but never fewer than `CHAT_RECENT_TURNS_MIN` (or all, if fewer exist). */
function fitTurns(turns: readonly ChatTurnText[], room: number): number {
  let used = 0;
  let count = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const cost = turnTokens(turns[index] as ChatTurnText);
    if (used + cost > room && count >= CHAT_RECENT_TURNS_MIN) {
      break;
    }
    used += cost;
    count += 1;
  }
  return count;
}

function tableOf(revisionId: string, segments: readonly TranscriptSegment[]): AliasTable {
  return new AliasTable(
    [...segments]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((segment, index) => ({ alias: index + 1, citation: { transcriptRevisionId: revisionId, segmentId: segment.id }, text: segment.text })),
  );
}

function systemText(input: ChatPlanInput, context: string, table: AliasTable): string {
  return renderPrompt(CHAT_SYSTEM_PROMPT.text, { ...commonSlots(input, table), context_section: context });
}

function fullContext(input: ChatPlanInput, table: AliasTable): string {
  const lines = table.entries.map((entry) => table.line(entry.alias));
  return [...summarySection(input, table), SECTION.transcript, ...lines].join("\n");
}

function retrievalContext(input: ChatPlanInput, table: AliasTable, chapter: readonly TranscriptSegment[], hits: readonly TranscriptSegment[]): string {
  const parts = [...summarySection(input, table)];
  if (input.chapters.length > 0) {
    parts.push(SECTION.chapters, ...input.chapters.map((chapter) => `- ${clock(chapter.startMs)} ${chapter.title}`));
  }
  const current = currentChapter(input);
  if (current !== undefined && chapter.length > 0) {
    parts.push(`${SECTION.currentChapter}${current.title}`, ...chapter.map((segment) => lineOf(segment, table)));
  }
  if (hits.length > 0) {
    parts.push(SECTION.hits, ...hits.map((segment) => lineOf(segment, table)));
  }
  return parts.join("\n");
}

function summarySection(input: ChatPlanInput, table: AliasTable): string[] {
  return input.summary === undefined || input.summary === "" ? [] : [SECTION.summary, aliased(input.summary, table)];
}

function currentTurnText(input: ChatPlanInput, table: AliasTable): string {
  return userText(input.question, input.quote, table);
}

function userText(question: string, quote: ChatQuoteText | undefined, table: AliasTable): string {
  if (quote === undefined) {
    return question;
  }
  const alias = table.aliasOf(quote.segmentId);
  const marker = alias === undefined ? "" : `[[s${alias}]] `;
  return `${CHAT_QUOTE_HEADING}${marker}${oneLine(quote.text)}\n${question}`;
}

/** Room a quote's alias marker may take once the table is known. */
function quoteAllowance(input: ChatPlanInput): number {
  return input.quote === undefined ? 0 : estimateTokens("[[s9999]] ");
}

function currentChapter(input: ChatPlanInput): ChatChapter | undefined {
  const at = input.positionMs ?? quoteStart(input);
  return at === undefined ? undefined : input.chapters.find((chapter) => chapter.startMs <= at && at < chapter.endMs);
}

function quoteStart(input: ChatPlanInput): number | undefined {
  const quoted = input.quote === undefined ? undefined : input.segments.find((segment) => segment.id === input.quote?.segmentId);
  return quoted?.startMs;
}

function currentChapterSegments(input: ChatPlanInput, ordered: readonly TranscriptSegment[]): TranscriptSegment[] {
  const chapter = currentChapter(input);
  return chapter === undefined ? [] : ordered.filter((segment) => segment.startMs >= chapter.startMs && segment.startMs < chapter.endMs);
}

function anchorMs(input: ChatPlanInput, ordered: readonly TranscriptSegment[]): number {
  return input.positionMs ?? quoteStart(input) ?? ordered[0]?.startMs ?? 0;
}

/** Segments nearest to `at` first; ties go to the earlier one. */
function byDistance(segments: readonly TranscriptSegment[], at: number): TranscriptSegment[] {
  const distance = (segment: TranscriptSegment): number => (at < segment.startMs ? segment.startMs - at : at >= segment.endMs ? at - segment.endMs : 0);
  return [...segments].sort((a, b) => distance(a) - distance(b) || a.ordinal - b.ordinal);
}

function byTime(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((a, b) => a.ordinal - b.ordinal);
}

/** Each hit with its neighbours, best hit first; a segment appears in its first group only. */
function hitGroups(ordered: readonly TranscriptSegment[], hits: readonly string[]): TranscriptSegment[][] {
  const position = new Map(ordered.map((segment, index) => [segment.id as string, index]));
  const seen = new Set<string>();
  const groups: TranscriptSegment[][] = [];
  for (const id of hits.slice(0, CHAT_RETRIEVAL_HITS_MAX)) {
    const index = position.get(id);
    if (index === undefined) {
      continue;
    }
    const group = ordered
      .slice(Math.max(0, index - CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS), index + CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS + 1)
      .filter((segment) => !seen.has(segment.id));
    for (const segment of group) {
      seen.add(segment.id);
    }
    if (group.length > 0) {
      groups.push(group);
    }
  }
  return groups;
}

function lineOf(segment: TranscriptSegment, table: AliasTable): string {
  const alias = table.aliasOf(segment.id);
  return alias === undefined ? oneLine(segment.text) : table.line(alias);
}

/** A line's cost with a generous alias marker, before the table is numbered. */
function lineTokens(segment: TranscriptSegment): number {
  return estimateTokens(`[[s9999]] ${oneLine(segment.text)}\n`);
}

function turnTokens(turn: ChatTurnText): number {
  const quote = turn.quote === undefined ? "" : `${CHAT_QUOTE_HEADING}[[s9999]] ${turn.quote.text}\n`;
  return estimateTokens(quote + stripMarkers(turn.question)) + estimateTokens(stripMarkers(turn.answer));
}

function stripMarkers(text: string): string {
  return text.replace(CANONICAL, "").replace(UNRESOLVED, "").replace(WEB_MARKER, "");
}

function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** `m:ss` or `h:mm:ss`, as in the chapter table of contents. */
function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
