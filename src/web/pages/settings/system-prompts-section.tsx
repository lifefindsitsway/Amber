import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PROMPT_CUSTOM_MAX_CHARS } from "../../../shared/defaults.ts";
import { promptDtoSchema, promptListDtoSchema, promptVersionListDtoSchema, type PromptDto } from "../../../shared/dto/prompt.ts";
import type { settings as settingsCopy } from "../../../shared/i18n/zh-CN/ui-settings.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ConfirmButton, Field, RequestError, SettingsBlock } from "./settings-ui.tsx";

export const PROMPTS_KEY = ["prompts"] as const;
const PROMPT_VERSIONS_KEY = "prompt-versions";
const PROTOCOL_ERROR_CODE = "invalid_request.prompt_protocol";

type PromptCopyKey = `settings.systemPrompts.items.${keyof typeof settingsCopy.systemPrompts.items}.${"name" | "description"}`;

/** The server names each prompt by an i18n key under the system prompt items of the settings copy. */
function usePromptCopy(): (key: string) => string {
  const { t } = useTranslation();
  return (key) => t(key as PromptCopyKey);
}

/** What a text lacks or has too much: the required items it does not contain, and placeholders the prompt does not know. */
export interface PromptProblems {
  missing: string[];
  unknown: string[];
}

/**
 * The local, as-you-type counterpart of the server check. The server stays authoritative:
 * a rejected save shows its own lists until the text changes.
 */
export function promptProblems(prompt: Pick<PromptDto, "slots" | "protocol">, text: string): PromptProblems {
  const missing = [...prompt.slots, ...prompt.protocol].filter((item) => !text.includes(item));
  const placeholders = [...new Set(text.match(/\{\{\w+\}\}/g) ?? [])];
  return { missing, unknown: placeholders.filter((slot) => !prompt.slots.includes(slot)) };
}

function rejectedProblems(error: unknown): PromptProblems | undefined {
  if (!(error instanceof ApiError) || error.error.code !== PROTOCOL_ERROR_CODE) {
    return undefined;
  }
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return { missing: list(error.error.details?.["missing"]), unknown: list(error.error.details?.["unknown"]) };
}

/**
 * The builtin prompts Amber sends to models, each of which the user may replace with a
 * text of their own; the text in effect is the user's latest version or else the builtin.
 */
export function SystemPromptsSection() {
  const { t } = useTranslation();
  const client = useApi();
  const prompts = useQuery({ queryKey: PROMPTS_KEY, queryFn: () => client.get("/api/prompts", promptListDtoSchema) });
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const items = prompts.data?.items ?? [];
  const editing = items.find((prompt) => prompt.id === editingId);
  return (
    <SettingsBlock title={t("settings.systemPrompts.blocks.systemPrompts")} intro={t("settings.systemPrompts.intro")}>
      {prompts.isPending ? <Loading /> : null}
      {prompts.isError ? <p className="text-sm text-danger">{t("settings.systemPrompts.loadFailed")}</p> : null}
      <ul className="divide-y divide-line">
        {items.map((prompt) => (
          <PromptRow key={prompt.id} prompt={prompt} onEdit={() => setEditingId(prompt.id)} />
        ))}
      </ul>
      <RequestError error={prompts.error} />
      {editing === undefined ? null : <PromptEditor prompt={editing} onClose={() => setEditingId(undefined)} />}
    </SettingsBlock>
  );
}

function PromptRow({ prompt, onEdit }: { prompt: PromptDto; onEdit: () => void }) {
  const { t } = useTranslation();
  const copy = usePromptCopy();
  return (
    <li className="flex items-center justify-between gap-3 py-2" data-prompt={prompt.id}>
      <div className="min-w-0">
        <div>
          <span className="text-sm">{copy(prompt.nameKey)}</span>
          <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${prompt.customized ? "bg-accent-soft text-accent" : "bg-sunken text-muted"}`}>
            {prompt.customized ? t("settings.systemPrompts.status.customized") : t("settings.systemPrompts.status.builtin")}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted">{copy(prompt.descriptionKey)}</p>
      </div>
      <Button size="sm" onClick={onEdit}>
        {t("common.action.edit")}
      </Button>
    </li>
  );
}

function PromptEditor({ prompt, onClose }: { prompt: PromptDto; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const copy = usePromptCopy();
  const name = copy(prompt.nameKey);
  const effective = prompt.current?.text ?? prompt.builtin.text;
  const [text, setText] = useState(effective);
  // The text a rejected save carried, so the server's verdict is shown only for that text.
  const [rejectedText, setRejectedText] = useState<string | undefined>(undefined);
  const path = `/api/prompts/${encodeURIComponent(prompt.id)}`;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: PROMPTS_KEY });
    await queryClient.invalidateQueries({ queryKey: [PROMPT_VERSIONS_KEY, prompt.id] });
  };
  const save = useMutation({
    mutationFn: (body: { text: string }) => client.put(path, promptDtoSchema, { body }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: (_error, body) => setRejectedText(body.text),
  });
  const restore = useMutation({
    mutationFn: () => client.delete(path, promptDtoSchema),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const tooLong = text.length > PROMPT_CUSTOM_MAX_CHARS;
  const empty = text.trim() === "";
  const unchanged = text === effective;
  const server = rejectedText === text ? rejectedProblems(save.error) : undefined;
  const problems = server ?? promptProblems(prompt, text);
  const missing = new Set(problems.missing);
  const required = [...prompt.slots, ...prompt.protocol];
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onClose())} title={t("settings.systemPrompts.editTitle", { name })} wide>
      <p className="mb-3 text-xs text-muted">{copy(prompt.descriptionKey)}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!tooLong && !empty && !unchanged && !save.isPending) {
            save.mutate({ text });
          }
        }}
      >
        <Field
          label={t("settings.systemPrompts.text")}
          htmlFor="system-prompt-text"
          aside={
            <span className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`} data-testid="prompt-count">
              {t("settings.systemPrompts.count", { count: text.length, max: PROMPT_CUSTOM_MAX_CHARS })}
            </span>
          }
        >
          <textarea
            id="system-prompt-text"
            className={`min-h-64 w-full rounded-md border bg-surface p-2 font-mono text-xs outline-none focus:border-accent ${tooLong ? "border-danger" : "border-line"}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {tooLong ? <p className="text-xs text-danger">{t("settings.systemPrompts.tooLong", { max: PROMPT_CUSTOM_MAX_CHARS })}</p> : null}
          {empty ? <p className="text-xs text-danger">{t("settings.systemPrompts.empty")}</p> : null}
        </Field>
        <div className="mb-3" data-testid="prompt-required">
          <p className="mb-1 text-xs font-medium text-muted">{t("settings.systemPrompts.required")}</p>
          {required.length === 0 ? (
            <p className="text-xs text-muted">{t("settings.systemPrompts.noRequired")}</p>
          ) : (
            <>
              <p className="mb-1 text-xs text-muted">{t("settings.systemPrompts.requiredHint")}</p>
              <ul className="flex flex-wrap gap-1.5">
                {required.map((item) => (
                  <li
                    key={item}
                    data-required={item}
                    data-missing={missing.has(item) ? "true" : "false"}
                    className={`rounded px-1.5 py-0.5 font-mono text-xs ${missing.has(item) ? "bg-danger/10 text-danger" : "bg-sunken"}`}
                  >
                    {item}
                    {missing.has(item) ? <span className="ml-1 font-sans">{t("settings.systemPrompts.missing")}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
          {problems.unknown.length === 0 ? null : (
            <div className="mt-2" data-testid="prompt-unknown">
              <ul className="flex flex-wrap gap-1.5">
                {problems.unknown.map((slot) => (
                  <li key={slot} className="rounded bg-danger/10 px-1.5 py-0.5 font-mono text-xs text-danger">
                    {t("settings.systemPrompts.unknown", { slot })}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-danger">{t("settings.systemPrompts.unknownHint")}</p>
            </div>
          )}
        </div>
        <p className="mb-3 rounded bg-panel p-2 text-xs text-muted" data-testid="prompt-scope">
          {t("settings.systemPrompts.scope")}
        </p>
        <PromptVersions promptId={prompt.id} />
        <RequestError error={save.error ?? restore.error} />
        <div className="mt-3 flex items-center justify-between gap-2">
          <ConfirmButton
            label={t("settings.systemPrompts.restore")}
            variant="danger"
            disabled={!prompt.customized || restore.isPending}
            message={t("settings.systemPrompts.restoreConfirm", { name })}
            onConfirm={() => restore.mutate()}
          />
          <div className="flex gap-2">
            <Button onClick={onClose}>{t("common.action.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={save.isPending || tooLong || empty || unchanged}>
              {t("common.action.save")}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** The user's own versions, newest first; fetched only once the list is opened. */
function PromptVersions({ promptId }: { promptId: string }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const [open, setOpen] = useState(false);
  const versions = useQuery({
    queryKey: [PROMPT_VERSIONS_KEY, promptId],
    queryFn: () => client.get(`/api/prompts/${encodeURIComponent(promptId)}/versions`, promptVersionListDtoSchema),
    enabled: open,
  });
  const items = versions.data?.items ?? [];
  return (
    <details className="mb-3 text-xs" data-testid="prompt-versions" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-muted">{t("settings.systemPrompts.versions")}</summary>
      {!open ? null : versions.isPending ? (
        <Loading />
      ) : versions.isError ? (
        <p className="mt-2 text-danger">{t("settings.systemPrompts.versionsLoadFailed")}</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-muted">{t("settings.systemPrompts.noVersions")}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {[...items].reverse().map((version) => (
            <li key={version.version} className="rounded bg-panel p-2" data-version={version.version}>
              <details>
                <summary className="cursor-pointer text-muted">
                  {t("settings.systemPrompts.version", { version: version.version })} · {formatDateTime(version.createdAt, i18n.language)}
                  {version.current ? (
                    <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-accent">{t("settings.systemPrompts.current")}</span>
                  ) : null}
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{version.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
