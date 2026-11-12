import type { TFunction } from "i18next";
import type { SpeakerContextDto, SpeakerContextState } from "../../../shared/dto/speaker-context.ts";

/**
 * How the transcript a generation would read stands with its speakers: whether it is read by
 * speakers at all (`speakerMode`) and whether the user reviewed them (`confirmed`). A
 * generation reads speakers only when both hold.
 */
export interface TranscriptSpeakerState {
  speakerMode: boolean;
  confirmed: boolean;
}

/** The one-line notice of an AI result about its speaker basis; `state` names which one, for tests and styling. */
export interface SpeakerBasisNotice {
  state: Exclude<SpeakerContextState, "consistent"> | "can_include";
  text: string;
}

/**
 * The notice a summary, chapters or highlights revision shows about the speakers it was
 * generated with. A stale result says nothing here: its text is out of date already, and the
 * staleness notice covers it. A result generated with speakers reports its derived state
 * (nothing when consistent). A result generated without them suggests regenerating only
 * when a new generation would actually read speakers, i.e. the current transcript is read by
 * speakers and they are reviewed; `primary` is undefined while that is not known yet.
 */
export function speakerBasisNotice(
  t: TFunction,
  input: { stale: boolean; speakerContext: SpeakerContextDto | undefined; primary: TranscriptSpeakerState | undefined },
): SpeakerBasisNotice | undefined {
  if (input.stale) return undefined;
  const context = input.speakerContext;
  if (context === undefined) {
    return input.primary?.speakerMode === true && input.primary.confirmed ? { state: "can_include", text: t("speakerContext.canInclude") } : undefined;
  }
  switch (context.state) {
    case "consistent":
      return undefined;
    case "attribution_changed":
      return {
        state: context.state,
        text:
          context.changedSentences === undefined
            ? t("speakerContext.noticePlain.attribution_changed")
            : t("speakerContext.notice.attribution_changed", { count: context.changedSentences }),
      };
    case "evidence_removed":
      return {
        state: context.state,
        text:
          context.removedCitations === undefined
            ? t("speakerContext.noticePlain.evidence_removed")
            : t("speakerContext.notice.evidence_removed", { count: context.removedCitations }),
      };
    case "names_changed": {
      const renamed = context.renamed ?? [];
      return {
        state: context.state,
        text:
          renamed.length === 0
            ? t("speakerContext.noticePlain.names_changed")
            : renamed.map((entry) => t("speakerContext.notice.names_changed", { was: entry.was, now: entry.now })).join(t("speakerContext.renamedSeparator")),
      };
    }
    case "unknown":
    case "unconfirmed":
      return { state: context.state, text: t(`speakerContext.notice.${context.state}`) };
  }
}

/**
 * Whether a generation entry gets 「发言人未核对，本次不读取」: the transcript it reads is
 * read by speakers but they are not reviewed, so the request leaves them out. Text without
 * speakers has nothing to leave out and gets no hint.
 */
export function speakersNotRead(state: TranscriptSpeakerState | undefined): boolean {
  return state !== undefined && state.speakerMode && !state.confirmed;
}
