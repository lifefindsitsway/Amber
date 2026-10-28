import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { DISPLAY_NAME_MAX_CHARS, UI_LANGUAGE_DEFAULT } from "../../../shared/defaults.ts";
import {
  summaryTemplateDtoSchema,
  summaryTemplateListDtoSchema,
  summaryTemplateVersionListDtoSchema,
  type SummaryTemplateDto,
} from "../../../shared/dto/summary.ts";
import { languageNames } from "../../../shared/i18n/zh-CN/languages.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, usePatchSettings, useSettings } from "../../api/queries.ts";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ConfirmButton, Field, INPUT_CLASS, RequestError, SettingsBlock } from "./settings-ui.tsx";
import { SystemPromptsSection } from "./system-prompts-section.tsx";

export const TEMPLATES_KEY = ["summary-templates"] as const;

/** Display name: builtin templates store an i18n key (`summaryTemplate.*`), custom ones the user's text. */
export function useTemplateName(): (template: SummaryTemplateDto) => string {
  const { t } = useTranslation();
  return (template) => (template.builtin ? t(template.name as `summaryTemplate.${"core" | "detailed" | "terms"}`) : template.name);
}

/**
 * `/settings/templates`: the defaults (summary template, output language), the builtin
 * (read-only) and custom summary templates, and the customizable system prompts.
 */
export function TemplatesSection() {
  const { t } = useTranslation();
  const client = useApi();
  const nameOf = useTemplateName();
  const templates = useQuery({ queryKey: TEMPLATES_KEY, queryFn: () => client.get("/api/summary-templates", summaryTemplateListDtoSchema) });
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const [editing, setEditing] = useState<SummaryTemplateDto | "new" | undefined>(undefined);
  if (templates.isPending) {
    return <Loading />;
  }
  const items = (templates.data?.items ?? []).filter((template) => !template.deleted);
  const uiLanguage = settings.data?.language ?? UI_LANGUAGE_DEFAULT;
  return (
    <div>
      <SettingsBlock title={t("settings.systemPrompts.blocks.defaults")}>
        <Field label={t("settings.templates.defaultTemplate")} hint={t("settings.templates.defaultTemplateHint")} htmlFor="default-template">
          <select
            id="default-template"
            className={INPUT_CLASS}
            value={settings.data?.defaultSummaryTemplateId ?? ""}
            onChange={(event) => patchSettings.mutate({ defaultSummaryTemplateId: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">{t("settings.common.none")}</option>
            {items.map((template) => (
              <option key={template.id} value={template.id}>
                {nameOf(template)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("settings.templates.outputLanguage")} hint={t("settings.templates.outputLanguageHint")} htmlFor="output-language">
          <select
            id="output-language"
            className={INPUT_CLASS}
            value={settings.data?.defaultOutputLanguage ?? ""}
            onChange={(event) => patchSettings.mutate({ defaultOutputLanguage: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">{`${t("settings.common.none")} (${languageNames[uiLanguage] ?? uiLanguage})`}</option>
            {Object.entries(languageNames).map(([tag, name]) => (
              <option key={tag} value={tag}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <RequestError error={patchSettings.error} />
      </SettingsBlock>
      <SettingsBlock
        title={t("settings.systemPrompts.blocks.summaryTemplates")}
        intro={t("settings.templates.intro")}
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            {t("settings.templates.create")}
          </Button>
        }
      >
        <ul className="divide-y divide-line">
          {items.map((template) => (
            <TemplateRow key={template.id} template={template} onEdit={() => setEditing(template)} />
          ))}
        </ul>
        <RequestError error={templates.error} />
      </SettingsBlock>
      {editing === undefined ? null : <TemplateEditor template={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} />}
      <SystemPromptsSection />
    </div>
  );
}

function TemplateRow({ template, onEdit }: { template: SummaryTemplateDto; onEdit: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const nameOf = useTemplateName();
  const remove = useMutation({
    mutationFn: () => client.delete(`/api/summary-templates/${encodeURIComponent(template.id)}`, z.undefined()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
  return (
    <li className="flex items-center justify-between gap-3 py-2" data-template={template.id}>
      <div>
        <span className="text-sm">{nameOf(template)}</span>
        <span className="ml-2 rounded bg-sunken px-1.5 py-0.5 text-xs text-muted">
          {template.builtin ? t("settings.templates.builtin") : t("settings.templates.custom")}
        </span>
        <span className="ml-2 text-xs text-muted">{t("settings.templates.version", { version: template.currentVersion })}</span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onEdit}>
          {template.builtin ? t("settings.templates.versions") : t("common.action.edit")}
        </Button>
        {template.builtin ? null : (
          <ConfirmButton
            label={t("common.action.delete")}
            variant="danger"
            message={t("settings.templates.deleteConfirm", { name: template.name })}
            onConfirm={() => remove.mutate()}
          />
        )}
      </div>
      <RequestError error={remove.error} />
    </li>
  );
}

/** Creates a template, edits a custom one, or shows a builtin's versions read-only. */
function TemplateEditor({ template, onClose }: { template: SummaryTemplateDto | undefined; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const nameOf = useTemplateName();
  const readOnly = template?.builtin === true;
  const versions = useQuery({
    queryKey: ["summary-template-versions", template?.id],
    queryFn: () => client.get(`/api/summary-templates/${encodeURIComponent(template?.id ?? "")}/versions`, summaryTemplateVersionListDtoSchema),
    enabled: template !== undefined,
  });
  const latest = versions.data?.items.at(-1);
  const [name, setName] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState<string | undefined>(undefined);
  const shownName = name ?? (template === undefined ? "" : nameOf(template));
  const shownPrompt = prompt ?? latest?.prompt ?? "";
  const tooLong = shownName.trim().length > DISPLAY_NAME_MAX_CHARS;
  const save = useMutation({
    mutationFn: () => {
      if (template === undefined) {
        return client.post("/api/summary-templates", summaryTemplateDtoSchema, { body: { name: shownName.trim(), prompt: shownPrompt } });
      }
      return client.patch(`/api/summary-templates/${encodeURIComponent(template.id)}`, summaryTemplateDtoSchema, {
        body: { ...(name === undefined ? {} : { name: name.trim() }), ...(prompt === undefined ? {} : { prompt }) },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
      await queryClient.invalidateQueries({ queryKey: ["summary-template-versions"] });
      onClose();
    },
  });
  const unchanged = template !== undefined && name === undefined && prompt === undefined;
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onClose())} title={template === undefined ? t("settings.templates.create") : shownName} wide>
      {readOnly ? <p className="mb-3 text-xs text-muted">{t("settings.templates.readOnly")}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!readOnly && !tooLong && !unchanged && shownName.trim() !== "" && shownPrompt.trim() !== "") {
            save.mutate();
          }
        }}
      >
        <Field label={t("settings.templates.name")} htmlFor="template-name">
          <input id="template-name" className={INPUT_CLASS} value={shownName} readOnly={readOnly} onChange={(event) => setName(event.target.value)} />
          {tooLong ? <p className="text-xs text-danger">{t("settings.templates.nameTooLong", { max: DISPLAY_NAME_MAX_CHARS })}</p> : null}
        </Field>
        <Field label={t("settings.templates.prompt")} htmlFor="template-prompt">
          <textarea
            id="template-prompt"
            className="min-h-48 w-full rounded-md border border-line bg-surface p-2 font-mono text-xs outline-none focus:border-accent"
            value={shownPrompt}
            readOnly={readOnly}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        {versions.data === undefined || versions.data.items.length === 0 ? null : (
          <details className="mb-3 text-xs">
            <summary className="cursor-pointer text-muted">{t("settings.templates.versions")}</summary>
            <ul className="mt-2 space-y-2">
              {[...versions.data.items].reverse().map((version) => (
                <li key={version.version} className="rounded bg-panel p-2">
                  <p className="mb-1 text-muted">
                    {t("settings.templates.version", { version: version.version })} · {formatDateTime(version.createdAt, i18n.language)}
                  </p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{version.prompt}</pre>
                </li>
              ))}
            </ul>
          </details>
        )}
        <RequestError error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{readOnly ? t("common.action.close") : t("common.action.cancel")}</Button>
          {readOnly ? null : (
            <Button type="submit" variant="primary" disabled={save.isPending || tooLong || unchanged}>
              {t("common.action.save")}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
