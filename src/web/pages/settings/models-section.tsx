import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GripVertical } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  probeResultDtoSchema,
  providerListDtoSchema,
  providerProfileDtoSchema,
  type CapabilityFlagsDto,
  type CreateProviderRequest,
  type ModelCapabilityDto,
  type ProbeResultDto,
  type ProviderListDto,
  type ProviderProfileDto,
} from "../../../shared/dto/provider.ts";
import { LLM_PROTOCOLS, TRI_STATES, type LlmProtocol } from "../../../shared/enums.ts";
import { LLM_PRESETS } from "../../../shared/llm-presets.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useCacheObservedModel, usePatchSettings, useProviders, useSetModelPricing, useSettings } from "../../api/queries.ts";
import { ModelPricingControl } from "../../components/model-pricing-dialog.tsx";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { useDragOrder, type DragHandleProps } from "../../ui/use-drag-order.ts";
import {
  ConfirmButton,
  CredentialInput,
  CredentialStatus,
  Field,
  INPUT_CLASS,
  positiveInt,
  RequestError,
  SettingsBlock,
  TestConnectionError,
} from "./settings-ui.tsx";

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
      <p className="mb-4 text-sm text-muted">{t("settings.models.intro")}</p>
      {items.length === 0 ? (
        <SettingsBlock>
          <EmptyState title={t("settings.models.wizardTitle")} hint={t("settings.models.wizardHint")}>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("settings.models.addProfile")}
            </Button>
          </EmptyState>
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
  return (
    <SettingsBlock title={t("settings.models.defaultModel")}>
      <select
        id="default-model"
        aria-label={t("settings.models.defaultModel")}
        className={INPUT_CLASS}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") {
            patch.mutate({ defaultModelRef: null });
            return;
          }
          const [providerProfileId, modelId] = JSON.parse(next) as [string, string];
          patch.mutate({ defaultModelRef: { providerProfileId, modelId } });
        }}
      >
        <option value="">{t("settings.common.none")}</option>
        {profiles.map((profile) =>
          profile.models.map((model) => (
            <option key={modelKey(profile.id, model.modelId)} value={modelKey(profile.id, model.modelId)}>
              {`${profile.name} · ${model.modelId}`}
            </option>
          )),
        )}
      </select>
      <p className="mt-2 text-xs text-muted" data-testid="default-model-hint">
        {t("settings.models.defaultModelHint")}
      </p>
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

function ProfileCard({ profile, collapsed, onToggle, dragHandle }: { profile: ProviderProfileDto; collapsed: boolean; onToggle: () => void; dragHandle: DragHandleProps }) {
  const { t } = useTranslation();
  const client = useApi();
  const invalidate = useInvalidateProviders();
  const [editing, setEditing] = useState(false);
  const credential = useMutation({
    mutationFn: (value: string) =>
      client.put(`/api/providers/${encodeURIComponent(profile.id)}/credential`, providerProfileDtoSchema, { body: { value } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => client.delete(`/api/providers/${encodeURIComponent(profile.id)}`, z.undefined()),
    onSuccess: invalidate,
  });
  return (
    <SettingsBlock
      title={
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken"
            aria-label={t("settings.models.dragProfile", { name: profile.name })}
            title={t("settings.models.dragProfile", { name: profile.name })}
            {...dragHandle}
          >
            <GripVertical size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-sunken"
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? "settings.models.expandProfile" : "settings.models.collapseProfile", { name: profile.name })}
            onClick={onToggle}
          >
            <ChevronDown size={14} className={collapsed ? "-rotate-90" : ""} />
          </button>
          <span>{profile.name}</span>
          {collapsed ? <span className="text-xs font-normal text-muted">{t("settings.models.modelCount", { count: profile.models.length })}</span> : null}
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
            message={t("settings.models.deleteConfirm", { name: profile.name })}
            onConfirm={() => remove.mutate()}
          />
        </>
      }
    >
      {collapsed ? null : (
        <>
          <p className="mb-3 text-xs text-muted">
            {t(`settings.models.protocolValue.${profile.protocol}`)} · <span className="font-mono">{profile.baseURL}</span>
          </p>
          <Field
            label={t("settings.models.keyLabel")}
            hint={t("settings.common.credential.writeOnly")}
            htmlFor={`key-${profile.id}`}
            aside={<CredentialStatus status={profile.credentialStatus} />}
          >
            <CredentialInput id={`key-${profile.id}`} hasCredential={profile.hasCredential} pending={credential.isPending} onSubmit={(value) => credential.mutate(value)} />
          </Field>
          <RequestError error={credential.error} />
          <h3 className="mt-4 mb-2 text-xs font-medium text-muted">{t("settings.models.modelsTitle")}</h3>
          {profile.models.length === 0 ? <p className="text-sm text-muted">{t("settings.models.noModels")}</p> : null}
          <ul className="divide-y divide-line">
            {profile.models.map((model) => (
              <ModelRow key={model.modelId} profile={profile} model={model} />
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
  const tone = value === "supported" ? "text-ok" : value === "unsupported" ? "text-danger" : "text-muted";
  return <span className={tone}>{t(`settings.models.tri.${value}`)}</span>;
}

function ModelRow({ profile, model }: { profile: ProviderProfileDto; model: ModelCapabilityDto }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const invalidate = useInvalidateProviders();
  const [showOverride, setShowOverride] = useState(false);
  const [result, setResult] = useState<ProbeResultDto | undefined>(undefined);
  const pricing = useSetModelPricing("providers");
  const cacheObserved = useCacheObservedModel(profile.id, model.modelId);
  const probe = useMutation({
    mutationFn: () =>
      client.post(`/api/providers/${encodeURIComponent(profile.id)}/probe`, probeResultDtoSchema, { body: { modelId: model.modelId } }),
    onSuccess: async (probed) => {
      setResult(probed);
      await invalidate();
    },
  });
  const limits = model.effective.limits;
  return (
    <li className="py-3" data-model={model.modelId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-sm">{model.modelId}</p>
          <p className="text-xs text-muted">
            {t("settings.models.contextWindow")}: {limits.contextWindowTokens ?? "—"} ({t("settings.models.contextWindowHint")})
            {limits.maxOutputTokens === undefined ? null : ` · ${t("settings.models.maxOutput")}: ${limits.maxOutputTokens}`}
          </p>
          <ModelPricingControl
            modelId={model.modelId}
            scope="llm"
            pricing={model.pricing}
            cacheObserved={cacheObserved}
            onSubmit={(next) => pricing.mutateAsync({ profileId: profile.id, modelId: model.modelId, pricing: next })}
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={probe.isPending || !profile.hasCredential} onClick={() => probe.mutate()}>
            {probe.isPending ? t("settings.models.testing") : t("settings.models.testConnection")}
          </Button>
          <Button size="sm" onClick={() => setShowOverride(!showOverride)} aria-expanded={showOverride}>
            {t("settings.models.override")}
          </Button>
        </div>
      </div>
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
      {result === undefined ? null : (
        <p className="mt-1 text-xs text-ok" role="status">
          {t("settings.models.latency", { ms: Math.round(result.latencyMs) })}
        </p>
      )}
      <TestConnectionError error={probe.error} />
      {showOverride ? <OverrideEditor profile={profile} model={model} /> : null}
    </li>
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
      <p className="mb-2 text-xs text-muted">{t("settings.models.overrideHint")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CAPABILITY_KEYS.map((key) => (
          <label key={key} className="flex items-center justify-between gap-2 text-xs">
            <span>{t(`settings.models.capability.${key}`)}</span>
            <select
              className="h-7 rounded border border-line bg-surface px-1"
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
            </select>
          </label>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {t("common.action.save")}
        </Button>
      </div>
      <RequestError error={save.error} />
    </div>
  );
}

interface ModelDraft {
  /** Local row identity, so a row keeps its inputs while it is dragged. */
  key: string;
  modelId: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
}

function draftOf(model: ModelCapabilityDto, key: string): ModelDraft {
  const limits = model.limits.userOverride ?? model.effective.limits;
  return {
    key,
    modelId: model.modelId,
    contextWindowTokens: String(limits.contextWindowTokens ?? model.effective.limits.contextWindowTokens ?? ""),
    maxOutputTokens: String(limits.maxOutputTokens ?? ""),
  };
}

/** Create (with a preset) or edit a Profile; the model list is replaced as a whole. */
function ProfileEditor({ profile, onClose }: { profile?: ProviderProfileDto | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const invalidate = useInvalidateProviders();
  const [presetId, setPresetId] = useState(LLM_PRESETS[0]?.id ?? "custom");
  const preset = LLM_PRESETS.find((item) => item.id === presetId);
  const [name, setName] = useState(profile?.name ?? preset?.name ?? "");
  const [protocol, setProtocol] = useState<LlmProtocol>(profile?.protocol ?? preset?.endpoints[0]?.protocol ?? "openai_compatible");
  const [baseURL, setBaseURL] = useState(profile?.baseURL ?? preset?.endpoints[0]?.baseURL ?? "");
  // A vendor preset offers only the protocols it serves; editing shows the saved one (locked).
  const protocols: readonly LlmProtocol[] =
    profile === undefined && preset !== undefined && preset.endpoints.length > 0 ? preset.endpoints.map((endpoint) => endpoint.protocol) : LLM_PROTOCOLS;
  const nextKey = useRef(0);
  const newKey = (): string => `row-${(nextKey.current += 1)}`;
  const [models, setModels] = useState<ModelDraft[]>(
    () => profile?.models.map((model) => draftOf(model, newKey())) ?? [{ key: newKey(), modelId: "", contextWindowTokens: "", maxOutputTokens: "" }],
  );
  // Dragging only reorders the rows here; saving sends the list in this order.
  const rows = useDragOrder(
    models.map((model) => model.key),
    (keys) => setModels((current) => keys.flatMap((key) => current.find((model) => model.key === key) ?? [])),
  );
  const [touched, setTouched] = useState(false);

  const parsed = models.map((model) => ({
    modelId: model.modelId.trim(),
    contextWindowTokens: positiveInt(model.contextWindowTokens),
    maxOutputTokens: positiveInt(model.maxOutputTokens),
  }));
  const valid =
    name.trim() !== "" &&
    baseURL.trim() !== "" &&
    parsed.every(
      (model) =>
        model.modelId.length > 0 &&
        model.contextWindowTokens !== undefined &&
        !Number.isNaN(model.contextWindowTokens) &&
        (model.maxOutputTokens === undefined || !Number.isNaN(model.maxOutputTokens)),
    );
  const body = parsed.map((model) => ({
    modelId: model.modelId,
    contextWindowTokens: model.contextWindowTokens ?? 0,
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  }));

  const save = useMutation({
    mutationFn: () => {
      if (profile === undefined) {
        const request: CreateProviderRequest = { name: name.trim(), protocol, baseURL: baseURL.trim(), models: body };
        return client.post("/api/providers", providerProfileDtoSchema, { body: request });
      }
      return client.patch(`/api/providers/${encodeURIComponent(profile.id)}`, providerProfileDtoSchema, {
        body: { name: name.trim(), baseURL: baseURL.trim(), models: body },
      });
    },
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  const updateModel = (key: string, change: Partial<ModelDraft>): void =>
    setModels((current) => current.map((model) => (model.key === key ? { ...model, ...change } : model)));
  const shown = rows.order.flatMap((key) => models.find((model) => model.key === key) ?? []);

  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onClose())} title={profile === undefined ? t("settings.models.addProfile") : t("settings.models.editProfile")} wide>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (valid) {
            save.mutate();
          }
        }}
      >
        {profile === undefined ? (
          <Field label={t("settings.models.preset")} htmlFor="profile-preset">
            <select
              id="profile-preset"
              className={INPUT_CLASS}
              value={presetId}
              onChange={(event) => {
                const next = LLM_PRESETS.find((item) => item.id === event.target.value);
                setPresetId(event.target.value);
                if (next !== undefined) {
                  const endpoint = next.endpoints[0];
                  setName(endpoint === undefined ? "" : next.name);
                  if (endpoint !== undefined) setProtocol(endpoint.protocol);
                  setBaseURL(endpoint?.baseURL ?? "");
                }
              }}
            >
              {LLM_PRESETS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.endpoints.length === 0 ? t("settings.models.presetCustom") : item.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={t("settings.models.name")} htmlFor="profile-name">
          <input id="profile-name" className={INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("settings.models.protocol")} htmlFor="profile-protocol">
          <select
            id="profile-protocol"
            className={INPUT_CLASS}
            value={protocol}
            disabled={profile !== undefined}
            onChange={(event) => {
              const next = event.target.value as LlmProtocol;
              setProtocol(next);
              const endpoint = preset?.endpoints.find((item) => item.protocol === next);
              if (endpoint !== undefined) setBaseURL(endpoint.baseURL);
            }}
          >
            {protocols.map((item) => (
              <option key={item} value={item}>
                {t(`settings.models.protocolValue.${item}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("settings.models.baseURL")} htmlFor="profile-base-url">
          <input id="profile-base-url" className={`${INPUT_CLASS} font-mono`} value={baseURL} onChange={(event) => setBaseURL(event.target.value)} />
        </Field>
        <h3 className="mt-4 mb-2 text-xs font-medium text-muted">{t("settings.models.modelsTitle")}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th />
              <th className="pb-1 font-medium">{t("settings.models.modelId")}</th>
              <th className="pb-1 font-medium">
                {t("settings.models.contextWindow")}
                <span className="block font-normal">{t("settings.models.contextWindowHint")}</span>
              </th>
              <th className="pb-1 font-medium">
                {t("settings.models.maxOutput")}
                <span className="block font-normal">{t("settings.common.optional")}</span>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((model) => {
              const index = models.indexOf(model);
              const window = parsed[index]?.contextWindowTokens;
              const max = parsed[index]?.maxOutputTokens;
              return (
                <tr key={model.key} ref={rows.rowRef(model.key)} className={`align-top ${rows.dragging === model.key ? "bg-accent-soft" : ""}`} data-testid="model-draft">
                  <td className="pr-1 pb-2">
                    <button
                      type="button"
                      className="mt-1.5 cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken"
                      aria-label={`${t("settings.models.dragModel")} · ${model.modelId}`}
                      title={t("settings.models.dragModel")}
                      {...rows.handleProps(model.key)}
                    >
                      <GripVertical size={14} />
                    </button>
                  </td>
                  <td className="pr-2 pb-2">
                    <input
                      aria-label={t("settings.models.modelId")}
                      className={`${INPUT_CLASS} font-mono`}
                      value={model.modelId}
                      onChange={(event) => updateModel(model.key, { modelId: event.target.value })}
                    />
                    {touched && model.modelId.trim() === "" ? <p className="text-xs text-danger">{t("settings.models.required")}</p> : null}
                  </td>
                  <td className="pr-2 pb-2">
                    <input
                      aria-label={t("settings.models.contextWindow")}
                      inputMode="numeric"
                      className={INPUT_CLASS}
                      value={model.contextWindowTokens}
                      onChange={(event) => updateModel(model.key, { contextWindowTokens: event.target.value })}
                    />
                    {touched && (window === undefined || Number.isNaN(window)) ? (
                      <p className="text-xs text-danger">{t("settings.models.invalidNumber")}</p>
                    ) : null}
                  </td>
                  <td className="pr-2 pb-2">
                    <input
                      aria-label={t("settings.models.maxOutput")}
                      inputMode="numeric"
                      className={INPUT_CLASS}
                      value={model.maxOutputTokens}
                      onChange={(event) => updateModel(model.key, { maxOutputTokens: event.target.value })}
                    />
                    {touched && max !== undefined && Number.isNaN(max) ? <p className="text-xs text-danger">{t("settings.models.invalidNumber")}</p> : null}
                  </td>
                  <td className="pb-2">
                    <Button size="sm" variant="ghost" onClick={() => setModels((current) => current.filter((item) => item.key !== model.key))}>
                      {t("settings.models.removeModel")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Button size="sm" onClick={() => setModels((current) => [...current, { key: newKey(), modelId: "", contextWindowTokens: "", maxOutputTokens: "" }])}>
          {t("settings.models.addModel")}
        </Button>
        <RequestError error={save.error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {t("common.action.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
