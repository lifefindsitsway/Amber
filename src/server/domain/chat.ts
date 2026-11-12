import type { ChatMessageStatus } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import type { Citation } from "./artifact.ts";
import type { ModelRefSnapshot, PromptRef } from "./model-ref.ts";
import type { SpeakerContextSnapshot } from "./speaker-context.ts";
import type { ChatWebSearch } from "./web-search.ts";

/**
 * One conversation about a Content; a Content may have several. Its title and latest message
 * time are derived from its messages, never stored.
 */
export interface ChatThread {
  id: string;
  contentId: string;
  currentCompactionId?: string;
  /** The user's own title; absent: the title is derived from the first question. */
  customTitle?: string;
  /** When it was pinned; pinned threads list first. */
  pinnedAt?: number;
  createdAt: number;
}

/**
 * Rolling summary produced by the chat context policy; an AI artifact with provenance. Its
 * body, model and prompt never change; `throughMessageId` only moves to an earlier kept
 * message when the turn it ended on is deleted.
 */
export interface ChatCompaction {
  id: string;
  threadId: string;
  throughMessageId: string;
  body: string;
  modelRef: ModelRefSnapshot;
  promptRef: PromptRef;
  promptSnapshot: string;
  /**
   * What the absorbed answers that read speakers (and those of the compaction it replaced)
   * were based on, one entry per transcript revision and speaker snapshot. Written with the
   * row and never changed, so whether its text still holds can be judged sentence by
   * sentence after those answers are deleted. Absent: no absorbed answer read speakers.
   */
  speakerBases?: ChatSpeakerBasis[];
  createdAt: number;
}

/**
 * The speaker basis of an answer a compaction absorbed: enough to compare who said each
 * sentence it read with the current primary again, not just a digest.
 */
export interface ChatSpeakerBasis {
  transcriptRevisionId: string;
  speakerContext: SpeakerContextSnapshot;
  /** The sentences the absorbed answers on this basis cited. */
  citedSegmentIds: string[];
}

/**
 * The material an answer was finally planned with, written once planning (web material,
 * compaction) is done and before the answer streams. Recorded only when it says something
 * the estimate shown before asking cannot: the answer read speakers (`speakerClips` = some
 * person's material is a selection), or the default summary was left out because its
 * speakers no longer hold (`summaryOmitted`).
 */
export interface ChatContextUsed {
  mode: "full" | "retrieval" | "metadata";
  speakerClips?: true;
  summaryOmitted?: true;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  /** Citations appear as canonical `[[seg:<segmentId>]]` markers. */
  text: string;
  /** A half-streamed answer must never look complete after a reload. */
  status: ChatMessageStatus;
  modelRef?: ModelRefSnapshot;
  /** Fixed to the primary revision at the time the message was answered. */
  contextTranscriptRevisionId?: string;
  /**
   * On an answer: the speakers it was given, written when the attempt is created and kept
   * whether it completes, fails or is interrupted. Absent when it was given none.
   */
  speakerContext?: SpeakerContextSnapshot;
  /** On an answer: the material it was finally planned with; kept whether it completes, fails or is interrupted. */
  contextUsed?: ChatContextUsed;
  citations: Citation[];
  suggestions?: string[];
  /** The web search of an answer; absent when none was asked for. */
  webSearch?: ChatWebSearch;
  /** On a retry's answer: the answer it replaces. */
  replacesMessageId?: string;
  /** Why a `failed` answer failed. */
  error?: AppError;
  createdAt: number;
  /** When an answer reached its final state; absent while streaming and on answers stored before it was recorded. */
  finishedAt?: number;
}

/** A thread's messages grouped into turns: a question with every answer attempt that followed it. */
export interface ChatTurn {
  user: ChatMessage;
  /** Oldest first; a retry appends an attempt, a successful retry removes the one it replaced. */
  attempts: ChatMessage[];
}

/**
 * Groups messages (oldest first) into turns: a user message and every assistant message up
 * to the next user message. Assistant messages before the first question belong to no turn.
 */
export function groupTurns(messages: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message, attempts: [] });
    } else {
      turns.at(-1)?.attempts.push(message);
    }
  }
  return turns;
}

/**
 * The answer a turn stands for in display, context, compaction, deletion and retry: its
 * last `complete` attempt, else its last attempt; absent while it has none.
 */
export function effectiveAnswer(turn: ChatTurn): ChatMessage | undefined {
  return turn.attempts.findLast((attempt) => attempt.status === "complete") ?? turn.attempts.at(-1);
}

/** The last message of a turn: where a compaction that folds it ends. */
export function lastMessageOf(turn: ChatTurn): ChatMessage {
  return turn.attempts.at(-1) ?? turn.user;
}

/**
 * A thread's title: the first line of its first question, cut to `maxChars` code points;
 * absent while it has no question. Derived on every read, so it follows deletions.
 */
export function chatThreadTitle(firstQuestion: string | undefined, maxChars: number): string | undefined {
  const line = firstQuestion?.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line === "" ? undefined : [...line].slice(0, maxChars).join("");
}
