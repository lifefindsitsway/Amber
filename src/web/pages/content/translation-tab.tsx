import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Languages, Pencil, Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { transcriptRevisionListItemDtoSchema } from "../../../shared/dto/content.ts";
import { languageTagSchema } from "../../../shared/dto/import.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { TranslationEntryDto } from "../../../shared/dto/translation.ts";
import { languageNames } from "../../../shared/i18n/zh-CN/languages.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { useProviders, useSettings } from "../../api/queries.ts";
import { chatModelEntries, chatModelOptions, defaultChatModel, modelKey } from "../../chat/chat-data.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { FailedTaskNotice } from "../../components/failed-task-notice.tsx";
import { ModelSelect } from "../../components/model-select.tsx";
import { TaskFlow } from "../../components/task-flow.tsx";
import { Button } from "../../ui/button.tsx";
import { Checkbox } from "../../ui/checkbox.tsx";
import { FieldError, NOTE_TEXT_CLASS, TEXT_ACTION_CLASS } from "../../ui/notice.tsx";
import { TextInput } from "../../ui/text-field.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, useLatestTranslateTask, useRevisions, useTranslations } from "./content-data.ts";
import { languageLabel, revisionLabel } from "./labels.ts";
import { SpeakersNotReadHint } from "./speaker-basis-notice.tsx";
import { TranslationDraftEditor } from "./translation-draft-editor.tsx";

/** Per Content, the failed translate Task whose flow the user closed. */
export function translateFailureDismissedKey(contentId: string): string {
  return `amber.translate.failureDismissed.${contentId}`;
}

const primarySubtag = (tag: string): string => (tag.split("-")[0] ?? tag).toLowerCase();

/**
 * Quick language choices for a source language: the shared language table without the
 * source's own language (a translation into it is refused).
 */
export function targetLanguageChoices(sourceLanguage: string | undefined): string[] {
  const source = sourceLanguage === undefined ? undefined : primarySubtag(sourceLanguage);
  return Object.keys(languageNames).filter((tag) => primarySubtag(tag) !== source);
}

/**
 * 翻译 tab: target languages, model, terminology hint and an explicit
 * start; then each language's current version, opened in the subtitles tab.
 */
export function TranslationTab() {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const contentId = page.content.id;
  const [params, setParams] = useSearchParams();
  const revisions = useRevisions(contentId);
  const translations = useTranslations(contentId);
  const latestTask = useLatestTranslateTask(contentId);
  const providers = useProviders();
  const settings = useSettings();
  const options = useMemo(() => chatModelOptions(providers.data?.items ?? []), [providers.data]);
  const modelEntries = useMemo(() => chatModelEntries(options), [options]);
  const modelPickerId = useId();
  const customErrorId = useId();
  const [pickedModel, setPickedModel] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [editing, setEditing] = useState<string | undefined>(undefined);

  const primaryId = revisions.data?.primaryTranscriptRevisionId;
  const source = revisions.data?.revisions.find((revision) => revision.id === primaryId);
  const fallbackModel = defaultChatModel(options, settings.data);
  const modelRef = options.find((option) => modelKey(option.modelRef) === pickedModel)?.modelRef ?? fallbackModel;

  const start = useMutation({
    mutationFn: () =>
      client.post(`/api/contents/${encodeURIComponent(contentId)}/translations`, taskAcceptedDtoSchema, {
        body: { targetLanguages: chosen, ...(modelRef === undefined ? {} : { modelRef }) },
        idempotent: true,
      }),
    onSuccess: () => {
      setChosen([]);
      void queryClient.invalidateQueries({ queryKey: contentKeys.translations(contentId) });
      void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
    },
  });

  const unarchiveAndEdit = useUnarchiveAndEdit(contentId, setEditing);

  if (translations.isPending || revisions.isPending) return <Loading />;
  if (translations.isError) {
    return translations.error instanceof ApiError ? <ErrorView error={translations.error.error} /> : <EmptyState title={t("common.state.loadFailed")} />;
  }
  if (editing !== undefined) {
    return <TranslationDraftEditor key={editing} language={editing} onClose={() => setEditing(undefined)} />;
  }
  const label = (tag: string): string => languageLabel(tag, t, i18n);
  const archivedIds = new Set((revisions.data?.revisions ?? []).filter((item) => item.archived).map((item) => item.id));
  // Re-translating a language whose current translation the user edited replaces it as current; say so before.
  const replacesManual = translations.data.translations.some((entry) => chosen.includes(entry.targetLanguage) && entry.current?.generation["kind"] === "manual");
  const list = (tags: readonly string[]): string => new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(tags.map(label));
  const choices = [...new Set([...targetLanguageChoices(source?.language), ...chosen])];
  const toggle = (tag: string): void => setChosen(chosen.includes(tag) ? chosen.filter((item) => item !== tag) : [...chosen, tag]);
  const customValid = languageTagSchema.safeParse(custom.trim()).success && (source === undefined || primarySubtag(custom.trim()) !== primarySubtag(source.language));
  const customInvalid = custom.trim() !== "" && !customValid;
  const openVersion = (revisionId: string): void => {
    // The version list may predate the translation; the subtitles tab picks it once re-read.
    void queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
    const search = new URLSearchParams(params);
    search.set("tab", "subtitles");
    search.set("revision", revisionId);
    setParams(search, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="translation-tab">
      {source === undefined ? (
        <p className="text-sm text-muted">{t("contentView.translation.needsTranscript")}</p>
      ) : (
        <section className="flex flex-col gap-3">
          <p className="text-xs text-muted">{t("contentView.translation.source", { label: revisionLabel(source, primaryId, t, i18n) })}</p>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t("contentView.translation.languages")}</legend>
            <div className="flex flex-wrap gap-1.5">
              {choices.map((tag) => (
                <label
                  key={tag}
                  // The chip is the check box's face: the box itself is visually hidden, so the chip shows its focus.
                  className={`flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition duration-150 motion-reduce:transition-none has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent ${chosen.includes(tag) ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-sunken"}`}
                >
                  <Checkbox className="sr-only" checked={chosen.includes(tag)} onChange={() => toggle(tag)} data-testid={`translation-language-${tag}`} />
                  {label(tag)}
                </label>
              ))}
            </div>
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!customValid) return;
                const [canonical = custom.trim()] = Intl.getCanonicalLocales(custom.trim());
                if (!chosen.includes(canonical)) setChosen([...chosen, canonical]);
                setCustom("");
              }}
            >
              <div className="flex items-center gap-2">
                <TextInput
                  size="sm"
                  className="w-56"
                  placeholder={t("contentView.translation.customLanguage")}
                  aria-label={t("contentView.translation.customLanguage")}
                  value={custom}
                  invalid={customInvalid}
                  aria-describedby={customInvalid ? customErrorId : undefined}
                  onChange={(event) => setCustom(event.target.value)}
                />
                <Button size="sm" type="submit" disabled={!customValid}>
                  <Plus size={14} />
                  {t("contentView.translation.addLanguage")}
                </Button>
              </div>
              {customInvalid ? <FieldError id={customErrorId}>{t("contentView.translation.invalidLanguage")}</FieldError> : null}
            </form>
          </fieldset>
          {options.length === 0 ? (
            <p className={NOTE_TEXT_CLASS}>
              {t("contentView.translation.needsModel")}{" "}
              <Link to="/settings/models" className={TEXT_ACTION_CLASS}>
                {t("common.action.goConfigure")}
              </Link>
            </p>
          ) : (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <label htmlFor={modelPickerId} className="shrink-0 text-muted">
                {t("contentView.translation.model")}
              </label>
              {/* The wrapper caps the trigger at 16rem so a long name cannot push the row apart. */}
              <div className="flex max-w-64 min-w-0">
                <ModelSelect
                  kind="llm"
                  id={modelPickerId}
                  entries={modelEntries}
                  value={modelRef === undefined ? "" : modelKey(modelRef)}
                  onChange={setPickedModel}
                  testId="translation-model"
                  size="sm"
                  width="content"
                />
              </div>
            </div>
          )}
          <p className={NOTE_TEXT_CLASS}>
            {t("contentView.translation.termsHint")}{" "}
            <Link to="/settings/terminology" className={TEXT_ACTION_CLASS}>
              {t("contentView.translation.termsLink")}
            </Link>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={chosen.length === 0 || modelRef === undefined || start.isPending} onClick={() => start.mutate()} data-testid="translation-start">
              <Languages size={14} />
              {t("contentView.translation.start")}
            </Button>
            <SpeakersNotReadHint contentId={contentId} revisionId={primaryId} testId="translation-speakers-not-read" />
          </div>
          {replacesManual ? (
            <p className={NOTE_TEXT_CLASS} data-testid="translation-replaces-manual">
              {t("editor.entry.retranslateHint")}
            </p>
          ) : null}
          {start.error instanceof ApiError ? <ErrorView error={start.error.error} /> : null}
        </section>
      )}
      {translations.data.activeTasks.map((task) => (
        <section key={task.taskId} className="flex flex-col gap-1" data-testid="translation-running">
          <p className="text-xs text-muted">{t("contentView.translation.running", { languages: list(task.targetLanguages) })}</p>
          <TaskFlow taskId={task.taskId} />
        </section>
      ))}
      {translations.data.activeTasks.length === 0 ? (
        <FailedTaskNotice
          task={latestTask.data}
          storageKey={translateFailureDismissedKey(contentId)}
          message={t("contentView.translation.failed")}
          testId="translation-failed"
        />
      ) : null}
      {unarchiveAndEdit.error instanceof ApiError ? <ErrorView error={unarchiveAndEdit.error.error} /> : null}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t("contentView.translation.versions")}</h2>
        {translations.data.translations.length === 0 ? (
          <p className="text-sm text-muted">{t("contentView.translation.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {translations.data.translations.map((entry) => (
              <TranslationRow
                key={entry.artifactId}
                entry={entry}
                label={label(entry.targetLanguage)}
                archived={entry.current !== undefined && archivedIds.has(entry.current.id)}
                busy={unarchiveAndEdit.isPending}
                onOpen={openVersion}
                onEdit={() => setEditing(entry.targetLanguage)}
                onUnarchiveAndEdit={(revisionId) => unarchiveAndEdit.mutate({ revisionId, language: entry.targetLanguage })}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TranslationRow(props: {
  entry: TranslationEntryDto;
  label: string;
  /** The language's current translation is archived. */
  archived: boolean;
  busy: boolean;
  onOpen: (revisionId: string) => void;
  onEdit: () => void;
  onUnarchiveAndEdit: (revisionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { entry } = props;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm" data-testid="translation-entry" data-language={entry.targetLanguage}>
      <span className="font-medium">{props.label}</span>
      {entry.current === undefined ? null : (
        <span className="text-xs text-muted">{new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(entry.current.createdAt)}</span>
      )}
      {entry.stale ? (
        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent" data-testid="translation-stale">
          {t("contentView.translation.stale")}
        </span>
      ) : null}
      <span className="text-xs text-muted">{t("contentView.translation.history", { count: entry.revisions.length })}</span>
      {entry.current === undefined ? null : (
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => props.onOpen((entry.current as { id: string }).id)} data-testid="translation-open">
            {t("contentView.translation.open")}
          </Button>
          <TranslationEditButton entry={entry} archived={props.archived} busy={props.busy} onEdit={props.onEdit} onUnarchiveAndEdit={props.onUnarchiveAndEdit} />
        </div>
      )}
    </li>
  );
}

/**
 * 「取消归档并编辑」: an archived current translation cannot be edited, so it is restored first
 * and the editor of its language opens once that succeeded.
 */
export function useUnarchiveAndEdit(contentId: string, onReady: (language: string) => void) {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entry: { revisionId: string; language: string }) => {
      await client.put(`/api/transcript/revisions/${encodeURIComponent(entry.revisionId)}/archived`, transcriptRevisionListItemDtoSchema, { body: { archived: false } });
      return entry.language;
    },
    onSuccess: async (language) => {
      await queryClient.invalidateQueries({ queryKey: contentKeys.revisions(contentId) });
      onReady(language);
    },
  });
}

/**
 * 「编辑译文」, a secondary outlined button: 「继续编辑 •」 while the language has a draft, and
 * 「取消归档并编辑」 when its current translation is archived. A resumed draft with an archived
 * base still opens: the editor then offers only to discard it.
 */
export function TranslationEditButton(props: {
  entry: TranslationEntryDto;
  archived: boolean;
  busy?: boolean;
  onEdit: () => void;
  onUnarchiveAndEdit: (revisionId: string) => void;
}) {
  const { t } = useTranslation();
  const { entry } = props;
  if (entry.current === undefined) return null;
  const currentId = entry.current.id;
  const unarchive = entry.draft === undefined && props.archived;
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={props.busy === true}
      onClick={() => (unarchive ? props.onUnarchiveAndEdit(currentId) : props.onEdit())}
      data-testid="translation-edit"
    >
      <Pencil size={14} />
      {entry.draft !== undefined ? t("editor.entry.resume") : unarchive ? t("editor.entry.unarchiveAndEdit") : t("editor.entry.edit")}
    </Button>
  );
}
