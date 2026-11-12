import { CHAT_RETRIEVAL_HITS_MAX } from "../../shared/defaults.ts";
import type { SpeakerContextDto } from "../../shared/dto/speaker-context.ts";
import type { ChatSpeakerReading } from "../domain/chat-context.ts";
import { carriedSummary, hasSearchTerms, mentionedSpeakers, perSpeakerHits, speakerTurns, type CarriedSummary } from "../domain/chat-speakers.ts";
import type { ChatMessage } from "../domain/chat.ts";
import { SPEAKER_RULES_FRAGMENT } from "../domain/prompts.ts";
import { speakerFraming, type SpeakerContextSnapshot } from "../domain/speaker-context.ts";
import type { SpeakerContextStateResult } from "../domain/speaker-lineage.ts";
import type { SummaryRevision } from "../domain/artifact.ts";
import type { TranscriptSegment } from "../domain/transcript.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import { summarySpeakerContext } from "./artifact-speakers.ts";
import { resolveSpeakerContext } from "./speaker-context.ts";
import type { SpeakerLineageReader } from "./speaker-lineage.ts";

/**
 * The speaker side of a chat answer, read inside the transaction that reads the primary
 * revision's sentences, so the transcript, who said what, the labels and the retrieval
 * candidates of one answer all describe the same moment.
 */

/** The speakers an answer reads: its snapshot and how the planner frames them. */
export interface ChatSpeakers {
  snapshot: SpeakerContextSnapshot;
  reading: Omit<ChatSpeakerReading, "person">;
}

/**
 * The speakers an answer grounded in `revisionId` reads: present only when the user reviewed
 * that revision's speakers and it is read by speaker; anything else answers as without
 * speakers. `segments` are the revision's sentences.
 */
export function chatSpeakers(
  scope: RepositoryScope,
  owner: string,
  contentId: string,
  revisionId: string,
  segments: readonly TranscriptSegment[],
): ChatSpeakers | undefined {
  const snapshot = resolveSpeakerContext(scope, owner, contentId, revisionId, "transcript");
  if (snapshot === undefined) {
    return undefined;
  }
  const ordered = [...segments].sort((a, b) => a.ordinal - b.ordinal);
  return {
    snapshot,
    reading: { framing: speakerFraming(snapshot, SPEAKER_RULES_FRAGMENT, ordered), speakers: snapshot.speakers, turns: speakerTurns(ordered) },
  };
}

/** What an answer said about who said what rests on: the revision it read, its speakers and the sentences it cites. */
export interface ChatAnswerBasis {
  /** Absent only on an answer stored without its revision, which cannot be compared. */
  transcriptRevisionId?: string;
  speakerContext: SpeakerContextSnapshot;
  citedSegmentIds: readonly string[];
}

/** The basis of an answer that was given speakers; absent for one given none (or a question). */
export function answerBasis(message: ChatMessage): ChatAnswerBasis | undefined {
  if (message.role !== "assistant" || message.speakerContext === undefined) {
    return undefined;
  }
  return {
    ...(message.contextTranscriptRevisionId === undefined ? {} : { transcriptRevisionId: message.contextTranscriptRevisionId }),
    speakerContext: message.speakerContext,
    citedSegmentIds: message.citations.map((citation) => citation.segmentId as string),
  };
}

/**
 * How a basis compares with the Content's current primary, by the derivation every stored
 * result's speaker state uses: sentence by sentence along the lineage, then names, then the
 * primary's review. A basis whose revision is gone, is no longer the primary or one of its
 * ancestors, or was never recorded cannot be compared: `unknown`.
 */
export function basisSpeakerState(
  scope: RepositoryScope,
  owner: string,
  lineage: SpeakerLineageReader,
  contentId: string,
  basis: ChatAnswerBasis,
): SpeakerContextStateResult {
  const from = basis.transcriptRevisionId;
  return (
    (from === undefined
      ? undefined
      : lineage.state(scope, owner, { contentId, generatedFromRevisionId: from, snapshot: basis.speakerContext, citedSegmentIds: basis.citedSegmentIds })) ?? {
      state: "unknown",
    }
  );
}

/** Retrieval candidates of one answer: they depend only on the revision and the quoted text plus question. */
export interface ChatCandidates {
  /** Ranked segment ids of the plain search. */
  hits: string[];
  /** Who the text names and their own hits; absent without speakers or without a question. */
  person?: NonNullable<ChatSpeakerReading["person"]>;
}

/**
 * Every index query an answer may need, made once: the plain hits, and with speakers the
 * people named and, when words besides their names remain, hits within each one's sentences
 * (an equal share of the hit quota each). Planning later only chooses among these, however
 * often it runs, so a primary switched mid-answer cannot change what retrieval finds.
 */
export function chatCandidates(
  scope: RepositoryScope,
  owner: string,
  revisionId: string | undefined,
  query: string,
  speakers: ChatSpeakers | undefined,
): ChatCandidates {
  if (revisionId === undefined) {
    return { hits: [] };
  }
  const hits = scope.search.matchSegments(owner, revisionId, query, CHAT_RETRIEVAL_HITS_MAX);
  if (speakers === undefined || query === "") {
    return { hits };
  }
  const mentions = mentionedSpeakers(query, speakers.snapshot.speakers);
  if (mentions.ids.length === 0 || !hasSearchTerms(mentions.residual)) {
    return { hits, person: { mentioned: mentions.ids } };
  }
  const limit = perSpeakerHits(mentions.ids.length);
  const speakerHits = Object.fromEntries(
    mentions.ids.map((id) => [id, scope.search.matchSegments(owner, revisionId, mentions.residual, limit, { speakerIds: [id] })]),
  );
  return { hits, person: { mentioned: mentions.ids, speakerHits } };
}

/**
 * The default summary as an answer carries it, by the speaker context the summary itself
 * shows (one definition of its cited sentences and state for both). A summary written
 * without speakers, or one whose transcript is no longer the primary or one of its
 * ancestors (its text is stale, which says more), has no state and is carried as it is.
 */
export function chatSummary(scope: RepositoryScope, owner: string, lineage: SpeakerLineageReader, contentId: string, revision: SummaryRevision): CarriedSummary {
  return carriedSummary(revision.body, summarySpeakerContext(scope, owner, lineage, contentId, revision));
}

/**
 * The speaker context an answer shows: only when what it was given no longer matches now,
 * so the reader is told who the speakers were when it answered and that this differs from
 * now. Absent for an answer given no speakers and for one whose speakers still hold. An
 * answer read from a transcript that is no longer the primary or one of its ancestors cannot
 * be compared sentence by sentence: `unknown`.
 */
export function messageSpeakerContext(
  scope: RepositoryScope,
  owner: string,
  lineage: SpeakerLineageReader,
  contentId: string,
  message: ChatMessage,
): SpeakerContextDto | undefined {
  const basis = answerBasis(message);
  if (basis === undefined) {
    return undefined;
  }
  const snapshot = basis.speakerContext;
  const state = basisSpeakerState(scope, owner, lineage, contentId, basis);
  if (state.state === "consistent") {
    return undefined;
  }
  return {
    state: state.state,
    speakers: snapshot.speakers.map((speaker) => ({ id: speaker.id, label: speaker.label })),
    ...(state.changedSentences === undefined || state.changedSentences === 0 ? {} : { changedSentences: state.changedSentences }),
    ...(state.removedCitations === undefined || state.removedCitations === 0 ? {} : { removedCitations: state.removedCitations }),
    ...(state.renamed === undefined ? {} : { renamed: state.renamed.map((rename) => ({ ...rename })) }),
  };
}
