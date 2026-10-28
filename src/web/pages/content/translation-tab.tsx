import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Languages, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { languageTagSchema } from "../../../shared/dto/import.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { TranslationEntryDto } from "../../../shared/dto/translation.ts";
import { languageNames } from "../../../shared/i18n/zh-CN/languages.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { useProviders, useSettings } from "../../api/queries.ts";
import { chatModelOptions, defaultChatModel, modelKey } from "../../chat/chat-data.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { FailedTaskNotice } from "../../components/failed-task-notice.tsx";
import { TaskFlow } from "../../components/task-flow.tsx";
import { Button } from "../../ui/button.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, useLatestTranslateTask, useRevisions, useTranslations } from "./content-data.ts";
import { languageLabel, revisionLabel } from "./labels.ts";

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
  const [pickedModel, setPickedModel] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<string[]>([]);
  const [custom, setCustom] = useState("");

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

  if (translations.isPending || revisions.isPending) return <Loading />;
  if (translations.isError) {
    return translations.error instanceof ApiError ? <ErrorView error={translations.error.error} /> : <EmptyState title={t("common.state.loadFailed")} />;
  }
  const label = (tag: string): string => languageLabel(tag, t, i18n);
  const list = (tags: readonly string[]): string => new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(tags.map(label));
  const choices = [...new Set([...targetLanguageChoices(source?.language), ...chosen])];
  const toggle = (tag: string): void => setChosen(chosen.includes(tag) ? chosen.filter((item) => item !== tag) : [...chosen, tag]);
  const customValid = languageTagSchema.safeParse(custom.trim()).success && (source === undefined || primarySubtag(custom.trim()) !== primarySubtag(source.language));
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
                  className={`flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${chosen.includes(tag) ? "border-accent bg-accent-soft text-accent" : "border-line"}`}
                >
                  <input type="checkbox" className="sr-only" checked={chosen.includes(tag)} onChange={() => toggle(tag)} data-testid={`translation-language-${tag}`} />
                  {label(tag)}
                </label>
              ))}
            </div>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!customValid) return;
                const [canonical = custom.trim()] = Intl.getCanonicalLocales(custom.trim());
                if (!chosen.includes(canonical)) setChosen([...chosen, canonical]);
                setCustom("");
              }}
            >
              <input
                className="h-7 w-56 rounded border border-line bg-surface px-2 text-xs"
                placeholder={t("contentView.translation.customLanguage")}
                aria-label={t("contentView.translation.customLanguage")}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
              <Button size="sm" type="submit" disabled={!customValid}>
                <Plus size={14} />
                {t("contentView.translation.addLanguage")}
              </Button>
              {custom.trim() !== "" && !customValid ? <span className="text-xs text-danger">{t("contentView.translation.invalidLanguage")}</span> : null}
            </form>
          </fieldset>
          {options.length === 0 ? (
            <p className="text-xs text-muted">
              {t("contentView.translation.needsModel")}{" "}
              <Link to="/settings/models" className="text-accent hover:underline">
                {t("common.action.goConfigure")}
              </Link>
            </p>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">{t("contentView.translation.model")}</span>
              <select
                className="h-7 max-w-64 rounded border border-line bg-surface px-1 text-xs"
                value={modelRef === undefined ? "" : modelKey(modelRef)}
                onChange={(event) => setPickedModel(event.target.value)}
                data-testid="translation-model"
              >
                {options.map((option) => (
                  <option key={modelKey(option.modelRef)} value={modelKey(option.modelRef)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-xs text-muted">
            {t("contentView.translation.termsHint")}{" "}
            <Link to="/settings/terminology" className="text-accent hover:underline">
              {t("contentView.translation.termsLink")}
            </Link>
          </p>
          <div>
            <Button variant="primary" size="sm" disabled={chosen.length === 0 || modelRef === undefined || start.isPending} onClick={() => start.mutate()} data-testid="translation-start">
              <Languages size={14} />
              {t("contentView.translation.start")}
            </Button>
          </div>
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
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t("contentView.translation.versions")}</h2>
        {translations.data.translations.length === 0 ? (
          <p className="text-sm text-muted">{t("contentView.translation.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {translations.data.translations.map((entry) => (
              <TranslationRow key={entry.artifactId} entry={entry} label={label(entry.targetLanguage)} onOpen={openVersion} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TranslationRow(props: { entry: TranslationEntryDto; label: string; onOpen: (revisionId: string) => void }) {
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
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => props.onOpen((entry.current as { id: string }).id)} data-testid="translation-open">
          {t("contentView.translation.open")}
        </Button>
      )}
    </li>
  );
}
