import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mic } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ASR_PRESETS, asrDiarizationSupport } from "../../../../../shared/asr-presets.ts";
import type { AsrProfileDto } from "../../../../../shared/dto/asr-profile.ts";
import type { AsrModelRefDto } from "../../../../../shared/dto/model-ref.ts";
import { taskAcceptedDtoSchema } from "../../../../../shared/dto/task.ts";
import { ApiError } from "../../../../api/client.ts";
import { useApi } from "../../../../api/context.tsx";
import { useAsrProfiles } from "../../../../api/queries.ts";
import { diarizationOffer } from "../../../../components/asr-diarization.ts";
import { AsrModelSelect } from "../../../../components/asr-model-select.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { Button } from "../../../../ui/button.tsx";
import { contentKeys } from "../../content-data.ts";

/** The error code of a comparison the Content has no room of speakers for. */
const SPEAKER_CAPACITY_CODE = "conflict.speaker_capacity";

/**
 * The user's profiles narrowed to the models that declare speaker identification: a comparison
 * without speakers would have nothing to compare.
 */
export function identifyingProfiles(profiles: readonly AsrProfileDto[]): AsrProfileDto[] {
  return profiles.flatMap((profile) => {
    const models = profile.models.filter((model) => model.available && asrDiarizationSupport(ASR_PRESETS[profile.provider], model.modelId) !== undefined);
    return models.length === 0 ? [] : [{ ...profile, models }];
  });
}

/**
 * 「用另一家模型再识别一次」: one more, paid transcription of the Content made only to compare
 * speakers with. Nothing happens before the explicit click; the model is picked among those
 * that identify speakers, and identification is required. The server refuses up front, before
 * anything is paid, a model or length that cannot identify speakers and a Content without room
 * for more speakers; both refusals are shown here.
 */
export function ComparisonTranscribe(props: { contentId: string; durationMs?: number; onSubmitted?: (taskId: string) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const profiles = useAsrProfiles();
  const usable = useMemo(() => identifyingProfiles(profiles.data?.items ?? []), [profiles.data]);
  const [model, setModel] = useState<AsrModelRefDto | undefined>(undefined);
  const offer = diarizationOffer(usable, model, props.durationMs);
  const noteId = useId();
  const submit = useMutation({
    mutationFn: (asrModelRef: AsrModelRefDto) =>
      client.post(`/api/contents/${encodeURIComponent(props.contentId)}/transcript/retranscribe`, taskAcceptedDtoSchema, {
        body: { asrModelRef, diarization: { mode: "required" }, comparison: true },
        idempotent: true,
      }),
    onSuccess: (accepted) => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.latestTask(props.contentId) });
      props.onSubmitted?.(accepted.taskId);
    },
  });
  const failure = submit.error instanceof ApiError ? submit.error.error : undefined;
  const room = failure?.code === SPEAKER_CAPACITY_CODE ? failure.details : undefined;

  if (profiles.isPending) return null;
  if (usable.length === 0) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="comparison-transcribe-none">
        {t("speakerCompare.trigger.noModel")}
        <Link to="/settings/transcription" className="text-accent hover:underline">
          {t("speakerCompare.trigger.configure")}
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="comparison-transcribe">
      <div className="flex flex-wrap items-center gap-2">
        <AsrModelSelect
          profiles={usable}
          value={model}
          onChange={(next) => {
            setModel(next);
            submit.reset();
          }}
          label={t("speakerCompare.trigger.model")}
          placeholder={t("speakerCompare.trigger.pickModel")}
          className="h-8 min-w-0 max-w-full rounded-md border border-line bg-surface px-2 text-sm"
          testId="comparison-model"
          disabled={submit.isPending}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={model === undefined || offer.status !== "available" || submit.isPending || submit.isSuccess}
          aria-describedby={noteId}
          onClick={() => {
            if (model !== undefined) submit.mutate(model);
          }}
          data-testid="comparison-transcribe-submit"
        >
          <Mic size={14} aria-hidden="true" />
          {t("speakerCompare.trigger.button")}
        </Button>
      </div>
      <p id={noteId} className="text-xs text-muted">
        {offer.status === "over_recommended" ? t("speakerTools.note.overRecommended") : t("speakerCompare.trigger.paid")}
      </p>
      {submit.isSuccess ? (
        <p role="status" className="text-xs text-muted" data-testid="comparison-transcribe-submitted">
          {t("speakerCompare.trigger.submitted")}
        </p>
      ) : null}
      {room !== undefined ? (
        <p role="alert" className="text-xs text-danger" data-testid="comparison-capacity">
          {t("speakerCompare.trigger.capacity", { room: Number(room["room"]), required: Number(room["required"]) })}
        </p>
      ) : failure !== undefined ? (
        <ErrorView error={failure} />
      ) : null}
    </div>
  );
}
