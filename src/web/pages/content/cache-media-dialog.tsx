import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { CACHE_MEDIA_TYPES, type CacheMediaQuality, type CacheMediaType } from "../../../shared/cache-file-name.ts";
import { CACHE_MEDIA_MAX_HEIGHT, DISPLAY_NAME_MAX_CHARS } from "../../../shared/defaults.ts";
import type { MediaAssetDto } from "../../../shared/dto/content.ts";
import {
  cacheMediaInspectDtoSchema,
  cacheMediaQualitiesDtoSchema,
  type CacheMediaInspectDto,
  type CacheMediaRequest,
  type CacheQualityStatus,
  type CacheVideoQuality,
} from "../../../shared/dto/media.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { CACHE_MEDIA_QUALITIES } from "../../../shared/enums.ts";
import { formatBytes } from "../../../shared/units.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useUnfinishedTasks } from "../../api/queries.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { cacheLocationKey } from "../../desktop/cached-media.ts";
import { cacheHeight, compareCacheQuality, isAudioOnly, qualityLabel } from "../../player/media-url.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { contentKeys } from "./content-data.ts";

const DEFAULT_QUALITY: CacheMediaQuality = CACHE_MEDIA_QUALITIES.find((quality) => quality === CACHE_MEDIA_MAX_HEIGHT) ?? CACHE_MEDIA_QUALITIES[0];
/**
 * How far a picture's short side may be from its tier and still read as a standard picture
 * of that tier; the same slack the tier label itself allows (1280×714 is 720P).
 */
const STANDARD_PICTURE_TOLERANCE = 1.05;
/** What an inspection fails with when the source no longer offers the chosen tier. */
const QUALITY_UNAVAILABLE = "invalid_request.cache_quality_unavailable";

/** A quality option: a tier, with the picture size of its stream when the source was probed. */
type QualityOption = { tier: CacheMediaQuality } & Partial<Pick<CacheVideoQuality, "width" | "height">>;

/**
 * The option text of a tier: `720P`, and for a non-standard picture (ultra-wide, or a size
 * whose short side is not about the tier) the real size as well, `720P（1280×410）`, so the
 * user knows what the tier downloads. Portrait pictures whose short side is the tier read
 * as standard.
 */
export function qualityOptionLabel(option: QualityOption, t: TFunction): string {
  const { tier, width, height } = option;
  if (width === undefined || height === undefined) {
    return t("contentView.cache.qualityValue", { height: tier });
  }
  const short = Math.min(width, height);
  const standard = short >= tier / STANDARD_PICTURE_TOLERANCE && short <= tier * STANDARD_PICTURE_TOLERANCE;
  return standard
    ? t("contentView.cache.qualityValue", { height: tier })
    : t("contentView.cache.qualityValueSized", { height: tier, width, pixelHeight: height });
}

/**
 * The quality preselected among the source's own: the highest one not above
 * `CACHE_MEDIA_MAX_HEIGHT`, else the highest there is.
 */
export function defaultCacheQuality(qualities: readonly CacheMediaQuality[]): CacheMediaQuality {
  const sorted = [...qualities].sort((a, b) => a - b);
  return sorted.filter((quality) => quality <= CACHE_MEDIA_MAX_HEIGHT).pop() ?? sorted.pop() ?? DEFAULT_QUALITY;
}

/**
 * Where the probe of the source's qualities stands: one probe per opening of the dialog, and
 * another when an inspection finds the chosen tier gone.
 */
type QualityProbe = { kind: "loading" } | { kind: "ready"; status: CacheQualityStatus; qualities: CacheVideoQuality[] } | { kind: "failed" };

/** The `POST /cache-media` (and `/inspect`) body for a choice; the quality tier applies to a video only. */
export function cacheMediaRequest(type: CacheMediaType, quality: CacheMediaQuality, fileName: string, overwriteAssetId?: string): CacheMediaRequest {
  const base: CacheMediaRequest = type === "video" ? { type, quality, fileName } : { type, fileName };
  return overwriteAssetId === undefined ? base : { ...base, overwriteAssetId };
}

/** Why the inspected request cannot be started; empty when it can. */
export function cacheBlockers(inspection: CacheMediaInspectDto): Array<"foreignFile" | "pendingName" | "recoveryHold" | "diskLow"> {
  return [
    ...(inspection.foreignFile ? (["foreignFile"] as const) : []),
    ...(inspection.pendingName ? (["pendingName"] as const) : []),
    ...(inspection.recoveryHold ? (["recoveryHold"] as const) : []),
    ...(inspection.disk.ok ? [] : (["diskLow"] as const)),
  ];
}

/**
 * Whether the inspected request needs the user before it starts: something blocks it, it
 * would overwrite another Content's cache, replace one of this Content's caches (whose file
 * may carry another name and is then deleted), cache audio where a video was asked for, or,
 * given the requested quality, is expected to download a video of another or an unknown
 * quality: a listed quality is only a candidate, and the format selection may settle lower.
 * Anything else starts right after the inspection, without a second click.
 */
export function needsReview(inspection: CacheMediaInspectDto, requestedType: CacheMediaType, requestedQuality?: CacheMediaQuality): boolean {
  return (
    cacheBlockers(inspection).length > 0 ||
    inspection.overwrite !== undefined ||
    inspection.replaces.length > 0 ||
    (requestedType === "video" && inspection.expected.type === "audio") ||
    (requestedType === "video" && requestedQuality !== undefined && inspection.expected.type === "video" && inspection.expected.height !== requestedQuality)
  );
}

/** One cache of the Content as the dialog lists it. */
export interface CacheRow {
  assetId: string;
  type: CacheMediaType;
  height?: number;
  fileName: string;
  sizeBytes: number;
}

/** The last segment of a local path, Windows or POSIX. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

/** The Content's available caches from its media list: video by quality, then audio. */
export function cacheRowsOf(media: readonly MediaAssetDto[]): CacheRow[] {
  const caches = media.filter((item) => item.kind === "platform_cache" && item.availability === "available");
  const rows = (items: MediaAssetDto[], type: CacheMediaType): CacheRow[] =>
    items.sort(compareCacheQuality).map((item) => {
      const height = type === "video" ? cacheHeight(item) : undefined;
      return {
        assetId: item.id,
        type,
        ...(height === undefined ? {} : { height }),
        fileName: item.displayName ?? (item.localPath === undefined ? item.id : fileNameOf(item.localPath)),
        sizeBytes: item.sizeBytes,
      };
    });
  return [...rows(caches.filter((item) => !isAudioOnly(item)), "video"), ...rows(caches.filter(isAudioOnly), "audio")];
}

/** The caches an inspection reported, in the same order as `cacheRowsOf`. */
function cacheRowsOfInspection(caches: CacheMediaInspectDto["caches"]): CacheRow[] {
  const order = (row: CacheMediaInspectDto["caches"][number]): number => (row.type === "audio" ? -1 : (row.height ?? 0));
  return [...caches]
    .sort((a, b) => order(b) - order(a) || b.createdAt - a.createdAt)
    .map((row) => ({
      assetId: row.assetId,
      type: row.type,
      ...(row.height === undefined ? {} : { height: row.height }),
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
    }));
}

/**
 * 「缓存本视频」 (desktop client): the user picks a video (the quality tier it is cached in)
 * or audio only and the file name, prefilled with the Content's display title. Each opening
 * probes the tiers the source currently offers once and lists only those; until the probe
 * answers a video cannot be started, and when it fails the general-purpose tiers are offered
 * instead. An inspection that finds the chosen tier gone probes the list again.
 * 「开始缓存」 first asks the server
 * what the request would produce: the expected file name, the caches it replaces, another
 * Content's cache it would overwrite (which needs a confirmation) and what blocks it. When
 * none of that needs the user (`needsReview`), the `cache_media` Task starts right away;
 * otherwise the dialog shows the answer and 「确认缓存」 starts it. The caller follows the
 * Task's progress through `onStarted`.
 * Below, the Content's caches can be deleted one by one, except while it has unfinished Tasks.
 */
export function CacheMediaDialog(props: {
  contentId: string;
  /** The display title (`customTitle ?? title`), undefined when the Content has none. */
  title: string | undefined;
  /** The Content's media, for the list of its caches before an inspection reports them. */
  media: readonly MediaAssetDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("contentView.cache.title")} description={t("contentView.cache.hint")}>
      {/* Mounted only while open, so every opening starts from the current title and defaults. */}
      <CacheMediaForm contentId={props.contentId} title={props.title} media={props.media} onClose={() => props.onOpenChange(false)} onStarted={props.onStarted} />
    </Modal>
  );
}

function CacheMediaForm(props: { contentId: string; title: string | undefined; media: readonly MediaAssetDto[]; onClose: () => void; onStarted: (taskId: string) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [type, setType] = useState<CacheMediaType>("video");
  const [quality, setQuality] = useState<CacheMediaQuality>(DEFAULT_QUALITY);
  const [fileName, setFileName] = useState(props.title ?? "");
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  // Set once an inspection found something for the user to decide (or its automatic start failed).
  const [reviewing, setReviewing] = useState(false);
  const path = `/api/contents/${encodeURIComponent(props.contentId)}/cache-media`;
  const [probe, setProbe] = useState<QualityProbe>({ kind: "loading" });
  // Bumped to probe the list again; 0 is the probe of the opening.
  const [probeSeq, setProbeSeq] = useState(0);
  // Not a cached query: every opening asks afresh, and an answer arriving after the dialog
  // closed (or after a later probe started) must not touch the form.
  useEffect(() => {
    const controller = new AbortController();
    const reprobe = probeSeq > 0;
    client.get(`${path}/qualities`, cacheMediaQualitiesDtoSchema, { signal: controller.signal }).then(
      (answer) => {
        if (controller.signal.aborted) return;
        setProbe({ kind: "ready", status: answer.status, qualities: answer.qualities });
        // Only the tier changes: an audio inspection in flight is not about the tier, and no
        // video inspection can be, since a video cannot be started before this answer. A
        // second probe keeps the user's tier while the source still offers it.
        if (answer.status === "available") {
          const tiers = answer.qualities.map((option) => option.tier);
          setQuality((current) => (reprobe && tiers.includes(current) ? current : defaultCacheQuality(tiers)));
        } else if (reprobe) {
          setQuality((current) => (CACHE_MEDIA_QUALITIES.some((tier) => tier === current) ? current : DEFAULT_QUALITY));
        }
      },
      () => {
        if (controller.signal.aborted) return;
        setProbe({ kind: "failed" });
        if (reprobe) setQuality((current) => (CACHE_MEDIA_QUALITIES.some((tier) => tier === current) ? current : DEFAULT_QUALITY));
      },
    );
    return () => controller.abort();
  }, [client, path, probeSeq]);
  const listed = probe.kind === "ready" && probe.status === "available";
  const qualityOptions: readonly QualityOption[] = listed ? probe.qualities : CACHE_MEDIA_QUALITIES.map((tier) => ({ tier }));
  const videoBlocked = probe.kind === "loading" || (probe.kind === "ready" && probe.status === "audio_only");
  const inspect = useMutation({
    mutationFn: (body: CacheMediaRequest) => client.post(`${path}/inspect`, cacheMediaInspectDtoSchema, { body }),
    // The inspection reads the quality of older caches from their files; show it.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.content(props.contentId) }),
  });
  const start = useMutation({
    mutationFn: (body: CacheMediaRequest) => client.post(path, taskAcceptedDtoSchema, { body, idempotent: true }),
    onSuccess: (accepted) => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.cacheTask(props.contentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
      props.onClose();
      props.onStarted(accepted.taskId);
    },
    // A conflict means the inspection is out of date: the next click inspects again. Any other
    // failure leaves the answer on screen, so 「确认缓存」 can retry it.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        inspect.reset();
        setOverwriteConfirmed(false);
        setReviewing(false);
      } else {
        setReviewing(true);
      }
    },
  });
  // Any change to the choice makes the inspection stale.
  const edit = (apply: () => void): void => {
    apply();
    inspect.reset();
    start.reset();
    setOverwriteConfirmed(false);
    setReviewing(false);
  };
  const inspection = inspect.data;
  const shown = reviewing ? inspection : undefined;
  // The form stays put while a Task is being started from it.
  const locked = start.isPending;
  const blockers = inspection === undefined ? [] : cacheBlockers(inspection);
  const overwrite = inspection?.overwrite;
  const canConfirm = inspection !== undefined && blockers.length === 0 && (overwrite === undefined || overwriteConfirmed) && !start.isPending;
  const rows = inspection === undefined ? cacheRowsOf(props.media) : cacheRowsOfInspection(inspection.caches);
  const error = start.error ?? inspect.error;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-muted">{t("contentView.cache.type")}</legend>
        {CACHE_MEDIA_TYPES.map((value) => (
          <label key={value} className="inline-flex items-center gap-2">
            <input
              type="radio"
              name="cache-type"
              value={value}
              checked={type === value}
              onChange={() => edit(() => setType(value))}
              disabled={locked}
              data-testid={`cache-type-${value}`}
            />
            {t(`contentView.cache.typeValue.${value}`)}
          </label>
        ))}
      </fieldset>
      {type !== "video" ? null : probe.kind === "ready" && probe.status === "audio_only" ? (
        <p className="text-xs text-danger" role="status" data-testid="cache-qualities-audio-only">
          {t("contentView.cache.qualitiesAudioOnly")}
        </p>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("contentView.cache.quality")}</span>
          {probe.kind === "loading" ? (
            <select className="h-8 rounded border border-line bg-surface px-2" value="" disabled data-testid="cache-quality">
              <option value="">{t("contentView.cache.qualityProbing")}</option>
            </select>
          ) : (
            <select
              className="h-8 rounded border border-line bg-surface px-2"
              value={quality}
              onChange={(event) => {
                const next = qualityOptions.find((option) => String(option.tier) === event.target.value);
                if (next !== undefined) edit(() => setQuality(next.tier));
              }}
              disabled={locked}
              data-testid="cache-quality"
            >
              {qualityOptions.map((option) => (
                <option key={option.tier} value={option.tier}>
                  {qualityOptionLabel(option, t)}
                </option>
              ))}
            </select>
          )}
          {probe.kind === "loading" ? null : listed ? (
            <span className="text-xs text-muted" data-testid="cache-qualities-hint">
              {t("contentView.cache.qualitiesHint")}
            </span>
          ) : (
            <span className="text-xs text-muted" data-testid="cache-qualities-unknown">
              {t("contentView.cache.qualitiesUnknown")}
            </span>
          )}
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t("contentView.cache.fileName")}</span>
        <input
          className="h-8 rounded border border-line bg-surface px-2"
          value={fileName}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          onChange={(event) => {
            const next = event.target.value;
            edit(() => setFileName(next));
          }}
          disabled={locked}
          data-testid="cache-file-name"
        />
      </label>
      {shown === undefined ? null : (
        <InspectionPanel
          inspection={shown}
          requestedType={type}
          requestedQuality={quality}
          blockers={blockers}
          overwriteConfirmed={overwriteConfirmed}
          onOverwriteConfirmed={setOverwriteConfirmed}
        />
      )}
      {error instanceof ApiError ? <ErrorView error={error.error} /> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
        {shown === undefined ? (
          <Button
            variant="primary"
            disabled={inspect.isPending || start.isPending || (type === "video" && videoBlocked)}
            onClick={() => {
              start.reset();
              const body = cacheMediaRequest(type, quality, fileName);
              const requestedType = type;
              const requestedQuality = quality;
              inspect.mutate(body, {
                // Passed to this call rather than to `useMutation`: it is dropped once the dialog
                // closes or the choice changes (`inspect.reset()`), so neither starts a Task.
                onSuccess: (answer) => {
                  if (needsReview(answer, requestedType, requestedQuality)) {
                    setReviewing(true);
                  } else {
                    start.mutate(body);
                  }
                },
                // The source no longer offers the chosen tier: the error stays on screen and
                // the list is probed again for the user to choose from; nothing starts.
                onError: (failure) => {
                  if (failure instanceof ApiError && failure.error.code === QUALITY_UNAVAILABLE) {
                    setProbe({ kind: "loading" });
                    setProbeSeq((seq) => seq + 1);
                  }
                },
              });
            }}
            data-testid="cache-inspect"
          >
            {inspect.isPending ? t("contentView.cache.inspecting") : start.isPending ? t("contentView.cache.starting") : t("contentView.cache.start")}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!canConfirm}
            onClick={() => start.mutate(cacheMediaRequest(type, quality, fileName, overwriteConfirmed ? overwrite?.assetId : undefined))}
            data-testid="cache-confirm"
          >
            {t("contentView.cache.confirm")}
          </Button>
        )}
      </div>
      <CacheList
        contentId={props.contentId}
        rows={rows}
        onDeleted={() => {
          inspect.reset();
          setReviewing(false);
        }}
      />
    </div>
  );
}

function InspectionPanel(props: {
  inspection: CacheMediaInspectDto;
  requestedType: CacheMediaType;
  requestedQuality: CacheMediaQuality;
  blockers: ReturnType<typeof cacheBlockers>;
  overwriteConfirmed: boolean;
  onOverwriteConfirmed: (confirmed: boolean) => void;
}) {
  const { t } = useTranslation();
  const { inspection } = props;
  const name = inspection.expectedFileName;
  const expected =
    props.requestedType === "audio"
      ? t("contentView.cache.expectedAudio", { name })
      : inspection.expected.type === "audio"
        ? t("contentView.cache.audioInstead", { name })
        : inspection.expected.height === undefined
          ? t("contentView.cache.expectedUnknown", { name })
          : t("contentView.cache.expected", { name });
  const overwrite = inspection.overwrite;
  const expectedHeight = inspection.expected.height;
  const differs = props.requestedType === "video" && inspection.expected.type === "video" && expectedHeight !== undefined && expectedHeight !== props.requestedQuality;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line px-3 py-2 text-xs" data-testid="cache-inspection">
      {differs ? (
        <p data-testid="cache-expected-differs">
          {t("contentView.cache.expectedDiffers", { expected: qualityLabel(expectedHeight, t), requested: qualityLabel(props.requestedQuality, t) })}
        </p>
      ) : null}
      <p className="break-all" data-testid="cache-expected-name">
        {expected}
      </p>
      {inspection.replaces.map((item) => (
        <p key={item.assetId} className="break-all" data-testid="cache-replaces">
          {props.requestedType === "audio" || inspection.expected.type === "audio"
            ? t("contentView.cache.replacesAudio")
            : t("contentView.cache.replaces", { label: qualityLabel(item.height, t) })}
        </p>
      ))}
      {overwrite === undefined ? null : (
        <div className="flex flex-col gap-1 rounded border border-danger/40 bg-danger/5 px-2 py-1.5" data-testid="cache-overwrite">
          <p className="break-all">
            {t("contentView.cache.overwrite", { title: overwrite.title ?? t("contentView.untitled"), name: overwrite.fileName, size: formatBytes(overwrite.sizeBytes) })}
          </p>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={props.overwriteConfirmed}
              onChange={(event) => props.onOverwriteConfirmed(event.target.checked)}
              data-testid="cache-overwrite-confirm"
            />
            {t("contentView.cache.overwriteConfirm")}
          </label>
        </div>
      )}
      {props.blockers.length === 0 ? null : (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-danger" role="alert" data-testid="cache-blocked">
          {props.blockers.map((blocker) =>
            blocker === "diskLow" ? (
              <li key={blocker}>
                {t("contentView.cache.diskLow")}{" "}
                {t("contentView.cache.diskCache", { free: formatBytes(inspection.disk.cache.freeBytes), reserve: formatBytes(inspection.disk.cache.lowWaterBytes) })}
                {inspection.disk.data === undefined
                  ? null
                  : `; ${t("contentView.cache.diskData", { free: formatBytes(inspection.disk.data.freeBytes), reserve: formatBytes(inspection.disk.data.lowWaterBytes) })}`}
              </li>
            ) : (
              <li key={blocker}>{t(`contentView.cache.${blocker}`)}</li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * The Content's caches with a delete button each. The server checks the file is the one it
 * registered before deleting it, which takes a moment for a large file. Deleting waits until
 * the Content has no unfinished Task, so a running Task never loses its file.
 */
function CacheList(props: { contentId: string; rows: readonly CacheRow[]; onDeleted: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const unfinished = useUnfinishedTasks();
  const busy = unfinished.data?.items.some((task) => task.contentId === props.contentId) === true;
  const [confirming, setConfirming] = useState<CacheRow | undefined>(undefined);
  const remove = useMutation({
    mutationFn: (assetId: string) => client.delete(`/api/media/${encodeURIComponent(assetId)}`, z.undefined()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.content(props.contentId) });
      void queryClient.invalidateQueries({ queryKey: cacheLocationKey });
      props.onDeleted();
    },
  });
  if (props.rows.length === 0) return null;
  const labelOf = (row: CacheRow): string => (row.type === "audio" ? t("contentView.cache.audioLabel") : qualityLabel(row.height, t));
  return (
    <section className="flex flex-col gap-1 border-t border-line pt-3" data-testid="cache-list">
      <h3 className="text-xs text-muted">{t("contentView.cache.existing")}</h3>
      <ul className="flex flex-col gap-1">
        {props.rows.map((row) => (
          <li key={row.assetId} className="flex items-center gap-2 text-xs" data-testid={`cache-row-${row.assetId}`}>
            <span className="shrink-0 font-medium">{labelOf(row)}</span>
            <span className="min-w-0 flex-1 truncate text-muted" title={row.fileName}>
              {row.fileName}
            </span>
            <span className="shrink-0 text-muted">{formatBytes(row.sizeBytes)}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || remove.isPending}
              {...(busy ? { title: t("contentView.cache.deleteBlocked") } : {})}
              aria-label={`${t("contentView.cache.delete")} ${labelOf(row)}`}
              onClick={() => setConfirming(row)}
              data-testid={`cache-delete-${row.assetId}`}
            >
              <Trash2 size={14} aria-hidden="true" />
              {remove.isPending && remove.variables === row.assetId ? t("contentView.cache.deleting") : t("contentView.cache.delete")}
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        title={t("contentView.cache.deleteTitle")}
        description={t("contentView.cache.deleteHint", { name: confirming?.fileName ?? "" })}
        confirmLabel={remove.isPending ? t("contentView.cache.deleting") : t("contentView.cache.delete")}
        danger
        onConfirm={async () => {
          if (confirming !== undefined) await remove.mutateAsync(confirming.assetId);
        }}
      />
    </section>
  );
}
