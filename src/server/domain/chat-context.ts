import {
  CHAT_COMPACTION_BUDGET_CHARS,
  CHAT_RECENT_TURNS,
  CHAT_RECENT_TURNS_MIN,
  CHAT_RETRIEVAL_HITS_MAX,
  CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS,
  CONTEXT_SAFETY_RATIO,
  WEB_SEARCH_CONTEXT_MAX_TOKENS,
} from "../../shared/defaults.ts";
import type { SpeakerContextState } from "../../shared/dto/speaker-context.ts";
import type { ContentSourceKind, LlmProtocol } from "../../shared/enums.ts";
import {
  allTurnSections,
  clipNote,
  historyNotice,
  historyNoticeFragment,
  interleavedGroups,
  sampleSection,
  turnsShown,
  type HistoryNotice,
  type SpeakerClipSection,
  type SpeakerTurn,
} from "./chat-speakers.ts";
import { AliasTable, type AliasEntry } from "./citations.ts";
import { amberError } from "./errors.ts";
import type { LlmRequest } from "./llm.ts";
import {
  CHAT_COMPACTION_HEADING,
  CHAT_COMPACTION_PROMPT,
  CHAT_QUOTE_HEADING,
  CHAT_REFERENCE_HEADING,
  CHAT_WEB_HEADING,
  CHAT_WEB_NONE,
  chatModelSection,
  outputLanguageName,
  renderPrompt,
} from "./prompts.ts";
import type { SpeakerContextSpeaker, SpeakerFraming } from "./speaker-context.ts";
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
  /**
   * How what the answer said about who said what compares with now, by the speakers it was
   * given; absent when it was given none (it then never calls for a notice).
   */
  speakerState?: SpeakerContextState;
}

/**
 * How an answer reads the speakers of the revision it is grounded in. Present only when
 * that revision's speakers were reviewed and are read by speaker; without it a request is
 * exactly what it would be without speakers.
 */
export interface ChatSpeakerReading {
  /** Header lines over the revision's sentences in `ordinal` order (positions are indexes into that order). */
  framing: SpeakerFraming;
  /** The speakers the revision names, with the labels the model sees. */
  speakers: readonly SpeakerContextSpeaker[];
  /** Every turn of the revision, in order. */
  turns: readonly SpeakerTurn[];
  /**
   * The people the quoted text and question name, and what was found for them; absent when
   * there is no question (the context shown before asking), which never takes speaker clips.
   */
  person?: {
    /** Named speaker ids, `ordinal` order. */
    mentioned: readonly string[];
    /**
     * Ranked hits within each named person's sentences (segment ids), searched with the
     * names taken out; absent when nothing is left to search for.
     */
    speakerHits?: Readonly<Record<string, readonly string[]>>;
  };
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
  /**
   * The texts of the `chat.system` and `chat.system.metadata` prompts in effect for this
   * answer: the user's own versions or the builtin ones.
   */
  prompts: { system: string; metadata: string };
  /** The speakers this answer reads; absent: none. */
  speakers?: ChatSpeakerReading;
  /**
   * The speaker states of the current compaction's bases, judged like `ChatTurnText.speakerState`;
   * absent or empty when there is no compaction or no answer it absorbed read speakers.
   */
  compactionSpeakerStates?: readonly SpeakerContextState[];
  /**
   * Set while planning: older chat text goes in behind this notice, which opens the
   * compaction when there is one and otherwise the first history message sent.
   */
  historyNotice?: HistoryNotice;
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
  /** Retrieval took speaker clips: some person's material is a selection, not all their turns. */
  speakerClips?: true;
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
  const cost = turnCost(bare);
  const recent = bare.turns.slice(-CHAT_RECENT_TURNS_MIN).reduce((sum, turn) => sum + cost(turn), 0);
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
    compaction_section: compactionSection(input, table),
    web_section: webSection(input.web),
  };
}

/**
 * The `{{compaction_section}}`: the current compaction under its heading, with the history
 * notice in front when older chat text calls for one. Empty without a compaction: the notice
 * then opens the first history message instead (see `finish`), since in this slot it would
 * stand right before this answer's material and read as a warning about that.
 */
function compactionSection(input: ChatPlanInput, table: AliasTable): string {
  if (!hasCompaction(input)) {
    return "";
  }
  const body = `${CHAT_COMPACTION_HEADING}\n${aliased(input.compaction as string, table)}`;
  return input.historyNotice === undefined ? body : `${historyNoticeFragment(input.historyNotice).text}\n${body}`;
}

function hasCompaction(input: ChatPlanInput): boolean {
  return input.compaction !== undefined && input.compaction !== "";
}

/** The notice that opens the first history message: one is due and there is no compaction to stand before. */
function noticeInHistory(input: ChatPlanInput): HistoryNotice | undefined {
  return hasCompaction(input) ? undefined : input.historyNotice;
}

/** Room the notice takes when it opens the first history message; part of the fixed part. */
function noticeAllowance(input: ChatPlanInput): number {
  const notice = noticeInHistory(input);
  return notice === undefined ? 0 : estimateTokens(`${historyNoticeFragment(notice).text}\n`);
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
  const fixed = estimateTokens(systemText(input, fullContext(input, table), table)) + estimateTokens(currentTurnText(input, table)) + noticeAllowance(input);
  const cost = turnCost(input);
  const recent = input.turns.slice(-CHAT_RECENT_TURNS_MIN).reduce((sum, turn) => sum + cost(turn), 0);
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
  if (input.historyNotice !== undefined) {
    return carrying(planOnce(input, hits), input);
  }
  // The notice is part of the request it is decided for: it lengthens the fixed part, which
  // can move the mode between full and retrieval and so carry more or fewer history turns,
  // and those turns decide the notice. Each level is planned in turn, lightest first, and
  // the first whose plan carries history calling for exactly that level is sent. Without
  // speakers the first plan already holds, so such a request is planned once, as before.
  const planned: Array<{ input: ChatPlanInput; plan: ChatRequestPlan; due: HistoryNotice | undefined }> = [];
  for (const level of NOTICE_LEVELS) {
    const noticed = level === undefined ? input : { ...input, historyNotice: level };
    const plan = planOnce(noticed, hits);
    const due = noticeDue(input, plan.carriedTurns);
    if (due === level) {
      return carrying(plan, noticed);
    }
    planned.push({ input: noticed, plan, due });
  }
  // No level holds (each one moves the history into calling for another): take the lightest
  // whose history calls for no stronger notice than it carries, so older text is never sent
  // under a lighter warning than it needs; at worst that is the caution, which always holds.
  const safe = planned.find((entry) => noticeRank(entry.due) <= noticeRank(entry.input.historyNotice)) as (typeof planned)[number];
  return carrying(safe.plan, safe.input);
}

/** The notice levels from lightest to strongest; each is stronger than every one before it. */
const NOTICE_LEVELS: ReadonlyArray<HistoryNotice | undefined> = [undefined, "unverified", "caution"];

function noticeRank(notice: HistoryNotice | undefined): number {
  return NOTICE_LEVELS.indexOf(notice);
}

/**
 * Refuses a request whose system prompt lost a speaker fragment it must carry: the rules
 * when the answer reads speakers (they ride in `{{context_section}}`), the history notice
 * when older chat text calls for it and there is a compaction (it rides in
 * `{{compaction_section}}`; without one it opens the first history message, which the
 * prompt text cannot lose). The answer records the speakers it was given, so it must never
 * be sent without the model being shown them. A prompt saved through the settings keeps
 * both slots; this guards any text that did not.
 */
function carrying(plan: ChatRequestPlan, input: ChatPlanInput): ChatRequestPlan {
  const rules = input.speakers?.framing.rules;
  const notice = input.historyNotice;
  const missing = [
    ...(rules !== undefined && plan.mode !== "metadata" && !plan.system.includes(rules.text) ? ["{{context_section}}"] : []),
    ...(notice !== undefined && hasCompaction(input) && !plan.system.includes(historyNoticeFragment(notice).text) ? ["{{compaction_section}}"] : []),
  ];
  if (missing.length > 0) {
    throw amberError("invalid_request", "the chat system prompt has no slot to carry the speaker fragments in", {
      code: "invalid_request.prompt_protocol",
      details: { missing, unknown: [] },
    });
  }
  return plan;
}

/**
 * The notice the older chat text a plan carries calls for: its answers that were given
 * speakers and have text (a failed answer adds none), and the compaction's bases.
 */
function noticeDue(input: ChatPlanInput, carried: number): HistoryNotice | undefined {
  const answers = input.turns.slice(input.turns.length - carried).filter((turn) => turn.answer !== "");
  const compaction = hasCompaction(input) ? (input.compactionSpeakerStates ?? []) : [];
  return historyNotice([...answers.map((turn) => turn.speakerState), ...compaction]);
}

function planOnce(input: ChatPlanInput, hits: readonly string[]): ChatRequestPlan {
  const mode = chooseChatMode(input);
  const budget = chatBudget(input.contextWindowTokens);
  const cost = turnCost(input);
  const allTurns = input.turns.reduce((sum, turn) => sum + cost(turn), 0);
  if (input.revisionId === undefined) {
    return planMetadataRequest(input, budget, allTurns);
  }
  if (mode === "full") {
    const table = tableOf(input.revisionId, input.segments);
    const system = systemText(input, fullContext(input, table), table);
    const current = currentTurnText(input, table);
    const avail = budget - estimateTokens(system) - estimateTokens(current) - noticeAllowance(input);
    const carried = fitTurns(input.turns, avail, cost);
    return finish(mode, table, system, current, input, carried, allTurns > avail);
  }

  const ordered = [...input.segments].sort((a, b) => a.ordinal - b.ordinal);
  const shellTable = new AliasTable([]);
  const shellSystem = systemText(input, retrievalContext(input, shellTable, [], []), shellTable);
  const avail = budget - estimateTokens(shellSystem) - estimateTokens(currentTurnText(input, shellTable)) - quoteAllowance(input) - noticeAllowance(input);
  if (avail <= 0) {
    throw amberError("llm_capability", "the fixed part of a chat request exceeds the model's budget", { code: "llm_capability.context_length" });
  }
  if (input.speakers !== undefined) {
    return planSpeakerRetrieval(input, input.speakers, ordered, hits, avail, allTurns);
  }
  const chapterSegments = currentChapterSegments(input, ordered);
  const groups = hitGroups(ordered, hits);
  const material = [...chapterSegments, ...groups.flat()].reduce((sum, segment) => sum + lineTokens(segment), 0);
  const turnsBudget = avail - Math.min(material, Math.floor(avail / 2));
  const carried = fitTurns(input.turns, turnsBudget, cost);
  const used = input.turns.slice(input.turns.length - carried).reduce((sum, turn) => sum + cost(turn), 0);
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
  const avail = budget - estimateTokens(metadataSystem(input, facts, table)) - estimateTokens(current) - noticeAllowance(input);
  if (avail <= 0) {
    throw amberError("llm_capability", "the fixed part of a chat request exceeds the model's budget", { code: "llm_capability.context_length" });
  }
  const references = input.metadata?.references ?? [];
  const material = references.reduce((sum, text) => sum + estimateTokens(`${text}\n`), estimateTokens(`${CHAT_REFERENCE_HEADING}\n`));
  const turnsBudget = avail - (references.length === 0 ? 0 : Math.min(material, Math.floor(avail / 2)));
  const turnCostOf = turnCost(input);
  const carried = fitTurns(input.turns, turnsBudget, turnCostOf);
  const used = input.turns.slice(input.turns.length - carried).reduce((sum, turn) => sum + turnCostOf(turn), 0);
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
  return renderPrompt(input.prompts.metadata, { ...commonSlots(input, table), metadata_section: section.join("\n") });
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
  // Without a compaction the notice opens the oldest history message that is sent.
  let notice = noticeInHistory(input);
  for (const turn of input.turns.slice(input.turns.length - carried)) {
    if (turn.answer === "") {
      continue;
    }
    const asked = userText(turn.question, turn.quote, table);
    const user = notice === undefined ? asked : `${historyNoticeFragment(notice).text}\n${asked}`;
    notice = undefined;
    const answer = aliased(turn.answer, table);
    estimated += estimateTokens(user) + estimateTokens(answer);
    messages.push({ role: "user", content: [{ type: "text", text: user }] }, { role: "assistant", content: [{ type: "text", text: answer }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: current }] });
  return { mode, table, system, messages, estimatedTokens: estimated, carriedTurns: carried, overBudget };
}

/** The most recent turns that fit `room`, but never fewer than `CHAT_RECENT_TURNS_MIN` (or all, if fewer exist). */
function fitTurns(turns: readonly ChatTurnText[], room: number, costOf: (turn: ChatTurnText) => number): number {
  let used = 0;
  let count = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const cost = costOf(turns[index] as ChatTurnText);
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

/** The `chat.system` prompt; with speakers the rules fragment opens the material (`{{context_section}}`). */
function systemText(input: ChatPlanInput, context: string, table: AliasTable): string {
  const value = input.speakers === undefined ? context : input.speakers.framing.slotValue(context);
  return renderPrompt(input.prompts.system, { ...commonSlots(input, table), context_section: value });
}

/** The whole revision, one block: with speakers a header line opens it and marks every change of speaker. */
function fullContext(input: ChatPlanInput, table: AliasTable): string {
  const lines = table.entries.map((entry) => table.line(entry.alias));
  const shown = input.speakers === undefined ? lines : input.speakers.framing.block(lines, 0);
  return [...summarySection(input, table), SECTION.transcript, ...shown].join("\n");
}

function retrievalContext(input: ChatPlanInput, table: AliasTable, chapter: readonly TranscriptSegment[], hits: readonly TranscriptSegment[]): string {
  return retrievalContextOf(
    input,
    table,
    chapter.map((segment) => lineOf(segment, table)),
    hits.map((segment) => lineOf(segment, table)),
  );
}

/** Summary, chapter list, the current chapter's lines and the retrieved lines, each part only when it has something. */
function retrievalContextOf(input: ChatPlanInput, table: AliasTable, chapterLines: readonly string[], hitLines: readonly string[]): string {
  const parts = [...summarySection(input, table)];
  if (input.chapters.length > 0) {
    parts.push(SECTION.chapters, ...input.chapters.map((chapter) => `- ${clock(chapter.startMs)} ${chapter.title}`));
  }
  const current = currentChapter(input);
  if (current !== undefined && chapterLines.length > 0) {
    parts.push(`${SECTION.currentChapter}${current.title}`, ...chapterLines);
  }
  if (hitLines.length > 0) {
    parts.push(SECTION.hits, ...hitLines);
  }
  return parts.join("\n");
}

/** A sentence line as planned, before the aliases are numbered: with the widest marker the table may give it. */
function planLine(segment: TranscriptSegment): string {
  return `[[s9999]] ${oneLine(segment.text)}`;
}

/**
 * What adding sentence `position` to the sentences `set` already sent together adds, header
 * lines included: its line, its header when it opens a block or the speaker changes there,
 * less the header the next sentence no longer needs once this one joins it to a block. The
 * sum over any order of additions is the exact cost of the final set.
 */
function addedCost(framing: SpeakerFraming, ordered: readonly TranscriptSegment[], set: ReadonlySet<number>, position: number): number {
  const own = framing.cost(planLine(ordered[position] as TranscriptSegment), position, !set.has(position - 1));
  const next = position + 1;
  if (!set.has(next)) {
    return own;
  }
  const line = planLine(ordered[next] as TranscriptSegment);
  return own - (framing.cost(line, next, true) - framing.cost(line, next, false));
}

/** The cost of sending `positions` together. */
function setCost(framing: SpeakerFraming, ordered: readonly TranscriptSegment[], positions: Iterable<number>): number {
  const set = new Set<number>();
  let cost = 0;
  for (const position of positions) {
    if (set.has(position)) continue;
    cost += addedCost(framing, ordered, set, position);
    set.add(position);
  }
  return cost;
}

/** Sorted positions cut into runs of consecutive sentences. */
function runsOf(positions: Iterable<number>): number[][] {
  const runs: number[][] = [];
  for (const position of [...positions].sort((a, b) => a - b)) {
    const run = runs.at(-1);
    if (run !== undefined && run.at(-1) === position - 1) {
      run.push(position);
    } else {
      runs.push([position]);
    }
  }
  return runs;
}

/** The lines of `positions`, each run of consecutive sentences a block with its header lines. */
function framedLines(framing: SpeakerFraming, ordered: readonly TranscriptSegment[], positions: Iterable<number>, table: AliasTable): string[] {
  return runsOf(positions).flatMap((run) => framing.block(run.map((position) => lineOf(ordered[position] as TranscriptSegment, table)), run[0] as number));
}

/** A section of retrieved material: a person's (with its coverage line) or, without `clip`, the plain hits. */
interface PlannedSection {
  clip?: SpeakerClipSection;
  set: Set<number>;
}

/** Sentences one step of planning added: a retrieved group to `section`, or (without one) a current-chapter sentence. */
interface Addition {
  section?: number;
  positions: number[];
}

/**
 * Retrieval when the answer reads speakers. The current chapter and every retrieved group
 * carry header lines and are budgeted with them. Without a question about someone the hits
 * are taken as without speakers. A question naming people takes, for each of them, every
 * turn with the sentence before it when all of that fits the room for retrieved material;
 * otherwise each named person gets hits searched within their own sentences (when the
 * question has words besides the names and that search found something) or representative
 * turns, sharing the room. With nobody named and no hit at all, every speaker gets
 * representative turns. Each person's material opens with a line saying how much of their
 * speech it is; a group that does not fit is skipped, as hits are. History is costed as it
 * is sent, and a rendered request still over the budget gives back what was added last.
 */
function planSpeakerRetrieval(
  input: ChatPlanInput,
  speakers: ChatSpeakerReading,
  ordered: readonly TranscriptSegment[],
  hits: readonly string[],
  avail: number,
  allTurns: number,
): ChatRequestPlan {
  const revisionId = input.revisionId as string;
  const framing = speakers.framing;
  const position = new Map(ordered.map((segment, index) => [segment.id as string, index]));
  const positionOf = (segment: TranscriptSegment): number => position.get(segment.id) as number;
  const chapterSegments = currentChapterSegments(input, ordered);
  const chapterMaterial = setCost(framing, ordered, chapterSegments.map(positionOf));
  const anchor = anchorMs(input, ordered);

  const allocate = (material: number) => {
    const turnsBudget = avail - Math.min(chapterMaterial + material, Math.floor(avail / 2));
    const carried = fitTurns(input.turns, turnsBudget, sentTurnTokens);
    const used = input.turns.slice(input.turns.length - carried).reduce((sum, turn) => sum + sentTurnTokens(turn), 0);
    let room = avail - used;
    const chapter = new Set<number>();
    let chapterRoom = Math.floor(room / 2);
    for (const segment of byDistance(chapterSegments, anchor)) {
      const at = positionOf(segment);
      const cost = addedCost(framing, ordered, chapter, at);
      if (cost > chapterRoom) {
        break;
      }
      chapterRoom -= cost;
      room -= cost;
      chapter.add(at);
    }
    return { turnsBudget, carried, chapter, room };
  };

  const noteCost = (clip: SpeakerClipSection): number => estimateTokens(`${clipNote(clip.label, clip.turns, clip.complete ? "all" : clip.turns)}\n`);
  const materialOf = (clips: ReadonlyArray<SpeakerClipSection | undefined>, groups: ReadonlyArray<{ section: number; group: number[] }>): number =>
    clips.reduce((sum, clip) => sum + (clip === undefined ? 0 : noteCost(clip)), 0) + groups.reduce((sum, { group }) => sum + setCost(framing, ordered, group), 0);

  /** Takes the groups in order while they fit; reports whether any had to be skipped, and what each taken group added. */
  const pick = (clips: ReadonlyArray<SpeakerClipSection | undefined>, groups: ReadonlyArray<{ section: number; group: number[] }>, start: { chapter: Set<number>; room: number }) => {
    const included = new Set(start.chapter);
    const sections: PlannedSection[] = clips.map((clip) => (clip === undefined ? { set: new Set<number>() } : { clip, set: new Set<number>() }));
    const added: Addition[] = [];
    let room = start.room;
    let skipped = false;
    for (const { section, group } of groups) {
      const planned = sections[section] as PlannedSection;
      const fresh = group.filter((at) => !included.has(at));
      if (fresh.length === 0) {
        continue;
      }
      const trial = new Set(planned.set);
      let cost = planned.clip !== undefined && planned.set.size === 0 ? noteCost(planned.clip) : 0;
      for (const at of fresh) {
        cost += addedCost(framing, ordered, trial, at);
        trial.add(at);
      }
      if (cost > room) {
        skipped = true;
        continue;
      }
      room -= cost;
      for (const at of fresh) {
        planned.set.add(at);
        included.add(at);
      }
      added.push({ section, positions: fresh });
    }
    return { sections, skipped, added };
  };

  const regularGroups = hitGroups(ordered, hits).map((group) => ({ section: 0, group: group.map(positionOf) }));
  const bySpeaker = new Map(speakers.speakers.map((speaker) => [speaker.id, speaker]));
  const person = speakers.person;
  const named = (person?.mentioned ?? []).flatMap((id) => {
    const speaker = bySpeaker.get(id);
    return speaker === undefined ? [] : [speaker];
  });
  const turnsOfSpeaker = (id: string): number => speakers.turns.filter((turn) => turn.speakerId === id).length;

  let clips: Array<SpeakerClipSection | undefined> = [undefined];
  let groups = regularGroups;
  let allocation = allocate(materialOf(clips, groups));
  let picked = pick(clips, groups, allocation);
  if (person !== undefined && named.length > 0) {
    const complete = allTurnSections(speakers.turns, named);
    const all = complete.flatMap((section, index) => section.groups.map((group) => ({ section: index, group })));
    allocation = allocate(materialOf(complete, all));
    picked = pick(complete, all, allocation);
    clips = complete;
    if (picked.skipped) {
      const partial = named.map((speaker) => {
        const own = person.speakerHits?.[speaker.id] ?? [];
        const ownGroups = hitGroups(ordered, own).map((group) => group.map(positionOf));
        return ownGroups.length > 0
          ? { speakerId: speaker.id, label: speaker.label, turns: turnsOfSpeaker(speaker.id), complete: false, groups: ownGroups }
          : sampleSection(speakers.turns, speaker, ordered);
      });
      const order = interleavedGroups(partial);
      allocation = allocate(materialOf(partial, order));
      picked = pick(partial, order, allocation);
      clips = partial;
    }
  } else if (person !== undefined && regularGroups.length === 0 && speakers.speakers.length > 0) {
    const samples = speakers.speakers.map((speaker) => sampleSection(speakers.turns, speaker, ordered));
    const order = interleavedGroups(samples);
    allocation = allocate(materialOf(samples, order));
    picked = pick(samples, order, allocation);
    clips = samples;
  }

  const quoted = input.quote === undefined ? undefined : position.get(input.quote.segmentId);
  const chapter = new Set(allocation.chapter);
  const sections = picked.sections;
  /** Sections of every turn of a person that lost a group while trimming: no longer all of it. */
  const trimmed = new Set<number>();
  const completeShown = (index: number): boolean => sections[index]?.clip?.complete === true && !trimmed.has(index);
  const render = (): ChatRequestPlan => {
    const included = new Set([...chapter, ...sections.flatMap((section) => [...section.set])]);
    const shown = ordered.filter((_segment, index) => included.has(index) || index === quoted);
    const table = tableOf(revisionId, shown);
    const hitLines = sections.flatMap((section, index) => {
      if (section.set.size === 0) {
        return [];
      }
      const lines = framedLines(framing, ordered, section.set, table);
      if (section.clip === undefined) {
        return lines;
      }
      const clip = section.clip;
      const note = clipNote(clip.label, clip.turns, completeShown(index) ? "all" : turnsShown(speakers.turns, clip.speakerId, section.set));
      return [note, ...lines];
    });
    const chapterLines = framedLines(framing, ordered, chapter, table);
    const system = systemText(input, retrievalContextOf(input, table, chapterLines, hitLines), table);
    return finish("retrieval", table, system, currentTurnText(input, table), input, allocation.carried, allTurns > allocation.turnsBudget);
  };

  // The material was budgeted line by line with its header lines, but headings, aliases and
  // the clip lines are only known once rendered. A request over the budget gives back what
  // was added last (retrieved groups latest first, then the current chapter's sentences
  // farthest first) rather than lose a header line or fail; only when nothing is left to
  // give back does it fail.
  const additions: Addition[] = [...[...chapter].map((at) => ({ positions: [at] })), ...picked.added];
  const budget = chatBudget(input.contextWindowTokens);
  let plan = render();
  while (plan.estimatedTokens > budget && additions.length > 0) {
    const last = additions.pop() as Addition;
    const from = last.section === undefined ? chapter : (sections[last.section] as PlannedSection).set;
    for (const at of last.positions) {
      from.delete(at);
    }
    if (last.section !== undefined) {
      trimmed.add(last.section);
    }
    plan = render();
  }
  if (!plan.overBudget && plan.estimatedTokens > budget) {
    throw amberError("llm_capability", "a chat request with speaker headers exceeds the model's budget", { code: "llm_capability.context_length" });
  }
  const clipped = sections.some((section, index) => section.clip !== undefined && !completeShown(index) && section.set.size > 0);
  return clipped ? { ...plan, speakerClips: true } : plan;
}

function summarySection(input: ChatPlanInput, table: AliasTable): string[] {
  return input.summary === undefined || input.summary === "" ? [] : [SECTION.summary, aliased(input.summary, table)];
}

function currentTurnText(input: ChatPlanInput, table: AliasTable): string {
  return userText(input.question, input.quote, table, quoteHeader(input));
}

/**
 * The header line of the quoted sentence when this answer reads speakers and the sentence
 * belongs to the revision it reads; a sentence quoted from another revision has no speaker
 * the model could check against the material.
 */
function quoteHeader(input: ChatPlanInput): string | undefined {
  const speakers = input.speakers;
  const quote = input.quote;
  if (speakers === undefined || quote === undefined) {
    return undefined;
  }
  const position = [...input.segments].sort((a, b) => a.ordinal - b.ordinal).findIndex((segment) => segment.id === quote.segmentId);
  return position < 0 ? undefined : speakers.framing.block([""], position)[0];
}

function userText(question: string, quote: ChatQuoteText | undefined, table: AliasTable, header?: string): string {
  if (quote === undefined) {
    return question;
  }
  const alias = table.aliasOf(quote.segmentId);
  const marker = alias === undefined ? "" : `[[s${alias}]] `;
  if (header !== undefined) {
    return `${CHAT_QUOTE_HEADING}\n${header}\n${marker}${oneLine(quote.text)}\n${question}`;
  }
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

/**
 * What a history turn is planned to cost. Without speakers it is the long-standing estimate
 * (stored markers left out). An answer that reads speakers is checked against its budget
 * once rendered, so there its history is costed as it will be sent: each stored marker as
 * the widest alias it may become, the question as it is written.
 */
function turnCost(input: ChatPlanInput): (turn: ChatTurnText) => number {
  return input.speakers === undefined ? turnTokens : sentTurnTokens;
}

function turnTokens(turn: ChatTurnText): number {
  const quote = turn.quote === undefined ? "" : `${CHAT_QUOTE_HEADING}[[s9999]] ${turn.quote.text}\n`;
  return estimateTokens(quote + stripMarkers(turn.question)) + estimateTokens(stripMarkers(turn.answer));
}

/** An upper bound of a history turn as `finish` renders it: never below what is sent. */
function sentTurnTokens(turn: ChatTurnText): number {
  const quote = turn.quote === undefined ? "" : `${CHAT_QUOTE_HEADING}[[s9999]] ${oneLine(turn.quote.text)}\n`;
  const answer = turn.answer.replace(CANONICAL, "[[s9999]]").replace(UNRESOLVED, "").replace(WEB_MARKER, "");
  return estimateTokens(quote + turn.question) + estimateTokens(answer);
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
