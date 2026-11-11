import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs } from "radix-ui";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { UI_LANGUAGE_DEFAULT } from "../../shared/defaults.ts";
import { contentDetailDtoSchema } from "../../shared/dto/content.ts";
import { importResponseSchema, inspectResponseSchema, type ImportItem, type ImportRequest, type ImportResponse } from "../../shared/dto/import.ts";
import type { LocalFileRequest } from "../../shared/dto/local-media.ts";
import type { AsrModelRefDto, ModelRefDto } from "../../shared/dto/model-ref.ts";
import { summaryTemplateListDtoSchema, type SummaryTemplateDto } from "../../shared/dto/summary.ts";
import type { AppError } from "../../shared/errors.ts";
import { languageNames } from "../../shared/i18n/zh-CN/languages.ts";
import { ApiError, type ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, useAsrProfiles, useCollections, useProviders, useSettings, useVersion } from "../api/queries.ts";
import { ErrorView } from "../components/error-view.tsx";
import { diarizationNoteKey, diarizationOffer } from "../components/asr-diarization.ts";
import { AsrModelSelect, initialAsrModelRef } from "../components/asr-model-select.tsx";
import { pickLocalFile, type PickedFile } from "../desktop/bridge.ts";
import { useDesktop } from "../desktop/use-desktop.ts";
import { linesOf, recognizeLink } from "../links.ts";
import type { NewPagePrefill } from "../shell/paste-guard.ts";
import { requestOpenTasks } from "../shell/task-panel.tsx";
import { Button } from "../ui/button.tsx";
import { FilePicker } from "../ui/file-picker.tsx";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import { PageHeader } from "../ui/feedback.tsx";

/** Builtin template id used when the user has not chosen a default. */
const FALLBACK_TEMPLATE_ID = "summary.core";
const NEW_COLLECTION = "\u0000new";

type Tab = "link" | "upload" | "local" | "subtitle";
type PartChoice = "first" | "all";

interface PartPrompt {
  url: string;
  title?: string;
  count: number;
}

const FIELD = "h-9 rounded-md border border-line bg-surface px-2 text-sm";
const SUBTITLE_ACCEPT = ".srt,.vtt,text/vtt,application/x-subrip";
/**
 * The file and subtitle tabs put each label beside its control, labels sharing one column; a narrow
 * form stacks them. Rows without a label of their own (hints, errors) sit under the controls.
 */
const FORM_GRID = "mt-5 grid grid-cols-1 gap-y-2 @lg:grid-cols-[max-content_1fr] @lg:items-center @lg:gap-x-6 @lg:gap-y-5";
const FORM_LABEL = "text-sm";
const FORM_HINT = "text-xs text-muted @lg:col-start-2 @lg:-mt-3";
const FORM_FULL = "@lg:col-span-2";

function encodeModel(ref: ModelRefDto): string {
  return JSON.stringify([ref.providerProfileId, ref.modelId]);
}

function decodeModel(value: string): ModelRefDto | undefined {
  if (value === "") return undefined;
  const [providerProfileId, modelId] = JSON.parse(value) as [string, string];
  return { providerProfileId, modelId };
}

/** `.srt` / `.vtt` from the file name; otherwise the server decides by content. */
function subtitleFormat(fileName: string): "srt" | "vtt" | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".srt")) return "srt";
  if (lower.endsWith(".vtt")) return "vtt";
  return undefined;
}

/** The file name of a picked path, whichever separator the platform uses. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Whether a shell grant has run out; the backend checks again regardless. */
function expired(file: PickedFile): boolean {
  return file.grant.expiresAt <= Date.now();
}

/**
 * Where to go after an import: one Content → its page; a platform list or a
 * named collection → that collection; several items into a chosen collection → it; loose
 * items → the library filtered to this batch, with the task panel open. Never creates a
 * collection on its own.
 */
export async function routeAfterImport(input: {
  api: ApiClient;
  response: ImportResponse;
  lines: readonly string[];
  collection: { id: string } | { name: string } | undefined;
}): Promise<{ path: string; openTasks: boolean }> {
  const { response, collection } = input;
  const scattered = { path: `/library?importBatchId=${encodeURIComponent(response.importBatchId)}`, openTasks: true };
  const firstId = response.contentIds[0];
  if (response.contentIds.length === 1 && firstId !== undefined) {
    return { path: `/contents/${firstId}`, openTasks: false };
  }
  if (collection !== undefined && "id" in collection) {
    return { path: `/collections/${collection.id}`, openTasks: false };
  }
  const platformList = input.lines.length === 1 && recognizeLink(input.lines[0] ?? "")?.kind === "collection";
  if (firstId === undefined || (collection === undefined && !platformList)) {
    return scattered;
  }
  try {
    const content = await input.api.get(`/api/contents/${encodeURIComponent(firstId)}`, contentDetailDtoSchema);
    const target =
      collection !== undefined ? [...content.collections].reverse().find((item) => item.name === collection.name) : content.collections[0];
    return target === undefined ? scattered : { path: `/collections/${target.id}`, openTasks: false };
  } catch {
    return scattered;
  }
}

/** The new page: links, local media and subtitle import, with this run's settings. */
export function NewPage() {
  const { t, i18n } = useTranslation();
  const formId = useId();
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const version = useVersion();
  const settings = useSettings();
  const providers = useProviders();
  const asrProfiles = useAsrProfiles();
  const collections = useCollections();
  const templates = useQuery({
    queryKey: ["summaryTemplates"],
    queryFn: () => api.get("/api/summary-templates", summaryTemplateListDtoSchema),
  });
  const server = version.data?.mode === "server";
  const desktop = useDesktop();

  const [tab, setTab] = useState<Tab>("link");
  const [text, setText] = useState(() => (location.state as NewPagePrefill | null)?.prefill ?? "");
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const [subtitle, setSubtitle] = useState<{ name: string; text: string } | undefined>(undefined);
  const [subtitleLanguage, setSubtitleLanguage] = useState("");
  const [uploadFile, setUploadFile] = useState<File | undefined>(undefined);
  const [uploadSubtitle, setUploadSubtitle] = useState<File | undefined>(undefined);
  const [localFile, setLocalFile] = useState<PickedFile | undefined>(undefined);
  const [localSubtitle, setLocalSubtitle] = useState<PickedFile | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [templateChoice, setTemplateChoice] = useState<string | undefined>(undefined);
  const [modelChoice, setModelChoice] = useState<string | undefined>(undefined);
  // `null` once the user picked "none"; undefined until the user touches the picker.
  const [asrChoice, setAsrChoice] = useState<AsrModelRefDto | null | undefined>(undefined);
  const [languageChoice, setLanguageChoice] = useState<string | undefined>(undefined);
  const [collectionChoice, setCollectionChoice] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [autoProofread, setAutoProofread] = useState(true);
  const [partPrompts, setPartPrompts] = useState<PartPrompt[]>([]);
  const [partChoices, setPartChoices] = useState<Record<string, PartChoice>>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [error, setError] = useState<AppError | undefined>(undefined);
  // Items skipped because their Content is in the trash; the page stays so the user sees why.
  const [skipped, setSkipped] = useState<{ count: number; next?: { path: string; openTasks: boolean } } | undefined>(undefined);

  const modelOptions = (providers.data?.items ?? []).flatMap((profile) =>
    profile.models.map((model) => ({ value: encodeModel({ providerProfileId: profile.id, modelId: model.modelId }), label: `${profile.name} · ${model.modelId}` })),
  );
  const defaultModel = settings.data?.defaultModelRef === undefined ? undefined : encodeModel(settings.data.defaultModelRef);
  const model = modelChoice ?? (defaultModel !== undefined && modelOptions.some((option) => option.value === defaultModel) ? defaultModel : (modelOptions[0]?.value ?? ""));
  // The ASR model starts as the user's default while it can be picked, else none: unlike the
  // LLM model, nothing is chosen for the user.
  const asrOptions = asrProfiles.data?.items ?? [];
  const asrModelRef = asrChoice === undefined ? initialAsrModelRef(asrOptions, settings.data?.defaultAsrModelRef) : (asrChoice ?? undefined);
  const asrSetting = asrModelRef === undefined ? {} : { asrModelRef };
  // What the speaker identification setting will do with this model; the length of what is imported is not known yet.
  const diarizationNote = diarizationNoteKey(settings.data?.asrDiarization === true, diarizationOffer(asrOptions, asrModelRef, undefined));
  const templateId = templateChoice ?? settings.data?.defaultSummaryTemplateId ?? FALLBACK_TEMPLATE_ID;
  const outputLanguage = languageChoice ?? settings.data?.defaultOutputLanguage ?? settings.data?.language ?? UI_LANGUAGE_DEFAULT;
  const languageOptions = [...new Set([...Object.keys(languageNames), outputLanguage])];
  const languageLabel = (tag: string): string => (i18n.exists(`languageNames.${tag}`) ? t(`languageNames.${tag}`) : tag);
  const templateLabel = (template: SummaryTemplateDto): string => (template.builtin && i18n.exists(template.name) ? String(t(template.name as never)) : template.name);

  const lines = tab === "subtitle" ? linesOf(subtitleUrl).slice(0, 1) : linesOf(text);
  const recognized = lines.map((line) => recognizeLink(line));
  const noLlm = providers.data !== undefined && providers.data.items.length === 0;

  /** Leaves for the import's result, unless some items were skipped for being in the trash. */
  const finishImport = (response: ImportResponse, next: { path: string; openTasks: boolean }): void => {
    const skippedCount = response.skippedTrashedContentIds?.length ?? 0;
    if (skippedCount > 0) {
      setSkipped({ count: skippedCount, ...(response.contentIds.length === 0 ? {} : { next }) });
      return;
    }
    void navigate(next.path);
    if (next.openTasks) requestOpenTasks();
  };

  const collectionTarget = (): { id: string } | { name: string } | undefined => {
    if (collectionChoice === "") return undefined;
    if (collectionChoice === NEW_COLLECTION) return { name: newCollectionName.trim() };
    return { id: collectionChoice };
  };

  const upload = useMutation({
    mutationFn: async (options: { allowDuplicate: boolean }): Promise<void> => {
      if (uploadFile === undefined) return;
      const modelRef = decodeModel(model);
      const settings: ImportRequest["settings"] = { templateId, outputLanguage, autoProofread, ...(modelRef === undefined ? {} : { modelRef }), ...asrSetting };
      // Part order is fixed by the upload endpoint: the media file last.
      const form = new FormData();
      form.append("settings", JSON.stringify(settings));
      if (options.allowDuplicate) form.append("allowDuplicate", "true");
      if (uploadSubtitle !== undefined) {
        form.append("subtitleLanguage", subtitleLanguage);
        form.append("subtitle", uploadSubtitle, uploadSubtitle.name);
      }
      form.append("file", uploadFile, uploadFile.name);
      const response = await api.upload("/api/contents/upload", form, importResponseSchema, { idempotent: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
      finishImport(response, await routeAfterImport({ api, response, lines: [], collection: undefined }));
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.error : undefined),
  });

  const pick = useMutation({
    mutationFn: (kind: "media" | "subtitle") => pickLocalFile(kind),
    onSuccess: (file, kind) => {
      // A cancelled dialog changes nothing.
      if (file === null) return;
      setError(undefined);
      setProblem(undefined);
      if (kind === "media") setLocalFile(file);
      else setLocalSubtitle(file);
    },
  });

  const localImport = useMutation({
    mutationFn: async (options: { allowDuplicate: boolean }): Promise<void> => {
      if (localFile === undefined) return;
      const modelRef = decodeModel(model);
      const body: LocalFileRequest = {
        path: localFile.path,
        grant: localFile.grant,
        settings: { templateId, outputLanguage, autoProofread, ...(modelRef === undefined ? {} : { modelRef }), ...asrSetting },
        allowDuplicate: options.allowDuplicate,
        ...(localSubtitle === undefined ? {} : { initialSubtitle: { path: localSubtitle.path, grant: localSubtitle.grant, language: subtitleLanguage } }),
      };
      const response = await api.post("/api/contents/local-file", importResponseSchema, { body, idempotent: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
      finishImport(response, await routeAfterImport({ api, response, lines: [], collection: undefined }));
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.error.code === "unauthenticated.file_grant") {
        // The grants ran out (or the shell restarted with a new key): the user picks again.
        setLocalFile(undefined);
        setLocalSubtitle(undefined);
      }
      setError(caught instanceof ApiError ? caught.error : undefined);
    },
  });

  const submit = useMutation({
    mutationFn: async (): Promise<void> => {
      const collection = collectionTarget();
      const modelRef = decodeModel(model);
      const items: ImportItem[] =
        tab === "subtitle" && subtitle !== undefined
          ? [
              {
                url: lines[0] ?? "",
                initialSubtitle: {
                  text: subtitle.text,
                  language: subtitleLanguage,
                  ...(subtitleFormat(subtitle.name) === undefined ? {} : { format: subtitleFormat(subtitle.name) as "srt" | "vtt" }),
                },
              },
            ]
          : lines.map((url) => ({ url, ...(partChoices[url] === undefined ? {} : { parts: partChoices[url] }) }));
      const body: ImportRequest = {
        items,
        settings: { templateId, outputLanguage, autoProofread, ...(modelRef === undefined ? {} : { modelRef }), ...asrSetting },
        ...(collection === undefined ? {} : { collection }),
      };
      try {
        const response = await api.post("/api/contents/import", importResponseSchema, { body, idempotent: true });
        void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.collections });
        // A direct link to a trashed Content restores it, back into its collections.
        void queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails });
        void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
        void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
        finishImport(response, await routeAfterImport({ api, response, lines, collection }));
      } catch (caught) {
        if (caught instanceof ApiError && caught.error.code === "invalid_request.multipart_choice_required") {
          const prompts = await inspectParts(api, items.filter((item) => item.parts === undefined).map((item) => item.url));
          if (prompts.length > 0) {
            setPartPrompts(prompts);
            return;
          }
        }
        throw caught;
      }
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.error : undefined),
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setError(undefined);
    setProblem(undefined);
    setSkipped(undefined);
    if (tab === "upload") {
      if (uploadFile === undefined) return setProblem(t("shell.newPage.needFile"));
      if (uploadSubtitle !== undefined && subtitleLanguage === "") return setProblem(t("shell.newPage.needSubtitleLanguage"));
      upload.mutate({ allowDuplicate: false });
      return;
    }
    if (tab === "local") {
      if (localFile === undefined) return setProblem(t("shell.newPage.needLocalFile"));
      if (localSubtitle !== undefined && subtitleLanguage === "") return setProblem(t("shell.newPage.needSubtitleLanguage"));
      if (expired(localFile) || (localSubtitle !== undefined && expired(localSubtitle))) {
        setLocalFile(undefined);
        setLocalSubtitle(undefined);
        return setProblem(t("shell.newPage.pickAgain"));
      }
      localImport.mutate({ allowDuplicate: false });
      return;
    }
    if (lines.length === 0) return setProblem(t("shell.newPage.needUrl"));
    if (tab === "subtitle" && (subtitle === undefined || subtitleLanguage === "")) return setProblem(t("shell.newPage.needSubtitle"));
    if (collectionChoice === NEW_COLLECTION && newCollectionName.trim() === "") return setProblem(t("shell.newPage.needCollectionName"));
    submit.mutate();
  };

  const onSubtitleFile = (file: File | undefined): void => {
    if (file === undefined) return setSubtitle(undefined);
    void file.text().then((content) => setSubtitle({ name: file.name, text: content }));
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("shell.newPage.title")} />
      <form onSubmit={onSubmit} className="@container mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-8">
        {noLlm ? (
          <div data-testid="no-llm-banner" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
            <span>{t("shell.newPage.noLlmBanner")}</span>
            <Link to="/settings/models" className="font-medium text-accent underline">
              {t("shell.newPage.configureNow")}
            </Link>
          </div>
        ) : null}
        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <Tabs.List className="flex gap-1 border-b border-line">
            <TabTrigger value="link" label={t("shell.newPage.tabLink")} />
            {server ? (
              <TabTrigger value="upload" label={t("shell.newPage.tabUpload")} />
            ) : (
              <TabTrigger value="local" label={t("shell.newPage.tabLocal")} disabled={!desktop} />
            )}
            <TabTrigger value="subtitle" label={t("shell.newPage.tabSubtitle")} />
          </Tabs.List>
          {server || desktop ? null : <p className="mt-2 text-xs text-muted">{t("shell.newPage.localUnavailable")}</p>}
          <Tabs.Content value="link" className="mt-3 flex flex-col gap-2">
            <textarea
              data-testid="new-url-input"
              aria-label={t("shell.newPage.tabLink")}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("shell.newPage.urlPlaceholder")}
              rows={6}
              className="w-full rounded-md border border-line bg-surface p-3 font-mono text-sm"
            />
            {recognized.some((link) => link?.kind === "collection") ? (
              <p className="text-xs text-muted">{t("shell.newPage.collectionDetected")}</p>
            ) : lines.length > 1 ? (
              <p className="text-xs text-muted">{t("shell.newPage.batchDetected", { count: lines.length })}</p>
            ) : null}
          </Tabs.Content>
          {server ? (
            <Tabs.Content value="upload" className={FORM_GRID}>
              <span id={`${formId}-upload-file`} className={FORM_LABEL}>
                {t("shell.newPage.uploadFile")}
              </span>
              <FilePicker testId="upload-file" accept="audio/*,video/*" fileName={uploadFile?.name} onFile={setUploadFile} labelledBy={`${formId}-upload-file`} />
              <span className={FORM_HINT}>{t("shell.newPage.uploadHint")}</span>
              <span id={`${formId}-upload-subtitle`} className={FORM_LABEL}>
                {t("shell.newPage.uploadSubtitle")}
              </span>
              <FilePicker
                testId="upload-subtitle"
                accept={SUBTITLE_ACCEPT}
                fileName={uploadSubtitle?.name}
                onFile={setUploadSubtitle}
                labelledBy={`${formId}-upload-subtitle`}
              />
              {uploadSubtitle === undefined ? null : (
                <>
                  <label htmlFor={`${formId}-upload-language`} className={FORM_LABEL}>
                    {t("shell.newPage.subtitleLanguage")}
                  </label>
                  <select id={`${formId}-upload-language`} data-testid="upload-subtitle-language" value={subtitleLanguage} onChange={(event) => setSubtitleLanguage(event.target.value)} className={FIELD}>
                    <option value="">{t("shell.newPage.chooseLanguage")}</option>
                    {Object.keys(languageNames).map((tag) => (
                      <option key={tag} value={tag}>
                        {languageLabel(tag)}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </Tabs.Content>
          ) : null}
          {desktop ? (
            <Tabs.Content value="local" className={FORM_GRID}>
              <span className={FORM_LABEL}>{t("shell.newPage.uploadFile")}</span>
              <div className="flex min-w-0 items-center gap-3">
                <Button disabled={pick.isPending} onClick={() => pick.mutate("media")} data-testid="local-pick">
                  {t("shell.newPage.pickFile")}
                </Button>
                <span className="min-w-0 truncate text-sm" data-testid="local-file-name" title={localFile?.path}>
                  {localFile === undefined ? t("shell.newPage.noFilePicked") : baseName(localFile.path)}
                </span>
              </div>
              <span className={FORM_HINT}>{t("shell.newPage.localHint")}</span>
              <span className={FORM_LABEL}>{t("shell.newPage.uploadSubtitle")}</span>
              <div className="flex min-w-0 items-center gap-3">
                <Button disabled={pick.isPending} onClick={() => pick.mutate("subtitle")} data-testid="local-pick-subtitle">
                  {t("shell.newPage.pickSubtitle")}
                </Button>
                {localSubtitle === undefined ? null : (
                  <>
                    <span className="min-w-0 truncate text-sm" data-testid="local-subtitle-name" title={localSubtitle.path}>
                      {baseName(localSubtitle.path)}
                    </span>
                    <Button variant="ghost" onClick={() => setLocalSubtitle(undefined)}>
                      {t("shell.newPage.removeSubtitle")}
                    </Button>
                  </>
                )}
              </div>
              {localSubtitle === undefined ? null : (
                <>
                  <label htmlFor={`${formId}-local-language`} className={FORM_LABEL}>
                    {t("shell.newPage.subtitleLanguage")}
                  </label>
                  <select id={`${formId}-local-language`} data-testid="local-subtitle-language" value={subtitleLanguage} onChange={(event) => setSubtitleLanguage(event.target.value)} className={FIELD}>
                    <option value="">{t("shell.newPage.chooseLanguage")}</option>
                    {Object.keys(languageNames).map((tag) => (
                      <option key={tag} value={tag}>
                        {languageLabel(tag)}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {pick.error === null ? null : (
                <div className={FORM_FULL}>
                  <ErrorView error={appErrorOf(pick.error)} />
                </div>
              )}
            </Tabs.Content>
          ) : null}
          <Tabs.Content value="subtitle" className={FORM_GRID}>
            <label htmlFor={`${formId}-subtitle-url`} className={FORM_LABEL}>
              {t("shell.newPage.subtitleUrl")}
            </label>
            <input id={`${formId}-subtitle-url`} value={subtitleUrl} onChange={(event) => setSubtitleUrl(event.target.value)} placeholder={t("shell.newPage.subtitleUrlPlaceholder")} className={FIELD} />
            <span id={`${formId}-subtitle-file`} className={FORM_LABEL}>
              {t("shell.newPage.subtitleFile")}
            </span>
            <FilePicker testId="subtitle-file" accept={SUBTITLE_ACCEPT} fileName={subtitle?.name} onFile={onSubtitleFile} labelledBy={`${formId}-subtitle-file`} />
            <label htmlFor={`${formId}-subtitle-language`} className={FORM_LABEL}>
              {t("shell.newPage.subtitleLanguage")}
            </label>
            <select id={`${formId}-subtitle-language`} value={subtitleLanguage} onChange={(event) => setSubtitleLanguage(event.target.value)} className={FIELD}>
              <option value="">{t("shell.newPage.chooseLanguage")}</option>
              {Object.keys(languageNames).map((tag) => (
                <option key={tag} value={tag}>
                  {languageLabel(tag)}
                </option>
              ))}
            </select>
          </Tabs.Content>
        </Tabs.Root>

        {partPrompts.length === 0 ? null : (
          <div data-testid="parts-choice" className="rounded-md border border-line p-3 text-sm">
            <p className="font-medium">{t("shell.newPage.partsTitle")}</p>
            {partPrompts.map((prompt) => (
              <fieldset key={prompt.url} className="mt-2">
                <legend className="truncate text-xs text-muted">{prompt.title ?? prompt.url}</legend>
                <label className="mr-4 inline-flex items-center gap-1">
                  <input type="radio" name={prompt.url} checked={partChoices[prompt.url] === "first"} onChange={() => setPartChoices({ ...partChoices, [prompt.url]: "first" })} />
                  {t("shell.newPage.partsFirst")}
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="radio" name={prompt.url} checked={partChoices[prompt.url] === "all"} onChange={() => setPartChoices({ ...partChoices, [prompt.url]: "all" })} />
                  {t("shell.newPage.partsAll", { count: prompt.count })}
                </label>
              </fieldset>
            ))}
            <p className="mt-2 text-xs text-muted">{t("shell.newPage.partsHint")}</p>
          </div>
        )}

        <section className="rounded-md border border-line">
          <button type="button" onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings} className="flex w-full items-center gap-1 px-3 py-2 text-sm font-medium">
            {showSettings ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {t("shell.newPage.settings")}
          </button>
          {showSettings ? (
            <div className="grid grid-cols-1 gap-3 border-t border-line p-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                {t("shell.newPage.template")}
                <select value={templateId} onChange={(event) => setTemplateChoice(event.target.value)} className={FIELD}>
                  {(templates.data?.items ?? []).map((template) => (
                    <option key={template.id} value={template.id}>
                      {templateLabel(template)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("shell.newPage.model")}
                <select value={model} onChange={(event) => setModelChoice(event.target.value)} className={FIELD}>
                  <option value="">{t("shell.newPage.noModel")}</option>
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {asrOptions.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                  <label className="flex flex-col gap-1 text-sm">
                    {t("shell.newPage.asrModel")}
                    <AsrModelSelect
                      profiles={asrOptions}
                      value={asrModelRef}
                      onChange={(ref) => setAsrChoice(ref ?? null)}
                      className={FIELD}
                      label={t("shell.newPage.asrModel")}
                      noneLabel={t("shell.newPage.noAsrModel")}
                      testId="new-asr-model"
                    />
                  </label>
                  {diarizationNote === undefined ? null : (
                    <p className="text-xs text-muted" data-testid="new-diarization-note">
                      {t(`speakerTools.note.${diarizationNote}`)}
                    </p>
                  )}
                </div>
              )}
              <label className="flex flex-col gap-1 text-sm">
                {t("shell.newPage.outputLanguage")}
                <select value={outputLanguage} onChange={(event) => setLanguageChoice(event.target.value)} className={FIELD}>
                  {languageOptions.map((tag) => (
                    <option key={tag} value={tag}>
                      {languageLabel(tag)}
                    </option>
                  ))}
                </select>
              </label>
              {tab === "upload" || tab === "local" ? null : (
              <label className="flex flex-col gap-1 text-sm">
                {t("shell.newPage.collection")}
                <select value={collectionChoice} onChange={(event) => setCollectionChoice(event.target.value)} className={FIELD}>
                  <option value="">{t("shell.newPage.collectionNone")}</option>
                  {(collections.data?.items ?? []).map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                  <option value={NEW_COLLECTION}>{t("shell.newPage.collectionNew")}</option>
                </select>
              </label>
              )}
              {tab !== "upload" && tab !== "local" && collectionChoice === NEW_COLLECTION ? (
                <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                  {t("shell.newPage.collectionNewName")}
                  <input value={newCollectionName} onChange={(event) => setNewCollectionName(event.target.value)} className={FIELD} />
                </label>
              ) : null}
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={autoProofread} onChange={(event) => setAutoProofread(event.target.checked)} />
                {t("shell.newPage.autoProofread")}
              </label>
            </div>
          ) : null}
        </section>

        {problem === undefined ? null : <p className="text-sm text-danger">{problem}</p>}
        {skipped === undefined ? null : (
          <div data-testid="new-skipped-trashed" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
            <span>{t("shell.newPage.skippedTrashed", { count: skipped.count })}</span>
            <Link to="/trash" className="font-medium text-accent underline">
              {t("shell.newPage.openTrash")}
            </Link>
            {skipped.next === undefined ? null : (
              <Link
                to={skipped.next.path}
                className="font-medium text-accent underline"
                onClick={() => {
                  if (skipped.next?.openTasks === true) requestOpenTasks();
                }}
              >
                {t("shell.newPage.viewImported")}
              </Link>
            )}
          </div>
        )}
        {error === undefined ? null : (
          <ErrorView error={error}>
            {error.code === "conflict.duplicate_file" && (tab === "upload" || tab === "local") ? (
              <>
                {error.details?.["trashed"] === true ? (
                  <p data-testid="new-duplicate-in-trash" className="w-full text-sm">
                    {t("shell.newPage.duplicateInTrash")}{" "}
                    <Link to="/trash" className="font-medium text-accent underline">
                      {t("shell.newPage.openTrash")}
                    </Link>
                  </p>
                ) : null}
                {tab === "upload" ? (
                  <Button
                    size="sm"
                    data-testid="upload-anyway"
                    disabled={upload.isPending}
                    onClick={() => {
                      setError(undefined);
                      upload.mutate({ allowDuplicate: true });
                    }}
                  >
                    {t("shell.newPage.uploadAnyway")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    data-testid="local-anyway"
                    disabled={localImport.isPending}
                    onClick={() => {
                      setError(undefined);
                      localImport.mutate({ allowDuplicate: true });
                    }}
                  >
                    {t("shell.newPage.importAnyway")}
                  </Button>
                )}
              </>
            ) : undefined}
          </ErrorView>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" data-testid="new-submit" disabled={submit.isPending || upload.isPending || localImport.isPending}>
            {upload.isPending ? t("shell.newPage.uploading") : submit.isPending || localImport.isPending ? t("shell.newPage.submitting") : t("shell.newPage.submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}

function TabTrigger(props: { value: Tab; label: string; disabled?: boolean }) {
  return (
    <Tabs.Trigger
      value={props.value}
      disabled={props.disabled === true}
      className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[state=active]:border-accent data-[state=active]:text-ink"
    >
      {props.label}
    </Tabs.Trigger>
  );
}

/** Which of the given links name multi-part submissions, and how many parts each has. */
async function inspectParts(api: ApiClient, urls: readonly string[]): Promise<PartPrompt[]> {
  const candidates = urls.filter((url) => {
    const link = recognizeLink(url);
    return link !== undefined && link.platform === "bilibili" && !link.partChosen && link.kind !== "collection";
  });
  const results = await Promise.all(
    candidates.map(async (url): Promise<PartPrompt | undefined> => {
      try {
        const inspected = await api.post("/api/contents/inspect", inspectResponseSchema, { body: { url } });
        if (inspected.kind !== "multipart") return undefined;
        return { url, count: inspected.parts?.length ?? 0, ...(inspected.title === undefined ? {} : { title: inspected.title }) };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((prompt): prompt is PartPrompt => prompt !== undefined);
}
