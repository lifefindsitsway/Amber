import { useTranslation } from "react-i18next";
import type { AsrProfileDto } from "../../shared/dto/asr-profile.ts";
import type { AsrModelRefDto } from "../../shared/dto/model-ref.ts";
import type { SelectSize } from "../ui/select.tsx";
import { ModelSelect, type ModelSelectEntry } from "./model-select.tsx";

/** The value an ASR model takes in a picker; "" stands for none chosen. */
export function encodeAsrModel(ref: AsrModelRefDto): string {
  return JSON.stringify([ref.asrProfileId, ref.modelId]);
}

export function decodeAsrModel(value: string): AsrModelRefDto | undefined {
  if (value === "") return undefined;
  try {
    const [asrProfileId, modelId] = JSON.parse(value) as [string, string];
    return { asrProfileId, modelId };
  } catch {
    return undefined;
  }
}

/** Whether the reference names a model its profile lists and its provider still offers. */
export function isPickableAsrModel(profiles: readonly AsrProfileDto[], ref: AsrModelRefDto | undefined): ref is AsrModelRefDto {
  if (ref === undefined) return false;
  const profile = profiles.find((item) => item.id === ref.asrProfileId);
  return profile?.models.some((model) => model.modelId === ref.modelId && model.available) === true;
}

/**
 * The model an ASR picker starts with: the user's default while it can still
 * be picked, else none. It never falls back to the first listed model: a model is only used
 * when the user chose it, here or as the default.
 */
export function initialAsrModelRef(profiles: readonly AsrProfileDto[], defaultRef: AsrModelRefDto | undefined): AsrModelRefDto | undefined {
  return isPickableAsrModel(profiles, defaultRef) ? defaultRef : undefined;
}

/** Every pickable model as "profile · model", in the user's profile order and then model order. */
export function asrModelOptions(profiles: readonly AsrProfileDto[]): Array<{ ref: AsrModelRefDto; value: string; label: string }> {
  return profiles.flatMap((profile) =>
    profile.models
      .filter((model) => model.available)
      .map((model) => {
        const ref = { asrProfileId: profile.id, modelId: model.modelId };
        return { ref, value: encodeAsrModel(ref), label: `${profile.name} · ${model.modelId}` };
      }),
  );
}

/** "Profile · model" while the profile exists, else "service · model (profile deleted)". */
export function useAsrModelLabel(): (ref: AsrModelRefDto, profiles: readonly AsrProfileDto[], provider?: string) => string {
  const { t } = useTranslation();
  return (ref, profiles, provider) => {
    const profile = profiles.find((item) => item.id === ref.asrProfileId);
    if (profile !== undefined) {
      return `${profile.name} · ${ref.modelId}`;
    }
    const service = provider === undefined ? undefined : t(`settings.transcription.providers.${provider}`, { defaultValue: provider });
    return t("shell.flow.asrEngineDeleted", { engine: service === undefined ? ref.modelId : `${service} · ${ref.modelId}` });
  };
}

/**
 * A menu over the user's pickable ASR models, grouped by profile and marked with each service's
 * icon. With `noneLabel` its first entry chooses none; without it, an unset value shows
 * `placeholder` until the user picks.
 */
export function AsrModelSelect(props: {
  profiles: readonly AsrProfileDto[];
  value: AsrModelRefDto | undefined;
  onChange: (ref: AsrModelRefDto | undefined) => void;
  label: string;
  noneLabel?: string | undefined;
  placeholder?: string | undefined;
  /** Shown for a current value that is not (or no longer) pickable, so it stays selected. */
  currentLabel?: string | undefined;
  /** The service of that current value, for its mark; unknown or deleted shows the neutral one. */
  currentProvider?: string | undefined;
  /** A binding that stays listed (under `currentLabel`) even after another model is picked, so it can be chosen again. */
  bound?: AsrModelRefDto | undefined;
  id?: string | undefined;
  /** Ids of the hint or error that describe the picker. */
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  size?: SelectSize | undefined;
  width?: "fill" | "content" | undefined;
  /** Extra classes on the trigger, e.g. a maximum width. */
  className?: string | undefined;
  testId?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const entries: ModelSelectEntry[] = props.profiles.flatMap((profile) =>
    profile.models
      .filter((model) => model.available)
      .map((model) => ({
        value: encodeAsrModel({ asrProfileId: profile.id, modelId: model.modelId }),
        profileName: profile.name,
        profileKey: profile.id,
        modelId: model.modelId,
        service: profile.provider,
      })),
  );
  const value = props.value === undefined ? "" : encodeAsrModel(props.value);
  const shown = props.bound ?? props.value;
  const ownProvider = shown === undefined ? undefined : props.profiles.find((profile) => profile.id === shown.asrProfileId)?.provider;
  return (
    <ModelSelect
      kind="asr"
      entries={entries}
      value={value}
      onChange={(next) => props.onChange(decodeAsrModel(next))}
      noneLabel={props.noneLabel}
      placeholder={props.placeholder}
      current={{
        label: props.currentLabel ?? props.bound?.modelId ?? props.value?.modelId ?? "",
        modelId: (props.bound ?? props.value)?.modelId,
        service: props.currentProvider ?? ownProvider,
        value: props.bound === undefined ? undefined : encodeAsrModel(props.bound),
      }}
      id={props.id}
      ariaLabel={props.label}
      describedBy={props.describedBy}
      invalid={props.invalid}
      testId={props.testId}
      disabled={props.disabled}
      size={props.size}
      width={props.width}
      className={props.className}
    />
  );
}
