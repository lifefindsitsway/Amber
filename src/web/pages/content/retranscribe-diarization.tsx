import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AsrDiarizationSupport } from "../../../shared/asr-presets.ts";
import type { DiarizationRequest } from "../../../shared/dto/speaker.ts";
import type { AppError } from "../../../shared/errors.ts";
import { DIARIZATION_UNAVAILABLE_REASONS, type DiarizationUnavailableReason } from "../../../shared/speakers.ts";
import { parseSpeakerCount, speakerCountOutOfRange, type DiarizationOffer } from "../../components/asr-diarization.ts";
import { Button } from "../../ui/button.tsx";
import { Switch } from "../../ui/switch.tsx";

/** The error code of a required identification the submission cannot honour. */
export const DIARIZATION_UNAVAILABLE_CODE = "invalid_request.diarization_unavailable";

/**
 * The state of the re-transcribe identification options. The switch starts from the user's
 * setting until it is touched; it is off and locked while the chosen model or content length
 * offers no identification. What it asks of the Task is read through `request()`: an
 * available switch that is on is an explicit request, so a length the pre-checks refuse is
 * reported at submission rather than silently skipped. A locked switch the user never turned
 * off still follows their setting as a preference, so the revision records why nobody was
 * identified (the model offers none, or the audio is too long) instead of a plain "off".
 */
export function useDiarizationChoice(offer: DiarizationOffer, settingOn: boolean) {
  const [touched, setTouched] = useState<boolean | undefined>(undefined);
  const [countText, setCountText] = useState("");
  const enabled = offer.status === "available";
  const on = enabled && (touched ?? settingOn);
  const count = on ? parseSpeakerCount(countText) : undefined;
  const invalidCount = offer.status === "available" && on && speakerCountOutOfRange(offer.support, count);
  const wanted = touched ?? settingOn;
  const locked = offer.status === "unsupported" || offer.status === "over_recommended";
  const request = (): DiarizationRequest => {
    if (on) return { mode: "required", ...(typeof count === "number" ? { speakerCount: count } : {}) };
    return locked && wanted ? { mode: "preferred" } : { mode: "off" };
  };
  return { enabled, on, setOn: setTouched, countText, setCountText, invalidCount, request };
}

export type DiarizationChoice = ReturnType<typeof useDiarizationChoice>;

/** Why the switch is locked, as the short line next to it; `undefined` while it can be used or no model is chosen. */
function lockedReason(offer: DiarizationOffer): "unsupported" | "overRecommended" | undefined {
  if (offer.status === "unsupported") return "unsupported";
  if (offer.status === "over_recommended") return "overRecommended";
  return undefined;
}

/**
 * The identification switch with, while it is on, the speaker count field. The count's
 * wording follows the model: a reference value (labelled with the range) or an upper bound
 * (written around the input). Left empty the count is automatic.
 */
export function DiarizationOptions(props: {
  offer: DiarizationOffer;
  choice: DiarizationChoice;
  /** The setting the switch starts from is still loading: the switch waits rather than start from a guess. */
  settingPending?: boolean;
}) {
  const { t } = useTranslation();
  const { offer, choice } = props;
  const reasonId = useId();
  const errorId = useId();
  const reason = lockedReason(offer);
  const reasonText = reason === undefined ? undefined : t(`speakerTools.note.${reason}`);
  const support = offer.status === "available" ? offer.support : undefined;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="diarization-options">
      <Switch className="text-xs" checked={choice.on} disabled={!choice.enabled || props.settingPending === true} onChange={choice.setOn} title={reasonText} describedBy={reasonText === undefined ? undefined : reasonId} testId="diarization-switch">
        {t("speakerTools.retranscribe.diarization")}
      </Switch>
      {reasonText === undefined ? null : (
        <span id={reasonId} className="text-xs text-muted" data-testid="diarization-reason">
          {reasonText}
        </span>
      )}
      {support !== undefined && choice.on ? <SpeakerCountField support={support} choice={choice} errorId={errorId} /> : null}
      {support !== undefined && choice.on && choice.invalidCount ? (
        <span id={errorId} role="alert" className="basis-full text-xs text-danger" data-testid="diarization-count-error">
          {t("speakerTools.retranscribe.countInvalid", support.speakerCount)}
        </span>
      ) : null}
    </span>
  );
}

function SpeakerCountField(props: { support: AsrDiarizationSupport; choice: DiarizationChoice; errorId: string }) {
  const { t } = useTranslation();
  const { min, max, semantics } = props.support.speakerCount;
  const input = (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className={`h-7 w-14 rounded border bg-surface px-1 text-center text-xs tabular-nums ${props.choice.invalidCount ? "border-danger" : "border-line"}`}
      placeholder={t("speakerTools.retranscribe.countAuto")}
      aria-label={t(semantics === "reference" ? "speakerTools.retranscribe.countReferenceLabel" : "speakerTools.retranscribe.countMaximumLabel", { min, max })}
      aria-invalid={props.choice.invalidCount}
      aria-describedby={props.choice.invalidCount ? props.errorId : undefined}
      value={props.choice.countText}
      onChange={(event) => props.choice.setCountText(event.target.value)}
      data-testid="diarization-count"
    />
  );
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted" data-semantics={semantics}>
      {semantics === "reference" ? (
        <>
          <span>{t("speakerTools.retranscribe.countReference", { min, max })}</span>
          {input}
        </>
      ) : (
        <>
          <span>{t("speakerTools.retranscribe.countMaximumBefore")}</span>
          {input}
          <span>{t("speakerTools.retranscribe.countMaximumAfter")}</span>
        </>
      )}
    </label>
  );
}

/** The reason out of a refused submission; `undefined` when it names none Amber knows. */
export function unavailableReason(error: AppError): DiarizationUnavailableReason | undefined {
  const reason = error.details?.["reason"];
  return DIARIZATION_UNAVAILABLE_REASONS.find((known) => known === reason);
}

/**
 * Shown when a required identification was refused before anything was sent: why, and the
 * two ways on. Continuing without identification is the user's own decision, never automatic.
 */
export function DiarizationUnavailableNotice(props: { error: AppError; offer: DiarizationOffer; busy: boolean; onContinue: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const reason = unavailableReason(props.error);
  // The model's range, when the provider documents one for the chosen model.
  const range = props.offer.status === "available" || props.offer.status === "over_recommended" ? props.offer.support.speakerCount : undefined;
  const text =
    reason === undefined
      ? t("speakerTools.retranscribe.unavailable.other")
      : reason === "speaker_count" && range !== undefined
        ? t("speakerTools.retranscribe.unavailable.speaker_count_range", range)
        : t(`speakerTools.retranscribe.unavailable.${reason}`);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-sunken px-3 py-2 text-xs" data-testid="diarization-unavailable" data-reason={reason ?? "unknown"}>
      <p className="min-w-0 flex-1">
        <span className="font-medium">{t("speakerTools.retranscribe.unavailable.title")}</span>
        <span className="text-muted">{text}</span>
      </p>
      <Button size="sm" variant="primary" disabled={props.busy} onClick={props.onContinue} data-testid="diarization-continue">
        {t("speakerTools.retranscribe.unavailable.continueWithout")}
      </Button>
      <Button size="sm" variant="ghost" onClick={props.onCancel} data-testid="diarization-cancel">
        {t("common.action.cancel")}
      </Button>
    </div>
  );
}
