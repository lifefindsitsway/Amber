import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { z } from "zod";
import {
  CONCURRENCY_LIMITS,
  instanceSettingsDtoSchema,
  type ConcurrencyKey,
  type InstanceSettingKey,
  type InstanceSettingsDto,
  type InstanceSettingsPatch,
} from "../../../shared/dto/instance-settings.ts";
import { CACHE_MIGRATION_REFRESH_MS } from "../../../shared/defaults.ts";
import { cacheLocationDtoSchema, type CacheHoldDto, type CacheLocationDto, type CacheLocationPut } from "../../../shared/dto/local-media.ts";
import { isCacheDirReason, type AppError } from "../../../shared/errors.ts";
import { storageDtoSchema } from "../../../shared/dto/storage.ts";
import { usageDtoSchema } from "../../../shared/dto/usage.ts";
import { UPLOAD_RETENTION_POLICIES, type UploadRetentionPolicy } from "../../../shared/enums.ts";
import { BYTES_PER_GB, formatBytes } from "../../../shared/units.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useInstanceSettings, useVersion } from "../../api/queries.ts";
import { useIsServerAdmin } from "../../auth/auth-gate.tsx";
import { allowCacheDir, openFolder, pickCacheDir, type PickedFile } from "../../desktop/bridge.ts";
import { burnFileName, burnOutputFormat, burnOutputsKey, deleteBurnProduct, saveBurnProduct, useBurnOutputs } from "../../desktop/burn-outputs.ts";
import { cacheLocationKey } from "../../desktop/cached-media.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { formatDateTime, formatDuration } from "../../format.ts";
import { CredentialsSection } from "../admin/credentials-section.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { useAutoDismiss } from "../../use-auto-dismiss.ts";
import { ConfirmButton, Field, INPUT_CLASS, RequestError, SettingsBlock } from "./settings-ui.tsx";

/** Shown in this order: the task limit decides queueing, the other two pace the work inside tasks. */
const CONCURRENCY_FIELDS = ["concurrencyPipeline"] as const;
const DISK_FIELDS = ["maxDataGB", "lowWaterFreeGB", "lowWaterFreeRatio"] as const;
type NumericField = (typeof CONCURRENCY_FIELDS)[number] | (typeof DISK_FIELDS)[number];

/**
 * `/settings/storage`: usage totals, and the instance parameters where they live in local
 * mode (the local user is admin). Server mode keeps instance parameters in the admin area,
 * pointed to for administrators only, and shows each user their own storage.
 * The desktop client also owns the cache directory, lists burn products
 * not yet saved and offers the credential reset, which server mode keeps in
 * the admin area.
 */
export function StorageSection() {
  const { t } = useTranslation();
  const version = useVersion();
  const admin = useIsServerAdmin();
  const server = version.data?.mode === "server";
  const desktop = useDesktop();
  return (
    <div>
      {server ? (
        <>
          {admin ? <p className="mb-4 text-sm text-muted">{t("settings.storage.serverHint")}</p> : null}
          <MyStorageBlock />
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">{t("settings.storage.intro")}</p>
          {version.isPending ? <Loading /> : <InstanceSettingsEditor lowWaterHint />}
        </>
      )}
      {desktop ? (
        <>
          <CacheLocationBlock />
          <BurnOutputsBlock />
        </>
      ) : null}
      <UsageBlock />
      {desktop ? <CredentialsSection title={t("admin.section.credentials")} /> : null}
    </div>
  );
}

/**
 * The instance parameters editor (admin only; others see why it is unavailable).
 * `lowWaterHint` offers to drop the old free-ratio default, where the media cache lives.
 */
export function InstanceSettingsEditor({ lowWaterHint = false }: { lowWaterHint?: boolean } = {}) {
  const { t } = useTranslation();
  const instance = useInstanceSettings();
  return (
    <>
      {instance.isPending ? <Loading /> : null}
      {instance.data === undefined ? (
        instance.error instanceof ApiError && instance.error.error.class === "forbidden" ? (
          <p className="mb-4 text-sm text-muted">{t("settings.storage.forbidden")}</p>
        ) : (
          <RequestError error={instance.error} />
        )
      ) : (
        <>
          <ConcurrencyBlock settings={instance.data} />
          <InstanceBlock
            settings={instance.data}
            title={t("settings.storage.diskTitle")}
            fields={DISK_FIELDS}
            retention
            {...(lowWaterHint ? { notice: <LowWaterRatioHint settings={instance.data} /> } : {})}
          />
        </>
      )}
    </>
  );
}

/** Anchor of the concurrency block; the task panel's "adjust" link lands here. */
const CONCURRENCY_ANCHOR = "concurrency";

/**
 * The concurrency setting: only the number of Tasks processed at once, since model requests
 * and local heavy work are paced by the system. Arriving through `#concurrency` scrolls here and focuses the
 * first editable input once per navigation: the block only mounts after the settings
 * arrived, so the anchor is in place by then, and later refetches do not pull the page back.
 */
function ConcurrencyBlock({ settings }: { settings: InstanceSettingsDto }) {
  const { t } = useTranslation();
  const location = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (location.hash !== `#${CONCURRENCY_ANCHOR}` || handled.current === location.key) return;
    handled.current = location.key;
    const block = anchor.current;
    if (block === null) return;
    // jsdom has no layout and therefore no scrollIntoView.
    if (typeof block.scrollIntoView === "function") block.scrollIntoView({ block: "start" });
    block.querySelector<HTMLInputElement>("input:not([disabled])")?.focus();
  }, [location.hash, location.key]);
  return (
    <div id={CONCURRENCY_ANCHOR} ref={anchor} data-testid="instance-concurrency">
      <InstanceBlock settings={settings} title={t("settings.storage.concurrencyTitle")} intro={t("settings.storage.concurrencyIntro")} fields={CONCURRENCY_FIELDS} singleColumn />
    </div>
  );
}

function isConcurrencyKey(key: NumericField): key is ConcurrencyKey {
  return key in CONCURRENCY_LIMITS;
}

/** Whether `text` is an accepted value for `key`; concurrency takes whole numbers within its range. */
function validValue(key: NumericField, text: string): boolean {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) return false;
  return !isConcurrencyKey(key) || (Number.isInteger(value) && value >= 1 && value <= CONCURRENCY_LIMITS[key]);
}

/**
 * One block of instance parameters with its own save, which PATCHes only the fields of this
 * block the user changed; values set by environment variables stay read-only.
 */
function InstanceBlock(props: {
  settings: InstanceSettingsDto;
  title: string;
  intro?: string;
  fields: readonly NumericField[];
  retention?: boolean;
  /** One field per row, for fields whose hints are too long to pair. */
  singleColumn?: boolean;
  /** Shown above the fields. */
  notice?: ReactNode;
}) {
  const { settings } = props;
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Partial<Record<NumericField, string>>>({});
  const [retention, setRetention] = useState<UploadRetentionPolicy | undefined>(undefined);
  const locked = (key: InstanceSettingKey): boolean => settings.envOverridden.includes(key);
  const patch: InstanceSettingsPatch = {};
  let invalid = false;
  for (const key of props.fields) {
    const text = draft[key];
    if (text === undefined || locked(key)) continue;
    if (validValue(key, text)) {
      patch[key] = Number(text);
    } else {
      invalid = true;
    }
  }
  if (props.retention === true && retention !== undefined && !locked("uploadRetentionDefault")) {
    patch.uploadRetentionDefault = retention;
  }
  const save = useMutation({
    mutationFn: () => client.patch("/api/instance-settings", instanceSettingsDtoSchema, { body: patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.instanceSettings, next);
      setDraft({});
      setRetention(undefined);
    },
  });
  const hint = (key: NumericField): string | undefined => {
    const range = isConcurrencyKey(key)
      ? t(`settings.storage.${key}Hint`, { max: CONCURRENCY_LIMITS[key] })
      : key === "maxDataGB"
        ? t("settings.storage.maxDataGBHint")
        : undefined;
    if (!locked(key)) return range;
    return range === undefined ? t("settings.storage.fromEnv") : `${t("settings.storage.fromEnv")} · ${range}`;
  };
  return (
    <SettingsBlock title={props.title} {...(props.intro === undefined ? {} : { intro: props.intro })}>
      {props.notice}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid && Object.keys(patch).length > 0) save.mutate();
        }}
      >
        <div className={props.singleColumn === true ? "grid grid-cols-1" : "grid grid-cols-1 gap-x-4 sm:grid-cols-2"}>
          {props.fields.map((key) => {
            const text = draft[key];
            const bad = text !== undefined && !locked(key) && !validValue(key, text);
            return (
              <Field key={key} label={t(`settings.storage.${key}`)} hint={hint(key)} htmlFor={`instance-${key}`}>
                <input
                  id={`instance-${key}`}
                  className={INPUT_CLASS}
                  disabled={locked(key)}
                  aria-invalid={bad || undefined}
                  value={text ?? String(settings[key])}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  {...(isConcurrencyKey(key) ? { type: "number", min: 1, max: CONCURRENCY_LIMITS[key], step: 1 } : { inputMode: "decimal" as const })}
                />
              </Field>
            );
          })}
          {props.retention === true ? (
            <Field
              label={t("settings.storage.uploadRetentionDefault")}
              hint={locked("uploadRetentionDefault") ? t("settings.storage.fromEnv") : undefined}
              htmlFor="instance-retention"
            >
              <select
                id="instance-retention"
                className={INPUT_CLASS}
                disabled={locked("uploadRetentionDefault")}
                value={retention ?? settings.uploadRetentionDefault}
                onChange={(event) => setRetention(event.target.value as UploadRetentionPolicy)}
              >
                {UPLOAD_RETENTION_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {t(`settings.storage.retention.${policy}`)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
        <RequestError error={save.error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={invalid || Object.keys(patch).length === 0 || save.isPending}>
            {t("common.action.save")}
          </Button>
        </div>
      </form>
    </SettingsBlock>
  );
}

/**
 * The free-ratio default of earlier versions, when the media cache still had a size cap of its
 * own. Installations keep the value they saved, so the hint below offers to drop it; this is
 * a historical value to recognise, not a default.
 */
const LEGACY_LOW_WATER_FREE_RATIO = 0.2;
const LOW_WATER_HINT_KEY = "amber.settings.lowWaterRatioHint";

function lowWaterHintDismissed(): boolean {
  try {
    return localStorage.getItem(LOW_WATER_HINT_KEY) === "dismissed";
  } catch {
    return false;
  }
}

/**
 * Offers to drop the old free-ratio default: with an uncapped cache, a fifth of a large disk
 * kept free would stop caching long before the disk is anywhere near full. The saved value is
 * never changed without the click; "do not show again" is remembered by this browser.
 */
function LowWaterRatioHint({ settings }: { settings: InstanceSettingsDto }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(lowWaterHintDismissed);
  const apply = useMutation({
    mutationFn: () => client.patch("/api/instance-settings", instanceSettingsDtoSchema, { body: { lowWaterFreeRatio: 0 } }),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.instanceSettings, next),
  });
  if (dismissed || settings.lowWaterFreeRatio !== LEGACY_LOW_WATER_FREE_RATIO || settings.envOverridden.includes("lowWaterFreeRatio")) {
    return null;
  }
  const gb = settings.lowWaterFreeGB;
  return (
    <div className="mb-3 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm" role="status" data-testid="low-water-hint">
      <p>{t("settings.storage.lowWaterHint.text", { gb })}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={apply.isPending} data-testid="low-water-hint-apply" onClick={() => apply.mutate()}>
          {t("settings.storage.lowWaterHint.apply", { gb })}
        </Button>
        <Button
          size="sm"
          data-testid="low-water-hint-dismiss"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(LOW_WATER_HINT_KEY, "dismissed");
            } catch {
              // Private mode without storage: the hint stays away for this visit only.
            }
          }}
        >
          {t("settings.storage.lowWaterHint.dismiss")}
        </Button>
      </div>
      <RequestError error={apply.error} />
    </div>
  );
}

/** Server mode: the caller's uploads against their limit, or against the shared pool when there is none. */
function MyStorageBlock() {
  const { t } = useTranslation();
  const client = useApi();
  const storage = useQuery({ queryKey: ["storage"], queryFn: () => client.get("/api/storage", storageDtoSchema) });
  const data = storage.data;
  const limitBytes = data?.storageLimitGB === undefined ? undefined : data.storageLimitGB * BYTES_PER_GB;
  return (
    <SettingsBlock title={t("settings.storage.mine.title")}>
      {storage.isPending ? <Loading /> : null}
      <RequestError error={storage.error} />
      {data === undefined ? null : limitBytes === undefined ? (
        <p className="text-sm" data-testid="my-storage">
          {t("settings.storage.mine.unlimited", { used: formatBytes(data.usedBytes) })}
        </p>
      ) : (
        <div data-testid="my-storage">
          <p className="mb-2 text-sm">
            {t("settings.storage.mine.limited", {
              used: formatBytes(data.usedBytes),
              limit: `${data.storageLimitGB} GB`,
              remaining: formatBytes(limitBytes - data.usedBytes),
            })}
          </p>
          <div
            role="progressbar"
            aria-label={t("settings.storage.mine.title")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round((data.usedBytes / limitBytes) * 100))}
            className="h-2 overflow-hidden rounded-full bg-sunken"
          >
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, (data.usedBytes / limitBytes) * 100)}%` }} />
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{t("settings.storage.mine.hint")}</p>
    </SettingsBlock>
  );
}

/** Whether a cache move still holds the location: copying, or clearing the old files afterwards. */
function cacheMigrating(location: CacheLocationDto | undefined): boolean {
  return location?.migration?.phase === "copying" || location?.migration?.phase === "cleanup_pending";
}

/**
 * The shell's folder commands refuse a cache location as `cache_dir:<reason>: <detail>`;
 * that becomes the same `invalid_request.cache_dir` error the sidecar sends,
 * with the reason's text. Anything else is shown as before.
 */
export function cacheDirFailure(error: unknown, t: TFunction): AppError {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  const reason = text === undefined ? undefined : /^cache_dir:([a-z_]+):/u.exec(text)?.[1];
  if (reason === undefined) {
    return appErrorOf(error);
  }
  return {
    class: "invalid_request",
    code: "invalid_request.cache_dir",
    retryDisposition: "never",
    userMessage: t(`cacheDirErrors.${isCacheDirReason(reason) ? reason : "unknown"}`),
    ...(isCacheDirReason(reason) ? { details: { reason } } : {}),
  };
}

/**
 * The cache line: what Amber cached, the free space left on its volume, and the free space
 * below which new caches stop, the larger of the absolute floor and the volume ratio. A
 * directory that is not there has no volume to describe.
 */
function cacheUsageText(data: CacheLocationDto, settings: InstanceSettingsDto | undefined, t: TFunction): string {
  const used = { used: formatBytes(data.usedBytes), count: data.fileCount };
  if (!data.available) return t("settings.storage.cache.usage", used);
  const free = formatBytes(data.freeBytes);
  if (settings === undefined) return t("settings.storage.cache.usageWithFree", { ...used, free });
  const floor = Math.max(settings.lowWaterFreeGB * BYTES_PER_GB, data.totalBytes * settings.lowWaterFreeRatio);
  return t("settings.storage.cache.usageWithFloor", { ...used, free, floor: formatBytes(floor) });
}

/**
 * Interrupted cache replacements the start-up recovery could not settle: the user keeps the
 * file now at the path or restores the displaced copy, after which the entry disappears.
 * Keeping deletes the displaced copy, so it asks first; with no file at the path there is
 * nothing to keep and only restoring is offered.
 */
function CacheHolds({ holds }: { holds: readonly CacheHoldDto[] }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const settle = useMutation({
    mutationFn: ({ assetId, action }: { assetId: string; action: "keep" | "restore" }) =>
      client.post(`/api/media/cache-location/holds/${encodeURIComponent(assetId)}/${action}`, z.undefined()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: cacheLocationKey }),
  });
  const size = (bytes: number | undefined) => (bytes === undefined ? t("settings.storage.cache.holds.unknownSize") : formatBytes(bytes));
  return (
    <div className="mt-3 rounded-md border border-line p-3" data-testid="cache-holds">
      <p className="text-sm font-medium">{t("settings.storage.cache.holds.title")}</p>
      <p className="mt-1 text-xs text-muted">{t("settings.storage.cache.holds.intro")}</p>
      <ul className="mt-2 flex flex-col divide-y divide-line">
        {holds.map((hold) => (
          <li key={hold.assetId} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="cache-hold">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{hold.title ?? hold.fileName}</span>
              <span className="block truncate font-mono text-xs text-muted">{hold.fileName}</span>
            </span>
            <span className="text-xs text-muted">
              {hold.currentSizeBytes === undefined
                ? t("settings.storage.cache.holds.currentMissing")
                : t("settings.storage.cache.holds.current", { size: formatBytes(hold.currentSizeBytes) })}
            </span>
            <span className="text-xs text-muted">{t("settings.storage.cache.holds.displaced", { size: size(hold.displacedSizeBytes) })}</span>
            {hold.currentSizeBytes === undefined ? null : (
              <ConfirmButton
                label={t("settings.storage.cache.holds.keep")}
                message={t("settings.storage.cache.holds.keepConfirm", { fileName: hold.fileName })}
                variant="danger"
                disabled={settle.isPending}
                testId={`cache-hold-keep-${hold.assetId}`}
                onConfirm={() => settle.mutate({ assetId: hold.assetId, action: "keep" })}
              />
            )}
            <Button
              size="sm"
              disabled={settle.isPending}
              data-testid={`cache-hold-restore-${hold.assetId}`}
              onClick={() => settle.mutate({ assetId: hold.assetId, action: "restore" })}
            >
              {t("settings.storage.cache.holds.restore")}
            </Button>
          </li>
        ))}
      </ul>
      <RequestError error={settle.error} />
    </div>
  );
}

/** Where the user moves the cache to: a picked folder or back to the data directory. */
type CacheTarget = { kind: "move"; picked: PickedFile } | { kind: "default" };

/**
 * Desktop client: the cache directory of platform videos and audio.
 * Choosing a folder or the default starts the move at once; it copies every cached file,
 * and while it runs the page polls and the controls are locked. When it ends, the `localPath` of every
 * Content the page may hold points at the old root, so the Content queries are re-read.
 */
function CacheLocationBlock() {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const location = useQuery({
    queryKey: cacheLocationKey,
    queryFn: () => client.get("/api/media/cache-location", cacheLocationDtoSchema),
    refetchInterval: (query) => (cacheMigrating(query.state.data) ? CACHE_MIGRATION_REFRESH_MS : false),
  });
  const data = location.data;
  // Only for the free-space floor in the usage line; without it the line just leaves the floor out.
  const instance = useInstanceSettings();
  const busy = cacheMigrating(data);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void queryClient.invalidateQueries({ queryKey: ["content"] });
    }
    wasBusy.current = busy;
  }, [busy, queryClient]);
  const open = useMutation({ mutationFn: (path: string) => openFolder(path) });
  const change = useMutation({
    mutationFn: async (next: CacheTarget) => {
      // The shell creates the directory and admits it to the asset scope only for the folder the user picked.
      if (next.kind === "move") await allowCacheDir(next.picked.grant);
      const body: CacheLocationPut = next.kind === "move" ? { path: next.picked.path, grant: next.picked.grant } : { useDefault: true };
      return client.put("/api/media/cache-location", cacheLocationDtoSchema, { body });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(cacheLocationKey, next);
      // An unavailable source switches at once without a copy; the cached paths changed all the same.
      if (!cacheMigrating(next)) void queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
  const choose = useMutation({
    mutationFn: pickCacheDir,
    onSuccess: (picked) => {
      if (picked !== null) change.mutate({ kind: "move", picked });
    },
  });
  const locked = busy || choose.isPending || change.isPending;
  const failure = choose.error ?? open.error ?? change.error;
  return (
    <SettingsBlock title={t("settings.storage.cache.title")} intro={t("settings.storage.cache.intro")}>
      {location.isPending ? <Loading /> : null}
      <RequestError error={location.error} />
      {data === undefined ? null : (
        <div data-testid="cache-location">
          <p className="text-xs text-muted">{t("settings.storage.cache.location")}</p>
          <p className="mb-2 font-mono text-sm break-all" data-testid="cache-path">
            {data.path}
          </p>
          <p className="text-sm" data-testid="cache-usage">
            {cacheUsageText(data, instance.data, t)}
          </p>
          {data.available ? null : (
            <div className="mt-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm" role="alert" data-testid="cache-unavailable">
              <p className="font-medium text-danger">{t("settings.storage.cache.unavailable")}</p>
              <p className="mt-1">{t("settings.storage.cache.unavailableHint")}</p>
            </div>
          )}
          {data.holds.length === 0 ? null : <CacheHolds holds={data.holds} />}
          {data.migration?.phase === "copying" ? (
            <p className="mt-2 text-sm" role="status" data-testid="cache-progress">
              {t("settings.storage.cache.copying", {
                copied: formatBytes(data.migration.copiedBytes),
                total: formatBytes(data.migration.totalBytes),
                count: data.migration.fileCount,
              })}
            </p>
          ) : null}
          {data.migration?.phase === "cleanup_pending" ? (
            <p className="mt-2 text-sm" role="status" data-testid="cache-progress">
              {t("settings.storage.cache.cleanupPending")}
            </p>
          ) : null}
          {data.migration?.phase === "failed" ? (
            <div className="mt-2" data-testid="cache-failed">
              <p className="mb-1 text-sm">{t("settings.storage.cache.failed")}</p>
              <ErrorView error={data.migration.error} />
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={!data.available || locked || open.isPending} onClick={() => open.mutate(data.path)}>
              {t("settings.storage.cache.openFolder")}
            </Button>
            <Button size="sm" disabled={locked} onClick={() => choose.mutate()}>
              {t("settings.storage.cache.change")}
            </Button>
            {data.isDefault ? null : (
              <Button size="sm" disabled={locked} onClick={() => change.mutate({ kind: "default" })}>
                {t("settings.storage.cache.restoreDefault")}
              </Button>
            )}
          </div>
        </div>
      )}
      {failure === null ? null : (
        <div className="mt-2">
          <ErrorView error={cacheDirFailure(failure, t)} />
        </div>
      )}
    </SettingsBlock>
  );
}

/** Desktop client: burn products waiting in the data directory, to save elsewhere or delete. */
function BurnOutputsBlock() {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const outputs = useBurnOutputs(true);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const refresh = () => queryClient.invalidateQueries({ queryKey: burnOutputsKey });
  const save = useMutation({
    mutationFn: (input: { assetId: string; title: string; mimeType: string }) => saveBurnProduct(client, input.assetId, burnFileName(input.title, input.mimeType)),
    onMutate: () => setNotice(undefined),
    onSuccess: async (saved) => {
      setNotice(saved === null ? undefined : t("settings.storage.burnOutputs.saved", { path: saved.savedPath }));
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (assetId: string) => deleteBurnProduct(client, assetId),
    onMutate: () => setNotice(undefined),
    onSuccess: refresh,
  });
  useAutoDismiss(notice, () => setNotice(undefined));
  const items = outputs.data ?? [];
  return (
    <SettingsBlock title={t("settings.storage.burnOutputs.title")} intro={t("settings.storage.burnOutputs.intro")}>
      {outputs.isPending ? <Loading /> : null}
      <RequestError error={outputs.error} />
      {outputs.data !== undefined && items.length === 0 ? <p className="text-sm text-muted">{t("settings.storage.burnOutputs.empty")}</p> : null}
      {items.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-line" data-testid="burn-outputs">
          {items.map((item) => {
            const title = item.title ?? t("settings.storage.burnOutputs.untitled");
            const format = burnOutputFormat(item.mimeType);
            return (
              <li key={item.assetId} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="burn-output">
                <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
                {format === undefined ? null : (
                  <span className="rounded border border-line px-1 text-xs text-muted" data-testid="burn-output-format">
                    {t(`settings.storage.burnOutputs.format.${format}`)}
                  </span>
                )}
                <span className="text-xs text-muted">{formatBytes(item.sizeBytes)}</span>
                <span className="text-xs text-muted">{formatDateTime(item.createdAt, i18n.language)}</span>
                <Button size="sm" disabled={save.isPending || remove.isPending} onClick={() => save.mutate({ assetId: item.assetId, title, mimeType: item.mimeType })}>
                  {t("settings.storage.burnOutputs.saveAs")}
                </Button>
                <ConfirmButton
                  label={t("common.action.delete")}
                  variant="danger"
                  disabled={save.isPending || remove.isPending}
                  message={t("settings.storage.burnOutputs.deleteConfirm", { title })}
                  onConfirm={() => remove.mutate(item.assetId)}
                />
              </li>
            );
          })}
        </ul>
      )}
      {notice === undefined ? null : (
        <p className="mt-2 flex items-center gap-2 text-xs text-ok" role="status" data-testid="burn-output-saved">
          <span className="min-w-0 break-all">{notice}</span>
          <button type="button" className="shrink-0 rounded p-0.5 text-muted hover:bg-sunken" aria-label={t("common.action.close")} onClick={() => setNotice(undefined)}>
            <X size={12} />
          </button>
        </p>
      )}
      {save.error === null ? null : (
        <div className="mt-2">
          <ErrorView error={appErrorOf(save.error)} />
        </div>
      )}
      <RequestError error={remove.error} />
    </SettingsBlock>
  );
}

/** Totals over all recorded calls; user-entered prices are never applied to them. */
function UsageBlock() {
  const { t } = useTranslation();
  const client = useApi();
  const usage = useQuery({ queryKey: [...queryKeys.usage, "totals"], queryFn: () => client.get("/api/usage?limit=1", usageDtoSchema) });
  const totals = usage.data?.totals ?? [];
  return (
    <SettingsBlock title={t("settings.storage.usageTitle")}>
      {usage.isPending ? <Loading /> : null}
      <RequestError error={usage.error} />
      {usage.data !== undefined && totals.length === 0 ? <p className="text-sm text-muted">{t("settings.storage.usageEmpty")}</p> : null}
      {totals.length === 0 ? null : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-1 font-medium">{t("settings.storage.usageModel")}</th>
              <th className="pb-1 font-medium">{t("settings.storage.usageFeature")}</th>
              <th className="pb-1 font-medium">{t("settings.storage.usageCalls")}</th>
              <th className="pb-1 font-medium">{t("settings.storage.usageTokens")}</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((total, index) => (
              <tr key={index} className="border-t border-line">
                <td className="py-1">{total.kind === "llm" ? `${total.modelRef.providerNameSnapshot} · ${total.modelRef.modelDisplaySnapshot}` : `${total.provider} · ${total.model}`}</td>
                <td className="py-1">{total.kind === "llm"
                    ? t(`settings.storage.feature.${total.feature}`)
                    : total.feature === "test_connection"
                      ? t("settings.storage.feature.test_connection")
                      : t("settings.storage.usageAsr")}</td>
                <td className="py-1">{total.calls}</td>
                <td className="py-1">
                  {total.kind === "llm"
                    ? `${total.inputTokens ?? "—"} / ${total.outputTokens ?? "—"}`
                    : `${t("settings.storage.usageAudio")} ${formatDuration(total.audioMs)}`}
                  {total.incomplete ? <span className="ml-1 text-xs text-muted" title={t("settings.storage.usageIncomplete")}>*</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsBlock>
  );
}
