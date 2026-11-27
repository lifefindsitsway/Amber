import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs } from "radix-ui";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { UI_LANGUAGE_DEFAULT } from "../../shared/defaults.ts";
import { contentDetailDtoSchema } from "../../shared/dto/content.ts";
import {
  importResponseSchema,
  inspectResponseSchema,
  type ImportItem,
  type ImportRequest,
  type ImportResponse,
  type InspectResponse,
  type RelatedCollection,
} from "../../shared/dto/import.ts";
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
import { CollectionPreviewDialog } from "../components/collection-preview/collection-preview-dialog.tsx";
import { choiceRequiredUrls, importIntent, itemsWithChoices, outcomeUnknown, type ImportIntent } from "../components/collection-preview/import-intent.ts";
import type { CollectionChoice } from "../components/collection-preview/state.ts";
import { useCollectionPreview } from "../components/collection-preview/use-collection-preview.ts";
import { LinkRecognition } from "../components/link-scope-hint.tsx";
import { ModelSelect, type ModelSelectEntry } from "../components/model-select.tsx";
import { pickLocalFile, type PickedFile } from "../desktop/bridge.ts";
import { buildSubtitleImportOptions, importBlockers, plainImportPossible } from "./content/subtitle-import-choice.ts";
import { useSubtitlePreview, type SubtitlePreviewSource } from "./content/subtitle-import-data.ts";
import { SubtitleImportPreview, useSubtitleImportChoice } from "./content/subtitle-import-preview.tsx";
import type { SubtitleImportOptions, TimedSubtitleFormat } from "../../shared/dto/subtitle-import.ts";
import { useDesktop } from "../desktop/use-desktop.ts";
import { ContextWindowNotice } from "../models/context-window-notice.tsx";
import { useFocusAfterSave } from "../models/use-focus-after-save.ts";
import { useModelReadiness } from "../models/use-model-readiness.ts";
import { linesOf, parseLinkText, recognizeLink } from "../links.ts";
import { useLinkPasteField, type NewPagePrefill } from "../shell/paste-guard.ts";
import { requestOpenTasks } from "../shell/task-panel.tsx";
import { Button, FOCUS_RING } from "../ui/button.tsx";
import { Checkbox, Radio } from "../ui/checkbox.tsx";
import { FilePicker } from "../ui/file-picker.tsx";
import { NativeSelect } from "../ui/native-select.tsx";
import { Callout, FieldError, FieldHint, InlineNote, TEXT_ACTION_CLASS, TextAction } from "../ui/notice.tsx";
import { Select, type SelectOption } from "../ui/select.tsx";
import { TextArea, TextInput } from "../ui/text-field.tsx";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import { PageHeader } from "../ui/feedback.tsx";
import { useToast } from "../ui/toast.tsx";
import { checkableLink, ImportCheckNote, importCheckShown, SubtitleLoginNote, useImportCheck, useSubtitleLoginHint } from "./import-check.tsx";
import { ImportPackButton, PackActiveNotice } from "./content-pack/pack-entry.tsx";

/** Builtin template id used when the user has not chosen a default. */
const FALLBACK_TEMPLATE_ID = "summary.core";
const NEW_COLLECTION = "\u0000new";
/** The menu's value for "no collection": the menu cannot hold an empty value. */
const NO_COLLECTION = "\u0000none";

type Tab = "link" | "upload" | "local" | "subtitle";
type PartChoice = "first" | "all";

interface PartPrompt {
  url: string;
  title?: string;
  count: number;
}

/** The control a validation message belongs to; the message shows right under it. */
type ProblemField = "links" | "subtitleUrl" | "subtitleFile" | "subtitleLanguage" | "subtitlePreview" | "uploadFile" | "localFile" | "collectionName";

interface Problem {
  field: ProblemField;
  message: string;
}

/**
 * The box's single video opened as a choice from the platform collection it belongs to: on
 * confirming the preview, the video's link is sent as that collection with the chosen entries.
 */
interface RelatedPick {
  videoUrl: string;
  collectionUrl: string;
}

/** One send of the link (or subtitle) tab: the preview's choice, and the video chosen from its collection, if so. */
interface LinkSubmit {
  choices: readonly CollectionChoice[];
  related?: RelatedPick;
}

/** Answers that reject a link the import checked, shown under the box as what is wrong with it. */
const REJECTED_LINK_CODES: ReadonlySet<string> = new Set(["invalid_request.not_video", "invalid_request.link_expired"]);

/** Timed subtitles a new Content can carry; plain text cannot be imported with new media. */
const SUBTITLE_ACCEPT = ".srt,.vtt,.ass,.ambersub,text/vtt,application/x-subrip";
/**
 * The file and subtitle tabs put each label beside its field, labels sharing one column; a
 * narrow form stacks them. A field's explanation and error sit in its own cell under the
 * control, 6 px from it; rows without a label of their own start in the second column.
 */
const FORM_GRID = "mt-5 grid grid-cols-1 gap-y-1.5 @lg:grid-cols-[max-content_1fr] @lg:items-start @lg:gap-x-6 @lg:gap-y-5";
const FORM_LABEL = "mt-3.5 text-sm first:mt-0 @lg:mt-0 @lg:flex @lg:min-h-9 @lg:items-center";
const FORM_CELL = "flex min-w-0 flex-col gap-1.5";
const FORM_FULL = "@lg:col-span-2";
const FORM_SECOND = "min-w-0 @lg:col-start-2";

function encodeModel(ref: ModelRefDto): string {
  return JSON.stringify([ref.providerProfileId, ref.modelId]);
}

function decodeModel(value: string): ModelRefDto | undefined {
  if (value === "") return undefined;
  const [providerProfileId, modelId] = JSON.parse(value) as [string, string];
  return { providerProfileId, modelId };
}

/** The timed format a file name says; otherwise the server decides by content. */
function subtitleFormat(fileName: string): TimedSubtitleFormat | undefined {
  const extension = fileName.toLowerCase().split(".").pop();
  return extension === "srt" || extension === "vtt" || extension === "ass" || extension === "ambersub" ? extension : undefined;
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
 * Where to go after an import: entries chosen from a platform collection → that collection (the
 * first the answer names); one Content → its page; a named collection → that collection; loose
 * items → the library filtered to this batch, with the task panel open. Never creates a
 * collection on its own. Answers of older servers without `collectionIds` are resolved through
 * the first Content's collections.
 */
export async function routeAfterImport(input: {
  api: ApiClient;
  response: ImportResponse;
  /** The links sent, as sent. */
  urls: readonly string[];
  collection: { id: string } | { name: string } | undefined;
  /** Some item carried entries chosen from a platform collection. */
  collectionImport?: boolean;
}): Promise<{ path: string; openTasks: boolean }> {
  const { response, collection } = input;
  const scattered = {
    path: `/library?importBatchId=${encodeURIComponent(response.importBatchId)}`,
    openTasks: true,
  };
  const joined = response.collectionIds;
  const platformCollection = joined?.[0];
  if (input.collectionImport === true && platformCollection !== undefined) {
    return { path: `/collections/${platformCollection}`, openTasks: false };
  }
  const firstId = response.contentIds[0];
  if (response.contentIds.length === 1 && firstId !== undefined) {
    return { path: `/contents/${firstId}`, openTasks: false };
  }
  if (collection !== undefined && "id" in collection) {
    return { path: `/collections/${collection.id}`, openTasks: false };
  }
  // The chosen target comes last in the answer's collections.
  const named = collection === undefined ? undefined : joined?.at(-1);
  if (named !== undefined) {
    return { path: `/collections/${named}`, openTasks: false };
  }
  const platformList = input.urls.length === 1 && recognizeLink(input.urls[0] ?? "")?.kind === "collection";
  if (platformList && platformCollection !== undefined) {
    return { path: `/collections/${platformCollection}`, openTasks: false };
  }
  if (firstId === undefined || (collection === undefined && !platformList)) {
    return scattered;
  }
  try {
    const content = await input.api.get(`/api/contents/${encodeURIComponent(firstId)}`, contentDetailDtoSchema);
    const target = collection !== undefined ? [...content.collections].reverse().find((item) => item.name === collection.name) : content.collections[0];
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
  const toast = useToast();
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
  const [prefill] = useState(() => location.state as NewPagePrefill | null);
  const [text, setText] = useState(prefill?.prefill ?? "");
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const linkField = useLinkPasteField<HTMLTextAreaElement>({
    value: text,
    onValue: setText,
    multiline: true,
    initialNote: prefill?.pasteNote,
  });
  const subtitleField = useLinkPasteField<HTMLInputElement>({
    value: subtitleUrl,
    onValue: setSubtitleUrl,
    multiline: false,
  });
  const [subtitle, setSubtitle] = useState<File | undefined>(undefined);
  const [subtitleLanguage, setSubtitleLanguage] = useState("");
  const [uploadFile, setUploadFile] = useState<File | undefined>(undefined);
  const [uploadSubtitle, setUploadSubtitle] = useState<File | undefined>(undefined);
  // Remounts the upload's subtitle picker after a removal, so picking the same file again is seen.
  const [uploadSubtitleRound, setUploadSubtitleRound] = useState(0);
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
  // `undefined` until the user touches 「自动校对」: then it follows whether a subtitle is attached.
  const [autoProofreadChoice, setAutoProofreadChoice] = useState<boolean | undefined>(undefined);
  const [partPrompts, setPartPrompts] = useState<PartPrompt[]>([]);
  const [partChoices, setPartChoices] = useState<Record<string, PartChoice>>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  // The box text an import refused (an image post, an expired link): the refusal holds only
  // while the box still says that.
  const [refusedText, setRefusedText] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (refusedText !== undefined && text !== refusedText) {
      setRefusedText(undefined);
      setProblem(undefined);
    }
  }, [text, refusedText]);
  const [error, setError] = useState<AppError | undefined>(undefined);
  // Items skipped because their Content is in the trash; the page stays so the user sees why.
  const [skipped, setSkipped] = useState<{ count: number; next?: { path: string; openTasks: boolean } } | undefined>(undefined);
  // Links the server found to be collections (short links), to be chosen from like the others.
  const [extraPreviewUrls, setExtraPreviewUrls] = useState<readonly string[]>([]);
  // What the preview's last 「开始处理」 chose; a later submit reuses it instead of asking again.
  const [confirmed, setConfirmed] = useState<{ urls: readonly string[]; choices: CollectionChoice[] } | undefined>(undefined);
  // The link import being sent: its frozen body and Idempotency-Key, kept for a retry after a network failure.
  const intent = useRef<ImportIntent | undefined>(undefined);
  // The box's video opened in the preview of its platform collection, while that preview is the one shown.
  const [related, setRelated] = useState<RelatedPick | undefined>(undefined);
  // Links the import could not verify, waiting for 「仍然导入」, and the send they came from.
  const [unverified, setUnverified] = useState<{ urls: readonly string[]; send: LinkSubmit } | undefined>(undefined);
  // Links the user chose to import unverified; every later send of them says so.
  const acceptedUnverified = useRef(new Set<string>());

  const modelOptions: ModelSelectEntry[] = (providers.data?.items ?? []).flatMap((profile) =>
    profile.models.map((model) => ({
      value: encodeModel({
        providerProfileId: profile.id,
        modelId: model.modelId,
      }),
      profileName: profile.name,
      profileKey: profile.id,
      modelId: model.modelId,
      service: profile.presetId,
    })),
  );
  const defaultModel = settings.data?.defaultModelRef === undefined ? undefined : encodeModel(settings.data.defaultModelRef);
  const model = modelChoice ?? (defaultModel !== undefined && modelOptions.some((option) => option.value === defaultModel) ? defaultModel : (modelOptions[0]?.value ?? ""));
  // The ASR model starts as the user's default while it can be picked, else none: unlike the
  // LLM model, nothing is chosen for the user.
  const asrOptions = asrProfiles.data?.items ?? [];
  const modelRef = decodeModel(model);
  // Every import ends in a summary (and chapters unless the platform has its own), both planned
  // against the context window: a chosen model without one would only fail there.
  const readiness = useModelReadiness(modelRef, "context_window");
  const windowMissing = readiness.status === "missing_context_window";
  const submitId = `${formId}-submit`;
  const windowSaved = useFocusAfterSave(windowMissing, () => document.getElementById(submitId));
  const asrModelRef = asrChoice === undefined ? initialAsrModelRef(asrOptions, settings.data?.defaultAsrModelRef) : (asrChoice ?? undefined);
  const asrSetting = asrModelRef === undefined ? {} : { asrModelRef };
  // What the speaker identification setting will do with this model; the length of what is imported is not known yet.
  const diarizationNote = diarizationNoteKey(settings.data?.asrDiarization === true, diarizationOffer(asrOptions, asrModelRef, undefined));
  const templateId = templateChoice ?? settings.data?.defaultSummaryTemplateId ?? FALLBACK_TEMPLATE_ID;
  const outputLanguage = languageChoice ?? settings.data?.defaultOutputLanguage ?? settings.data?.language ?? UI_LANGUAGE_DEFAULT;
  const languageOptions = [...new Set([...Object.keys(languageNames), outputLanguage])];
  const languageLabel = (tag: string): string => (i18n.exists(`languageNames.${tag}`) ? t(`languageNames.${tag}`) : tag);
  const templateLabel = (template: SummaryTemplateDto): string => (template.builtin && i18n.exists(template.name) ? String(t(template.name as never)) : template.name);

  // Both link fields are read for their links from what they hold now; nothing of a past paste
  // decides what is sent.
  const parsed = useMemo(() => parseLinkText(text), [text]);
  const subtitleParsed = useMemo(() => parseLinkText(subtitleUrl), [subtitleUrl]);
  // With a supported link the link tab sends its supported links alone; without one, every line
  // goes as written and the server says what it cannot take.
  const linkUrls = parsed.links.length > 0 ? parsed.links.map((link) => link.url) : linesOf(text);
  // A subtitle belongs to one video: a single supported link is sent as extracted, anything else
  // as written (more than one link is refused before sending).
  const subtitleTarget = subtitleParsed.all.length === 1 && subtitleParsed.links[0] !== undefined ? subtitleParsed.links[0].url : subtitleUrl.trim();
  const urls = tab === "subtitle" ? (subtitleTarget === "" ? [] : [subtitleTarget]) : linkUrls;
  // Collection links are chosen from in the preview first: those recognizable here, and short
  // links the server reported as collections.
  const previewUrls = tab === "link" ? linkUrls.filter((url) => recognizeLink(url)?.kind === "collection" || extraPreviewUrls.includes(url)) : [];
  // Opened from the box's single video, the preview's collection takes that video's place in the batch.
  const reserved = related !== undefined && linkUrls.includes(related.videoUrl) ? linkUrls.length - 1 : linkUrls.length - previewUrls.length;
  const preview = useCollectionPreview({ reserved });
  const recognitionId = `${formId}-recognition`;
  const checkUrl = tab === "link" ? checkableLink(parsed) : undefined;
  const check = useImportCheck(checkUrl, text);
  const loginHint = useSubtitleLoginHint(parsed, tab === "link");
  // Links the import could not verify that are still in the box.
  const shownUnverified = unverified?.urls.filter((url) => urls.includes(url)) ?? [];
  // A choice of parts belongs to the link it was made for; an edited link asks again.
  const shownPartPrompts = partPrompts.filter((prompt) => urls.includes(prompt.url));

  // The subtitle of the open tab is previewed under its file; only that one is imported.
  const uploadSource = useMemo<SubtitlePreviewSource | undefined>(() => (uploadSubtitle === undefined ? undefined : { kind: "text", file: uploadSubtitle }), [uploadSubtitle]);
  const localSource = useMemo<SubtitlePreviewSource | undefined>(
    () =>
      localSubtitle === undefined
        ? undefined
        : {
            kind: "local",
            path: localSubtitle.path,
            grant: localSubtitle.grant,
          },
    [localSubtitle],
  );
  const linkSource = useMemo<SubtitlePreviewSource | undefined>(() => (subtitle === undefined ? undefined : { kind: "text", file: subtitle }), [subtitle]);
  const subtitleSource = tab === "upload" ? uploadSource : tab === "local" ? localSource : tab === "subtitle" ? linkSource : undefined;
  const previewState = useSubtitlePreview(subtitleSource);
  const subtitlePreview = previewState.status === "ready" ? previewState.preview : undefined;
  const [subtitleChoice, setSubtitleChoice] = useSubtitleImportChoice(subtitlePreview);
  const hasSubtitle = subtitleSource !== undefined;
  // A package names its own language; every other subtitle needs one chosen.
  const packageLanguage = subtitlePreview?.package?.language;
  const effectiveSubtitleLanguage = packageLanguage ?? subtitleLanguage;
  // A subtitle already gives the text, so it is not rewritten by AI unless the user asks for it.
  const autoProofread = autoProofreadChoice ?? !hasSubtitle;
  /** The subtitle was taken away: 「自动校对」 returns to its default. */
  const subtitleRemoved = (): void => setAutoProofreadChoice(undefined);

  /** Why the attached subtitle cannot go with the import yet, if it cannot. */
  const subtitleProblem = (): string | undefined => {
    if (!hasSubtitle) return undefined;
    if (previewState.status === "loading" || previewState.status === "idle") return t("subtitleImport.newPage.pending");
    if (previewState.status === "failed" && !plainImportPossible(previewState.error.code)) return t("subtitleImport.newPage.blocked");
    if (subtitlePreview !== undefined && subtitleChoice !== undefined && importBlockers(subtitlePreview, subtitleChoice, effectiveSubtitleLanguage).length > 0)
      return t("subtitleImport.newPage.blocked");
    return undefined;
  };
  /** The options of a previewed subtitle; a failed preview imports it as a plain subtitle. */
  const subtitleOptions = (): SubtitleImportOptions | undefined =>
    subtitlePreview === undefined || subtitleChoice === undefined ? undefined : buildSubtitleImportOptions(subtitlePreview, subtitleChoice);
  const noLlm = providers.data !== undefined && providers.data.items.length === 0;

  /** The validation message of a field, its id for the control's description, and whether the control is invalid. */
  const errorId = (field: ProblemField): string => `${formId}-problem-${field}`;
  const invalid = (field: ProblemField): boolean => problem?.field === field;
  const describedBy = (field: ProblemField, ...others: Array<string | undefined>): string | undefined => {
    const ids = [...others, invalid(field) ? errorId(field) : undefined].filter((id): id is string => id !== undefined);
    return ids.length === 0 ? undefined : ids.join(" ");
  };
  const fieldError = (field: ProblemField): ReactNode =>
    problem?.field === field ? (
      <FieldError id={errorId(field)} testId={`new-problem-${field}`}>
        {problem.message}
      </FieldError>
    ) : null;
  const fail = (field: ProblemField, message: string): void => {
    setProblem({ field, message });
    if (field === "collectionName") setShowSettings(true);
  };

  /** Leaves for the import's result, unless some items were skipped for being in the trash. */
  const finishImport = (response: ImportResponse, next: { path: string; openTasks: boolean }): void => {
    const skippedCount = response.skippedTrashedContentIds?.length ?? 0;
    if (skippedCount > 0) {
      setSkipped({
        count: skippedCount,
        ...(response.contentIds.length === 0 ? {} : { next }),
      });
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
      const settings: ImportRequest["settings"] = {
        templateId,
        outputLanguage,
        autoProofread,
        ...(modelRef === undefined ? {} : { modelRef }),
        ...asrSetting,
      };
      // Part order is fixed by the upload endpoint: the media file last.
      const form = new FormData();
      form.append("settings", JSON.stringify(settings));
      if (options.allowDuplicate) form.append("allowDuplicate", "true");
      if (uploadSubtitle !== undefined) {
        form.append("subtitleLanguage", effectiveSubtitleLanguage);
        const options = subtitleOptions();
        if (options !== undefined) form.append("subtitleOptions", JSON.stringify(options));
        form.append("subtitle", uploadSubtitle, uploadSubtitle.name);
      }
      form.append("file", uploadFile, uploadFile.name);
      const response = await api.upload("/api/contents/upload", form, importResponseSchema, { idempotent: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.unfinishedTasks,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
      finishImport(
        response,
        await routeAfterImport({
          api,
          response,
          urls: [],
          collection: undefined,
        }),
      );
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

  const localInitialSubtitle = (file: PickedFile): NonNullable<LocalFileRequest["initialSubtitle"]> => {
    const options = subtitleOptions();
    return {
      path: file.path,
      grant: file.grant,
      language: effectiveSubtitleLanguage,
      ...(options === undefined ? {} : { options }),
    };
  };

  const localImport = useMutation({
    mutationFn: async (options: { allowDuplicate: boolean }): Promise<void> => {
      if (localFile === undefined) return;
      const body: LocalFileRequest = {
        path: localFile.path,
        grant: localFile.grant,
        settings: {
          templateId,
          outputLanguage,
          autoProofread,
          ...(modelRef === undefined ? {} : { modelRef }),
          ...asrSetting,
        },
        allowDuplicate: options.allowDuplicate,
        ...(localSubtitle === undefined ? {} : { initialSubtitle: localInitialSubtitle(localSubtitle) }),
      };
      const response = await api.post("/api/contents/local-file", importResponseSchema, { body, idempotent: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.unfinishedTasks,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
      finishImport(
        response,
        await routeAfterImport({
          api,
          response,
          urls: [],
          collection: undefined,
        }),
      );
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

  /** Opens the preview of the collection links in the box; its 「开始处理」 is a new confirmation. */
  const openPreview = (startUrl?: string, links: readonly string[] = previewUrls): void => {
    setConfirmed(undefined);
    setError(undefined);
    setRelated(undefined);
    preview.open(links, startUrl);
  };

  /**
   * 「选择合集中的视频」: the preview of the collection the box's video belongs to, with that video
   * alone chosen to start with. Cancelling sends nothing; without confirming, the video goes alone.
   */
  const openRelated = (collection: RelatedCollection, answer: InspectResponse): void => {
    if (checkUrl === undefined) return;
    setConfirmed(undefined);
    setError(undefined);
    setRelated({ videoUrl: checkUrl, collectionUrl: collection.canonicalUrl });
    preview.open([collection.canonicalUrl], undefined, {
      [collection.canonicalUrl]: { canonicalUrl: answer.canonicalUrl, ...(collection.index === undefined ? {} : { index: collection.index - 1 }) },
    });
  };

  /** Tells once what became of the stored source links the import offered to replace, and drops their stale details. */
  const reportSourceUrlUpdates = (response: ImportResponse): void => {
    const updates = response.sourceUrlUpdates ?? [];
    for (const update of updates) void queryClient.invalidateQueries({ queryKey: queryKeys.content(update.contentId) });
    for (const result of ["updated", "kept"] as const) {
      if (updates.some((update) => update.result === result)) {
        toast.show({ tone: result === "updated" ? "success" : "info", message: t(`shell.newPage.sourceUrlUpdate.${result}`) });
      }
    }
  };

  /** Sends the links (or the subtitle tab's one), with the entries chosen in the preview. */
  const submit = useMutation({
    mutationFn: async ({ choices, related: pick }: LinkSubmit): Promise<void> => {
      const collection = collectionTarget();
      const unverifiedChoice = (url: string): Pick<ImportItem, "acceptUnverified"> => (acceptedUnverified.current.has(url) ? { acceptUnverified: true } : {});
      // The video chosen from its collection is sent as that collection, so it appears once, as an entry.
      const sentUrls = pick === undefined ? urls : urls.map((url) => (url === pick.videoUrl ? pick.collectionUrl : url));
      const previewed = new Set(pick === undefined ? previewUrls : [...previewUrls, pick.collectionUrl]);
      let items: ImportItem[];
      if (tab === "subtitle" && subtitle !== undefined) {
        // The previewed text itself, so the digest the options carry is of what is sent.
        const subtitleText = previewState.status === "ready" && previewState.text !== undefined ? previewState.text : await subtitle.text();
        const previewed = subtitlePreview?.format;
        const format = previewed !== undefined && previewed !== "txt" && previewed !== "md" ? previewed : subtitleFormat(subtitle.name);
        const options = subtitleOptions();
        items = [
          {
            url: urls[0] ?? "",
            ...unverifiedChoice(urls[0] ?? ""),
            initialSubtitle: {
              text: subtitleText,
              language: effectiveSubtitleLanguage,
              ...(format === undefined ? {} : { format }),
              ...(options === undefined ? {} : { options }),
            },
          },
        ];
      } else {
        items = itemsWithChoices(sentUrls, previewed, choices, (url) => ({
          url,
          ...(partChoices[url] === undefined ? {} : { parts: partChoices[url] }),
          ...unverifiedChoice(url),
        }));
      }
      const body: ImportRequest = {
        items,
        settings: {
          templateId,
          outputLanguage,
          autoProofread,
          ...(modelRef === undefined ? {} : { modelRef }),
          ...asrSetting,
        },
        ...(collection === undefined ? {} : { collection }),
        confirmCollections: true,
      };
      intent.current = importIntent(intent.current, body);
      try {
        const response = await api.post("/api/contents/import", importResponseSchema, { body: intent.current.body, idempotencyKey: intent.current.key });
        intent.current = undefined;
        // The page may stay (some items skipped): the links imported are read afresh next time,
        // and the next 「开始处理」 asks again instead of resending this choice.
        preview.close();
        preview.reset([...previewed]);
        setConfirmed(undefined);
        setRelated(undefined);
        setUnverified(undefined);
        reportSourceUrlUpdates(response);
        void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.collections });
        // A direct link to a trashed Content restores it, back into its collections.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.collectionDetails,
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.unfinishedTasks,
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
        finishImport(
          response,
          await routeAfterImport({
            api,
            response,
            urls: sentUrls,
            collection,
            collectionImport: items.some((item) => item.entries !== undefined),
          }),
        );
      } catch (caught) {
        if (!outcomeUnknown(caught)) intent.current = undefined;
        if (caught instanceof ApiError && caught.error.code === "invalid_request.multipart_choice_required") {
          preview.close();
          const prompts = await inspectParts(
            api,
            items.filter((item) => item.parts === undefined && item.entries === undefined).map((item) => item.url),
          );
          if (prompts.length > 0) {
            setPartPrompts(prompts);
            return;
          }
        }
        if (caught instanceof ApiError && caught.error.code === "invalid_request.collection_choice_required") {
          const asked = choiceRequiredUrls(caught.error).filter((url) => urls.includes(url));
          if (asked.length > 0) {
            const extra = [...new Set([...extraPreviewUrls, ...asked])];
            setExtraPreviewUrls(extra);
            openPreview(
              asked[0],
              linkUrls.filter((url) => recognizeLink(url)?.kind === "collection" || extra.includes(url)),
            );
            return;
          }
        }
        if (caught instanceof ApiError && caught.error.code === "conflict.collection_preview_stale" && pick !== undefined) {
          // The collection changed under the preview opened from the video: read it again the same way.
          preview.open([pick.collectionUrl]);
          preview.reread();
          setError(caught.error);
          return;
        }
        if (caught instanceof ApiError && caught.error.code === "conflict.collection_preview_stale" && previewUrls.length > 0) {
          // The collection changed under the preview: read it again, keeping what is still there.
          openPreview(preview.urls[preview.step]);
          preview.reread();
          setError(caught.error);
          return;
        }
        if (caught instanceof ApiError && caught.error.code === "invalid_request.link_unverified") {
          // Nothing was created: offer to import these links anyway, as a new confirmation.
          const asked = choiceRequiredUrls(caught.error).filter((url) => sentUrls.includes(url));
          preview.close();
          setUnverified({ urls: asked.length > 0 ? asked : sentUrls, send: { choices, ...(pick === undefined ? {} : { related: pick }) } });
          return;
        }
        if (caught instanceof ApiError && REJECTED_LINK_CODES.has(caught.error.code)) {
          // An image post or an expired link: what was pasted is the problem, said under its box.
          preview.close();
          const reason = caught.error.code === "invalid_request.not_video" ? "not_video" : "link_expired";
          fail(tab === "subtitle" ? "subtitleUrl" : "links", caught.error.userMessage !== "" ? caught.error.userMessage : t(`shell.newPage.check.${reason}`));
          if (tab !== "subtitle") setRefusedText(text);
          return;
        }
        if (caught instanceof ApiError && caught.error.code === "source_unsupported_url" && !preview.isOpen) {
          // A link the server cannot take is a problem with what was typed: say so under the box.
          fail("links", caught.error.userMessage !== "" ? caught.error.userMessage : t(`errors.${caught.error.class}`));
          return;
        }
        throw caught;
      }
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.error : undefined),
  });

  /** The link and subtitle tabs' checks before anything is sent; the message goes under its field. */
  const linkProblem = (): Problem | undefined => {
    if (tab === "subtitle" && subtitleParsed.all.length > 1)
      return {
        field: "subtitleUrl",
        message: t("shell.newPage.subtitleOneLink"),
      };
    if (urls.length === 0)
      return {
        field: tab === "subtitle" ? "subtitleUrl" : "links",
        message: t("shell.newPage.needUrl"),
      };
    if (tab === "subtitle" && (subtitle === undefined || effectiveSubtitleLanguage === "")) {
      return {
        field: subtitle === undefined ? "subtitleFile" : "subtitleLanguage",
        message: t("shell.newPage.needSubtitle"),
      };
    }
    if (tab === "subtitle") {
      const blocked = subtitleProblem();
      if (blocked !== undefined) return { field: "subtitlePreview", message: blocked };
    }
    if (collectionChoice === NEW_COLLECTION && newCollectionName.trim() === "")
      return {
        field: "collectionName",
        message: t("shell.newPage.needCollectionName"),
      };
    return undefined;
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setError(undefined);
    setProblem(undefined);
    setSkipped(undefined);
    setUnverified(undefined);
    if (windowMissing) return;
    if (tab === "upload") {
      if (uploadFile === undefined) return fail("uploadFile", t("shell.newPage.needFile"));
      if (uploadSubtitle !== undefined && effectiveSubtitleLanguage === "") return fail("subtitleLanguage", t("shell.newPage.needSubtitleLanguage"));
      const blocked = subtitleProblem();
      if (blocked !== undefined) return fail("subtitlePreview", blocked);
      upload.mutate({ allowDuplicate: false });
      return;
    }
    if (tab === "local") {
      if (localFile === undefined) return fail("localFile", t("shell.newPage.needLocalFile"));
      if (localSubtitle !== undefined && effectiveSubtitleLanguage === "") return fail("subtitleLanguage", t("shell.newPage.needSubtitleLanguage"));
      if (expired(localFile) || (localSubtitle !== undefined && expired(localSubtitle))) {
        setLocalFile(undefined);
        setLocalSubtitle(undefined);
        return fail("localFile", t("shell.newPage.pickAgain"));
      }
      const blocked = subtitleProblem();
      if (blocked !== undefined) return fail("subtitlePreview", blocked);
      localImport.mutate({ allowDuplicate: false });
      return;
    }
    const found = linkProblem();
    if (found !== undefined) return fail(found.field, found.message);
    if (previewUrls.length > 0) {
      // Chosen in the preview already (the import then asked about parts): sent as chosen.
      if (confirmed !== undefined && previewUrls.every((url) => confirmed.urls.includes(url))) {
        submit.mutate({ choices: confirmed.choices });
        return;
      }
      openPreview();
      return;
    }
    // Sent from the form, the box's video goes alone even after its collection was previewed.
    submit.mutate({ choices: [] });
  };

  /** 「仍然导入」: the same send again, these links marked as chosen without verification; a new body, so a new key. */
  const importUnverified = (): void => {
    if (unverified === undefined) return;
    for (const url of shownUnverified) acceptedUnverified.current.add(url);
    const send = unverified.send;
    setUnverified(undefined);
    setError(undefined);
    setProblem(undefined);
    submit.mutate(send);
  };

  /** The preview's 「开始处理」: checks the form, then sends with the choice. */
  const onPreviewConfirm = (choices: CollectionChoice[]): void => {
    const pick = related !== undefined && preview.urls.includes(related.collectionUrl) && urls.includes(related.videoUrl) ? related : undefined;
    if (pick === undefined) setConfirmed({ urls: previewUrls, choices });
    setError(undefined);
    setProblem(undefined);
    setSkipped(undefined);
    setUnverified(undefined);
    const found = linkProblem();
    // What is held back lives on the form: show it there; the choice is kept for the next submit.
    if (found !== undefined || windowMissing) {
      preview.close();
      if (found !== undefined) fail(found.field, found.message);
      return;
    }
    submit.mutate({ choices, ...(pick === undefined ? {} : { related: pick }) });
  };

  const onSubtitleFile = (file: File | undefined): void => {
    setSubtitle(file);
    if (file === undefined) subtitleRemoved();
  };

  const languageSelect = (id: string, testId: string | undefined) => (
    <NativeSelect
      id={id}
      data-testid={testId}
      value={subtitleLanguage}
      onChange={(event) => setSubtitleLanguage(event.target.value)}
      invalid={invalid("subtitleLanguage")}
      aria-describedby={describedBy("subtitleLanguage")}
    >
      <option value="">{t("shell.newPage.chooseLanguage")}</option>
      {Object.keys(languageNames).map((tag) => (
        <option key={tag} value={tag}>
          {languageLabel(tag)}
        </option>
      ))}
    </NativeSelect>
  );

  /** Under an attached subtitle: its preview, its language unless a package names it, and 「自动校对」 with why it starts off. */
  const subtitleDetails = (languageId: string, languageTestId: string) => (
    <>
      <div className={`${FORM_SECOND} ${FORM_CELL}`}>
        <SubtitleImportPreview
          state={previewState}
          choice={subtitleChoice}
          onChoice={setSubtitleChoice}
          onRefresh={previewState.refresh}
          originalLanguage={effectiveSubtitleLanguage}
        />
        {fieldError("subtitlePreview")}
      </div>
      {packageLanguage === undefined ? (
        <>
          <label htmlFor={languageId} className={FORM_LABEL}>
            {t("shell.newPage.subtitleLanguage")}
          </label>
          <div className={FORM_CELL}>
            {languageSelect(languageId, languageTestId)}
            {fieldError("subtitleLanguage")}
          </div>
        </>
      ) : null}
      <div className={`${FORM_SECOND} ${FORM_CELL}`} data-testid="subtitle-auto-proofread">
        <Checkbox checked={autoProofread} onChange={(event) => setAutoProofreadChoice(event.target.checked)} aria-describedby={`${formId}-proofread-note`}>
          {t("shell.newPage.autoProofread")}
        </Checkbox>
        <FieldHint id={`${formId}-proofread-note`}>{t("subtitleImport.newPage.autoProofreadNote")}</FieldHint>
      </div>
    </>
  );

  const collectionOptions: Array<SelectOption<string>> = [
    {
      value: NO_COLLECTION,
      label: t("shell.newPage.collectionNone"),
      dividerAfter: true,
    },
    ...(collections.data?.items ?? []).map((collection, index, all) => ({
      value: collection.id,
      label: collection.name,
      ...(index === all.length - 1 ? { dividerAfter: true } : {}),
    })),
    { value: NEW_COLLECTION, label: t("shell.newPage.collectionNew") },
  ];
  const linkPending = submit.isPending;
  // The rest of the recognition line: what checking the link found, then the login hint.
  const recognitionExtras = [
    // Once the import itself refused the link, the field error says it; the check would say it twice.
    ...(importCheckShown(check) && refusedText === undefined ? [<ImportCheckNote key="check" check={check} onChooseFromCollection={openRelated} />] : []),
    ...(loginHint === undefined ? [] : [<SubtitleLoginNote key="login" state={loginHint} />]),
  ];
  // Under the box: the links the import could not verify, and the choice to import them anyway.
  const unverifiedPrompt =
    shownUnverified.length === 0 ? null : (
      <InlineNote
        role="status"
        testId="new-unverified"
        icon={<CircleAlert size={14} className="text-warn" aria-hidden="true" />}
        action={
          <TextAction onClick={importUnverified} disabled={linkPending || windowMissing} data-testid="new-import-unverified">
            {t("shell.newPage.importAnyway")}
          </TextAction>
        }
      >
        {shownUnverified.length === 1 ? t("shell.newPage.unverified") : t("shell.newPage.unverifiedMany", { count: shownUnverified.length })}
      </InlineNote>
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("shell.newPage.title")} actions={<ImportPackButton testId="new-pack-import" />} />
      <PackActiveNotice className="mx-auto mt-4 w-[calc(100%-3rem)] max-w-2xl" />
      <form onSubmit={onSubmit} className="@container mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8">
        {noLlm ? (
          <Callout
            tone="info"
            testId="no-llm-banner"
            actions={
              <Link to="/settings/models" className={`text-sm font-medium ${TEXT_ACTION_CLASS}`}>
                {t("shell.newPage.configureNow")}
              </Link>
            }
          >
            {t("shell.newPage.noLlmBanner")}
          </Callout>
        ) : null}
        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <Tabs.List className="flex gap-1 border-b border-line">
            <TabTrigger value="link" label={t("shell.newPage.tabLink")} />
            {server ? <TabTrigger value="upload" label={t("shell.newPage.tabUpload")} /> : <TabTrigger value="local" label={t("shell.newPage.tabLocal")} disabled={!desktop} />}
            <TabTrigger value="subtitle" label={t("shell.newPage.tabSubtitle")} />
          </Tabs.List>
          {server || desktop ? null : <InlineNote className="mt-2">{t("shell.newPage.localUnavailable")}</InlineNote>}
          <Tabs.Content value="link" className="mt-3 flex flex-col gap-1.5">
            <TextArea
              data-testid="new-url-input"
              aria-label={t("shell.newPage.tabLink")}
              ref={linkField.ref}
              value={text}
              onChange={(event) => linkField.onChange(event.target.value)}
              onPaste={linkField.onPaste}
              placeholder={t("shell.newPage.urlPlaceholder")}
              rows={6}
              invalid={invalid("links")}
              aria-describedby={describedBy("links", recognitionId, recognitionExtras.length === 0 ? undefined : `${recognitionId}-more`)}
              className="w-full font-mono"
            />
            {fieldError("links")}
            {unverifiedPrompt}
            <LinkRecognition
              parsed={parsed}
              pasted={linkField.note}
              id={recognitionId}
              onPreview={() => openPreview()}
              reserve={checkUrl !== undefined}
              extras={recognitionExtras}
            />
          </Tabs.Content>
          {server ? (
            <Tabs.Content value="upload" className={FORM_GRID}>
              <span id={`${formId}-upload-file`} className={FORM_LABEL}>
                {t("shell.newPage.uploadFile")}
              </span>
              <div className={FORM_CELL}>
                <FilePicker testId="upload-file" accept="audio/*,video/*" fileName={uploadFile?.name} onFile={setUploadFile} labelledBy={`${formId}-upload-file`} />
                <FieldHint id={`${formId}-upload-hint`}>{t("shell.newPage.uploadHint")}</FieldHint>
                {fieldError("uploadFile")}
              </div>
              <span id={`${formId}-upload-subtitle`} className={FORM_LABEL}>
                {t("shell.newPage.uploadSubtitle")}
              </span>
              <div className={FORM_CELL}>
                <div className="flex min-w-0 items-center gap-3">
                  <FilePicker
                    key={uploadSubtitleRound}
                    testId="upload-subtitle"
                    accept={SUBTITLE_ACCEPT}
                    fileName={uploadSubtitle?.name}
                    onFile={(file) => {
                      setUploadSubtitle(file);
                      if (file === undefined) subtitleRemoved();
                    }}
                    labelledBy={`${formId}-upload-subtitle`}
                  />
                  {uploadSubtitle === undefined ? null : (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setUploadSubtitle(undefined);
                        setUploadSubtitleRound(uploadSubtitleRound + 1);
                        subtitleRemoved();
                      }}
                      data-testid="upload-remove-subtitle"
                    >
                      {t("shell.newPage.removeSubtitle")}
                    </Button>
                  )}
                </div>
                <FieldHint id={`${formId}-upload-subtitle-hint`}>{t("subtitleImport.newPage.fileHint")}</FieldHint>
              </div>
              {uploadSubtitle === undefined ? null : subtitleDetails(`${formId}-upload-language`, "upload-subtitle-language")}
            </Tabs.Content>
          ) : null}
          {desktop ? (
            <Tabs.Content value="local" className={FORM_GRID}>
              <span className={FORM_LABEL}>{t("shell.newPage.uploadFile")}</span>
              <div className={FORM_CELL}>
                <div className="flex min-w-0 items-center gap-3">
                  <Button disabled={pick.isPending} onClick={() => pick.mutate("media")} data-testid="local-pick">
                    {t("shell.newPage.pickFile")}
                  </Button>
                  <span className="min-w-0 truncate text-sm" data-testid="local-file-name" title={localFile?.path}>
                    {localFile === undefined ? t("shell.newPage.noFilePicked") : baseName(localFile.path)}
                  </span>
                </div>
                <FieldHint id={`${formId}-local-hint`}>{t("shell.newPage.localHint")}</FieldHint>
                {fieldError("localFile")}
              </div>
              <span className={FORM_LABEL}>{t("shell.newPage.uploadSubtitle")}</span>
              <div className={FORM_CELL}>
                <div className="flex min-w-0 items-center gap-3">
                  <Button disabled={pick.isPending} onClick={() => pick.mutate("subtitle")} data-testid="local-pick-subtitle">
                    {t("shell.newPage.pickSubtitle")}
                  </Button>
                  {localSubtitle === undefined ? null : (
                    <>
                      <span className="min-w-0 truncate text-sm" data-testid="local-subtitle-name" title={localSubtitle.path}>
                        {baseName(localSubtitle.path)}
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setLocalSubtitle(undefined);
                          subtitleRemoved();
                        }}
                      >
                        {t("shell.newPage.removeSubtitle")}
                      </Button>
                    </>
                  )}
                </div>
                <FieldHint id={`${formId}-local-subtitle-hint`}>{t("subtitleImport.newPage.fileHint")}</FieldHint>
              </div>
              {localSubtitle === undefined ? null : subtitleDetails(`${formId}-local-language`, "local-subtitle-language")}
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
            <div className={FORM_CELL}>
              <TextInput
                id={`${formId}-subtitle-url`}
                ref={subtitleField.ref}
                value={subtitleUrl}
                onChange={(event) => subtitleField.onChange(event.target.value)}
                onPaste={subtitleField.onPaste}
                placeholder={t("shell.newPage.subtitleUrlPlaceholder")}
                invalid={invalid("subtitleUrl")}
                aria-describedby={describedBy("subtitleUrl", subtitleField.note === undefined ? undefined : `${formId}-subtitle-paste-note`)}
              />
              {fieldError("subtitleUrl")}
              {tab === "subtitle" ? unverifiedPrompt : null}
              {subtitleField.note === undefined ? null : (
                <FieldHint id={`${formId}-subtitle-paste-note`} testId="subtitle-paste-note">
                  {t("shell.newPage.pasteNote", { count: subtitleField.note })}
                </FieldHint>
              )}
            </div>
            <span id={`${formId}-subtitle-file`} className={FORM_LABEL}>
              {t("shell.newPage.subtitleFile")}
            </span>
            <div className={FORM_CELL}>
              <FilePicker testId="subtitle-file" accept={SUBTITLE_ACCEPT} fileName={subtitle?.name} onFile={onSubtitleFile} labelledBy={`${formId}-subtitle-file`} />
              <FieldHint id={`${formId}-subtitle-file-hint`}>{t("subtitleImport.newPage.fileHint")}</FieldHint>
              {fieldError("subtitleFile")}
            </div>
            {subtitle === undefined ? (
              <>
                <label htmlFor={`${formId}-subtitle-language`} className={FORM_LABEL}>
                  {t("shell.newPage.subtitleLanguage")}
                </label>
                <div className={FORM_CELL}>
                  {languageSelect(`${formId}-subtitle-language`, undefined)}
                  {fieldError("subtitleLanguage")}
                </div>
              </>
            ) : (
              subtitleDetails(`${formId}-subtitle-language`, "subtitle-language")
            )}
          </Tabs.Content>
        </Tabs.Root>

        {shownPartPrompts.length === 0 ? null : (
          <Callout tone="info" title={t("shell.newPage.partsTitle")} testId="parts-choice">
            <div className="flex flex-col gap-3">
              {shownPartPrompts.map((prompt) => (
                <fieldset key={prompt.url} className="flex min-w-0 flex-col gap-1.5">
                  <legend className="mb-1.5 max-w-full truncate text-note text-muted">{prompt.title ?? prompt.url}</legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                    <Radio
                      name={prompt.url}
                      checked={partChoices[prompt.url] === "first"}
                      onChange={() =>
                        setPartChoices({
                          ...partChoices,
                          [prompt.url]: "first",
                        })
                      }
                    >
                      {t("shell.newPage.partsFirst")}
                    </Radio>
                    <Radio name={prompt.url} checked={partChoices[prompt.url] === "all"} onChange={() => setPartChoices({ ...partChoices, [prompt.url]: "all" })}>
                      {t("shell.newPage.partsAll", { count: prompt.count })}
                    </Radio>
                  </div>
                </fieldset>
              ))}
              <p className="text-note text-muted">{t("shell.newPage.partsHint")}</p>
            </div>
          </Callout>
        )}

        <section className="rounded-md border border-line">
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            aria-expanded={showSettings}
            className={`flex w-full items-center gap-1 rounded-md px-3 py-2 text-sm font-medium ${FOCUS_RING}`}
          >
            {showSettings ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            {t("shell.newPage.settings")}
          </button>
          {showSettings ? (
            <div className="grid grid-cols-1 gap-x-4 gap-y-5 border-t border-line p-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5 text-sm">
                <label htmlFor={`${formId}-template`}>{t("shell.newPage.template")}</label>
                <Select
                  id={`${formId}-template`}
                  value={templateId}
                  options={(templates.data?.items ?? []).map((template) => ({
                    value: template.id,
                    label: templateLabel(template),
                  }))}
                  onChange={setTemplateChoice}
                  placeholder={t("common.state.loading")}
                  testId="new-template"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5 text-sm">
                <label htmlFor={`${formId}-model`}>{t("shell.newPage.model")}</label>
                <ModelSelect
                  kind="llm"
                  id={`${formId}-model`}
                  entries={modelOptions}
                  value={model}
                  onChange={setModelChoice}
                  noneLabel={t("shell.newPage.noModel")}
                  testId="new-model"
                  size="lg"
                  width="fill"
                />
              </div>
              {asrOptions.length === 0 ? null : (
                <div className="flex min-w-0 flex-col gap-1.5 text-sm">
                  <label htmlFor={`${formId}-asr-model`}>{t("shell.newPage.asrModel")}</label>
                  <AsrModelSelect
                    id={`${formId}-asr-model`}
                    profiles={asrOptions}
                    value={asrModelRef}
                    onChange={(ref) => setAsrChoice(ref ?? null)}
                    label={t("shell.newPage.asrModel")}
                    noneLabel={t("shell.newPage.noAsrModel")}
                    testId="new-asr-model"
                    size="lg"
                    width="fill"
                  />
                  {diarizationNote === undefined ? null : (
                    <FieldHint id={`${formId}-diarization-note`} testId="new-diarization-note">
                      {t(`speakerTools.note.${diarizationNote}`)}
                    </FieldHint>
                  )}
                </div>
              )}
              <div className="flex min-w-0 flex-col gap-1.5 text-sm">
                <label htmlFor={`${formId}-language`}>{t("shell.newPage.outputLanguage")}</label>
                <Select
                  id={`${formId}-language`}
                  value={outputLanguage}
                  options={languageOptions.map((tag) => ({
                    value: tag,
                    label: languageLabel(tag),
                  }))}
                  onChange={setLanguageChoice}
                  placeholder={languageLabel(outputLanguage)}
                  testId="new-output-language"
                />
              </div>
              {tab === "upload" || tab === "local" ? null : (
                <div className="flex min-w-0 flex-col gap-1.5 text-sm">
                  <label htmlFor={`${formId}-collection`}>{t("shell.newPage.collection")}</label>
                  <Select
                    id={`${formId}-collection`}
                    value={collectionChoice === "" ? NO_COLLECTION : collectionChoice}
                    options={collectionOptions}
                    onChange={(value) => setCollectionChoice(value === NO_COLLECTION ? "" : value)}
                    placeholder={t("shell.newPage.collectionNone")}
                    testId="new-collection"
                  />
                </div>
              )}
              {tab !== "upload" && tab !== "local" && collectionChoice === NEW_COLLECTION ? (
                <div className="flex min-w-0 flex-col gap-1.5 text-sm sm:col-span-2">
                  <label htmlFor={`${formId}-collection-name`}>{t("shell.newPage.collectionNewName")}</label>
                  <TextInput
                    id={`${formId}-collection-name`}
                    value={newCollectionName}
                    onChange={(event) => setNewCollectionName(event.target.value)}
                    invalid={invalid("collectionName")}
                    aria-describedby={describedBy("collectionName")}
                  />
                  {fieldError("collectionName")}
                </div>
              ) : null}
              {/* With a subtitle attached the checkbox sits under it instead, with why it starts off. */}
              {hasSubtitle ? null : (
                <div className="sm:col-span-2">
                  <Checkbox checked={autoProofread} onChange={(event) => setAutoProofreadChoice(event.target.checked)}>
                    {t("shell.newPage.autoProofread")}
                  </Checkbox>
                </div>
              )}
            </div>
          ) : null}
        </section>

        {skipped === undefined ? null : (
          <Callout
            tone="warn"
            announce="status"
            testId="new-skipped-trashed"
            actions={
              <>
                <Link to="/trash" className={`text-sm font-medium ${TEXT_ACTION_CLASS}`}>
                  {t("shell.newPage.openTrash")}
                </Link>
                {skipped.next === undefined ? null : (
                  <Link
                    to={skipped.next.path}
                    className={`text-sm font-medium ${TEXT_ACTION_CLASS}`}
                    onClick={() => {
                      if (skipped.next?.openTasks === true) requestOpenTasks();
                    }}
                  >
                    {t("shell.newPage.viewImported")}
                  </Link>
                )}
              </>
            }
          >
            {t("shell.newPage.skippedTrashed", { count: skipped.count })}
          </Callout>
        )}
        {error === undefined || preview.isOpen ? null : (
          <ErrorView error={error}>
            {error.code === "conflict.duplicate_file" && (tab === "upload" || tab === "local") ? (
              <>
                {error.details?.["trashed"] === true ? (
                  <p data-testid="new-duplicate-in-trash" className="w-full text-sm">
                    {t("shell.newPage.duplicateInTrash")}{" "}
                    <Link to="/trash" className={`font-medium ${TEXT_ACTION_CLASS}`}>
                      {t("shell.newPage.openTrash")}
                    </Link>
                  </p>
                ) : null}
                {tab === "upload" ? (
                  <Button
                    size="sm"
                    data-testid="upload-anyway"
                    disabled={upload.isPending || windowMissing}
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
                    disabled={localImport.isPending || windowMissing}
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
        {windowMissing && modelRef !== undefined ? <ContextWindowNotice modelRef={modelRef} onSaved={windowSaved} testId="new-context-window" /> : null}
        <div className="flex items-center justify-end gap-3">
          {/* An upload can take long, so which step is under way is said beside the button, whose label stays. */}
          {upload.isPending || linkPending || localImport.isPending ? (
            <span role="status" className="text-xs text-muted" data-testid="new-submit-status">
              {upload.isPending ? t("shell.newPage.uploading") : t("shell.newPage.submitting")}
            </span>
          ) : null}
          <Button
            id={submitId}
            type="submit"
            variant="primary"
            data-testid="new-submit"
            loading={linkPending || upload.isPending || localImport.isPending}
            disabled={windowMissing}
          >
            {t("shell.newPage.submit")}
          </Button>
        </div>
      </form>
      <CollectionPreviewDialog
        preview={preview}
        onConfirm={onPreviewConfirm}
        submitting={linkPending}
        error={preview.isOpen ? error : undefined}
        reserved={reserved}
      />
    </div>
  );
}

function TabTrigger(props: { value: Tab; label: string; disabled?: boolean }) {
  return (
    <Tabs.Trigger
      value={props.value}
      disabled={props.disabled === true}
      className={`-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[state=active]:border-accent data-[state=active]:text-ink ${FOCUS_RING}`}
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
        return {
          url,
          count: inspected.parts?.length ?? 0,
          ...(inspected.title === undefined ? {} : { title: inspected.title }),
        };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((prompt): prompt is PartPrompt => prompt !== undefined);
}
