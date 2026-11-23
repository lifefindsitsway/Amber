import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GripVertical, Server } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  probeResultDtoSchema,
  providerListDtoSchema,
  providerProfileDtoSchema,
  type CapabilityFlagsDto,
  type ModelCapabilityDto,
  type ProviderListDto,
  type ProviderProfileDto,
} from "../../../shared/dto/provider.ts";
import { TRI_STATES } from "../../../shared/enums.ts";
import { CUSTOM_PRESET_ID, hasRegions, matchPresetAddress, normalizeBaseUrl, presetById } from "../../../shared/llm-presets.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useCacheObservedModel, usePatchSettings, useProviders, useSetContextWindow, useSetModelPricing, useSettings } from "../../api/queries.ts";
import { ModelPricingControl } from "../../components/model-pricing-dialog.tsx";
import { ModelSelect, type ModelSelectEntry } from "../../components/model-select.tsx";
import { formatDateTime } from "../../format.ts";
import { CONTEXT_WINDOW_SUGGESTION_LABELS } from "../../models/context-window.ts";
import { LlmModelMark } from "../../models/model-mark.tsx";
import { Button, FOCUS_RING } from "../../ui/button.tsx";
import { CONTROL_BASE, CONTROL_HEIGHT } from "../../ui/control.ts";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { NativeSelect } from "../../ui/native-select.tsx";
import { FieldError, FieldHint, NOTE_TEXT_CLASS, TextAction } from "../../ui/notice.tsx";
import { SuggestionInput } from "../../ui/suggestion-input.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import { useDragOrder, type DragHandleProps } from "../../ui/use-drag-order.ts";
import { VendorIcon } from "../../ui/vendor-icon.tsx";
import { ProbeResult } from "./probe-result.tsx";
import { ProfileEditor } from "./profile-editor.tsx";
import { ConfirmButton, CredentialInput, describedBy, Field, fieldHintId, RequestError, SettingsBlock } from "./settings-ui.tsx";
import { parseTokenCount } from "./token-count.tsx";

type TriState = (typeof TRI_STATES)[number];

const CAPABILITY_KEYS = ["stream", "tools", "structuredOutput", "vision", "audioInput", "reasoning"] as const satisfies ReadonlyArray<keyof CapabilityFlagsDto>;

/** `/settings/models`: LLM Provider Profiles, their models and the default model. */
export function ModelsSection() {
  const { t } = useTranslation();
  const providers = useProviders();
  const [creating, setCreating] = useState(false);
  if (providers.isPending) {
    return <Loading />;
  }
  const items = providers.data?.items ?? [];
  return (
    <div>
      <p className={`mb-4 ${NOTE_TEXT_CLASS}`}>{t("settings.models.intro")}</p>
      {items.length === 0 ? (
        <SettingsBlock>
          <EmptyState
            icon={<Server size={28} />}
            title={t("settings.models.wizardTitle")}
            hint={t("settings.models.wizardHint")}
            action={
              <Button variant="primary" onClick={() => setCreating(true)} data-testid="add-first-profile">
                {t("settings.models.addProfile")}
              </Button>
            }
          />
        </SettingsBlock>
      ) : (
        <>
          <DefaultModelBlock profiles={items} />
          <div className="mb-6">
            <Button variant="primary" onClick={() => setCreating(true)} data-testid="add-profile">
              {t("settings.models.addProfile")}
            </Button>
          </div>
          <ProfileList profiles={items} />
        </>
      )}
      {providers.error === null ? null : <RequestError error={providers.error} />}
      {creating ? <ProfileEditor onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function modelKey(providerProfileId: string, modelId: string): string {
  return JSON.stringify([providerProfileId, modelId]);
}

function DefaultModelBlock({ profiles }: { profiles: readonly ProviderProfileDto[] }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const patch = usePatchSettings();
  const current = settings.data?.defaultModelRef;
  const value = current === undefined ? "" : modelKey(current.providerProfileId, current.modelId);
  const entries: ModelSelectEntry[] = profiles.flatMap((profile) =>
    profile.models.map((model) => ({ value: modelKey(profile.id, model.modelId), profileName: profile.name, profileKey: profile.id, modelId: model.modelId, service: profile.presetId })),
  );
  // A default whose model or profile has since gone stays shown as it is, never as another model.
  const owner = current === undefined ? undefined : profiles.find((profile) => profile.id === current.providerProfileId);
  const currentShown =
    current === undefined
      ? undefined
      : {
          label: owner === undefined ? t("settings.models.defaultModelDeleted", { model: current.modelId }) : `${owner.name} · ${current.modelId}`,
          modelId: current.modelId,
          service: owner?.presetId,
        };
  return (
    <SettingsBlock title={t("settings.models.defaultModel")}>
      <ModelSelect
        kind="llm"
        id="default-model"
        ariaLabel={t("settings.models.defaultModel")}
        describedBy="default-model-hint"
        entries={entries}
        value={value}
        noneLabel={t("settings.common.none")}
        current={currentShown}
        size="lg"
        width="fill"
        onChange={(next) => {
          if (next === "") {
            patch.mutate({ defaultModelRef: null });
            return;
          }
          const [providerProfileId, modelId] = JSON.parse(next) as [string, string];
          patch.mutate({ defaultModelRef: { providerProfileId, modelId } });
        }}
      />
      <FieldHint id="default-model-hint" className="mt-1.5" testId="default-model-hint">
        {t("settings.models.defaultModelHint")}
      </FieldHint>
      <RequestError error={patch.error} />
    </SettingsBlock>
  );
}

function useInvalidateProviders(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  };
}

const COLLAPSED_PROFILES_KEY = "amber.settings.collapsedProfiles";

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
function ProfileList({ profiles }: { profiles: readonly ProviderProfileDto[] }) {
  const client = useApi();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(readCollapsedProfiles);
  const reorder = useMutation({
    mutationFn: (profileIds: string[]) => client.put("/api/providers/order", providerListDtoSchema, { body: { profileIds } }),
    onMutate: (profileIds) => {
      // Shown in the new order at once; a refusal puts the server's order back.
      const previous = queryClient.getQueryData<ProviderListDto>(queryKeys.providers);
      if (previous !== undefined) {
        const byId = new Map(previous.items.map((item) => [item.id, item]));
        const items = profileIds.flatMap((id) => byId.get(id) ?? []);
        queryClient.setQueryData<ProviderListDto>(queryKeys.providers, { ...previous, items });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKeys.providers, context.previous);
    },
    onSuccess: (list) => queryClient.setQueryData(queryKeys.providers, list),
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
    <div data-testid="profile-list">
      <RequestError error={reorder.error} />
      {order.map((id) => {
        const profile = byId.get(id);
        if (profile === undefined) return null;
        return (
          <div key={id} ref={rowRef(id)} data-testid="profile-card" data-profile={profile.name} className={dragging === id ? "opacity-70" : ""}>
            <ProfileCard profile={profile} collapsed={collapsed.has(id)} onToggle={() => toggle(id)} dragHandle={handleProps(id)} />
          </div>
        );
      })}
    </div>
  );
}

/** Where a profile points, as the card says it: the region of an official address, or that it is the user's own. */
function useWhere(profile: ProviderProfileDto): { region?: string; custom: boolean } {
  const { t, i18n } = useTranslation();
  const preset = presetById(profile.presetId);
  if (preset === undefined || preset.id === CUSTOM_PRESET_ID) {
    return { custom: false };
  }
  const match = matchPresetAddress(preset, profile.protocol, profile.baseURL);
  if (match === undefined) {
    return { custom: true };
  }
  const key = `llmPresets.region.${preset.id}.${match.regionId}`;
  return hasRegions(preset) && i18n.exists(key) ? { region: t(key as never), custom: false } : { custom: false };
}

const CREDENTIAL_TONE = { configured: "text-ok", missing: "text-muted", unavailable: "text-danger" } as const;

/** The key's state in words: waiting for one, set, or saved but unreadable (to be set again). */
function CredentialState({ status }: { status: ProviderProfileDto["credentialStatus"] }) {
  const { t } = useTranslation();
  return (
    <span
      className={`text-xs ${CREDENTIAL_TONE[status]}`}
      data-testid="profile-credential-status"
      title={status === "unavailable" ? t("settings.models.credentialUnavailableHint") : undefined}
    >
      {t(`settings.models.credential.${status}`)}
    </span>
  );
}

function ProfileCard({ profile, collapsed, onToggle, dragHandle }: { profile: ProviderProfileDto; collapsed: boolean; onToggle: () => void; dragHandle: DragHandleProps }) {
  const { t } = useTranslation();
  const client = useApi();
  const invalidate = useInvalidateProviders();
  const [editing, setEditing] = useState(false);
  const where = useWhere(profile);
  const credential = useMutation({
    mutationFn: (value: string) =>
      client.put(`/api/providers/${encodeURIComponent(profile.id)}/credential`, providerProfileDtoSchema, { body: { value } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => client.delete(`/api/providers/${encodeURIComponent(profile.id)}`, z.undefined()),
    onSuccess: invalidate,
  });
  const preset = presetById(profile.presetId);
  const regionHint = preset !== undefined && hasRegions(preset);
  const address = normalizeBaseUrl(profile.baseURL).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return (
    <SettingsBlock
      title={
        <span className="flex min-w-0 items-center gap-1">
          <Tooltip content={t("settings.models.dragProfile", { name: profile.name })}>
            <button
              type="button"
              className={`cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken ${FOCUS_RING}`}
              aria-label={t("settings.models.dragProfile", { name: profile.name })}
              {...dragHandle}
            >
              <GripVertical size={14} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t(collapsed ? "settings.models.expandProfile" : "settings.models.collapseProfile", { name: profile.name })}>
            <button
              type="button"
              className={`rounded p-1 text-muted hover:bg-sunken ${FOCUS_RING}`}
              aria-expanded={!collapsed}
              aria-label={t(collapsed ? "settings.models.expandProfile" : "settings.models.collapseProfile", { name: profile.name })}
              onClick={onToggle}
            >
              <ChevronDown size={14} className={`transition-transform duration-150 motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} aria-hidden="true" />
            </button>
          </Tooltip>
          <VendorIcon presetId={profile.presetId} className="mr-1" />
          <span className="min-w-0 truncate" data-testid="profile-title">
            {profile.name}
          </span>
          {collapsed ? <span className="shrink-0 text-xs font-normal text-muted">{t("settings.models.modelCount", { count: profile.models.length })}</span> : null}
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
            confirmLabel={t("settings.models.deleteProfileConfirm")}
            pending={remove.isPending}
            message={t("settings.models.deleteConfirm", { name: profile.name })}
            onConfirm={() => remove.mutate()}
          />
        </>
      }
    >
      {collapsed ? null : (
        <>
          <p className="mb-3 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted" data-testid="profile-endpoint">
            <span>{t(`settings.models.protocolValue.${profile.protocol}`)}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate font-mono" title={profile.baseURL}>
              {address}
            </span>
            {where.region === undefined ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="profile-region">{where.region}</span>
              </>
            )}
            {where.custom ? (
              <span className="rounded border border-line px-1 leading-4 text-ink" data-testid="profile-custom-address">
                {t("settings.models.addressCustom")}
              </span>
            ) : null}
          </p>
          <Field label={t("settings.models.keyLabel")} hint={t("settings.common.credential.writeOnly")} htmlFor={`key-${profile.id}`} aside={<CredentialState status={profile.credentialStatus} />}>
            <CredentialInput
              id={`key-${profile.id}`}
              hasCredential={profile.hasCredential}
              pending={credential.isPending}
              describedBy={fieldHintId(`key-${profile.id}`)}
              onSubmit={(value) => credential.mutate(value)}
            />
          </Field>
          <RequestError error={credential.error} />
          <h3 className="mt-4 mb-1 text-xs font-medium text-muted">{t("settings.models.modelsTitle")}</h3>
          {profile.models.length === 0 ? <p className={NOTE_TEXT_CLASS}>{t("settings.models.noModels")}</p> : null}
          <ul className="divide-y divide-line">
            {profile.models.map((model) => (
              <ModelRow key={model.modelId} profile={profile} model={model} regionHint={regionHint} />
            ))}
          </ul>
        </>
      )}
      <RequestError error={remove.error} />
      {editing ? <ProfileEditor profile={profile} onClose={() => setEditing(false)} /> : null}
    </SettingsBlock>
  );
}

function TriBadge({ value }: { value: TriState }) {
  const { t } = useTranslation();
  // Same tones as the test result's badges: not supporting something is a fact, not an error.
  const tone = value === "supported" ? "text-ok" : value === "unsupported" ? "text-ink" : "text-muted";
  return <span className={tone}>{t(`settings.models.tri.${value}`)}</span>;
}

function ModelRow({ profile, model, regionHint }: { profile: ProviderProfileDto; model: ModelCapabilityDto; regionHint: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const invalidate = useInvalidateProviders();
  const [showOverride, setShowOverride] = useState(false);
  const pricing = useSetModelPricing("providers");
  const cacheObserved = useCacheObservedModel(profile.id, model.modelId);
  const probe = useMutation({
    mutationFn: () =>
      client.post(`/api/providers/${encodeURIComponent(profile.id)}/probe`, probeResultDtoSchema, { body: { modelId: model.modelId }, idempotent: true }),
    onSuccess: invalidate,
  });
  return (
    <li className="py-3" data-model={model.modelId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-sm">
          <LlmModelMark modelId={model.modelId} presetId={profile.presetId} size={14} />
          <span className="min-w-0 truncate font-mono">{model.modelId}</span>
        </p>
        <div className="flex gap-2">
          <Button size="sm" loading={probe.isPending} disabled={!profile.hasCredential} title={t("settings.models.testHint")} onClick={() => probe.mutate()}>
            {probe.isPending ? t("settings.models.testing") : t("settings.models.testConnection")}
          </Button>
          <Button size="sm" onClick={() => setShowOverride(!showOverride)} aria-expanded={showOverride}>
            {t("settings.models.override")}
          </Button>
        </div>
      </div>
      <ModelLimits profileId={profile.id} model={model} />
      <ModelPricingControl
        modelId={model.modelId}
        scope="llm"
        pricing={model.pricing}
        cacheObserved={cacheObserved}
        onSubmit={(next) => pricing.mutateAsync({ profileId: profile.id, modelId: model.modelId, pricing: next })}
      />
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {CAPABILITY_KEYS.map((key) => (
          <div key={key} className="flex justify-between gap-2">
            <dt className="text-muted">{t(`settings.models.capability.${key}`)}</dt>
            <dd>
              <TriBadge value={model.effective.flags[key]} />
            </dd>
          </div>
        ))}
      </dl>
      {model.observedAt === undefined ? null : (
        <p className="mt-1 text-xs text-muted">{t("settings.models.observedAt", { time: formatDateTime(model.observedAt, i18n.language) })}</p>
      )}
      {/* Always mounted, so screen readers announce each new verdict that replaces its content. */}
      <div role="status" aria-live="polite" data-testid="probe-live">
        {probe.isPending ? null : <ProbeResult result={probe.data} error={probe.error ?? undefined} regionHint={regionHint} />}
      </div>
      {showOverride ? <OverrideEditor profile={profile} model={model} /> : null}
    </li>
  );
}

/**
 * The model's context window and max output. A missing window says so and can be filled in
 * right here (through the model's capability override), since summaries, chapters, highlights
 * and chat wait for it.
 */
function ModelLimits({ profileId, model }: { profileId: string; model: ModelCapabilityDto }) {
  const { t, i18n } = useTranslation();
  const [filling, setFilling] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const setWindow = useSetContextWindow();
  const inputId = useId();
  const { contextWindowTokens, maxOutputTokens } = model.effective.limits;
  const number = (value: number): string => value.toLocaleString(i18n.language);
  const maxPart = maxOutputTokens === undefined ? null : (
    <>
      <span aria-hidden="true"> · </span>
      {t("settings.models.limits.maxOutput", { value: number(maxOutputTokens) })}
    </>
  );
  if (contextWindowTokens !== undefined) {
    return (
      <p className="mt-0.5 text-xs text-muted" data-testid="model-limits">
        {t("settings.models.limits.contextWindow", { value: number(contextWindowTokens) })}
        {maxPart}
        <span className="text-muted/80">{t("settings.models.limits.declared")}</span>
      </p>
    );
  }
  if (!filling) {
    return (
      <p className="mt-0.5 text-xs text-muted" data-testid="model-limits">
        {t("settings.models.contextWindow")} <span className="text-ink">{t("settings.models.limits.missing")}</span>
        <span aria-hidden="true"> · </span>
        <TextAction className="font-medium" aria-label={t("settings.models.limits.fillFor", { model: model.modelId })} onClick={() => setFilling(true)}>
          {t("settings.models.limits.fill")}
        </TextAction>
        {maxPart}
      </p>
    );
  }
  const submit = (): void => {
    const value = parseTokenCount(text);
    if (value === undefined || Number.isNaN(value)) {
      setInvalid(true);
      return;
    }
    setWindow.mutate({ profileId, model, contextWindowTokens: value }, { onSuccess: () => setFilling(false) });
  };
  return (
    <form
      className="mt-1"
      data-testid="model-limits-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={inputId} className="mb-1 block text-xs text-muted">
        {t("settings.models.limits.inputLabel", { model: model.modelId })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SuggestionInput
          id={inputId}
          // Opened by an explicit click on 「填写」, so the field it reveals takes the focus.
          autoFocus
          suggestions={CONTEXT_WINDOW_SUGGESTION_LABELS}
          listLabel={t("settings.models.contextWindowSuggestions")}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("settings.models.tokenPlaceholder")}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy(invalid && `${inputId}-error`, `${inputId}-note`)}
          wrapperClassName="w-36"
          className={`w-full px-2 ${CONTROL_BASE} ${CONTROL_HEIGHT.sm}`}
          value={text}
          onValueChange={(value) => {
            setText(value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setFilling(false);
            }
          }}
        />
        <Button type="submit" size="sm" variant="primary" loading={setWindow.isPending} disabled={text.trim() === ""}>
          {t("common.action.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setFilling(false)}>
          {t("common.action.cancel")}
        </Button>
      </div>
      {invalid ? (
        <FieldError id={`${inputId}-error`} className="mt-1.5">
          {t("settings.models.invalidNumber")}
        </FieldError>
      ) : null}
      <FieldHint id={`${inputId}-note`} className="mt-1.5">
        {t("settings.models.contextWindowNote")}
      </FieldHint>
      <RequestError error={setWindow.error} />
    </form>
  );
}

function OverrideEditor({ profile, model }: { profile: ProviderProfileDto; model: ModelCapabilityDto }) {
  const { t } = useTranslation();
  const client = useApi();
  const invalidate = useInvalidateProviders();
  const [flags, setFlags] = useState<Partial<Record<keyof CapabilityFlagsDto, TriState>>>(() => {
    const initial: Partial<Record<keyof CapabilityFlagsDto, TriState>> = {};
    for (const key of CAPABILITY_KEYS) {
      const value = model.flags.userOverride?.[key];
      if (value !== undefined) initial[key] = value;
    }
    return initial;
  });
  const save = useMutation({
    mutationFn: () =>
      client.put(
        `/api/providers/${encodeURIComponent(profile.id)}/models/${encodeURIComponent(model.modelId)}/override`,
        providerProfileDtoSchema,
        { body: { flags: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, flags[key] ?? null])) } },
      ),
    onSuccess: invalidate,
  });
  return (
    <div className="mt-3 rounded-md bg-panel p-3">
      <p className={`mb-2 ${NOTE_TEXT_CLASS}`}>{t("settings.models.overrideHint")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CAPABILITY_KEYS.map((key) => (
          <label key={key} className="flex items-center justify-between gap-2 text-xs">
            <span>{t(`settings.models.capability.${key}`)}</span>
            <NativeSelect
              size="sm"
              value={flags[key] ?? ""}
              onChange={(event) => {
                const value = event.target.value as TriState | "";
                setFlags((current) => {
                  const next = { ...current };
                  if (value === "") {
                    delete next[key];
                  } else {
                    next[key] = value;
                  }
                  return next;
                });
              }}
            >
              <option value="">{t("settings.models.overrideNone")}</option>
              {TRI_STATES.map((state) => (
                <option key={state} value={state}>
                  {t(`settings.models.tri.${state}`)}
                </option>
              ))}
            </NativeSelect>
          </label>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          {t("common.action.save")}
        </Button>
      </div>
      <RequestError error={save.error} />
    </div>
  );
}

