import type { i18n as I18n, TFunction } from "i18next";
import type { TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import { asrDiarizationRecordSchema } from "../../../shared/dto/speaker.ts";
import { isComparisonGeneration } from "../../../shared/speaker-comparison.ts";
import { revisionBasis } from "./labels.ts";

/**
 * What an `asr` revision recorded about speaker identification, as a short status; `undefined`
 * for other kinds and for revisions made before the status was recorded.
 */
export function diarizationStatusText(revision: TranscriptRevisionDto, t: TFunction): string | undefined {
  if (revision.kind !== "asr") return undefined;
  const record = asrDiarizationRecordSchema.safeParse(revision.generation["diarization"]);
  if (!record.success) return undefined;
  return t("speakerTools.revisionInfo.diarization", { status: t(`speakerTools.revisionInfo.status.${record.data.status}`) });
}

/**
 * How many sentences of a hand-edited revision took their speaker from a suggestion the user
 * accepted without checking each one; `undefined` when none did or the record is absent.
 */
export function acceptedSuggestionsText(revision: TranscriptRevisionDto, t: TFunction): string | undefined {
  if (revision.kind !== "manual") return undefined;
  const review = revision.generation["speakerReview"];
  if (typeof review !== "object" || review === null) return undefined;
  const count = (review as Record<string, unknown>)["acceptedSuggestions"];
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? t("speakerTools.revisionInfo.acceptedSuggestions", { count }) : undefined;
}

/**
 * The version info a revision picker shows on hover: the revision it is based on, then how
 * its speakers came about. One line each; `undefined` when there is nothing to say.
 */
export function revisionInfo(revision: TranscriptRevisionDto, among: readonly TranscriptRevisionDto[], t: TFunction, i18n?: Pick<I18n, "exists">): string | undefined {
  const comparison = isComparisonGeneration(revision.generation) ? t("speakerCompare.revisionInfo") : undefined;
  const lines = [comparison, revisionBasis(revision, among, t, i18n), diarizationStatusText(revision, t), acceptedSuggestionsText(revision, t)].filter((line): line is string => line !== undefined);
  return lines.length === 0 ? undefined : lines.join("\n");
}
