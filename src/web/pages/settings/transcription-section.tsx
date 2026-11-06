import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GripVertical } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ASR_MODEL_ID_PATTERN, ASR_PRESETS, type AsrPreset } from "../../../shared/asr-presets.ts";
import { ASR_TEST_AUDIO_MS } from "../../../shared/defaults.ts";
import {
  asrProfileListDtoSchema,
  type AsrModelTestResultDto,
  type AsrProbeDto,
  type AsrProfileDto,
  type AsrProfileListDto,
  type AsrProfileModelDto,
  type AsrProfileModelInput,
} from "../../../shared/dto/asr-profile.ts";
import { ASR_PROVIDERS, type AsrProviderId } from "../../../shared/enums.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useAsrModelTest, useAsrProfileMutations, useAsrProfiles, usePatchSettings, useSetModelPricing, useSettings } from "../../api/queries.ts";
import { asrModelOptions, decodeAsrModel, encodeAsrModel, isPickableAsrModel } from "../../components/asr-model-select.tsx";
import { ModelPricingControl } from "../../components/model-pricing-dialog.tsx";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { useDragOrder, type DragHandleProps } from "../../ui/use-drag-order.ts";
import { ConfirmButton, CredentialInput, CredentialStatus, Field, INPUT_CLASS, RequestError, SettingsBlock, TestConnectionError } from "./settings-ui.tsx";

/**
 * `/settings/transcription`: the user's ASR profiles, each one service account with its
 * models, and the default model. Laid out like the LLM models
 * section; like the default LLM model, the default starts unset and is only ever set here.
 */
export function TranscriptionSection() {
  const { t } = useTranslation();
  const profiles = useAsrProfiles();
  const [creating, setCreating] = useState(false);
  if (profiles.isPending) {
    return <Loading />;
  }
  const items = profiles.data?.items ?? [];
  return (
    <div>
      <p className="mb-4 text-sm text-muted">{t("settings.transcription.intro")}</p>
      {items.length === 0 ? (
        <SettingsBlock>
          <EmptyState title={t("settings.transcription.empty")} hint={t("settings.transcription.emptyHint")}>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("settings.transcription.addProfile")}
            </Button>
          </EmptyState>
        </SettingsBlock>
      ) : (
        <>
          <DefaultModelBlock profiles={items} />
          <div className="mb-6">
            <Button variant="primary" onClick={() => setCreating(true)} data-testid="add-asr-profile">
              {t("settings.transcription.addProfile")}
            </Button>
          </div>
          <ProfileList profiles={items} />
        </>
      )}
      <RequestError error={profiles.error} />
      {creating ? <ProfileEditor onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function DefaultModelBlock({ profiles }: { profiles: readonly AsrProfileDto[] }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const patch = usePatchSettings();
  const current = settings.data?.defaultAsrModelRef;
  const value = isPickableAsrModel(profiles, current) ? encodeAsrModel(current) : "";
  return (
    <SettingsBlock title={t("settings.transcription.defaultModel")}>
      <select
        id="default-asr-model"
        aria-label={t("settings.transcription.defaultModel")}
        className={INPUT_CLASS}
        value={value}
        onChange={(event) => patch.mutate({ defaultAsrModelRef: decodeAsrModel(event.target.value) ?? null })}
      >
        <option value="">{t("settings.common.none")}</option>
        {asrModelOptions(profiles).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="mt-2 text-xs text-muted">{t("settings.transcription.defaultModelHint")}</p>
      <RequestError error={patch.error} />
    </SettingsBlock>
  );
}

const COLLAPSED_PROFILES_KEY = "amber.settings.collapsedAsrProfiles";

function readCollapsedProfiles(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROFILES_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * The profiles in the user's order: a profile is dragged by its handle (or
 * moved with the arrow keys) and the new order is saved when it is dropped; each can be
 * folded to its heading, which this browser remembers.
 */
function ProfileList({ profiles }: { profiles: readonly AsrProfileDto[] }) {
  const client = useApi();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(readCollapsedProfiles);
  const reorder = useMutation({
    mutationFn: (profileIds: string[]) => client.put("/api/asr-profiles/order", asrProfileListDtoSchema, { body: { profileIds } }),
    onMutate: (profileIds) => {
      // Shown in the new order at once; a refusal puts the server's order back.
      const previous = queryClient.getQueryData<AsrProfileListDto>(queryKeys.asrProfiles);
      if (previous !== undefined) {
        const byId = new Map(previous.items.map((item) => [item.id, item]));
        const items = profileIds.flatMap((id) => byId.get(id) ?? []);
        queryClient.setQueryData<AsrProfileListDto>(queryKeys.asrProfiles, { ...previous, items });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKeys.asrProfiles, context.previous);
    },
    onSuccess: (list) => queryClient.setQueryData(queryKeys.asrProfiles, list),
  });
  const { order, dragging, rowRef, handleProps } = useDragOrder(
    profiles.map((profile) => profile.id),
    (profileIds) => reorder.mutate(profileIds),
  );
  const toggle = (id: string): void => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_PROFILES_KEY, JSON.stringify([...next]));
    } catch {
      // Private mode without storage: the state just is not remembered.
    }
  };
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return (
    <div data-testid="asr-profile-list">
      <RequestError error={reorder.error} />
      {order.map((id) => {
        const profile = byId.get(id);
        if (profile === undefined) return null;
        return (
          <div key={id} ref={rowRef(id)} data-testid="asr-profile-card" data-profile={profile.name} className={dragging === id ? "opacity-70" : ""}>
            <ProfileCard profile={profile} collapsed={collapsed.has(id)} onToggle={() => toggle(id)} dragHandle={handleProps(id)} />
          </div>
        );
      })}
    </div>
  );
}

/** The display name of a preset region, or its id when no name is known. */
function useRegionName(): (id: string) => string {
  const { t, i18n } = useTranslation();
  return (id) => {
    const key = `settings.transcription.regions.${id}`;
    return i18n.exists(key) ? t(key as never) : id;
  };
}

/** The display name of a provider's request family, or its id when no name is known. */
function useFamilyName(): (provider: AsrProviderId, family: string) => string {
  const { t, i18n } = useTranslation();
  return (provider, family) => {
    const key = `settings.transcription.families.${provider}.${family}`;
    return i18n.exists(key) ? t(key as never) : family;
  };
}

/** The region a stored Base URL stands for, or the Base URL itself when it is none of the preset's. */
function regionOf(preset: AsrPreset, baseURL: string | undefined, regionName: (id: string) => string): string {
  const endpoint = baseURL === undefined ? preset.endpoints[0] : preset.endpoints.find((item) => item.baseURL === baseURL);
  return endpoint === undefined ? (baseURL ?? "") : regionName(endpoint.id);
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.error.class === "conflict";
}

/** A refusal for being in use reads as such; any other failure shows as usual. */
function MutationError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return isConflict(error) ? (
    <p className="mt-2 text-xs text-danger" role="alert">
      {t("settings.transcription.inUse")}
    </p>
  ) : (
    <RequestError error={error} />
  );
}

function ProfileCard({ profile, collapsed, onToggle, dragHandle }: { profile: AsrProfileDto; collapsed: boolean; onToggle: () => void; dragHandle: DragHandleProps }) {
  const { t } = useTranslation();
  const mutations = useAsrProfileMutations();
  const [editing, setEditing] = useState(false);
  const [probed, setProbed] = useState<AsrProbeDto | undefined>(undefined);
  const preset = ASR_PRESETS[profile.provider];
  const regionName = useRegionName();
  const where = preset.baseUrlPolicy === "preset_only" ? regionOf(preset, profile.baseURL, regionName) : (profile.baseURL ?? preset.endpoints[0]?.baseURL ?? "");
  return (
    <SettingsBlock
      title={
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken"
            aria-label={t("settings.transcription.dragProfile", { name: profile.name })}
            title={t("settings.transcription.dragProfile", { name: profile.name })}
            {...dragHandle}
          >
            <GripVertical size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-sunken"
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? "settings.transcription.expandProfile" : "settings.transcription.collapseProfile", { name: profile.name })}
            onClick={onToggle}
          >
            <ChevronDown size={14} className={collapsed ? "-rotate-90" : ""} />
          </button>
          <span data-testid="asr-profile-title">{profile.name}</span>
          {collapsed ? <span className="text-xs font-normal text-muted">{t("settings.transcription.modelCount", { count: profile.models.length })}</span> : null}
        </span>
      }
      actions={
        <>
          <Button size="sm" onClick={() => setEditing(true)}>
            {t("common.action.edit")}
          </Button>
          <ConfirmButton
            label={t("common.action.delete")}
            variant="danger"
            disabled={profile.inUse}
            message={t("settings.transcription.deleteConfirm", { name: profile.name })}
            onConfirm={() => mutations.remove.mutate(profile.id)}
          />
        </>
      }
    >
      {collapsed ? null : (
        <>
          <p className="mb-3 text-xs text-muted" data-testid="asr-profile-service">
            {t(`settings.transcription.providers.${profile.provider}`)} ·{" "}
            <span className={preset.baseUrlPolicy === "preset_only" ? "" : "font-mono"}>{where}</span>
          </p>
          {profile.inUse ? (
            <p className="mb-3 text-xs text-danger" data-testid="asr-profile-in-use">
              {t("settings.transcription.inUse")}
            </p>
          ) : null}
          <Field
            label={t("settings.transcription.keyLabel")}
            hint={t("settings.common.credential.writeOnly")}
            htmlFor={`asr-key-${profile.id}`}
            aside={<CredentialStatus status={profile.credentialStatus} />}
          >
            <CredentialInput
              id={`asr-key-${profile.id}`}
              hasCredential={profile.hasCredential}
              pending={mutations.credential.isPending}
              onSubmit={(value) => mutations.credential.mutate({ id: profile.id, value })}
            />
          </Field>
          <MutationError error={mutations.credential.error} />
          <div className="mt-2 flex items-center gap-3">
            <Button
              size="sm"
              disabled={!profile.hasCredential || mutations.probe.isPending}
              onClick={() => mutations.probe.mutate(profile.id, { onSuccess: setProbed })}
            >
              {t("settings.transcription.test")}
            </Button>
            {probed === undefined ? null : <ProbeResult probed={probed} />}
          </div>
          <RequestError error={mutations.probe.error} />
          <h3 className="mt-4 mb-1 text-xs font-medium text-muted">{t("settings.transcription.modelsTitle")}</h3>
          <p className="mb-1 text-xs text-muted" data-testid="asr-test-hint">
            {t("settings.transcription.testModelHint", { seconds: ASR_TEST_AUDIO_MS / 1000 })}
          </p>
          <ol className="divide-y divide-line" data-testid="asr-profile-models">
            {profile.models.map((model) => (
              <ModelRow key={model.modelId} profile={profile} model={model} />
            ))}
          </ol>
        </>
      )}
      <MutationError error={mutations.remove.error} />
      {editing ? <ProfileEditor profile={profile} onClose={() => setEditing(false)} /> : null}
    </SettingsBlock>
  );
}

/**
 * One model of a profile card: its family, its price, and "test connection", which sends a
 * short generated sound with that model and may cost a little.
 */
function ModelRow({ profile, model }: { profile: AsrProfileDto; model: AsrProfileModelDto }) {
  const { t, i18n } = useTranslation();
  const familyName = useFamilyName();
  const test = useAsrModelTest(profile.id);
  const pricing = useSetModelPricing("asr-profiles");
  const label = test.isPending ? t("settings.transcription.testingModel") : t("settings.transcription.testModel");
  return (
    <li className="py-2" data-testid="asr-profile-model" data-model={model.modelId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono" data-testid="asr-model-id">
            {model.modelId}
          </span>
          {model.family === undefined ? null : <span className="text-xs text-muted">{familyName(profile.provider, model.family)}</span>}
          {model.available ? null : <span className="text-xs text-danger">{t("settings.transcription.unavailable")}</span>}
        </div>
        <Button
          size="sm"
          disabled={!profile.hasCredential || !model.available || test.isPending}
          aria-label={`${label} · ${model.modelId}`}
          title={t("settings.transcription.testModelHint", { seconds: ASR_TEST_AUDIO_MS / 1000 })}
          onClick={() => test.mutate(model.modelId)}
        >
          {label}
        </Button>
      </div>
      <ModelPricingControl
        modelId={model.modelId}
        scope="asr"
        pricing={model.pricing}
        onSubmit={(next) => pricing.mutateAsync({ profileId: profile.id, modelId: model.modelId, pricing: next })}
      />
      <p className="mt-1 text-xs text-muted" data-testid="asr-model-tested">
        {model.testedAt === undefined ? t("settings.transcription.untested") : t("settings.transcription.testedAt", { time: formatDateTime(model.testedAt, i18n.language) })}
      </p>
      {test.data === undefined || test.isPending ? null : <TestResult result={test.data} />}
      <TestConnectionError error={test.error} />
    </li>
  );
}

function TestResult({ result }: { result: AsrModelTestResultDto }) {
  const { t } = useTranslation();
  const preview = result.textPreview?.trim() ?? "";
  // A confirmed remote cancellation is a settled outcome; otherwise the job may still be
  // running and billed, which the wording must not hide.
  const resultKey = result.result === "accepted" && result.remoteCancelled === true ? "acceptedCancelled" : result.result;
  return (
    <div className={`mt-1 text-xs ${result.result === "accepted" ? "text-muted" : "text-ok"}`} role="status" data-testid="asr-model-test-result">
      <p>{t(`settings.transcription.testResult.${resultKey}`, { ms: Math.round(result.latencyMs) })}</p>
      {result.result === "transcribed" && preview !== "" ? <p className="text-muted">{t("settings.transcription.testPreview", { text: preview })}</p> : null}
    </div>
  );
}

function ProbeResult({ probed }: { probed: AsrProbeDto }) {
  const { t } = useTranslation();
  const account = probed.subscriptionStatus !== undefined || (probed.usedUnits !== undefined && probed.limitUnits !== undefined);
  return (
    <span className="text-xs text-ok" role="status">
      {account ? t("settings.transcription.testOk") : t("settings.transcription.testOkUpload")}
      {probed.subscriptionStatus === undefined ? null : ` · ${t("settings.transcription.subscription")}: ${probed.subscriptionStatus}`}
      {probed.usedUnits === undefined || probed.limitUnits === undefined
        ? null
        : ` · ${t("settings.transcription.usage")}: ${probed.usedUnits} / ${probed.limitUnits}`}
    </span>
  );
}

/** A model in the editor: `fresh` until saved, which is when a typed-in model's family can still be chosen. */
interface ModelDraft {
  modelId: string;
  family: string | undefined;
  fresh: boolean;
}

function isKnown(preset: AsrPreset, modelId: string): boolean {
  return Object.hasOwn(preset.knownModels, modelId);
}

function freshDraft(preset: AsrPreset, modelId: string): ModelDraft {
  return { modelId, family: isKnown(preset, modelId) ? preset.knownModels[modelId] : preset.customModelFamily, fresh: true };
}

/**
 * What a save sends for a model: a typed-in model added here names its family; a known or
 * kept model is sent bare, since the server resolves or keeps its family.
 */
function modelInput(preset: AsrPreset, draft: ModelDraft): AsrProfileModelInput {
  return draft.fresh && !isKnown(preset, draft.modelId) && draft.family !== undefined ? { modelId: draft.modelId, family: draft.family } : { modelId: draft.modelId };
}

/**
 * Create or edit a profile; the model list is replaced as a whole, in the order shown. A
 * new profile starts with its service's recommended models and its key is saved right
 * after it. Any model id may be added: the service's models are only suggestions, a known
 * one brings its own family and any other is given one. A model's family is fixed once
 * saved. The service is fixed once created. A model a running Task uses, and the region of
 * a profile in use, stay as they are (the server refuses with `conflict`).
 */
function ProfileEditor({ profile, onClose }: { profile?: AsrProfileDto; onClose: () => void }) {
  const { t } = useTranslation();
  const mutations = useAsrProfileMutations();
  const regionName = useRegionName();
  const familyName = useFamilyName();
  const [provider, setProvider] = useState<AsrProviderId>(profile?.provider ?? "dashscope");
  const preset = ASR_PRESETS[provider];
  const [name, setName] = useState(profile?.name ?? t(`settings.transcription.providers.${provider}`));
  const [models, setModels] = useState<ModelDraft[]>(
    () =>
      profile?.models.map((model) => ({ modelId: model.modelId, family: model.family, fresh: false })) ??
      preset.recommendedModels.map((modelId) => freshDraft(preset, modelId)),
  );
  const ids = models.map((model) => model.modelId);
  // Dragging only reorders the rows here; saving sends the list in this order.
  const rows = useDragOrder(ids, (order) => setModels((current) => order.flatMap((id) => current.find((model) => model.modelId === id) ?? [])));
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState<"invalid" | "duplicate" | undefined>(undefined);
  const [baseURL, setBaseURL] = useState(profile?.baseURL ?? (preset.baseUrlPolicy === "preset_only" ? (preset.endpoints[0]?.baseURL ?? "") : ""));
  const [key, setKey] = useState("");
  const [touched, setTouched] = useState(false);
  const locked = profile?.inUse === true;
  const valid = name.trim() !== "" && models.length > 0;
  const unavailable = new Set(profile?.models.filter((model) => !model.available).map((model) => model.modelId) ?? []);
  const suggestions = preset.models.filter((model) => !ids.includes(model));
  // The drag order catches up with additions and removals on the next render.
  const shown = [...rows.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !rows.order.includes(id))].flatMap(
    (id) => models.find((model) => model.modelId === id) ?? [],
  );

  const addModel = (): void => {
    const modelId = adding.trim();
    if (!ASR_MODEL_ID_PATTERN.test(modelId)) {
      setAddError("invalid");
      return;
    }
    if (ids.includes(modelId)) {
      setAddError("duplicate");
      return;
    }
    // A saved model removed and added back is kept as it was, family included.
    const saved = profile?.models.find((model) => model.modelId === modelId);
    setModels((current) => [...current, saved === undefined ? freshDraft(preset, modelId) : { modelId, family: saved.family, fresh: false }]);
    setAdding("");
    setAddError(undefined);
  };

  const save = async (): Promise<void> => {
    const trimmedURL = baseURL.trim();
    const body = models.map((model) => modelInput(preset, model));
    if (profile === undefined) {
      const created = await mutations.create.mutateAsync({
        name: name.trim(),
        provider,
        models: body,
        ...(trimmedURL === "" ? {} : { baseURL: trimmedURL }),
      });
      if (key.trim() !== "") {
        await mutations.credential.mutateAsync({ id: created.id, value: key.trim() });
      }
    } else {
      const sameURL = trimmedURL === (profile.baseURL ?? "");
      const sameModels = ids.join("\u0000") === profile.models.map((model) => model.modelId).join("\u0000");
      await mutations.patch.mutateAsync({
        id: profile.id,
        patch: {
          ...(name.trim() === profile.name ? {} : { name: name.trim() }),
          ...(sameModels ? {} : { models: body }),
          ...(sameURL ? {} : { baseURL: trimmedURL === "" ? null : trimmedURL }),
        },
      });
    }
    onClose();
  };
  const [saving, setSaving] = useState(false);
  const failure = mutations.create.error ?? mutations.patch.error ?? mutations.credential.error;

  return (
    <Modal
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={profile === undefined ? t("settings.transcription.addProfile") : t("settings.transcription.editProfile")}
      wide
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!valid) return;
          setSaving(true);
          save()
            .catch(() => undefined)
            .finally(() => setSaving(false));
        }}
      >
        <Field label={t("settings.transcription.provider")} htmlFor="asr-provider">
          <select
            id="asr-provider"
            className={INPUT_CLASS}
            value={provider}
            disabled={profile !== undefined}
            onChange={(event) => {
              const next = event.target.value as AsrProviderId;
              const nextPreset = ASR_PRESETS[next];
              setProvider(next);
              setName(t(`settings.transcription.providers.${next}`));
              setModels(nextPreset.recommendedModels.map((modelId) => freshDraft(nextPreset, modelId)));
              setAdding("");
              setAddError(undefined);
              setBaseURL(nextPreset.baseUrlPolicy === "preset_only" ? (nextPreset.endpoints[0]?.baseURL ?? "") : "");
            }}
          >
            {ASR_PROVIDERS.map((item) => (
              <option key={item} value={item}>
                {t(`settings.transcription.providers.${item}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("settings.transcription.name")} htmlFor="asr-name">
          <input id="asr-name" className={INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} />
          {touched && name.trim() === "" ? <p className="text-xs text-danger">{t("settings.transcription.required")}</p> : null}
        </Field>
        {preset.baseUrlPolicy === "preset_only" ? (
          <Field label={t("settings.transcription.region")} htmlFor="asr-region" hint={t("settings.transcription.regionHint")}>
            <select id="asr-region" className={INPUT_CLASS} value={baseURL} disabled={locked} onChange={(event) => setBaseURL(event.target.value)}>
              {preset.endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.baseURL}>
                  {regionName(endpoint.id)}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={t("settings.transcription.baseURL")} htmlFor="asr-base-url">
            <input
              id="asr-base-url"
              className={`${INPUT_CLASS} font-mono`}
              value={baseURL}
              disabled={locked}
              placeholder={preset.endpoints[0]?.baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
            />
          </Field>
        )}
        <h3 className="mt-4 mb-2 text-xs font-medium text-muted">{t("settings.transcription.modelsTitle")}</h3>
        <ul data-testid="asr-model-drafts">
          {shown.map((model) => {
            const choosable = model.fresh && !isKnown(preset, model.modelId);
            return (
              <li
                key={model.modelId}
                ref={rows.rowRef(model.modelId)}
                className={`py-1 text-sm ${rows.dragging === model.modelId ? "bg-accent-soft" : ""}`}
                data-testid="asr-model-draft"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken"
                    aria-label={`${t("settings.transcription.dragModel")} · ${model.modelId}`}
                    title={t("settings.transcription.dragModel")}
                    {...rows.handleProps(model.modelId)}
                  >
                    <GripVertical size={14} />
                  </button>
                  <span className="min-w-0 flex-1 truncate font-mono">{model.modelId}</span>
                  {choosable ? (
                    <select
                      aria-label={t("settings.transcription.familyFor", { model: model.modelId })}
                      className="h-7 rounded border border-line bg-surface px-1 text-xs"
                      value={model.family ?? preset.customModelFamily}
                      onChange={(event) =>
                        setModels((current) => current.map((item) => (item.modelId === model.modelId ? { ...item, family: event.target.value } : item)))
                      }
                    >
                      {preset.families.map((family) => (
                        <option key={family.id} value={family.id}>
                          {familyName(provider, family.id)}
                        </option>
                      ))}
                    </select>
                  ) : model.family === undefined ? null : (
                    <span className="text-xs text-muted" data-testid="asr-model-draft-family">
                      {familyName(provider, model.family)}
                    </span>
                  )}
                  {unavailable.has(model.modelId) ? <span className="text-xs text-danger">{t("settings.transcription.unavailable")}</span> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={models.length <= 1}
                    aria-label={`${t("settings.transcription.removeModel")} · ${model.modelId}`}
                    onClick={() => setModels((current) => current.filter((item) => item.modelId !== model.modelId))}
                  >
                    {t("settings.transcription.removeModel")}
                  </Button>
                </div>
                {choosable ? <p className="ml-8 text-xs text-muted">{t("settings.transcription.familyHint")}</p> : null}
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex items-center gap-2">
          <input
            aria-label={t("settings.transcription.addModel")}
            list={`asr-model-suggestions-${provider}`}
            className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
            value={adding}
            placeholder={t("settings.transcription.addModelPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setAdding(event.target.value);
              setAddError(undefined);
            }}
            onKeyDown={(event) => {
              // Enter adds the typed model instead of saving the whole form.
              if (event.key === "Enter") {
                event.preventDefault();
                addModel();
              }
            }}
          />
          <datalist id={`asr-model-suggestions-${provider}`} data-testid="asr-model-suggestions">
            {suggestions.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <Button size="sm" disabled={adding.trim() === ""} onClick={addModel}>
            {t("settings.transcription.addModelSubmit")}
          </Button>
        </div>
        {addError === undefined ? null : (
          <p className="mt-1 text-xs text-danger" role="alert">
            {t(addError === "invalid" ? "settings.transcription.invalidModelId" : "settings.transcription.duplicateModel")}
          </p>
        )}
        {profile === undefined ? (
          <Field label={t("settings.transcription.keyLabel")} htmlFor="asr-new-key" hint={t("settings.common.credential.writeOnly")}>
            <input
              id="asr-new-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
              value={key}
              placeholder={t("settings.common.credential.placeholder")}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
        ) : null}
        {locked || isConflict(mutations.patch.error) ? (
          <p className="mb-2 text-xs text-danger" role="alert">
            {t("settings.transcription.inUse")}
          </p>
        ) : null}
        {isConflict(mutations.patch.error) ? null : <RequestError error={failure} />}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {t("common.action.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
