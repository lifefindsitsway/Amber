import { amberError } from "./errors.ts";
import type { PromptRef } from "./model-ref.ts";
import { SPEAKER_LINES_FRAGMENT, type BuiltinPrompt } from "./prompts.ts";
import { attributionDigest, type SpeakerContextSnapshot } from "./speaker-context.ts";

/**
 * The speaker section of the line-protocol prompts (proofreading and translation). Their
 * answers are parsed line by line against the lines sent, so no header line may go between
 * sentences: the speakers travel in a section of their own instead, appended to the value
 * of `{{terms_section}}` — the `speaker.lines` rules, the roster (one label per line), and
 * which lines of this very call each speaker says, run by run (`s12–s15 <label>` in a
 * proofreading call, `1–3 <label>` in a translation batch). Unassigned lines are not listed.
 * The target lines, their numbering and the answer protocol stay exactly as without it.
 */
export interface SpeakerSection {
  readonly snapshot: SpeakerContextSnapshot;
  readonly rules: BuiltinPrompt;
  /**
   * The `{{terms_section}}` value of one call: `terms` as it would be without speakers, then
   * the section for `lines`, the lines of the call in the order they are sent, each with the
   * name it is sent under and its speaker.
   */
  termsValue(terms: string, lines: ReadonlyArray<{ name: string; speakerId?: string }>): string;
}

/** Between two lines' names in a run: an en dash, as the ranges are written for people. */
const RANGE_DASH = "–";

/** The fragment a snapshot's `rules` names, when it is the speaker section this build sends. */
export function speakerLinesFragmentOf(ref: PromptRef): BuiltinPrompt | undefined {
  return ref.id === SPEAKER_LINES_FRAGMENT.ref.id && ref.version === SPEAKER_LINES_FRAGMENT.ref.version ? SPEAKER_LINES_FRAGMENT : undefined;
}

/**
 * The speaker section a stage reads `segments` (the whole revision it reads, in order) with,
 * or `undefined` when its request froze no speakers. As for the reading prompts, the
 * revision's attribution digest is recomputed before anything is sent: a revision never
 * changes, so a mismatch means the snapshot does not describe what is about to be read, and
 * the stage fails (`internal`, not retried) instead of calling. So does a rules version this
 * build does not know, or a sentence naming a speaker the snapshot does not label.
 */
export function speakerSectionForRead(
  snapshot: SpeakerContextSnapshot | undefined,
  segments: ReadonlyArray<{ id: string; speakerId?: string }>,
): SpeakerSection | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  if (attributionDigest(segments) !== snapshot.attributionDigest) {
    throw amberError("internal", "the read revision's speakers do not match the frozen speaker context");
  }
  const rules = speakerLinesFragmentOf(snapshot.rules);
  if (rules === undefined) {
    throw amberError("internal", `unknown speaker rules ${snapshot.rules.id} v${snapshot.rules.version}`);
  }
  const labels = new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker.label]));
  if (segments.some((segment) => segment.speakerId !== undefined && !labels.has(segment.speakerId))) {
    throw amberError("internal", "the frozen speaker context does not label every speaker of the read revision");
  }
  const head = [rules.text, ...snapshot.speakers.map((speaker) => speaker.label)].join("\n");
  return {
    snapshot,
    rules,
    termsValue: (terms, lines) => {
      const section = [head, ...lineRuns(lines, labels)].join("\n");
      return terms === "" ? section : `${terms}\n\n${section}`;
    },
  };
}

/** One entry per run of consecutive lines of one speaker: `<first>–<last> <label>`, or `<name> <label>` for a single line. */
function lineRuns(lines: ReadonlyArray<{ name: string; speakerId?: string }>, labels: ReadonlyMap<string, string>): string[] {
  const runs: string[] = [];
  let start = 0;
  while (start < lines.length) {
    const speakerId = lines[start]?.speakerId;
    let end = start;
    while (end + 1 < lines.length && lines[end + 1]?.speakerId === speakerId) {
      end += 1;
    }
    const label = speakerId === undefined ? undefined : labels.get(speakerId);
    if (label !== undefined) {
      const first = (lines[start] as { name: string }).name;
      const last = (lines[end] as { name: string }).name;
      runs.push(start === end ? `${first} ${label}` : `${first}${RANGE_DASH}${last} ${label}`);
    }
    start = end + 1;
  }
  return runs;
}
