import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { StageEngineDto } from "../../shared/dto/task.ts";
import type { StageId } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import { useAsrProfiles, useProviders } from "../api/queries.ts";
import { Callout, TextAction } from "../ui/notice.tsx";
import { useAsrModelLabel } from "./asr-model-select.tsx";

/**
 * "Profile · model" for an LLM binding. For ASR, "profile name · model" while the bound
 * profile exists, else "service · model (profile deleted)" with the service the stage
 * recorded, when known.
 */
export function useEngineLabel(engine: StageEngineDto | undefined): string | undefined {
  const providers = useProviders();
  const asrProfiles = useAsrProfiles(engine?.kind === "asr");
  const asrLabel = useAsrModelLabel();
  if (engine === undefined) {
    return undefined;
  }
  if (engine.kind === "asr") {
    if (!asrProfiles.isSuccess) {
      return undefined;
    }
    return asrLabel(engine.asrModelRef, asrProfiles.data.items, engine.provider);
  }
  const profile = providers.data?.items.find((item) => item.id === engine.modelRef.providerProfileId);
  return profile === undefined ? engine.modelRef.modelId : `${profile.name} · ${engine.modelRef.modelId}`;
}

/**
 * The three layers of a failure: stage + engine, the plain-language
 * explanation, and the redacted upstream text behind a toggle. Actions go below.
 * An error notice announced as an alert: it appears in response to something that just failed.
 */
export function ErrorView(props: { error: AppError; stage?: StageId; engine?: StageEngineDto; children?: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const engineLabel = useEngineLabel(props.engine);
  const message = props.error.userMessage !== "" ? props.error.userMessage : t(`errors.${props.error.class}`);
  return (
    <Callout
      tone="error"
      announce="alert"
      {...(props.stage === undefined
        ? {}
        : {
            title: (
              <>
                {t(`common.stage.${props.stage}`)}
                {engineLabel === undefined ? null : <span className="font-normal text-muted">{` · ${engineLabel}`}</span>}
              </>
            ),
          })}
      {...(props.children === undefined ? {} : { actions: props.children })}
    >
      <p>{message}</p>
      {props.error.upstreamMessage === undefined ? null : (
        <div className="mt-1.5">
          <TextAction className="text-note" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? t("common.action.hideDetail") : t("common.error.upstream")}
          </TextAction>
          {open ? <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface/70 p-2 text-xs whitespace-pre-wrap">{props.error.upstreamMessage}</pre> : null}
        </div>
      )}
    </Callout>
  );
}
