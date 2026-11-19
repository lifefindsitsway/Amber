import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { DANMAKU_FETCH_COOLDOWN_MS } from "../../shared/defaults.ts";
import type { ContentDetailDto } from "../../shared/dto/content.ts";
import { danmakuFetchResultDtoSchema, danmakuSnapshotDtoSchema, type DanmakuFetchResultDto, type DanmakuSnapshot } from "../../shared/dto/danmaku.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys } from "../api/queries.ts";

const COOLDOWN_CODE = "rate_limited.danmaku_cooldown";

/** Under the Content's key, so whatever refreshes the Content reads its snapshot again too (a read, never a platform request). */
export const danmakuKeys = {
  snapshot: (contentId: string) => ["content", contentId, "danmaku"] as const,
  fetch: (contentId: string) => ["danmaku-fetch", contentId] as const,
};

/** The stored snapshot; read only while it is wanted (the layer is on or the popover open). */
export function useDanmakuSnapshot(contentId: string, enabled: boolean) {
  const client = useApi();
  return useQuery({
    queryKey: danmakuKeys.snapshot(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}/danmaku`, danmakuSnapshotDtoSchema),
    enabled,
    // It changes only through a fetch, which writes the answer into the cache itself.
    staleTime: Infinity,
  });
}

/** How the last 「更新弹幕」 of this page went, as the popover says it. */
export type DanmakuFetchOutcome =
  | { kind: "pending" }
  | { kind: "fetched"; count: number; truncated: boolean }
  | { kind: "empty" }
  /** The platform sent nothing usable; `kept` says an earlier snapshot is still shown. */
  | { kind: "failed"; kept: boolean; reason: string | undefined }
  /** Asked again too soon; nothing was sent to the platform. */
  | { kind: "cooldown" }
  /** The request itself failed (the network, the server). */
  | { kind: "error"; reason: string | undefined };

export interface DanmakuFetchState {
  outcome: DanmakuFetchOutcome | undefined;
  /** Until when another request would only be refused, when this page knows. */
  coolUntil: number | undefined;
  fetch: () => void;
}

function retryAfterMsOf(error: ApiError): number {
  const detail = error.error.details?.["retryAfterMs"];
  if (typeof detail === "number" && Number.isFinite(detail) && detail >= 0) return detail;
  if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds * 1000;
  return DANMAKU_FETCH_COOLDOWN_MS;
}

const isCooldown = (error: unknown): error is ApiError => error instanceof ApiError && error.error.code === COOLDOWN_CODE;

const reasonOf = (error: unknown): string | undefined => (error instanceof ApiError && error.error.userMessage !== "" ? error.error.userMessage : undefined);

/**
 * The outcome of a finished request. `hadSnapshot` is whether a snapshot existed before it,
 * for a failed answer that came back without one.
 */
export function outcomeOf(result: DanmakuFetchResultDto, hadSnapshot: boolean): DanmakuFetchOutcome {
  if (result.result === "fetched") return { kind: "fetched", count: result.snapshot?.count ?? 0, truncated: result.truncated === true };
  if (result.result === "empty") return { kind: "empty" };
  if (result.error?.code === COOLDOWN_CODE) return { kind: "cooldown" };
  const reason = result.error === undefined || result.error.userMessage === "" ? undefined : result.error.userMessage;
  return { kind: "failed", kept: result.snapshot !== undefined || hadSnapshot, reason };
}

/** The Content detail's danmaku summary, kept in step with a fetched snapshot. */
function summaryUpdater(snapshot: DanmakuSnapshot | undefined) {
  return (detail: ContentDetailDto | undefined): ContentDetailDto | undefined =>
    detail === undefined || snapshot === undefined ? detail : { ...detail, danmaku: { fetchedAt: snapshot.fetchedAt, count: snapshot.count } };
}

interface FetchVariables {
  hadSnapshot: boolean;
}

/**
 * 「更新弹幕」: one request per call, never repeated by itself. A snapshot that comes back
 * replaces the cached one in one step, so the layer swaps lists without stopping playback.
 * The state is the mutation cache's, so it outlives the popover closing.
 */
export function useDanmakuFetch(contentId: string): DanmakuFetchState {
  const client = useApi();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey: danmakuKeys.fetch(contentId),
    mutationFn: (_variables: FetchVariables) =>
      client.post(`/api/contents/${encodeURIComponent(contentId)}/danmaku/fetch`, danmakuFetchResultDtoSchema, { body: {} }),
    onSuccess: (result) => {
      if (result.snapshot === undefined) return;
      queryClient.setQueryData(danmakuKeys.snapshot(contentId), { supported: true, snapshot: result.snapshot });
      queryClient.setQueryData<ContentDetailDto>(queryKeys.content(contentId), summaryUpdater(result.snapshot));
    },
  });
  const pending = useIsMutating({ mutationKey: danmakuKeys.fetch(contentId) }) > 0;
  const last = useMutationState({
    filters: { mutationKey: danmakuKeys.fetch(contentId) },
    select: (entry) => ({
      status: entry.state.status,
      data: entry.state.data as DanmakuFetchResultDto | undefined,
      error: entry.state.error,
      submittedAt: entry.state.submittedAt,
      hadSnapshot: (entry.state.variables as FetchVariables | undefined)?.hadSnapshot === true,
    }),
  }).at(-1);
  let outcome: DanmakuFetchOutcome | undefined;
  let coolUntil: number | undefined;
  if (pending) {
    outcome = { kind: "pending" };
  } else if (last?.status === "success" && last.data !== undefined) {
    outcome = outcomeOf(last.data, last.hadSnapshot);
    coolUntil = last.submittedAt + DANMAKU_FETCH_COOLDOWN_MS;
  } else if (last?.status === "error") {
    if (isCooldown(last.error)) {
      outcome = { kind: "cooldown" };
      coolUntil = last.submittedAt + retryAfterMsOf(last.error);
    } else {
      outcome = { kind: "error", reason: reasonOf(last.error) };
    }
  }
  const { mutate } = mutation;
  const fetch = useCallback(() => {
    if (pending) return;
    const known = queryClient.getQueryData<{ snapshot?: DanmakuSnapshot }>(danmakuKeys.snapshot(contentId));
    mutate({ hadSnapshot: known?.snapshot !== undefined });
  }, [pending, mutate, queryClient, contentId]);
  return { outcome, coolUntil, fetch };
}
