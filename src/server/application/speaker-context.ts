import { speakerModeFor } from "../../shared/speaker-turns.ts";
import { amberError } from "../domain/errors.ts";
import type { PromptRef } from "../domain/model-ref.ts";
import { SPEAKER_LINES_FRAGMENT, SPEAKER_RULES_FRAGMENT, type CustomizablePromptId } from "../domain/prompts.ts";
import { attributionDigest, speakerLabels, type SpeakerContextSnapshot } from "../domain/speaker-context.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import { promptTextOf, type PromptRefMap } from "../pipeline/prompts.ts";

/**
 * How a Task's model reads the speakers: sentence lines with header lines between them
 * (summaries, chapters, highlights) or a speaker section beside unchanged target lines
 * (proofreading, translation). It decides which rules fragment the snapshot names.
 */
export type SpeakerReading = "transcript" | "lines";

const RULES_OF: Record<SpeakerReading, PromptRef> = {
  transcript: SPEAKER_RULES_FRAGMENT.ref,
  lines: SPEAKER_LINES_FRAGMENT.ref,
};

/**
 * The speakers a Task reading `revisionId` is given, frozen at submission; `undefined` when it
 * reads none — the revision's speakers are not reviewed, or it is not read by speaker (fewer
 * than two speakers and none of them named) — and the Task then runs exactly as it would
 * without speakers. Called inside the submitting transaction, so the snapshot, the review mark
 * and the names are read together. Only the speakers the revision names are listed.
 */
export function resolveSpeakerContext(
  scope: RepositoryScope,
  owner: string,
  contentId: string,
  revisionId: string,
  reading: SpeakerReading,
): SpeakerContextSnapshot | undefined {
  if (scope.speakerConfirmations.confirmedAt(owner, revisionId) === undefined) {
    return undefined;
  }
  const segments = scope.transcripts.listSegments(owner, revisionId);
  const speakers = scope.speakers.list(owner, contentId);
  if (!speakerModeFor(segments, speakers)) {
    return undefined;
  }
  const used = new Set(segments.flatMap((segment) => (segment.speakerId === undefined ? [] : [segment.speakerId])));
  return {
    version: 1,
    rules: RULES_OF[reading],
    attributionDigest: attributionDigest(segments),
    speakers: speakerLabels(speakers.filter((speaker) => used.has(speaker.id))),
  };
}

/**
 * The slot each prompt of a Task kind carries the speakers in: the transcript slots of the
 * reading prompts, the terminology section of proofreading and translation (and the text
 * prompt slot through which audio proofreading carries it).
 */
const CARRYING_SLOTS: Partial<Record<string, ReadonlyArray<readonly [CustomizablePromptId, string]>>> = {
  regenerate_summary: [
    ["summary.envelope", "{{transcript_with_aliases}}"],
    ["rollup.partial", "{{group_content}}"],
  ],
  regenerate_chapters: [["chapter.ai", "{{transcript_with_aliases}}"]],
  recompute_highlights: [["highlight.default", "{{transcript_with_aliases}}"]],
  reproofread: [
    ["proofread.text", "{{terms_section}}"],
    ["proofread.audio", "{{proofread_text}}"],
  ],
  translate: [["translate.subtitles", "{{terms_section}}"]],
};

/**
 * Refuses a Task that would read speakers through a frozen prompt that lost the slot they
 * ride in (`invalid_request.prompt_protocol`, `details.missing` listing those slots): the
 * snapshot would be recorded while the model never saw it. A prompt saved through the
 * settings keeps its slots; this guards versions that bypassed that check. A frozen version
 * that no longer resolves is not refused: the stage then uses the builtin text, which has them.
 */
export function assertCarriesSpeakers(scope: RepositoryScope, owner: string, kind: string, promptRefs: PromptRefMap): void {
  const missing = (CARRYING_SLOTS[kind] ?? []).flatMap(([id, slot]) => {
    const ref = promptRefs[id];
    const text = ref === undefined ? undefined : promptTextOf(scope, owner, ref);
    return text === undefined || text.includes(slot) ? [] : [slot];
  });
  if (missing.length > 0) {
    throw amberError("invalid_request", "a frozen prompt has no slot to carry the speakers in", {
      code: "invalid_request.prompt_protocol",
      details: { missing, unknown: [] },
    });
  }
}

/**
 * The `speakerContext` member of a new Task request: present only when the read revision's
 * speakers are given to the model, after the frozen prompts were checked to carry them.
 */
export function freezeSpeakerContext(
  scope: RepositoryScope,
  owner: string,
  task: { kind: string; contentId: string; revisionId: string; promptRefs: PromptRefMap },
  reading: SpeakerReading,
): { speakerContext?: SpeakerContextSnapshot } {
  const snapshot = resolveSpeakerContext(scope, owner, task.contentId, task.revisionId, reading);
  if (snapshot === undefined) {
    return {};
  }
  assertCarriesSpeakers(scope, owner, task.kind, task.promptRefs);
  return { speakerContext: snapshot };
}
