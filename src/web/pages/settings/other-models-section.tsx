import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronDown, GripVertical } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  OTHER_MODEL_KINDS,
  OTHER_MODEL_NOTE_MAX_CHARS,
  otherModelProfileListDtoSchema,
  type OtherModelKind,
  type OtherModelProfileDto,
  type OtherModelProfileListDto,
} from "../../../shared/dto/other-model.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useOtherModelMutations, useOtherModels, useSetModelPricing } from "../../api/queries.ts";
import { ModelPricingControl } from "../../components/model-pricing-dialog.tsx";
import { Button, FOCUS_RING } from "../../ui/button.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { NativeSelect } from "../../ui/native-select.tsx";
import { FieldError, NOTE_TEXT_CLASS } from "../../ui/notice.tsx";
import { TextArea, TextInput } from "../../ui/text-field.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import { useDragOrder, type DragHandleProps } from "../../ui/use-drag-order.ts";
import { ConfirmButton, describedBy, Field, fieldErrorId, RequestError, SettingsBlock } from "./settings-ui.tsx";

/**
 * `/settings/other-models`: a register of models Amber does not call (speech synthesis,
 * image or video generation …), each profile a name, a note and models with their kind and
 * price. Laid out like the models section; no key, no address, no test.
 */
export function OtherModelsSection() {
  const { t } = useTranslation();
  const profiles = useOtherModels();
  const [creating, setCreating] = useState(false);
  if (profiles.isPending) {
    return <Loading />;
  }
  const items = profiles.data?.items ?? [];
  return (
    <div>
      <p className={`mb-4 ${NOTE_TEXT_CLASS}`} data-testid="other-models-intro">
        {t("settings.otherModels.intro")}
      </p>
      {items.length === 0 ? (
        <SettingsBlock>
          <EmptyState
            icon={<Boxes size={28} />}
            title={t("settings.otherModels.empty")}
            hint={t("settings.otherModels.emptyHint")}
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t("settings.otherModels.addProfile")}
              </Button>
            }
          />
        </SettingsBlock>
      ) : (
        <>
          <div className="mb-6">
            <Button variant="primary" onClick={() => setCreating(true)} data-testid="add-other-model-profile">
              {t("settings.otherModels.addProfile")}
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

const COLLAPSED_PROFILES_KEY = "amber.settings.collapsedOtherModels";

function readCollapsedProfiles(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROFILES_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * The profiles in the user's order: a profile is dragged by its handle (or moved with the
 * arrow keys) and the new order is saved when it is dropped; each can be folded to its
 * heading, which this browser remembers.
 */
function ProfileList({ profiles }: { profiles: readonly OtherModelProfileDto[] }) {
  const client = useApi();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(readCollapsedProfiles);
  const reorder = useMutation({
    mutationFn: (profileIds: string[]) => client.put("/api/other-models/order", otherModelProfileListDtoSchema, { body: { profileIds } }),
    onMutate: (profileIds) => {
      // Shown in the new order at once; a refusal puts the server's order back.
      const previous = queryClient.getQueryData<OtherModelProfileListDto>(queryKeys.otherModels);
      if (previous !== undefined) {
        const byId = new Map(previous.items.map((item) => [item.id, item]));
        const items = profileIds.flatMap((id) => byId.get(id) ?? []);
        queryClient.setQueryData<OtherModelProfileListDto>(queryKeys.otherModels, { ...previous, items });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKeys.otherModels, context.previous);
    },
    onSuccess: (list) => queryClient.setQueryData(queryKeys.otherModels, list),
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
    <div data-testid="other-model-profile-list">
      <RequestError error={reorder.error} />
      {order.map((id) => {
        const profile = byId.get(id);
        if (profile === undefined) return null;
        return (
          <div key={id} ref={rowRef(id)} data-testid="other-model-profile-card" data-profile={profile.name} className={dragging === id ? "opacity-70" : ""}>
            <ProfileCard profile={profile} collapsed={collapsed.has(id)} onToggle={() => toggle(id)} dragHandle={handleProps(id)} />
          </div>
        );
      })}
    </div>
  );
}

function ProfileCard({ profile, collapsed, onToggle, dragHandle }: { profile: OtherModelProfileDto; collapsed: boolean; onToggle: () => void; dragHandle: DragHandleProps }) {
  const { t } = useTranslation();
  const mutations = useOtherModelMutations();
  const pricing = useSetModelPricing("other-models");
  const [editing, setEditing] = useState(false);
  return (
    <SettingsBlock
      title={
        <span className="flex items-center gap-1">
          <Tooltip content={t("settings.otherModels.dragProfile", { name: profile.name })}>
            <button
              type="button"
              className={`cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken ${FOCUS_RING}`}
              aria-label={t("settings.otherModels.dragProfile", { name: profile.name })}
              {...dragHandle}
            >
              <GripVertical size={14} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t(collapsed ? "settings.otherModels.expandProfile" : "settings.otherModels.collapseProfile", { name: profile.name })}>
            <button
              type="button"
              className={`rounded p-1 text-muted hover:bg-sunken ${FOCUS_RING}`}
              aria-expanded={!collapsed}
              aria-label={t(collapsed ? "settings.otherModels.expandProfile" : "settings.otherModels.collapseProfile", { name: profile.name })}
              onClick={onToggle}
            >
              <ChevronDown size={14} className={`transition-transform duration-150 motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} aria-hidden="true" />
            </button>
          </Tooltip>
          <span>{profile.name}</span>
          {collapsed ? <span className="text-xs font-normal text-muted">{t("settings.otherModels.modelCount", { count: profile.models.length })}</span> : null}
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
            confirmLabel={t("settings.otherModels.deleteProfileConfirm")}
            pending={mutations.remove.isPending && mutations.remove.variables === profile.id}
            message={t("settings.otherModels.deleteConfirm", { name: profile.name })}
            onConfirm={() => mutations.remove.mutate(profile.id)}
          />
        </>
      }
    >
      {collapsed ? null : (
        <>
          {profile.note === undefined ? null : (
            <p className="mb-3 text-sm whitespace-pre-wrap text-muted" data-testid="other-model-profile-note">
              {profile.note}
            </p>
          )}
          <h3 className="mb-1 text-xs font-medium text-muted">{t("settings.otherModels.modelsTitle")}</h3>
          {profile.models.length === 0 ? <p className={NOTE_TEXT_CLASS}>{t("settings.otherModels.noModels")}</p> : null}
          <ul className="divide-y divide-line" data-testid="other-model-models">
            {profile.models.map((model) => (
              <li key={model.modelId} className="py-2" data-testid="other-model" data-model={model.modelId}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{model.modelId}</span>
                  <span className="text-xs text-muted">{t(`settings.otherModels.kinds.${model.kind}`)}</span>
                </div>
                <ModelPricingControl
                  modelId={model.modelId}
                  scope="other"
                  pricing={model.pricing}
                  onSubmit={(next) => pricing.mutateAsync({ profileId: profile.id, modelId: model.modelId, pricing: next })}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <RequestError error={mutations.remove.error} />
      {editing ? <ProfileEditor profile={profile} onClose={() => setEditing(false)} /> : null}
    </SettingsBlock>
  );
}

interface ModelDraft {
  /** Local row identity, so a row keeps its inputs while it is dragged. */
  key: string;
  modelId: string;
  kind: OtherModelKind;
}

/** Create or edit a profile; the model list is replaced as a whole, in the order shown, and kept models keep their price. */
function ProfileEditor({ profile, onClose }: { profile?: OtherModelProfileDto; onClose: () => void }) {
  const { t } = useTranslation();
  const mutations = useOtherModelMutations();
  const [name, setName] = useState(profile?.name ?? "");
  const [note, setNote] = useState(profile?.note ?? "");
  const nextKey = useRef(0);
  const newKey = (): string => `row-${(nextKey.current += 1)}`;
  const [models, setModels] = useState<ModelDraft[]>(
    () => profile?.models.map((model) => ({ key: newKey(), modelId: model.modelId, kind: model.kind })) ?? [{ key: newKey(), modelId: "", kind: "tts" }],
  );
  // Dragging only reorders the rows here; saving sends the list in this order.
  const rows = useDragOrder(
    models.map((model) => model.key),
    (keys) => setModels((current) => keys.flatMap((key) => current.find((model) => model.key === key) ?? [])),
  );
  const [touched, setTouched] = useState(false);
  const ids = models.map((model) => model.modelId.trim());
  const duplicated = new Set(ids.filter((id, index) => id !== "" && ids.indexOf(id) !== index));
  const noteTooLong = note.trim().length > OTHER_MODEL_NOTE_MAX_CHARS;
  const valid = name.trim() !== "" && !noteTooLong && ids.every((id) => id !== "") && duplicated.size === 0;
  const body = models.map((model) => ({ modelId: model.modelId.trim(), kind: model.kind }));

  const save = useMutation({
    mutationFn: async () => {
      const trimmedNote = note.trim();
      if (profile === undefined) {
        await mutations.create.mutateAsync({ name: name.trim(), ...(trimmedNote === "" ? {} : { note: trimmedNote }), models: body });
      } else {
        await mutations.patch.mutateAsync({
          id: profile.id,
          patch: { name: name.trim(), note: trimmedNote === "" ? null : trimmedNote, models: body },
        });
      }
    },
    onSuccess: onClose,
  });

  const updateModel = (key: string, change: Partial<ModelDraft>): void =>
    setModels((current) => current.map((model) => (model.key === key ? { ...model, ...change } : model)));
  const shown = rows.order.flatMap((key) => models.find((model) => model.key === key) ?? []);
  const formId = useId();
  const nameMissing = touched && name.trim() === "";

  return (
    <Modal
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={profile === undefined ? t("settings.otherModels.addProfile") : t("settings.otherModels.editProfile")}
      wide
      footer={
        <>
          <Button onClick={onClose}>{t("common.action.cancel")}</Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending}>
            {t("common.action.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (valid) save.mutate();
        }}
      >
        <Field label={t("settings.otherModels.name")} htmlFor="other-model-name" error={nameMissing ? t("settings.otherModels.required") : undefined}>
          <TextInput
            id="other-model-name"
            className="w-full"
            value={name}
            invalid={nameMissing}
            aria-describedby={nameMissing ? fieldErrorId("other-model-name") : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={t("settings.otherModels.note")}
          htmlFor="other-model-note"
          error={noteTooLong ? t("settings.otherModels.noteTooLong", { max: OTHER_MODEL_NOTE_MAX_CHARS }) : undefined}
        >
          <TextArea
            id="other-model-note"
            rows={3}
            className="w-full"
            value={note}
            invalid={noteTooLong}
            aria-describedby={noteTooLong ? fieldErrorId("other-model-note") : undefined}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <h3 className="mb-2 text-xs font-medium text-muted">{t("settings.otherModels.modelsTitle")}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th />
              <th className="pb-1 font-medium">{t("settings.otherModels.modelId")}</th>
              <th className="pb-1 font-medium">{t("settings.otherModels.kind")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((model) => {
              const id = model.modelId.trim();
              const idMissing = touched && id === "";
              const duplicate = duplicated.has(id);
              const errorId = `${formId}-${model.key}-error`;
              return (
                <tr
                  key={model.key}
                  ref={rows.rowRef(model.key)}
                  className={`align-top ${rows.dragging === model.key ? "bg-accent-soft" : ""}`}
                  data-testid="other-model-draft"
                >
                  <td className="pr-1 pb-2">
                    <Tooltip content={t("settings.otherModels.dragModel")}>
                      <button
                        type="button"
                        className={`mt-1.5 cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken ${FOCUS_RING}`}
                        aria-label={`${t("settings.otherModels.dragModel")} · ${model.modelId}`}
                        {...rows.handleProps(model.key)}
                      >
                        <GripVertical size={14} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </td>
                  <td className="pr-2 pb-2">
                    <TextInput
                      aria-label={t("settings.otherModels.modelId")}
                      className="w-full font-mono"
                      value={model.modelId}
                      invalid={idMissing || duplicate}
                      aria-describedby={describedBy((idMissing || duplicate) && errorId)}
                      onChange={(event) => updateModel(model.key, { modelId: event.target.value })}
                    />
                    {idMissing ? (
                      <FieldError id={errorId} className="mt-1.5">
                        {t("settings.otherModels.required")}
                      </FieldError>
                    ) : duplicate ? (
                      <FieldError id={errorId} className="mt-1.5">
                        {t("settings.otherModels.duplicateModel")}
                      </FieldError>
                    ) : null}
                  </td>
                  <td className="pr-2 pb-2">
                    <NativeSelect
                      aria-label={t("settings.otherModels.kind")}
                      className="w-full"
                      value={model.kind}
                      onChange={(event) => updateModel(model.key, { kind: event.target.value as OtherModelKind })}
                    >
                      {OTHER_MODEL_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`settings.otherModels.kinds.${kind}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  </td>
                  <td className="pb-2">
                    <Button size="sm" variant="ghost" onClick={() => setModels((current) => current.filter((item) => item.key !== model.key))}>
                      {t("settings.otherModels.removeModel")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Button size="sm" onClick={() => setModels((current) => [...current, { key: newKey(), modelId: "", kind: "tts" }])}>
          {t("settings.otherModels.addModel")}
        </Button>
        <RequestError error={mutations.create.error ?? mutations.patch.error} />
      </form>
    </Modal>
  );
}
