import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaAssetDto, TranscriptRevisionDto } from "../../../shared/dto/content.ts";
import type { BurnRequest } from "../../../shared/dto/media.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import {
  BURN_MODES,
  SUBTITLE_DELIVERIES,
  type BurnMode,
  type SubtitleDelivery,
  type SubtitleVideoContainer,
} from "../../../shared/enums.ts";
import type { AppError } from "../../../shared/errors.ts";
import type { SubtitleStyle } from "../../../shared/subtitle-style.ts";
import { formatBytes } from "../../../shared/units.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useMe } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { burnFileName, burnOutputsKey, fetchBurnOutputs, saveBurnProduct } from "../../desktop/burn-outputs.ts";
import { useSubtitlePrefs, type SubtitleTrackPref } from "../../player/subtitle-prefs.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { useContentPage } from "./content-context.tsx";
import { contentKeys, visibleRevisions } from "./content-data.ts";
import { useAutoDismiss } from "../../use-auto-dismiss.ts";
import { cacheHeight, compareCacheQuality, qualityLabel } from "../../player/media-url.ts";
import { revisionLabel } from "./labels.ts";
import { TrackedTask } from "./tracked-task.tsx";

/** Soft-subtitle containers in the order the dialog offers them; MKV keeps the style, so it leads. */
const SOFT_CONTAINERS: readonly SubtitleVideoContainer[] = ["mkv", "mp4"];

/** The container a hard-subtitle export always produces. */
const HARD_CONTAINER: SubtitleVideoContainer = "mp4";

const ORIGINAL_MEDIA_KINDS: ReadonlySet<MediaAssetDto["kind"]> = new Set(["external_local", "managed_upload"]);

/**
 * What an export of the selected subtitle version can use: a translation is exported over
 * its parent, any other version is the original; the translations are those of the original.
 */
export function burnSources(selected: TranscriptRevisionDto, all: readonly TranscriptRevisionDto[]): { original: TranscriptRevisionDto; translations: TranscriptRevisionDto[] } {
  const parent = selected.kind === "translated" && selected.parentRevisionId !== undefined ? all.find((item) => item.id === selected.parentRevisionId) : undefined;
  const original = parent ?? selected;
  return { original, translations: translationsOf(original, all) };
}

function translationsOf(original: TranscriptRevisionDto, all: readonly TranscriptRevisionDto[]): TranscriptRevisionDto[] {
  return all.filter((item) => item.kind === "translated" && item.parentRevisionId === original.id);
}

/**
 * The dialog's starting choice. While the local player shows subtitles, the export starts
 * from exactly what is on screen: its mode, its original (absent = the primary) and its
 * translation (absent = the first of that original). Otherwise it starts from the version
 * open in the subtitles tab.
 */
export function burnDefaults(
  selected: TranscriptRevisionDto,
  all: readonly TranscriptRevisionDto[],
  primaryId: string | undefined,
  track: SubtitleTrackPref,
): { originalId: string; mode: BurnMode; translationId: string | undefined } {
  if (track.mode !== "off") {
    const wanted = track.revisionId ?? primaryId;
    const original = all.find((item) => item.id === wanted && item.kind !== "translated");
    if (original !== undefined) {
      const translations = translationsOf(original, all);
      const translationId = (translations.find((item) => item.id === track.translationRevisionId) ?? translations[0])?.id;
      return { originalId: original.id, mode: translationId === undefined ? "original" : track.mode, translationId };
    }
  }
  const { original, translations } = burnSources(selected, all);
  const fromSelected = selected.kind === "translated" ? translations.find((item) => item.id === selected.id) : undefined;
  return {
    originalId: original.id,
    mode: fromSelected === undefined ? "original" : "bilingual",
    translationId: (fromSelected ?? translations[0])?.id,
  };
}

/** How the subtitles go into the video; a hard-subtitle export is always MP4. */
export interface BurnOutputChoice {
  delivery: SubtitleDelivery;
  container: SubtitleVideoContainer;
  style: SubtitleStyle;
}

/**
 * The `POST /burn` body for a choice. The dialog always sends the full output choice, so
 * every export it starts freezes its source video and style; `sourceAssetId` names the
 * source video the user picked. Translation modes need a translation of the original.
 */
export function burnRequest(
  original: TranscriptRevisionDto,
  mode: BurnMode,
  translationId: string | undefined,
  output: BurnOutputChoice,
  sourceAssetId?: string,
): BurnRequest | undefined {
  const choice = {
    delivery: output.delivery,
    container: output.delivery === "hard" ? HARD_CONTAINER : output.container,
    style: output.style,
    ...(sourceAssetId === undefined ? {} : { sourceAssetId }),
  };
  if (mode === "original") return { revisionId: original.id, mode, ...choice };
  return translationId === undefined ? undefined : { revisionId: original.id, translationRevisionId: translationId, mode, ...choice };
}

/** A video the export can be made from. */
export interface BurnVideoSource {
  asset: MediaAssetDto;
  kind: "original" | "cache";
}

/**
 * Every video an export can use: the latest available original file, then each available
 * video cache, highest quality first (the newest first within one quality). An audio cache
 * has no picture.
 */
export function burnSourceVideos(media: readonly MediaAssetDto[]): BurnVideoSource[] {
  const available = media.filter((item) => item.availability === "available");
  const original = available
    .filter((item) => ORIGINAL_MEDIA_KINDS.has(item.kind))
    .reduce<MediaAssetDto | undefined>((best, item) => (best === undefined || item.createdAt >= best.createdAt ? item : best), undefined);
  const caches = available.filter((item) => item.kind === "platform_cache" && item.mimeType.startsWith("video/")).sort(compareCacheQuality);
  return [...(original === undefined ? [] : [{ asset: original, kind: "original" as const }]), ...caches.map((asset) => ({ asset, kind: "cache" as const }))];
}

/**
 * The video the server exports over when none is named, by its own rule: the latest
 * available original file, else the highest-quality video cache.
 */
export function burnSourceVideo(media: readonly MediaAssetDto[]): BurnVideoSource | undefined {
  return burnSourceVideos(media)[0];
}

/** The export's starting source: the video cache the player shows, else the server's own pick. */
export function defaultBurnSource(sources: readonly BurnVideoSource[], playingAssetId: string | undefined): BurnVideoSource | undefined {
  return sources.find((source) => source.asset.id === playingAssetId) ?? sources[0];
}

/** Common video MIME types whose subtype does not read as a format name. */
const MIME_FORMATS: Readonly<Record<string, string>> = {
  "video/x-matroska": "MKV",
  "video/quicktime": "MOV",
  "video/x-msvideo": "AVI",
  "video/x-flv": "FLV",
  "video/mp2t": "TS",
};

/** A video's format as the user knows it: its file extension, else a name for its MIME type. */
export function videoFormat(asset: Pick<MediaAssetDto, "displayName" | "localPath" | "mimeType">): string {
  for (const name of [asset.displayName, asset.localPath]) {
    const match = name === undefined ? null : /\.([A-Za-z0-9]{1,8})$/u.exec(name);
    if (match?.[1] !== undefined) return match[1].toUpperCase();
  }
  const mime = asset.mimeType.toLowerCase();
  return MIME_FORMATS[mime] ?? (mime.split("/")[1] ?? mime).replace(/^x-/u, "").toUpperCase();
}

/**
 * The streams an MP4 soft-subtitle export cannot hold, from `invalid_request.container_unsupported`
 * (`details.streams` entries are `index:type:codec`), shown as `#1 video vp9`.
 */
export function unsupportedStreams(error: unknown): string[] | undefined {
  if (!(error instanceof ApiError) || error.error.code !== "invalid_request.container_unsupported") return undefined;
  const streams = error.error.details?.["streams"];
  if (!Array.isArray(streams)) return [];
  return streams.map((entry) => {
    const [index, type, ...codec] = entry.split(":");
    return index === undefined || type === undefined || codec.length === 0 ? entry : `#${index} ${type} ${codec.join(":")}`;
  });
}

/**
 * 「导出字幕视频」 dialog of the subtitles tab (desktop client). `playingAssetId` is the video
 * cache the local player shows, which the source video starts from.
 */
export function BurnDialog(props: {
  contentId: string;
  selected: TranscriptRevisionDto;
  revisions: readonly TranscriptRevisionDto[];
  primaryId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (taskId: string) => void;
  playingAssetId?: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const page = useContentPage();
  const me = useMe();
  const userId = me.data?.userId;
  // Read with a placeholder until the account is known; nothing is sent before then.
  const prefs = useSubtitlePrefs(userId ?? "", props.contentId);
  const defaults = burnDefaults(props.selected, props.revisions, props.primaryId, userId === undefined ? { version: 1, mode: "off" } : prefs.track);
  const originals = visibleRevisions(
    props.revisions.filter((item) => item.kind !== "translated"),
    props.primaryId,
    { include: [defaults.originalId, burnSources(props.selected, props.revisions).original.id] },
  );
  const [pickedOriginal, setPickedOriginal] = useState<string | undefined>(undefined);
  const original = originals.find((item) => item.id === (pickedOriginal ?? defaults.originalId)) ?? burnSources(props.selected, props.revisions).original;
  const translations = translationsOf(original, props.revisions);
  const [pickedMode, setPickedMode] = useState<BurnMode | undefined>(undefined);
  const [pickedTranslation, setPickedTranslation] = useState<string | undefined>(undefined);
  const mode = translations.length === 0 ? "original" : (pickedMode ?? defaults.mode);
  const translationId = (
    translations.find((item) => item.id === pickedTranslation) ??
    translations.find((item) => item.id === defaults.translationId) ??
    translations[0]
  )?.id;
  const [delivery, setDelivery] = useState<SubtitleDelivery>("hard");
  const [container, setContainer] = useState<SubtitleVideoContainer>("mkv");
  const sources = burnSourceVideos(page.content.media);
  const [pickedSource, setPickedSource] = useState<string | undefined>(undefined);
  const source = sources.find((item) => item.asset.id === pickedSource) ?? defaultBurnSource(sources, props.playingAssetId);
  const sourceLabel = (item: BurnVideoSource): string => {
    const values = { kind: t(`contentView.burn.sourceVideoKind.${item.kind}`), format: videoFormat(item.asset), size: formatBytes(item.asset.sizeBytes) };
    return item.kind === "original"
      ? t("contentView.burn.sourceVideoLabel", values)
      : t("contentView.burn.sourceVideoCacheLabel", { ...values, quality: qualityLabel(cacheHeight(item.asset), t) });
  };
  const style: SubtitleStyle = { appearance: prefs.appearance, placement: prefs.placement };
  const body = userId === undefined ? undefined : burnRequest(original, mode, translationId, { delivery, container, style }, source?.asset.id);
  const start = useMutation({
    mutationFn: (request: BurnRequest) =>
      client.post(`/api/contents/${encodeURIComponent(props.contentId)}/burn`, taskAcceptedDtoSchema, { body: request, idempotent: true }),
    onSuccess: (accepted) => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.latestTask(props.contentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
      props.onOpenChange(false);
      props.onStarted(accepted.taskId);
    },
  });
  const unsupported = unsupportedStreams(start.error);
  const listFormat = new Intl.ListFormat(i18n.language, { type: "conjunction" });
  const appearance = prefs.appearance;
  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        if (!open) start.reset();
        props.onOpenChange(open);
      }}
      title={t("contentView.burn.title")}
      description={t("contentView.burn.hint")}
    >
      <div className="flex flex-col gap-3 text-sm">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs text-muted">{t("contentView.burn.mode")}</legend>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">{t("contentView.burn.originalRevision")}</span>
            <select
              className="h-8 rounded border border-line bg-surface px-2"
              value={original.id}
              onChange={(event) => {
                setPickedOriginal(event.target.value);
                setPickedTranslation(undefined);
              }}
              data-testid="burn-original"
            >
              {originals.map((item) => (
                <option key={item.id} value={item.id}>
                  {revisionLabel(item, props.primaryId, t, i18n, originals)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {BURN_MODES.map((value) => (
              <label key={value} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="burn-mode"
                  value={value}
                  checked={mode === value}
                  disabled={value !== "original" && translations.length === 0}
                  onChange={() => setPickedMode(value)}
                />
                {t(`contentView.burn.modeValue.${value}`)}
              </label>
            ))}
          </div>
          {translations.length === 0 ? <p className="text-xs text-muted">{t("contentView.burn.noTranslation")}</p> : null}
          {mode === "original" || translations.length === 0 ? null : (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">{t("contentView.burn.translation")}</span>
              <select
                className="h-8 rounded border border-line bg-surface px-2"
                value={translationId}
                onChange={(event) => setPickedTranslation(event.target.value)}
                data-testid="burn-translation"
              >
                {translations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {revisionLabel(item, props.primaryId, t, i18n, translations)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {source === undefined ? (
          <p className="text-xs text-muted" data-testid="burn-source-video">
            {t("contentView.burn.noSourceVideo")}
          </p>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">{t("contentView.burn.sourceVideo")}</span>
            <select
              className="h-8 rounded border border-line bg-surface px-2"
              value={source.asset.id}
              onChange={(event) => {
                setPickedSource(event.target.value);
                start.reset();
              }}
              data-testid="burn-source"
            >
              {sources.map((item) => (
                <option key={item.asset.id} value={item.asset.id}>
                  {sourceLabel(item)}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs text-muted">{t("contentView.burn.delivery")}</legend>
          {SUBTITLE_DELIVERIES.map((value) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="burn-delivery"
                className="mt-1"
                value={value}
                checked={delivery === value}
                onChange={() => {
                  setDelivery(value);
                  start.reset();
                }}
                aria-describedby={`burn-delivery-hint-${value}`}
              />
              <span className="flex flex-col">
                <span>{t(`contentView.burn.deliveryValue.${value}`)}</span>
                <span id={`burn-delivery-hint-${value}`} className="text-xs text-muted">
                  {t(`contentView.burn.deliveryHint.${value}`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {delivery === "hard" ? null : (
          <fieldset className="flex flex-col gap-2" data-testid="burn-container">
            <legend className="mb-1 text-xs text-muted">{t("contentView.burn.container")}</legend>
            {SOFT_CONTAINERS.map((value) => (
              <label key={value} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="burn-container"
                  className="mt-1"
                  value={value}
                  checked={container === value}
                  onChange={() => {
                    setContainer(value);
                    start.reset();
                  }}
                  aria-describedby={`burn-container-hint-${value}`}
                />
                <span className="flex flex-col">
                  <span>{t(`contentView.burn.containerValue.${value}`)}</span>
                  <span id={`burn-container-hint-${value}`} className="text-xs text-muted">
                    {t(`contentView.burn.containerHint.${value}`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">{t("contentView.burn.style")}</span>
          <span className="inline-flex items-center gap-1 text-xs" data-testid="burn-style-summary">
            <span aria-hidden className="inline-block size-3 rounded-sm border border-line" style={{ backgroundColor: appearance.original.color }} />
            <span aria-hidden className="inline-block size-3 rounded-sm border border-line" style={{ backgroundColor: appearance.translation.color }} />
            {t("contentView.burn.styleSummary", { originalSize: appearance.original.fontSize, translationSize: appearance.translation.fontSize })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              props.onOpenChange(false);
              page.openSubtitleEditor();
            }}
            data-testid="burn-adjust-style"
          >
            {t("contentView.burn.adjustInPlayer")}
          </Button>
        </div>
        {source === undefined ? null : (
          <p className="text-xs text-muted" data-testid="burn-estimated-size">
            {delivery === "soft" ? t("contentView.burn.estimatedSize", { size: formatBytes(source.asset.sizeBytes) }) : t("contentView.burn.estimatedSizeHard")}
          </p>
        )}
        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
          <li>{t("contentView.burn.streamsNote")}</li>
          <li>{t("contentView.burn.fidelityNote")}</li>
        </ul>
        {unsupported !== undefined ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm" role="alert" data-testid="burn-unsupported">
            <span className="min-w-0 flex-1">{t("contentView.burn.unsupported", { streams: listFormat.format(unsupported) })}</span>
            <Button
              size="sm"
              onClick={() => {
                setContainer("mkv");
                start.reset();
              }}
              data-testid="burn-use-mkv"
            >
              {t("contentView.burn.useMkv")}
            </Button>
          </div>
        ) : start.error instanceof ApiError ? (
          <ErrorView error={start.error.error} />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => props.onOpenChange(false)}>{t("common.action.cancel")}</Button>
          <Button
            variant="primary"
            disabled={body === undefined || source === undefined || start.isPending}
            onClick={() => {
              if (body !== undefined) start.mutate(body);
            }}
            data-testid="burn-start"
          >
            {t("contentView.burn.start")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type SaveState = { kind: "saving" } | { kind: "saved"; path: string } | { kind: "kept" } | { kind: "missing" } | { kind: "failed"; error: AppError };

/**
 * Follows a burn Task and, once it succeeded, offers its product for saving right away:
 * the save dialog opens, a saved copy is removed from the data directory, a cancelled one
 * stays listed under Settings › Storage.
 */
export function BurnTracker(props: { taskId: string; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState | undefined>(undefined);
  const { taskId, title } = props;
  const onSucceeded = useCallback(() => {
    setState({ kind: "saving" });
    void (async () => {
      try {
        const output = (await fetchBurnOutputs(client)).find((item) => item.taskId === taskId);
        if (output === undefined) {
          setState({ kind: "missing" });
          return;
        }
        const saved = await saveBurnProduct(client, output.assetId, burnFileName(title, output.mimeType));
        setState(saved === null ? { kind: "kept" } : { kind: "saved", path: saved.savedPath });
      } catch (caught) {
        setState({ kind: "failed", error: appErrorOf(caught) });
      } finally {
        void queryClient.invalidateQueries({ queryKey: burnOutputsKey });
      }
    })();
  }, [client, queryClient, taskId, title]);
  // Only the success notice goes away by itself; a cancelled save, a missing output or a
  // failure stays until closed, so the user does not miss that nothing was saved.
  useAutoDismiss(state?.kind === "saved" ? state : undefined, props.onClose);
  return (
    <div className="flex flex-col gap-2" data-testid="burn-tracker">
      <TrackedTask taskId={taskId} onSucceeded={onSucceeded} onClose={props.onClose} />
      {state === undefined ? null : state.kind === "failed" ? (
        <ErrorView error={state.error}>
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            {t("common.action.close")}
          </Button>
        </ErrorView>
      ) : (
        <div className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm" role="status" data-testid="burn-save-state">
          <span className="min-w-0 flex-1">
            {state.kind === "saving"
              ? t("contentView.burn.saving")
              : state.kind === "saved"
                ? t("contentView.burn.saved", { path: state.path })
                : state.kind === "kept"
                  ? t("contentView.burn.kept")
                  : t("contentView.burn.outputMissing")}
          </span>
          {state.kind === "saving" ? null : (
            <Button size="sm" variant="ghost" onClick={props.onClose}>
              {t("common.action.close")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
