import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { providerProfileDtoSchema, type CreateProviderRequest, type ModelCapabilityDto, type ProviderProfileDto, type UpdateProviderRequest } from "../../../shared/dto/provider.ts";
import { LLM_PROTOCOLS, type LlmProtocol } from "../../../shared/enums.ts";
import {
  CUSTOM_PRESET_ID,
  LLM_PRESETS,
  endpointPathSuffix,
  hasRegions,
  isLlmPresetId,
  isValidWorkspaceId,
  matchPresetAddress,
  normalizeBaseUrl,
  normalizeWorkspaceId,
  officialBaseUrl,
  presetById,
  presetProtocols,
  supportsWorkspace,
  type LlmPreset,
  type LlmPresetId,
} from "../../../shared/llm-presets.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { PasswordInput } from "../../ui/password-input.tsx";
import { Select, type SelectOption } from "../../ui/select.tsx";
import { useDragOrder, type DragHandleProps } from "../../ui/use-drag-order.ts";
import { VendorIcon } from "../../ui/vendor-icon.tsx";
import { Field, fieldHintId, INPUT_CLASS, RequestError } from "./settings-ui.tsx";
import { ContextWindowSuggestions, parseTokenCount } from "./token-count.tsx";

/** The edit dialog's "no service" choice; never a preset id. */
const NO_PRESET = "none";
type ServiceChoice = LlmPresetId | typeof NO_PRESET;

/** A request body field that only the client knows about: the key travels once, with the create call. */
type CreateWithCredential = CreateProviderRequest & { credential?: { value: string } };

type Limits = { contextWindowTokens: number | undefined; maxOutputTokens: number | undefined };

interface ModelDraft {
  /** Local row identity, so a row keeps its inputs while it is dragged. */
  key: string;
  modelId: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  /** The saved model the row started from; absent for a row added here. */
  saved?: Limits & { modelId: string };
}

/** Everything that decides where the profile connects; the region and workspace id are read back from it. */
interface Connection {
  presetId: LlmPresetId | undefined;
  protocol: LlmProtocol;
  baseURL: string;
  /** As typed; the address uses it once it is a valid id. */
  workspaceText: string;
  /**
   * A region chosen whose only addresses are per workspace, while no valid id is typed yet:
   * there is no address to read it back from, so it is held until there is.
   */
  pendingRegion: string | undefined;
}

/** What the last automatic change replaced, so "undo" can put all of it back. */
interface ConnectionUndo {
  before: Connection;
  /** The name too, while it still follows the service. */
  name: string | undefined;
  message: string;
  /** Typing a workspace id rewrites the address on every key; such a run is one change. */
  kind: "workspace" | "other";
}

/** The user-declared limits a model row edits: its override layer, else what is in effect. */
function savedLimits(model: ModelCapabilityDto): Limits {
  const own = model.limits.userOverride;
  return {
    contextWindowTokens: own?.contextWindowTokens ?? model.effective.limits.contextWindowTokens,
    maxOutputTokens: own?.maxOutputTokens ?? model.effective.limits.maxOutputTokens,
  };
}

function hostAndPath(baseURL: string): string {
  return normalizeBaseUrl(baseURL).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}

/**
 * One limit of a row as the request sends it. The server keeps an omitted limit of a model it
 * already has under that id, replaces a number and clears `null`. So a row still under its
 * saved id leaves an unchanged value out and sends a cleared one as `null`; any other row sends
 * what it shows, and `null` when blank under an id the profile already has (else the old
 * model's value would silently carry over).
 */
function limitField(text: string, id: string, saved: ModelDraft["saved"], field: keyof Limits, existing: ReadonlySet<string>): number | null | undefined {
  const parsed = parseTokenCount(text);
  if (saved !== undefined && saved.modelId === id) {
    if (parsed === undefined) {
      return saved[field] === undefined ? undefined : null;
    }
    return parsed === saved[field] ? undefined : parsed;
  }
  if (parsed !== undefined) {
    return parsed;
  }
  return existing.has(id) ? null : undefined;
}

function useRegionName(): (preset: LlmPreset, regionId: string) => string {
  const { t, i18n } = useTranslation();
  return (preset, regionId) => {
    const key = `llmPresets.region.${preset.id}.${regionId}`;
    return i18n.exists(key) ? t(key as never) : regionId;
  };
}

/** A stored preset id the editor can show: a known vendor; the custom preset reads as "unspecified". */
function shownPreset(presetId: string | undefined): LlmPresetId | undefined {
  return presetId !== undefined && isLlmPresetId(presetId) && presetId !== CUSTOM_PRESET_ID ? presetId : undefined;
}

/**
 * Create or edit an LLM Profile. A new profile starts from a service: until one is chosen
 * nothing else shows and nothing can be saved; choosing fills in the vendor's official address
 * for its default protocol, so a user only adds a key and a model id. The Base URL is the one
 * source of truth: the region and workspace id shown are read back from it, and switching
 * service, region, protocol or workspace id rewrites it to the matching official address with
 * a way back to everything it changed. The service of an existing profile only changes its icon
 * and labels; its protocol is fixed and its key is managed on the card.
 */
export function ProfileEditor({ profile, onClose }: { profile?: ProviderProfileDto | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const regionName = useRegionName();
  const ids = {
    service: useId(),
    region: useId(),
    workspace: useId(),
    key: useId(),
    name: useId(),
    protocol: useId(),
    baseURL: useId(),
    suggestions: useId(),
    connection: useId(),
  };
  const editing = profile !== undefined;
  const initialPreset = shownPreset(profile?.presetId);

  const initialConnection = (): Connection => {
    const preset = presetById(initialPreset);
    const read = preset === undefined || profile === undefined ? undefined : matchPresetAddress(preset, profile.protocol, profile.baseURL);
    return {
      presetId: initialPreset,
      protocol: profile?.protocol ?? "openai_compatible",
      baseURL: profile?.baseURL ?? "",
      workspaceText: read?.workspaceId ?? "",
      pendingRegion: undefined,
    };
  };
  const [connection, setConnection] = useState<Connection>(initialConnection);
  const { presetId, protocol, baseURL, workspaceText, pendingRegion } = connection;
  const preset = presetById(presetId);
  /** A preset with official addresses; the custom preset has none to compare with. */
  const vendor = preset !== undefined && preset.id !== CUSTOM_PRESET_ID ? preset : undefined;
  const match = vendor === undefined ? undefined : matchPresetAddress(vendor, protocol, baseURL);
  const [undo, setUndo] = useState<ConnectionUndo | undefined>(undefined);
  const [connectionOpen, setConnectionOpen] = useState(false);
  /** Set when the server refused a new address because unfinished tasks use the profile. */
  const [locked, setLocked] = useState<string | undefined>(undefined);
  const [key, setKey] = useState("");
  const [name, setName] = useState(profile?.name ?? "");
  const [nameTouched, setNameTouched] = useState(editing);
  const [touched, setTouched] = useState(false);
  const [dirty, setDirty] = useState(false);

  const nextKey = useRef(0);
  const newKey = (): string => `row-${(nextKey.current += 1)}`;
  const [models, setModels] = useState<ModelDraft[]>(
    () =>
      profile?.models.map((model) => {
        const saved = savedLimits(model);
        return {
          key: newKey(),
          modelId: model.modelId,
          contextWindowTokens: saved.contextWindowTokens === undefined ? "" : String(saved.contextWindowTokens),
          maxOutputTokens: saved.maxOutputTokens === undefined ? "" : String(saved.maxOutputTokens),
          saved: { ...saved, modelId: model.modelId },
        };
      }) ?? [{ key: newKey(), modelId: "", contextWindowTokens: "", maxOutputTokens: "" }],
  );
  // Dragging only reorders the rows here; saving sends the list in this order.
  const rows = useDragOrder(
    models.map((model) => model.key),
    (keys) => {
      setDirty(true);
      setModels((current) => keys.flatMap((rowKey) => current.find((model) => model.key === rowKey) ?? []));
    },
  );

  const regionId = match?.regionId ?? pendingRegion;
  const workspaceId = normalizeWorkspaceId(workspaceText);
  const workspaceInvalid = workspaceId !== "" && !isValidWorkspaceId(workspaceId);
  const workspaceMissing = pendingRegion !== undefined && baseURL.trim() === "" && !workspaceInvalid;
  const pathSuffix = endpointPathSuffix(baseURL);
  const serviceName = (id: LlmPresetId): string => t(`llmPresets.name.${id}`);

  // Parsed rows, in the order shown.
  const shown = rows.order.flatMap((rowKey) => models.find((model) => model.key === rowKey) ?? []);
  const parsedRows: ParsedRow[] = shown.map((model) => ({
    model,
    id: model.modelId.trim(),
    window: parseTokenCount(model.contextWindowTokens),
    max: parseTokenCount(model.maxOutputTokens),
  }));
  const idCounts = new Map<string, number>();
  for (const row of parsedRows) idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
  const duplicated = (row: ParsedRow): boolean => row.id !== "" && (idCounts.get(row.id) ?? 0) > 1;
  const rowsValid = parsedRows.length > 0 && parsedRows.every((row) => row.id !== "" && !duplicated(row) && !Number.isNaN(row.window) && !Number.isNaN(row.max));
  const valid = (editing || preset !== undefined) && name.trim() !== "" && baseURL.trim() !== "" && !workspaceInvalid && rowsValid;
  const existingIds: ReadonlySet<string> = new Set(profile?.models.map((model) => model.modelId) ?? []);

  const save = useMutation({
    mutationFn: async () => {
      if (profile === undefined) {
        const request: CreateWithCredential = {
          name: name.trim(),
          protocol,
          baseURL: baseURL.trim(),
          // The custom preset is stored as no preset at all.
          ...(presetId === undefined || presetId === CUSTOM_PRESET_ID ? {} : { presetId }),
          models: parsedRows.map((row) => ({
            modelId: row.id,
            ...(row.window === undefined ? {} : { contextWindowTokens: row.window }),
            ...(row.max === undefined ? {} : { maxOutputTokens: row.max }),
          })),
          ...(key.trim() === "" ? {} : { credential: { value: key.trim() } }),
        };
        return client.post("/api/providers", providerProfileDtoSchema, { body: request, idempotent: true });
      }
      const modelInputs = parsedRows.map((row) => {
        const window = limitField(row.model.contextWindowTokens, row.id, row.model.saved, "contextWindowTokens", existingIds);
        const max = limitField(row.model.maxOutputTokens, row.id, row.model.saved, "maxOutputTokens", existingIds);
        return { modelId: row.id, ...(window === undefined ? {} : { contextWindowTokens: window }), ...(max === undefined ? {} : { maxOutputTokens: max }) };
      });
      const sameModels =
        modelInputs.map((model) => model.modelId).join("\u0000") === profile.models.map((model) => model.modelId).join("\u0000") &&
        modelInputs.every((model) => Object.keys(model).length === 1);
      const patch: UpdateProviderRequest = {
        ...(name.trim() === profile.name ? {} : { name: name.trim() }),
        ...(presetId === initialPreset ? {} : { presetId: presetId ?? null }),
        ...(baseURL.trim() === profile.baseURL ? {} : { baseURL: baseURL.trim() }),
        ...(sameModels ? {} : { models: modelInputs }),
      };
      if (Object.keys(patch).length === 0) {
        return profile;
      }
      return client.patch(`/api/providers/${encodeURIComponent(profile.id)}`, providerProfileDtoSchema, { body: patch });
    },
    onSuccess: async () => {
      setKey("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.error.code === "conflict.profile_tasks_unfinished" && profile !== undefined) {
        // Put the saved address back and hold it there, so the rest of the edit can still be saved.
        setLocked(error.error.userMessage);
        setUndo(undefined);
        setConnection((current) => {
          const read = vendor === undefined ? undefined : matchPresetAddress(vendor, current.protocol, profile.baseURL);
          return { ...current, baseURL: profile.baseURL, workspaceText: read?.workspaceId ?? "", pendingRegion: undefined };
        });
      }
    },
  });

  /** The official address for a choice, using the typed workspace id when it is a valid one. */
  const official = (target: LlmPreset, choice: { regionId?: string | undefined; protocol: LlmProtocol }): string | undefined =>
    officialBaseUrl(target, {
      ...(choice.regionId === undefined ? {} : { regionId: choice.regionId }),
      protocol: choice.protocol,
      ...(target.workspacePath !== undefined && workspaceId !== "" && !workspaceInvalid ? { workspaceId } : {}),
    });

  /** Where an automatic change says it went: the service, and the region where there are several. */
  const targetLabel = (target: LlmPreset, targetRegion: string | undefined): string =>
    hasRegions(target) && targetRegion !== undefined ? `${serviceName(target.id)} · ${regionName(target, targetRegion)}` : serviceName(target.id);

  /**
   * Applies a change the user asked for that moved the address, remembering what it replaced.
   * The very first service choice has nothing to go back to.
   */
  const change = (next: Connection, message: string, kind: ConnectionUndo["kind"], nextName?: string): void => {
    save.reset();
    setDirty(true);
    const carried = kind === "workspace" && undo?.kind === "workspace" ? undo : undefined;
    const before = carried?.before ?? connection;
    const beforeName = carried === undefined ? (nameTouched ? undefined : name) : carried.name;
    const unchanged = before.baseURL === next.baseURL && before.protocol === next.protocol && before.presetId === next.presetId && before.pendingRegion === next.pendingRegion;
    const fromNothing = before.presetId === undefined && before.baseURL.trim() === "";
    setUndo(unchanged || fromNothing ? undefined : { before, name: beforeName, message, kind });
    setConnection(next);
    if (nextName !== undefined) setName(nextName);
  };

  /** An address set directly (typed): the workspace field is read back from it. */
  const typeAddress = (next: string): void => {
    save.reset();
    setDirty(true);
    setUndo(undefined);
    const read = vendor === undefined ? undefined : matchPresetAddress(vendor, protocol, next);
    setConnection({ ...connection, baseURL: next, pendingRegion: undefined, workspaceText: read?.workspaceId ?? "" });
  };

  const takeBack = (): void => {
    if (undo === undefined) return;
    save.reset();
    setConnection(undo.before);
    if (undo.name !== undefined && !nameTouched) setName(undo.name);
    setUndo(undefined);
  };

  const chooseService = (choice: ServiceChoice): void => {
    const next = choice === NO_PRESET ? undefined : presetById(choice);
    setDirty(true);
    if (editing) {
      // Display only: the address and protocol of a saved profile stay as they are.
      const read = next === undefined || next.id === CUSTOM_PRESET_ID ? undefined : matchPresetAddress(next, protocol, baseURL);
      setConnection({ ...connection, presetId: next?.id, workspaceText: read?.workspaceId ?? "", pendingRegion: undefined });
      return;
    }
    if (next === undefined) return;
    const nextName = nameTouched ? undefined : serviceName(next.id);
    if (next.id === CUSTOM_PRESET_ID) {
      // No official address to offer: the field is emptied for the user's own, and can be taken back.
      change({ presetId: next.id, protocol: "openai_compatible", baseURL: "", workspaceText: "", pendingRegion: undefined }, t("settings.models.addressCleared"), "other", nextName);
      return;
    }
    const nextProtocol = presetProtocols(next)[0]?.protocol ?? protocol;
    const address = officialBaseUrl(next, { protocol: nextProtocol }) ?? "";
    change({ presetId: next.id, protocol: nextProtocol, baseURL: address, workspaceText: "", pendingRegion: undefined }, t("settings.models.addressChanged", { target: serviceName(next.id) }), "other", nextName);
  };

  const chooseRegion = (nextRegion: string): void => {
    if (vendor === undefined) return;
    const address = official(vendor, { regionId: nextRegion, protocol });
    if (address === undefined) {
      // Reachable only through a workspace address and no valid id yet: hold the region and ask for the id.
      change({ ...connection, baseURL: "", pendingRegion: nextRegion }, t("settings.models.addressCleared"), "other");
      return;
    }
    change({ ...connection, baseURL: address, pendingRegion: undefined }, t("settings.models.addressChanged", { target: targetLabel(vendor, nextRegion) }), "other");
  };

  const chooseProtocol = (next: LlmProtocol): void => {
    const address = vendor === undefined ? undefined : official(vendor, { regionId, protocol: next });
    if (vendor === undefined || address === undefined) {
      setDirty(true);
      setConnection({ ...connection, protocol: next });
      return;
    }
    change({ ...connection, protocol: next, baseURL: address, pendingRegion: undefined }, t("settings.models.addressChanged", { target: targetLabel(vendor, regionId) }), "other");
  };

  const typeWorkspace = (text: string): void => {
    setDirty(true);
    const id = normalizeWorkspaceId(text);
    if (vendor === undefined || (id !== "" && !isValidWorkspaceId(id))) {
      setConnection({ ...connection, workspaceText: text });
      return;
    }
    const targetRegion = regionId ?? vendor.regions[0]?.id;
    const address = officialBaseUrl(vendor, { ...(targetRegion === undefined ? {} : { regionId: targetRegion }), protocol, ...(id === "" ? {} : { workspaceId: id }) });
    if (address === undefined) {
      change({ ...connection, workspaceText: text, baseURL: "", pendingRegion: targetRegion }, t("settings.models.addressCleared"), "workspace");
      return;
    }
    change({ ...connection, workspaceText: text, baseURL: address, pendingRegion: undefined }, t("settings.models.addressChanged", { target: targetLabel(vendor, targetRegion) }), "workspace");
  };

  const restoreRegion = regionId ?? vendor?.regions[0]?.id;
  const restoreAddress = vendor === undefined ? undefined : official(vendor, { regionId: restoreRegion, protocol });
  const restorable = vendor !== undefined && match === undefined && baseURL.trim() !== "" && restoreAddress !== undefined && locked === undefined;
  const restoreOfficial = (): void => {
    if (vendor !== undefined && restoreAddress !== undefined) {
      change({ ...connection, baseURL: restoreAddress, pendingRegion: undefined }, t("settings.models.addressChanged", { target: targetLabel(vendor, restoreRegion) }), "other");
    }
  };

  const chosen = editing || preset !== undefined;
  const regionsShown = vendor !== undefined && hasRegions(vendor);
  const connectionForced =
    chosen &&
    ((preset?.id === CUSTOM_PRESET_ID && !editing) ||
      baseURL.trim() === "" ||
      pathSuffix !== undefined ||
      (regionsShown && match === undefined) ||
      locked !== undefined);
  // Once something needed the group open it stays open: folding it away under the user (and
  // the focus with it) when the problem is fixed would be worse than one extra open section.
  useEffect(() => {
    if (connectionForced) setConnectionOpen(true);
  }, [connectionForced]);
  const connectionShown = connectionOpen || connectionForced;

  const protocolOptions: ReadonlyArray<SelectOption<LlmProtocol>> = (
    vendor === undefined ? LLM_PROTOCOLS.map((item) => ({ protocol: item, legacy: false })) : presetProtocols(vendor).map((item) => ({ protocol: item.protocol, legacy: item.legacy === true }))
  ).map((item) => ({
    value: item.protocol,
    label: t(`settings.models.protocolValue.${item.protocol}`),
    ...(item.legacy ? { tag: t("settings.models.protocolLegacy") } : {}),
  }));
  // A saved protocol the preset no longer lists still has to show.
  const protocolChoices = protocolOptions.some((option) => option.value === protocol)
    ? protocolOptions
    : [...protocolOptions, { value: protocol, label: t(`settings.models.protocolValue.${protocol}`) }];

  // Editing offers "unspecified" in place of "custom": for a saved profile they mean the same.
  const serviceOptions: ReadonlyArray<SelectOption<ServiceChoice>> = [
    ...(editing ? [{ value: NO_PRESET as ServiceChoice, label: t("settings.models.serviceNone"), icon: <VendorIcon presetId={undefined} /> }] : []),
    ...LLM_PRESETS.filter((item) => !editing || item.id !== CUSTOM_PRESET_ID).map((item) => ({
      value: item.id as ServiceChoice,
      label: serviceName(item.id),
      icon: <VendorIcon presetId={item.id} />,
    })),
  ];

  const updateModel = (rowKey: string, update: Partial<ModelDraft>): void => {
    setDirty(true);
    setModels((current) => current.map((model) => (model.key === rowKey ? { ...model, ...update } : model)));
  };

  // A dismissal by a click outside the dialog is ignored once something was typed, so a stray
  // click cannot throw away a pasted key; Esc and 「取消」 still close it.
  const pressedOutside = useRef(false);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      // Menus of this dialog are portaled out of it, yet pressing in them is not "outside".
      pressedOutside.current = target instanceof Element && target.closest('[role="dialog"]') === null && target.closest("[data-radix-popper-content-wrapper]") === null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  const onOpenChange = (open: boolean): void => {
    if (open) return;
    const outside = pressedOutside.current;
    pressedOutside.current = false;
    if (outside && dirty) return;
    onClose();
  };

  const serviceHint = chosen ? (editing ? t("settings.models.serviceEditHint") : undefined) : t("settings.models.serviceHint");
  const lockedId = `${ids.baseURL}-locked`;
  const workspaceError = workspaceInvalid || workspaceMissing;

  return (
    <Modal open onOpenChange={onOpenChange} title={editing ? t("settings.models.editProfile") : t("settings.models.addProfile")} wide>
      <form
        noValidate
        data-testid="profile-editor"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (valid && !save.isPending) {
            save.mutate();
          }
        }}
      >
        <Field label={t("settings.models.service")} htmlFor={ids.service} hint={serviceHint}>
          <Select
            id={ids.service}
            value={editing ? (presetId ?? NO_PRESET) : presetId}
            options={serviceOptions}
            onChange={chooseService}
            placeholder={t("settings.models.serviceUnset")}
            {...(serviceHint === undefined ? {} : { describedBy: fieldHintId(ids.service) })}
            testId="profile-service"
          />
        </Field>

        {chosen ? (
          <>
            {regionsShown && vendor !== undefined ? (
              <div className={supportsWorkspace(vendor) ? "grid gap-x-3 sm:grid-cols-2" : ""}>
                <Field label={t("settings.models.region")} htmlFor={ids.region} hint={t("settings.models.regionHint")}>
                  <Select
                    key={vendor.id}
                    id={ids.region}
                    value={regionId}
                    options={vendor.regions.map((item) => ({ value: item.id, label: regionName(vendor, item.id) }))}
                    onChange={chooseRegion}
                    placeholder={t("settings.models.addressCustom")}
                    disabled={locked !== undefined}
                    describedBy={locked === undefined ? fieldHintId(ids.region) : `${fieldHintId(ids.region)} ${lockedId}`}
                    testId="profile-region"
                  />
                </Field>
                {supportsWorkspace(vendor) ? (
                  <Field label={t("settings.models.workspace")} htmlFor={ids.workspace} hint={workspaceError ? undefined : t("settings.models.workspaceHint")}>
                    <input
                      id={ids.workspace}
                      className={`${INPUT_CLASS} font-mono`}
                      value={workspaceText}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={locked !== undefined}
                      aria-invalid={workspaceError ? true : undefined}
                      aria-describedby={workspaceError ? `${ids.workspace}-error` : fieldHintId(ids.workspace)}
                      onChange={(event) => typeWorkspace(event.target.value)}
                    />
                    {workspaceInvalid ? (
                      <InlineError id={`${ids.workspace}-error`} testId="workspace-invalid">
                        {t("settings.models.workspaceInvalid")}
                      </InlineError>
                    ) : workspaceMissing && pendingRegion !== undefined ? (
                      <InlineError id={`${ids.workspace}-error`} testId="workspace-required">
                        {t("settings.models.workspaceRequired", { region: regionName(vendor, pendingRegion) })}
                      </InlineError>
                    ) : null}
                  </Field>
                ) : null}
              </div>
            ) : null}

            {editing ? null : (
              <Field label={t("settings.models.keyLabel")} htmlFor={ids.key} hint={t("settings.models.keyHint")}>
                <PasswordInput
                  id={ids.key}
                  className={INPUT_CLASS}
                  autoComplete="off"
                  value={key}
                  aria-describedby={fieldHintId(ids.key)}
                  placeholder={t("settings.models.keyPlaceholder")}
                  onChange={(event) => {
                    setDirty(true);
                    setKey(event.target.value);
                  }}
                />
              </Field>
            )}

            <ModelTable
              rows={parsedRows}
              touched={touched}
              duplicated={duplicated}
              suggestionsId={ids.suggestions}
              dragRef={rows.rowRef}
              dragging={rows.dragging}
              handleProps={rows.handleProps}
              onChange={updateModel}
              onRemove={(rowKey) => {
                setDirty(true);
                setModels((current) => current.filter((model) => model.key !== rowKey));
              }}
              onAdd={() => {
                setDirty(true);
                const rowKey = newKey();
                setModels((current) => [...current, { key: rowKey, modelId: "", contextWindowTokens: "", maxOutputTokens: "" }]);
                return rowKey;
              }}
            />

            <Field label={t("settings.models.name")} htmlFor={ids.name}>
              <input
                id={ids.name}
                className={INPUT_CLASS}
                value={name}
                aria-invalid={touched && name.trim() === "" ? true : undefined}
                onChange={(event) => {
                  setDirty(true);
                  setName(event.target.value);
                  setNameTouched(true);
                }}
              />
              {touched && name.trim() === "" ? <InlineError>{t("settings.models.required")}</InlineError> : null}
            </Field>

            <section className="mb-3 rounded-md border border-line" aria-labelledby={ids.connection} data-testid="profile-connection">
              <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
                <h3 id={ids.connection} className="text-xs font-medium text-muted">
                  {t("settings.models.connection")}
                </h3>
                {connectionShown ? null : (
                  <p className="min-w-0 flex-1 truncate text-xs" data-testid="connection-summary" title={baseURL}>
                    {t(`settings.models.protocolValue.${protocol}`)}
                    {baseURL.trim() === "" ? null : (
                      <>
                        <span className="text-muted"> · </span>
                        <span className="font-mono">{hostAndPath(baseURL)}</span>
                      </>
                    )}
                    {vendor === undefined || baseURL.trim() === "" ? null : (
                      <>
                        <span className="text-muted"> · </span>
                        <span className={match === undefined ? "text-ink" : "text-muted"}>{t(match === undefined ? "settings.models.addressCustom" : "settings.models.addressOfficial")}</span>
                      </>
                    )}
                  </p>
                )}
                {connectionForced ? null : (
                  <Button size="sm" variant="ghost" className="ml-auto text-accent-ink dark:text-accent" aria-expanded={connectionShown} onClick={() => setConnectionOpen(!connectionShown)}>
                    {connectionShown ? t("settings.models.connectionCollapse") : t("settings.models.connectionEdit")}
                  </Button>
                )}
              </div>
              {connectionShown ? (
                <div className="border-t border-line px-3 pt-3">
                  <Field label={t("settings.models.protocol")} htmlFor={ids.protocol} hint={editing ? t("settings.models.protocolLocked") : undefined}>
                    <Select
                      id={ids.protocol}
                      value={protocol}
                      options={protocolChoices}
                      onChange={chooseProtocol}
                      placeholder={t("settings.models.protocol")}
                      disabled={editing}
                      {...(editing ? { describedBy: fieldHintId(ids.protocol) } : {})}
                      testId="profile-protocol"
                    />
                  </Field>
                  <Field label={t("settings.models.baseURL")} htmlFor={ids.baseURL}>
                    <input
                      id={ids.baseURL}
                      className={`${INPUT_CLASS} font-mono`}
                      value={baseURL}
                      spellCheck={false}
                      autoComplete="off"
                      inputMode="url"
                      disabled={locked !== undefined}
                      aria-invalid={touched && baseURL.trim() === "" && pendingRegion === undefined ? true : undefined}
                      aria-describedby={locked === undefined ? undefined : lockedId}
                      onChange={(event) => typeAddress(event.target.value)}
                    />
                    {touched && baseURL.trim() === "" && pendingRegion === undefined ? <InlineError>{t("settings.models.baseURLRequired")}</InlineError> : null}
                    {pathSuffix === undefined ? null : <InlineError testId="address-path-suffix">{t("settings.models.addressPathSuffix", { suffix: pathSuffix })}</InlineError>}
                    {locked === undefined ? null : (
                      <InlineError id={lockedId} testId="profile-tasks-conflict">
                        {locked} {t("settings.models.addressReverted")}
                      </InlineError>
                    )}
                  </Field>
                </div>
              ) : null}
              <AddressNotice undo={undo} restorable={restorable && undo === undefined} labelled={connectionShown} onUndo={takeBack} onRestore={restoreOfficial} />
            </section>
          </>
        ) : null}

        {save.error instanceof ApiError && save.error.error.code === "conflict.profile_tasks_unfinished" ? null : <RequestError error={save.error} />}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!chosen || save.isPending} data-testid="profile-save">
            {t("common.action.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function InlineError({ children, id, testId }: { children: ReactNode; id?: string; testId?: string }) {
  return (
    <p id={id} className="mt-1 text-xs text-danger" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * Under the connection group, collapsed or not: says the address was just changed (with undo),
 * or that it is the user's own (with a way back to the official one). While the group is folded
 * its summary already says "custom address", so only the way back is added. Announced politely,
 * since the change is caused by a control further up.
 */
function AddressNotice(props: { undo: ConnectionUndo | undefined; restorable: boolean; labelled: boolean; onUndo: () => void; onRestore: () => void }) {
  const { t } = useTranslation();
  const link = "rounded px-0.5 font-medium text-accent-ink underline decoration-accent/60 underline-offset-2 hover:decoration-accent dark:text-accent";
  return (
    <div aria-live="polite" className="empty:hidden">
      {props.undo !== undefined ? (
        <p className="border-t border-line px-3 py-2 text-xs text-muted" data-testid="address-changed">
          {props.undo.message}
          <span aria-hidden="true"> · </span>
          <button type="button" className={link} onClick={props.onUndo}>
            {t("settings.models.addressUndo")}
          </button>
        </p>
      ) : props.restorable ? (
        <p className="border-t border-line px-3 py-2 text-xs text-muted" data-testid="address-custom">
          {props.labelled ? (
            <>
              {t("settings.models.addressCustom")}
              <span aria-hidden="true"> · </span>
            </>
          ) : null}
          <button type="button" className={link} onClick={props.onRestore}>
            {t("settings.models.addressRestore")}
          </button>
        </p>
      ) : null}
    </div>
  );
}

interface ParsedRow {
  model: ModelDraft;
  /** The model id as it will be sent: trimmed. */
  id: string;
  window: number | undefined;
  max: number | undefined;
}

/**
 * The model rows. Adding a row puts the focus in its model id; removing one moves it to the
 * next row (or the previous, or 「添加模型」), so the keyboard user never lands on the page body.
 */
function ModelTable(props: {
  rows: readonly ParsedRow[];
  touched: boolean;
  duplicated: (row: ParsedRow) => boolean;
  suggestionsId: string;
  dragRef: (rowKey: string) => (element: HTMLElement | null) => void;
  dragging: string | undefined;
  handleProps: (rowKey: string) => DragHandleProps;
  onChange: (rowKey: string, change: Partial<ModelDraft>) => void;
  onRemove: (rowKey: string) => void;
  /** Returns the new row's key. */
  onAdd: () => string;
}) {
  const { t } = useTranslation();
  const noteId = `${props.suggestionsId}-note`;
  const idInputs = useRef(new Map<string, HTMLInputElement>());
  const addRow = useRef<HTMLDivElement>(null);
  const [focusTarget, setFocusTarget] = useState<string | undefined>(undefined);
  const ADD = "\u0000add";
  useEffect(() => {
    if (focusTarget === undefined) return;
    // A new row joins the drag order one render later; wait for its input to exist.
    const element = focusTarget === ADD ? addRow.current?.querySelector("button") : idInputs.current.get(focusTarget);
    if (element === undefined || element === null) return;
    element.focus();
    setFocusTarget(undefined);
  }, [focusTarget, props.rows]);
  const rowLabel = (field: string, index: number): string => t("settings.models.rowField", { field, row: index + 1 });
  return (
    <div className="mb-3">
      <h3 className="mb-1 text-xs font-medium text-muted">{t("settings.models.modelsTitle")}</h3>
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-7" />
          <col />
          <col className="w-[32%] sm:w-36" />
          <col className="w-[26%] sm:w-32" />
          <col className="w-8" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs text-muted">
            <th>
              <span className="sr-only">{t("settings.models.columnOrder")}</span>
            </th>
            <th className="pb-1 font-medium">{t("settings.models.modelId")}</th>
            <th className="pb-1 pl-2 font-medium">
              {t("settings.models.contextWindow")}
              <span className="block font-normal">{t("settings.models.optionalTokens")}</span>
            </th>
            <th className="pb-1 pl-2 font-medium">
              {t("settings.models.maxOutput")}
              <span className="block font-normal">{t("settings.models.optionalTokens")}</span>
            </th>
            <th>
              <span className="sr-only">{t("settings.models.columnActions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => {
            const { model } = row;
            const idMissing = props.touched && row.id === "";
            const duplicate = props.duplicated(row);
            const named = (action: string): string => (row.id === "" ? rowLabel(action, index) : `${action} · ${row.id}`);
            return (
              <tr key={model.key} ref={props.dragRef(model.key)} className={`align-top ${props.dragging === model.key ? "bg-accent-soft" : ""}`} data-testid="model-draft">
                <td className="pb-2">
                  <button
                    type="button"
                    className="mt-1.5 cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken"
                    aria-label={named(t("settings.models.dragModel"))}
                    title={t("settings.models.dragModel")}
                    {...props.handleProps(model.key)}
                  >
                    <GripVertical size={14} aria-hidden="true" />
                  </button>
                </td>
                <td className="pb-2">
                  <input
                    ref={(element) => {
                      if (element === null) idInputs.current.delete(model.key);
                      else idInputs.current.set(model.key, element);
                    }}
                    aria-label={rowLabel(t("settings.models.modelId"), index)}
                    aria-invalid={idMissing || duplicate ? true : undefined}
                    className={`${INPUT_CLASS} font-mono`}
                    value={model.modelId}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => props.onChange(model.key, { modelId: event.target.value })}
                  />
                  {idMissing ? <InlineError>{t("settings.models.required")}</InlineError> : null}
                  {duplicate ? <InlineError testId="model-duplicate">{t("settings.models.duplicateModel")}</InlineError> : null}
                </td>
                <td className="pb-2 pl-2">
                  <input
                    aria-label={rowLabel(t("settings.models.contextWindow"), index)}
                    aria-describedby={noteId}
                    aria-invalid={Number.isNaN(row.window) ? true : undefined}
                    list={props.suggestionsId}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={t("settings.models.tokenPlaceholder")}
                    className={`${INPUT_CLASS} placeholder:text-muted/70`}
                    value={model.contextWindowTokens}
                    onChange={(event) => props.onChange(model.key, { contextWindowTokens: event.target.value })}
                  />
                  {Number.isNaN(row.window) ? <InlineError>{t("settings.models.invalidNumber")}</InlineError> : null}
                </td>
                <td className="pb-2 pl-2">
                  <input
                    aria-label={rowLabel(t("settings.models.maxOutput"), index)}
                    aria-invalid={Number.isNaN(row.max) ? true : undefined}
                    inputMode="numeric"
                    autoComplete="off"
                    className={INPUT_CLASS}
                    value={model.maxOutputTokens}
                    onChange={(event) => props.onChange(model.key, { maxOutputTokens: event.target.value })}
                  />
                  {Number.isNaN(row.max) ? <InlineError>{t("settings.models.invalidNumber")}</InlineError> : null}
                </td>
                <td className="pb-2 pl-1">
                  <button
                    type="button"
                    className="mt-1.5 rounded p-1 text-muted hover:bg-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={named(t("settings.models.removeModel"))}
                    title={t("settings.models.removeModel")}
                    disabled={props.rows.length <= 1}
                    onClick={() => {
                      const neighbour = props.rows[index + 1] ?? props.rows[index - 1];
                      props.onRemove(model.key);
                      setFocusTarget(neighbour?.model.key ?? ADD);
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ContextWindowSuggestions id={props.suggestionsId} />
      <p id={noteId} className="mb-2 text-xs text-muted" data-testid="context-window-note">
        {t("settings.models.contextWindowNote")}
      </p>
      <div ref={addRow}>
        <Button size="sm" onClick={() => setFocusTarget(props.onAdd())}>
          <Plus size={14} aria-hidden="true" />
          {t("settings.models.addModel")}
        </Button>
      </div>
    </div>
  );
}
