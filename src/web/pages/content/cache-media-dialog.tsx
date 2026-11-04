import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { CACHE_MEDIA_TYPES, type CacheMediaQuality, type CacheMediaType } from "../../../shared/cache-file-name.ts";
import { CACHE_INSPECT_DEBOUNCE_MS, CACHE_MEDIA_MAX_HEIGHT, DISPLAY_NAME_MAX_CHARS } from "../../../shared/defaults.ts";
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
/** What a submission fails with when the check it names is gone, or was for another choice. */
const INSPECTION_EXPIRED = "conflict.cache_inspection_expired";

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
 * Once the choice is complete (the name after typing pauses) the dialog checks it in the
 * background: the expected file name and size, the caches it replaces, another Content's
 * cache it would overwrite (which needs a confirmation) and what blocks it, answered with a
 * token that names the check. A change to the choice aborts the check and drops its answer.
 * 「开始缓存」 locks the form and starts the `cache_media` Task with that token as soon as the
 * check is answered and needs nothing from the user (`needsReview`); a check still running is
 * waited for, and the wait can be cancelled. When the answer needs the user, the dialog shows
 * it and 「确认缓存」 starts the Task. A token the server no longer knows makes the dialog
 * check again once and submit the same intent. The caller follows the Task's progress
 * through `onStarted`.
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

/** What a check is about: the three things the user chooses. */
interface CheckParams {
  type: CacheMediaType;
  quality: CacheMediaQuality;
  fileName: string;
}

/** Two choices are the same check when this is equal; the quality tier only counts for a video. */
function checkKey(params: CheckParams): string {
  return params.type === "video" ? `video|${params.quality}|${params.fileName}` : `audio||${params.fileName}`;
}

/** The latest check of the choice `key` stands for: running, answered or failed. */
type Check = { key: string; params: CheckParams } & (
  | { status: "checking" }
  | { status: "ready"; answer: CacheMediaInspectDto }
  | { status: "failed"; error: unknown }
);

/**
 * What the user asked for by clicking 「开始缓存」: the Task starts as soon as the check of
 * this choice is answered and needs nothing from the user. `retried` is set once the check
 * was redone because its token had expired; `confirmed` carries what the user had reviewed
 * when it was.
 */
interface StartIntent {
  key: string;
  retried: boolean;
  confirmed?: { answer: CacheMediaInspectDto; overwriteAssetId?: string };
}

/** One submission of the Task, with what is needed to judge its failure. */
interface StartRequest {
  request: CacheMediaRequest;
  params: CheckParams;
  answer: CacheMediaInspectDto;
  overwriteAssetId?: string;
  /** The user reviewed the answer (or confirmed it) rather than it needing nothing. */
  confirmed: boolean;
  retried: boolean;
}

/** Whether two answers show the user the same decision: the same estimate, replacements and overwrite. */
function sameReview(a: CacheMediaInspectDto, b: CacheMediaInspectDto): boolean {
  const replaced = (answer: CacheMediaInspectDto): string => answer.replaces.map((item) => item.assetId).join(",");
  return (
    a.expected.type === b.expected.type &&
    a.expected.height === b.expected.height &&
    a.expectedFileName === b.expectedFileName &&
    a.overwrite?.assetId === b.overwrite?.assetId &&
    replaced(a) === replaced(b)
  );
}

function CacheMediaForm(props: { contentId: string; title: string | undefined; media: readonly MediaAssetDto[]; onClose: () => void; onStarted: (taskId: string) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [type, setType] = useState<CacheMediaType>("video");
  const [quality, setQuality] = useState<CacheMediaQuality>(DEFAULT_QUALITY);
  const [fileName, setFileName] = useState(props.title ?? "");
  // The name the background check works on: it follows the typed name once typing pauses.
  const [settledName, setSettledName] = useState(fileName);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  // Set when a submission failed with the answer still good, so 「确认缓存」 can retry it.
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
        // Only the tier changes: an audio check in flight is not about the tier, and no
        // video check can be, since none starts before this answer. A second probe keeps the
        // user's tier while the source still offers it.
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

  // The check of the current choice runs on its own once the choice is complete; a choice
  // that changes meanwhile aborts it, and an answer arriving late is dropped by the abort.
  const [check, setCheck] = useState<Check | undefined>(undefined);
  const running = useRef<{ key: string; controller: AbortController } | undefined>(undefined);
  // Set after a check found its tier gone or a submission was refused: nothing then starts
  // by itself until the user edits the choice or clicks, or a bad answer would loop.
  const [autoPaused, setAutoPaused] = useState(false);
  const [intent, setIntentState] = useState<StartIntent | undefined>(undefined);
  // Read by the answers of requests in flight, which would otherwise see the intent of their own render.
  const intentRef = useRef<StartIntent | undefined>(undefined);
  const setIntent = (next: StartIntent | undefined): void => {
    intentRef.current = next;
    setIntentState(next);
  };
  const closed = useRef(false);
  const abortRunning = useCallback((): void => {
    const current = running.current;
    if (current === undefined) return;
    current.controller.abort();
    running.current = undefined;
    setCheck((now) => (now?.status === "checking" ? undefined : now));
  }, []);
  // Closing the dialog drops whatever is in flight, including a wait for a Task to start.
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      abortRunning();
    };
  }, [abortRunning]);

  const liveKey = checkKey({ type, quality, fileName });
  const settled = settledName === fileName;
  useEffect(() => {
    const flying = running.current;
    if (!(type === "audio" || (probe.kind === "ready" && probe.status !== "audio_only"))) {
      // Without a quality list there is nothing to check, unless a click is waiting on a check.
      if (intentRef.current === undefined) abortRunning();
      return;
    }
    if (flying !== undefined && flying.key !== liveKey) abortRunning();
    if (!settled || autoPaused) return;
    if (running.current?.key === liveKey || check?.key === liveKey) return;
    startCheck({ type, quality, fileName });
    // `startCheck` only reads refs and stable setters, so it is not a dependency.
  }, [type, quality, fileName, probe, liveKey, settled, autoPaused, check?.key]);

  const invalidateCheck = (): void => {
    abortRunning();
    setCheck(undefined);
    setIntent(undefined);
    setReviewing(false);
    setOverwriteConfirmed(false);
  };

  const start = useMutation({
    mutationFn: (submission: StartRequest) => client.post(path, taskAcceptedDtoSchema, { body: submission.request, idempotent: true }),
    onSuccess: (accepted) => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.cacheTask(props.contentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
      props.onClose();
      props.onStarted(accepted.taskId);
    },
    onError: (error, submission) => {
      if (closed.current) return;
      if (error instanceof ApiError && error.error.code === INSPECTION_EXPIRED) {
        if (submission.retried) {
          // Twice is enough: the error stays on screen and the next click checks again.
          invalidateCheck();
          setAutoPaused(true);
        } else {
          // The token is gone, not the request: check again and submit the same intent.
          start.reset();
          setOverwriteConfirmed(false);
          setIntent({
            key: checkKey(submission.params),
            retried: true,
            ...(submission.confirmed ? { confirmed: { answer: submission.answer, ...(submission.overwriteAssetId === undefined ? {} : { overwriteAssetId: submission.overwriteAssetId }) } } : {}),
          });
          startCheck(submission.params);
        }
        return;
      }
      // Another conflict means the answer is out of date; the next click checks again. Any
      // other failure leaves the answer on screen, so 「确认缓存」 can retry it.
      if (error instanceof ApiError && error.status === 409) {
        invalidateCheck();
        setAutoPaused(true);
      } else {
        setReviewing(true);
      }
    },
  });

  function submit(answer: CacheMediaInspectDto, params: CheckParams, options: { overwriteAssetId?: string; confirmed: boolean; retried: boolean }): void {
    const request: CacheMediaRequest = { ...cacheMediaRequest(params.type, params.quality, params.fileName, options.overwriteAssetId), inspectionId: answer.inspectionId };
    setIntent(undefined);
    start.mutate({ request, params, answer, confirmed: options.confirmed, retried: options.retried, ...(options.overwriteAssetId === undefined ? {} : { overwriteAssetId: options.overwriteAssetId }) });
  }

  /** What follows an answer the user is waiting for: submit it, or stop where the user has to decide. */
  function settle(answer: CacheMediaInspectDto, params: CheckParams, wanted: StartIntent): void {
    if (wanted.confirmed !== undefined) {
      // The check was redone behind a decision the user had already made: it stands if the
      // new answer shows the same thing, else the user decides again.
      if (cacheBlockers(answer).length === 0 && sameReview(answer, wanted.confirmed.answer)) {
        submit(answer, params, { ...(wanted.confirmed.overwriteAssetId === undefined ? {} : { overwriteAssetId: wanted.confirmed.overwriteAssetId }), confirmed: true, retried: true });
      } else {
        setOverwriteConfirmed(false);
        setIntent(undefined);
      }
      return;
    }
    if (needsReview(answer, params.type, params.quality)) {
      setIntent(undefined);
      return;
    }
    submit(answer, params, { confirmed: false, retried: wanted.retried });
  }

  function startCheck(params: CheckParams): void {
    const key = checkKey(params);
    abortRunning();
    const controller = new AbortController();
    running.current = { key, controller };
    setCheck({ key, params, status: "checking" });
    const body = cacheMediaRequest(params.type, params.quality, params.fileName);
    client.post(`${path}/inspect`, cacheMediaInspectDtoSchema, { body, signal: controller.signal }).then(
      (answer) => {
        if (controller.signal.aborted) return;
        running.current = undefined;
        setCheck({ key, params, status: "ready", answer });
        // The inspection reads the quality of older caches from their files; show it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.content(props.contentId) });
        const wanted = intentRef.current;
        if (wanted?.key === key) settle(answer, params, wanted);
      },
      (failure) => {
        if (controller.signal.aborted) return;
        running.current = undefined;
        setCheck({ key, params, status: "failed", error: failure });
        if (intentRef.current?.key === key) setIntent(undefined);
        // The source no longer offers the chosen tier: the error stays on screen and the
        // list is probed again for the user to choose from; nothing starts.
        if (failure instanceof ApiError && failure.error.code === QUALITY_UNAVAILABLE) {
          setAutoPaused(true);
          setProbe({ kind: "loading" });
          setProbeSeq((seq) => seq + 1);
        }
      },
    );
  }

  // Any change to the choice makes the check stale. A tier or type change is not typing, so
  // it needs no pause before the new check.
  const edit = (apply: () => void, options: { settleName?: boolean } = {}): void => {
    apply();
    if (options.settleName === true) setSettledName(fileName);
    start.reset();
    setAutoPaused(false);
    invalidateCheck();
  };
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettledName(fileName), CACHE_INSPECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settled, fileName]);

  const begin = (): void => {
    start.reset();
    setAutoPaused(false);
    setSettledName(fileName);
    const params: CheckParams = { type, quality, fileName };
    const wanted: StartIntent = { key: liveKey, retried: false };
    setIntent(wanted);
    if (check?.key === liveKey && check.status === "ready") {
      settle(check.answer, params, wanted);
    } else if (running.current?.key !== liveKey) {
      startCheck(params);
    }
  };

  const current = check?.key === liveKey ? check : undefined;
  const answer = current?.status === "ready" ? current.answer : undefined;
  const shown = answer !== undefined && (reviewing || needsReview(answer, type, quality)) ? answer : undefined;
  // The form stays put while a Task is being started from it or a click waits for the check.
  const locked = start.isPending || intent !== undefined;
  const blockers = answer === undefined ? [] : cacheBlockers(answer);
  const overwrite = answer?.overwrite;
  const canConfirm = answer !== undefined && blockers.length === 0 && (overwrite === undefined || overwriteConfirmed) && !locked;
  // The list follows the latest answer, even one for a choice since changed: its caches are the Content's.
  const latest = check?.status === "ready" ? check.answer : undefined;
  const rows = latest === undefined ? cacheRowsOf(props.media) : cacheRowsOfInspection(latest.caches);
  const checkable = type === "audio" || (probe.kind === "ready" && probe.status !== "audio_only");
  const phase = !checkable ? undefined : current !== undefined ? current.status : autoPaused ? undefined : "checking";
  const error = start.error ?? (check?.status === "failed" ? check.error : undefined);
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
              onChange={() => edit(() => setType(value), { settleName: true })}
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
                if (next !== undefined) edit(() => setQuality(next.tier), { settleName: true });
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
      {phase === undefined || phase === "failed" ? null : (
        <p className={`text-xs ${answer !== undefined && !answer.disk.ok ? "text-danger" : "text-muted"}`} role="status" data-testid="cache-preflight">
          {answer === undefined ? t("contentView.cache.preflightChecking") : preflightText(answer, t)}
        </p>
      )}
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
          <>
            {intent === undefined || start.isPending ? null : (
              <Button onClick={() => setIntent(undefined)} data-testid="cache-cancel-wait">
                {t("contentView.cache.cancelWaiting")}
              </Button>
            )}
            <Button variant="primary" disabled={locked || (type === "video" && videoBlocked)} onClick={begin} data-testid="cache-inspect">
              {start.isPending ? t("contentView.cache.starting") : intent !== undefined ? t("contentView.cache.waiting") : t("contentView.cache.start")}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={!canConfirm}
            onClick={() => submit(shown, { type, quality, fileName }, { ...(overwriteConfirmed && overwrite !== undefined ? { overwriteAssetId: overwrite.assetId } : {}), confirmed: true, retried: false })}
            data-testid="cache-confirm"
          >
            {start.isPending ? t("contentView.cache.starting") : t("contentView.cache.confirm")}
          </Button>
        )}
      </div>
      <CacheList contentId={props.contentId} rows={rows} onDeleted={invalidateCheck} />
    </div>
  );
}

/** 「预计 1.2 GB · 保存为 «名称»」, with the low disk named after it. */
function preflightText(answer: CacheMediaInspectDto, t: TFunction): string {
  const name = answer.expectedFileName;
  const preview =
    answer.expected.sizeBytes === undefined
      ? t("contentView.cache.preflightPreviewNoSize", { name })
      : t("contentView.cache.preflightPreview", { size: formatBytes(answer.expected.sizeBytes), name });
  return answer.disk.ok ? preview : `${preview} · ${t("contentView.cache.preflightDiskLow")}`;
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
