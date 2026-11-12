import { CHAT_RETRIEVAL_HITS_MAX, CHAT_SPEAKER_SAMPLE_SENTENCES, CHAT_SPEAKER_SAMPLE_TURNS, SPEAKER_MENTION_MIN_GRAPHEMES } from "../../shared/defaults.ts";
import type { SpeakerContextState } from "../../shared/dto/speaker-context.ts";
import type { ChatSpeakerBasis } from "./chat.ts";
import { SPEAKER_CAUTION_FRAGMENT, SPEAKER_UNVERIFIED_FRAGMENT, type BuiltinPrompt } from "./prompts.ts";
import { questionTrigrams } from "./search-query.ts";
import { ordinalSpeakerLabel, sanitizeSpeakerName, speakerContextDigest, type SpeakerContextSpeaker } from "./speaker-context.ts";

/**
 * What chat does with speakers beyond the header lines: recognising the people a question
 * is about, finding their turns, the material taken for them when the transcript does not
 * fit, and how older AI text (the default summary, earlier answers, compactions) is carried
 * into an answer whose speakers may differ from the ones that text was written with.
 *
 * Pure: positions are indexes into the read revision's sentences in order.
 */

/** Opens the coverage line put before the material taken for one person. Model input, not UI copy. */
const CLIP_NOTE_PREFIX = "【发言人片段】";
/** Opens a line telling the model a speaker it may know from older text is now called otherwise. Model input. */
const RENAME_PREFIX = "【改名】";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** A name ending in a digit is not found inside a longer number: 「发言人 1」 is not in 「发言人 12」. */
const DIGIT_END = /\p{Nd}$/u;
const DIGIT_START = /^\p{Nd}/u;

function graphemeCount(text: string): number {
  let count = 0;
  for (const _segment of graphemes.segment(text)) count += 1;
  return count;
}

/** NFKC and lower case: how names and questions are compared. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** The people a question names, and the question with those names taken out. */
export interface SpeakerMentions {
  /** Speaker ids in `ordinal` order; several for one name shared by several speakers. */
  ids: string[];
  /** The text with every recognised name removed, as the user wrote it otherwise. */
  residual: string;
}

/**
 * The speakers of `speakers` that `text` names. A speaker is named by its label, by its
 * confirmed name alone (so one name shared by several speakers names all of them), or as
 * 「发言人 N」 (with or without the space). Comparison is NFKC and case-insensitive; a name
 * shorter than `SPEAKER_MENTION_MIN_GRAPHEMES` grapheme clusters is never looked for, so a
 * one-character name does not turn every question into a question about someone. At each
 * place the longest name wins, and a match must start and end on grapheme boundaries (and
 * one ending in a digit must not run on into more digits).
 */
export function mentionedSpeakers(text: string, speakers: readonly SpeakerContextSpeaker[]): SpeakerMentions {
  const terms = new Map<string, Set<string>>();
  const add = (term: string, id: string): void => {
    const folded = fold(term).trim();
    if (folded === "" || graphemeCount(folded) < SPEAKER_MENTION_MIN_GRAPHEMES) return;
    const ids = terms.get(folded) ?? new Set<string>();
    ids.add(id);
    terms.set(folded, ids);
  };
  for (const speaker of speakers) {
    add(speaker.label, speaker.id);
    add(ordinalSpeakerLabel(speaker.ordinal), speaker.id);
    add(ordinalSpeakerLabel(speaker.ordinal).replace(/\s+/gu, ""), speaker.id);
    if (speaker.name !== undefined) add(sanitizeSpeakerName(speaker.name), speaker.id);
  }
  const ordered = [...terms.keys()].sort((a, b) => b.length - a.length);

  // The folded text grapheme by grapheme, remembering where each one starts and ends.
  const pieces = [...graphemes.segment(text)].map((piece) => ({ original: piece.segment, folded: fold(piece.segment) }));
  const starts: number[] = [];
  let folded = "";
  for (const piece of pieces) {
    starts.push(folded.length);
    folded += piece.folded;
  }
  const pieceAt = new Map(starts.map((start, index) => [start, index]));
  const ends = new Set(starts.map((start, index) => start + (pieces[index]?.folded.length ?? 0)));

  const found = new Set<string>();
  const removed = new Set<number>();
  let index = 0;
  while (index < pieces.length) {
    const at = starts[index] as number;
    const term = ordered.find(
      (candidate) => folded.startsWith(candidate, at) && ends.has(at + candidate.length) && !(DIGIT_END.test(candidate) && DIGIT_START.test(folded.slice(at + candidate.length, at + candidate.length + 2))),
    );
    if (term === undefined) {
      index += 1;
      continue;
    }
    for (const id of terms.get(term) ?? []) found.add(id);
    const next = pieceAt.get(at + term.length) ?? pieces.length;
    for (let removedIndex = index; removedIndex < next; removedIndex += 1) removed.add(removedIndex);
    index = next;
  }
  const ids = speakers.filter((speaker) => found.has(speaker.id)).map((speaker) => speaker.id);
  const residual = pieces.map((piece, pieceIndex) => (removed.has(pieceIndex) ? " " : piece.original)).join("");
  return { ids, residual };
}

/** Whether a text still has something the trigram index can search for. */
export function hasSearchTerms(text: string): boolean {
  return questionTrigrams(text).length > 0;
}

/** How many filtered hits each of `count` named people may bring: the retrieval quota shared evenly. */
export function perSpeakerHits(count: number): number {
  return count === 0 ? 0 : Math.max(1, Math.floor(CHAT_RETRIEVAL_HITS_MAX / count));
}

/** One turn: consecutive sentences of one speaker, `[first, last]` positions. */
export interface SpeakerTurn {
  speakerId: string;
  first: number;
  last: number;
}

/** Every turn of an assigned speaker, in order; unassigned sentences belong to no turn. */
export function speakerTurns(segments: ReadonlyArray<{ speakerId?: string }>): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  segments.forEach((segment, position) => {
    const last = turns.at(-1);
    if (segment.speakerId === undefined) return;
    if (last !== undefined && last.speakerId === segment.speakerId && last.last === position - 1) {
      last.last = position;
    } else {
      turns.push({ speakerId: segment.speakerId, first: position, last: position });
    }
  });
  return turns;
}

/** Positions `first..last`. */
function span(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

/**
 * Material taken for one person: groups of positions, each sent as consecutive sentences,
 * in the order they compete for room. `complete` = every turn of the person, with the
 * sentence before each (usually what the turn answers).
 */
export interface SpeakerClipSection {
  speakerId: string;
  label: string;
  /** All turns of the person in the read revision. */
  turns: number;
  complete: boolean;
  groups: number[][];
}

/** Every turn of each person, each with the sentence before it. */
export function allTurnSections(turns: readonly SpeakerTurn[], people: readonly SpeakerContextSpeaker[]): SpeakerClipSection[] {
  return people.map((person) => {
    const own = turns.filter((turn) => turn.speakerId === person.id);
    return {
      speakerId: person.id,
      label: person.label,
      turns: own.length,
      complete: true,
      groups: own.map((turn) => span(Math.max(0, turn.first - 1), turn.last)),
    };
  });
}

/**
 * Representative turns of a person: the time from the first sentence's start to the last
 * one's end is cut into `CHAT_SPEAKER_SAMPLE_TURNS` equal parts, and the person's longest
 * turn starting in each part is taken (longest by time, then by sentences, then the
 * earliest), at most `CHAT_SPEAKER_SAMPLE_SENTENCES` of its sentences from its start.
 */
export function sampleSection(
  turns: readonly SpeakerTurn[],
  person: SpeakerContextSpeaker,
  segments: ReadonlyArray<{ startMs: number; endMs: number }>,
): SpeakerClipSection {
  const own = turns.filter((turn) => turn.speakerId === person.id);
  const from = segments[0]?.startMs ?? 0;
  const to = segments.reduce((end, segment) => Math.max(end, segment.endMs), from);
  const width = Math.max(1, to - from) / CHAT_SPEAKER_SAMPLE_TURNS;
  const bucketOf = (turn: SpeakerTurn): number =>
    Math.min(CHAT_SPEAKER_SAMPLE_TURNS - 1, Math.max(0, Math.floor(((segments[turn.first]?.startMs ?? from) - from) / width)));
  const length = (turn: SpeakerTurn): number => (segments[turn.last]?.endMs ?? 0) - (segments[turn.first]?.startMs ?? 0);
  const best = new Map<number, SpeakerTurn>();
  for (const turn of own) {
    const bucket = bucketOf(turn);
    const held = best.get(bucket);
    const longer =
      held === undefined ||
      length(turn) > length(held) ||
      (length(turn) === length(held) && turn.last - turn.first > held.last - held.first);
    if (longer) best.set(bucket, turn);
  }
  const groups = [...best.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, turn]) => span(turn.first, Math.min(turn.last, turn.first + CHAT_SPEAKER_SAMPLE_SENTENCES - 1)));
  return { speakerId: person.id, label: person.label, turns: own.length, complete: false, groups };
}

/**
 * The order the groups of several sections compete for room in: the first group of each
 * section, then the second of each, and so on, so a short budget is shared between people.
 */
export function interleavedGroups(sections: readonly SpeakerClipSection[]): Array<{ section: number; group: number[] }> {
  const order: Array<{ section: number; group: number[] }> = [];
  const longest = sections.reduce((max, section) => Math.max(max, section.groups.length), 0);
  for (let round = 0; round < longest; round += 1) {
    sections.forEach((section, index) => {
      const group = section.groups[round];
      if (group !== undefined) order.push({ section: index, group });
    });
  }
  return order;
}

/** How many distinct turns of the person the shown positions touch. */
export function turnsShown(turns: readonly SpeakerTurn[], speakerId: string, shown: ReadonlySet<number>): number {
  return turns.filter((turn) => turn.speakerId === speakerId && span(turn.first, turn.last).some((position) => shown.has(position))).length;
}

/** The coverage line put before a person's material. */
export function clipNote(label: string, turns: number, shown: number | "all"): string {
  return shown === "all" ? `${CLIP_NOTE_PREFIX}${label} 共 ${turns} 轮发言，以下为全部` : `${CLIP_NOTE_PREFIX}${label} 共 ${turns} 轮发言，以下选取 ${shown} 轮，不是全部`;
}

/** What becomes of the default summary in an answer, given its speaker state. */
export type CarriedSummary = { kind: "omitted" } | { kind: "carried"; text: string };

/**
 * The default summary as an answer carries it. A summary whose attributions changed, whose
 * cited sentences were removed, or that cannot be compared is left out (the context label
 * says why); one whose speakers were only renamed comes with a line per renamed speaker; one
 * read against a transcript whose speakers are not reviewed now comes with the caution.
 * Without a state (generated without speakers, or its transcript is no longer the primary's
 * lineage) it is carried as it is.
 */
export function carriedSummary(
  body: string,
  state: { state: SpeakerContextState; renamed?: ReadonlyArray<{ was: string; now: string }> } | undefined,
): CarriedSummary {
  switch (state?.state) {
    case "attribution_changed":
    case "evidence_removed":
    case "unknown":
      return { kind: "omitted" };
    case "names_changed":
      return { kind: "carried", text: [...(state.renamed ?? []).map((rename) => `${RENAME_PREFIX}生成时为${rename.was}，现为${rename.now}`), body].join("\n") };
    case "unconfirmed":
      return { kind: "carried", text: `${SPEAKER_CAUTION_FRAGMENT.text}\n${body}` };
    default:
      return { kind: "carried", text: body };
  }
}

/**
 * What older chat text (history answers, the compaction) carried into an answer is preceded
 * by: `caution` when what it said about who said what has changed or is not confirmed now,
 * `unverified` when it can no longer be compared with the current transcript.
 */
export type HistoryNotice = "caution" | "unverified";

/**
 * The one notice older chat text needs, from the speaker state of each answer and compaction
 * basis it carries (`undefined` for text written without speakers, which never calls for
 * one): the caution when any changed, lost cited sentences, was renamed or is unconfirmed;
 * else "cannot be checked" when any cannot be compared; else none.
 */
export function historyNotice(states: Iterable<SpeakerContextState | undefined>): HistoryNotice | undefined {
  let unverified = false;
  for (const state of states) {
    if (state === "attribution_changed" || state === "evidence_removed" || state === "names_changed" || state === "unconfirmed") return "caution";
    if (state === "unknown") unverified = true;
  }
  return unverified ? "unverified" : undefined;
}

/** The fragment a notice is given as. */
export function historyNoticeFragment(notice: HistoryNotice): BuiltinPrompt {
  return notice === "caution" ? SPEAKER_CAUTION_FRAGMENT : SPEAKER_UNVERIFIED_FRAGMENT;
}

/**
 * The speaker bases a new compaction records: those of the compaction it replaces, then
 * those of the answers it absorbs. Bases on the same revision with the same speaker snapshot
 * become one, citing every sentence either cited (first appearance order), so the record
 * stays small however often it is carried on; the speaker state of the merged basis calls
 * for the same notice as the separate ones did, since only the cited sentences differ and
 * a removed one counts whichever basis cited it.
 */
export function mergedSpeakerBases(previous: readonly ChatSpeakerBasis[] | undefined, absorbed: readonly ChatSpeakerBasis[]): ChatSpeakerBasis[] {
  const merged = new Map<string, ChatSpeakerBasis>();
  for (const basis of [...(previous ?? []), ...absorbed]) {
    const key = `${basis.transcriptRevisionId}\n${speakerContextDigest(basis.speakerContext)}`;
    const held = merged.get(key);
    if (held === undefined) {
      merged.set(key, { transcriptRevisionId: basis.transcriptRevisionId, speakerContext: structuredClone(basis.speakerContext), citedSegmentIds: [...new Set(basis.citedSegmentIds)] });
    } else {
      held.citedSegmentIds = [...new Set([...held.citedSegmentIds, ...basis.citedSegmentIds])];
    }
  }
  return [...merged.values()];
}
