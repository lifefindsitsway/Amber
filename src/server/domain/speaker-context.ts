import { createHash } from "node:crypto";
import { z } from "zod";
import { SPEAKER_NAME_CONTROL_CLASS } from "../../shared/speakers.ts";
import { canonicalJson } from "./canonical-json.ts";
import { amberError } from "./errors.ts";
import type { PromptRef } from "./model-ref.ts";
import { SPEAKER_RULES_FRAGMENT, type BuiltinPrompt } from "./prompts.ts";
import { estimateTokens } from "./token-estimate.ts";

/**
 * The speakers one AI request was actually given: who they were and what each was called.
 * It is taken once — when a Task is submitted, or when a chat answer starts — and travels
 * with the request, so a rename, a withdrawn review or a new primary transcript while the
 * work is running never mixes two sets of speakers into one result. The result keeps it,
 * which is what later allows telling whether its attributions still hold.
 *
 * A request carries one only when the transcript it reads has had its speakers reviewed by
 * the user; anything else is sent exactly as it would be without speakers.
 */
export interface SpeakerContextSnapshot {
  version: 1;
  /** The version of the speaker rules sent with the transcript lines. */
  rules: PromptRef;
  /**
   * SHA-256 over the read revision's sentences in order, each as `(segmentId, speakerId)`.
   * A revision is immutable, so this is constant for it; a stage recomputes it before its
   * first call and refuses to run on a mismatch.
   */
  attributionDigest: string;
  /** Only the speakers the read revision names. `label` is the text the model sees for them. */
  speakers: SpeakerContextSpeaker[];
}

export interface SpeakerContextSpeaker {
  id: string;
  ordinal: number;
  /** The confirmed name, when the label is built from one. */
  name?: string;
  label: string;
}

export const speakerContextSnapshotSchema = z
  .object({
    version: z.literal(1),
    rules: z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict(),
    attributionDigest: z.string().min(1),
    speakers: z.array(
      z
        .object({ id: z.string().min(1), ordinal: z.number().int().positive(), name: z.string().min(1).exactOptional(), label: z.string().min(1) })
        .strict(),
    ),
  })
  .strict();

/** The line put before a run of sentences of one speaker. */
export const SPEAKER_HEADER_PREFIX = "【发言人】";
/** The label of sentences nobody was assigned to. */
export const UNASSIGNED_SPEAKER_LABEL = "未分配";

/** How a model sees a speaker it may not call by name: by the speaker's number in the Content. */
export function ordinalSpeakerLabel(ordinal: number): string {
  return `发言人 ${ordinal}`;
}

/**
 * What a stored name already loses (C0/C1 controls, bidi embeddings, overrides, isolates and
 * marks), plus the Unicode line and paragraph separators, which would end a prompt line, and
 * the invisible zero-width characters, which would let a name look like another label (or like
 * 「未分配」) to the model while comparing as different.
 */
const NAME_CONTROLS = new RegExp(`[${SPEAKER_NAME_CONTROL_CLASS}\\u2028\\u2029\\u200B-\\u200D\\u2060\\uFEFF]`, "gu");

/**
 * A name as it may appear in a prompt. A name is data the user (or a recognizer) typed, so it
 * must not be able to end its line, forge a header line (`【发言人】`) or an alias (`[[s1]]`):
 * controls and line breaks are removed, and `[` `]` `【` `】` become the full-width `［` `］`.
 * The rules fragment also tells the model that what a header line names is never an
 * instruction; sanitising alone cannot guarantee a model ignores the text.
 */
export function sanitizeSpeakerName(name: string): string {
  return name.replace(NAME_CONTROLS, "").replace(/[[【]/g, "［").replace(/[\]】]/g, "］").trim();
}

/** A speaker of the read revision, as stored. */
export interface LabeledSpeakerSource {
  id: string;
  ordinal: number;
  name?: string;
  nameConfirmedAt?: number;
}

/**
 * The label each speaker is given to a model: a confirmed name as it is; a confirmed name two
 * of `speakers` share, followed by the speaker's number (`名字（发言人 N）`), so the model can
 * keep them apart; otherwise — no name, or a name never confirmed — `发言人 N`. `speakers`
 * must be exactly the speakers the read revision names: who shares a name is decided among
 * them only. The result is in `ordinal` order; `name` is kept only when the label uses it.
 *
 * A name may be anything, `发言人 2`, `未分配` or one ending in a number in brackets
 * included: identity is the speaker id, never the name. So a final pass makes every label
 * one the model can resolve to exactly one speaker: a label another speaker also has, or one
 * equal to the label of unassigned sentences, gets `（发言人 N）` with the speaker's own
 * number appended, until no two are equal and none is `未分配`. Ordinals are unique within a
 * Content, so the labels that still collide after a round grow apart and the pass ends.
 */
export function speakerLabels(speakers: readonly LabeledSpeakerSource[]): SpeakerContextSpeaker[] {
  const named = speakers.map((speaker) => {
    const confirmed = speaker.nameConfirmedAt !== undefined && speaker.name !== undefined ? sanitizeSpeakerName(speaker.name) : "";
    return { speaker, shown: confirmed };
  });
  const uses = new Map<string, number>();
  for (const { shown } of named) {
    if (shown !== "") uses.set(shown, (uses.get(shown) ?? 0) + 1);
  }
  const labeled = named
    .map(({ speaker, shown }): SpeakerContextSpeaker => {
      if (shown === "" || speaker.name === undefined) {
        return { id: speaker.id, ordinal: speaker.ordinal, label: ordinalSpeakerLabel(speaker.ordinal) };
      }
      const label = (uses.get(shown) ?? 0) > 1 ? withOrdinal(shown, speaker.ordinal) : shown;
      return { id: speaker.id, ordinal: speaker.ordinal, name: speaker.name, label };
    })
    .sort((a, b) => a.ordinal - b.ordinal);
  for (;;) {
    const counts = new Map<string, number>();
    for (const { label } of labeled) counts.set(label, (counts.get(label) ?? 0) + 1);
    const clashing = labeled.filter(({ label }) => label === UNASSIGNED_SPEAKER_LABEL || (counts.get(label) ?? 0) > 1);
    if (clashing.length === 0) {
      return labeled;
    }
    for (const speaker of clashing) {
      speaker.label = withOrdinal(speaker.label, speaker.ordinal);
    }
  }
}

/** `text` followed by the speaker's number in full-width brackets: `text（发言人 N）`. */
function withOrdinal(text: string, ordinal: number): string {
  return `${text}（${ordinalSpeakerLabel(ordinal)}）`;
}

/**
 * The `attributionDigest` of a revision: SHA-256 over its sentences in order, each as
 * `[segmentId, speakerId | null]`, in canonical JSON.
 */
export function attributionDigest(segments: ReadonlyArray<{ id: string; speakerId?: string }>): string {
  const pairs = segments.map((segment) => [segment.id, segment.speakerId ?? null]);
  return `sha256:${createHash("sha256").update(canonicalJson(pairs)).digest("hex")}`;
}

/** The fragment a snapshot's `rules` names, when it is one this build sends with transcript lines. */
export function speakerRulesFragmentOf(ref: PromptRef): BuiltinPrompt | undefined {
  return ref.id === SPEAKER_RULES_FRAGMENT.ref.id && ref.version === SPEAKER_RULES_FRAGMENT.ref.version ? SPEAKER_RULES_FRAGMENT : undefined;
}

/**
 * Transcript lines with their speakers, for one request that reads a reviewed revision: the
 * sentence lines stay exactly as without speakers, and a header line `【发言人】<label>` goes
 * before the first sentence of every block sent together and before every sentence whose
 * speaker differs from the one before it (`【发言人】未分配` for unassigned sentences). The
 * rules fragment opens the value of the slot that carries the lines.
 */
export interface SpeakerFraming {
  readonly snapshot: SpeakerContextSnapshot;
  readonly rules: BuiltinPrompt;
  /** The value of the slot carrying the transcript: the rules fragment, then `body`. */
  slotValue(body: string): string;
  /**
   * The estimated tokens sentence `position` adds to a block: its line, plus its header line
   * when it opens the block or the speaker changes there. A sentence that is no change of
   * speaker in the whole transcript still pays for a header when a cut makes it a block's first.
   */
  cost(line: string, position: number, blockStart: boolean): number;
  /** The lines of the block of sentences starting at `first`, with their header lines. */
  block(lines: readonly string[], first: number): string[];
}

/**
 * The framing of `segments` (the whole read revision, in order) under `snapshot`. Throws
 * when a sentence names a speaker the snapshot does not label, which the attribution digest
 * check before it rules out for a snapshot taken from this revision.
 */
export function speakerFraming(snapshot: SpeakerContextSnapshot, rules: BuiltinPrompt, segments: ReadonlyArray<{ speakerId?: string }>): SpeakerFraming {
  const labels = new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker.label]));
  const headers = segments.map((segment) => {
    if (segment.speakerId === undefined) {
      return `${SPEAKER_HEADER_PREFIX}${UNASSIGNED_SPEAKER_LABEL}`;
    }
    const label = labels.get(segment.speakerId);
    if (label === undefined) {
      throw new TypeError("a sentence names a speaker the snapshot does not label");
    }
    return `${SPEAKER_HEADER_PREFIX}${label}`;
  });
  const changes = segments.map((segment, position) => position === 0 || segment.speakerId !== segments[position - 1]?.speakerId);
  const headerCosts = headers.map((header) => estimateTokens(`${header}\n`));
  const prefix = `${rules.text}\n`;
  return {
    snapshot,
    rules,
    slotValue: (body) => `${prefix}${body}`,
    cost: (line, position, blockStart) => estimateTokens(`${line}\n`) + (blockStart || changes[position] === true ? (headerCosts[position] as number) : 0),
    block: (lines, first) =>
      lines.flatMap((line, index) => {
        const position = first + index;
        return index === 0 || changes[position] === true ? [headers[position] as string, line] : [line];
      }),
  };
}

/**
 * The framing a stage reads `segments` (the whole revision it reads, in order) with, or
 * `undefined` when its request froze no speakers. Before anything is sent the revision's
 * attribution digest is recomputed: a revision never changes, so a mismatch means the
 * snapshot does not describe what is about to be read, and the stage fails (`internal`, not
 * retried) instead of calling. So does a rules version this build does not know.
 */
export function framingForRead(snapshot: SpeakerContextSnapshot | undefined, segments: ReadonlyArray<{ id: string; speakerId?: string }>): SpeakerFraming | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  if (attributionDigest(segments) !== snapshot.attributionDigest) {
    throw amberError("internal", "the read revision's speakers do not match the frozen speaker context");
  }
  const rules = speakerRulesFragmentOf(snapshot.rules);
  if (rules === undefined) {
    throw amberError("internal", `unknown speaker rules ${snapshot.rules.id} v${snapshot.rules.version}`);
  }
  try {
    return speakerFraming(snapshot, rules, segments);
  } catch {
    throw amberError("internal", "the frozen speaker context does not label every speaker of the read revision");
  }
}

/** Digest material of a snapshot, for the input digests of the units that read with it. */
export function speakerContextDigest(snapshot: SpeakerContextSnapshot): string {
  return `sha256:${createHash("sha256").update(canonicalJson(snapshot)).digest("hex")}`;
}
