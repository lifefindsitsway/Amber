import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { z } from "zod";
import {
  asrModelTestResultDtoSchema,
  asrProbeDtoSchema,
  asrProfileDtoSchema,
  asrProfileListDtoSchema,
  type AsrProfileCreate,
  type AsrProfilePatch,
} from "../../shared/dto/asr-profile.ts";
import { collectionDetailDtoSchema, collectionListDtoSchema, type CollectionPatchRequest } from "../../shared/dto/collection.ts";
import { contentDtoSchema, contentListDtoSchema, type ContentListDto, type ContentPatchRequest } from "../../shared/dto/content.ts";
import type { ModelPricingRequest } from "../../shared/dto/model-pricing.ts";
import {
  otherModelProfileDtoSchema,
  otherModelProfileListDtoSchema,
  type OtherModelProfileCreate,
  type OtherModelProfilePatch,
} from "../../shared/dto/other-model.ts";
import { platformAccountListDtoSchema } from "../../shared/dto/platform-account.ts";
import { providerListDtoSchema, providerProfileDtoSchema } from "../../shared/dto/provider.ts";
import { instanceSettingsDtoSchema } from "../../shared/dto/instance-settings.ts";
import { userSettingsDtoSchema, type UserSettingsDto, type UserSettingsPatch } from "../../shared/dto/settings.ts";
import { authMeDtoSchema, setupStatusDtoSchema, versionDtoSchema } from "../../shared/dto/system.ts";
import { TASK_HISTORY_HIDE_MAX, TASK_HISTORY_PAGE_SIZE } from "../../shared/defaults.ts";
import {
  taskHistoryHiddenDtoSchema,
  taskHistoryRestoredDtoSchema,
  taskListDtoSchema,
  type TaskHistoryHideRequest,
  type TaskHistoryRestoreRequest,
  type TaskListDto,
} from "../../shared/dto/task.ts";
import {
  decodeModelKey,
  usageActivitiesResponseSchema,
  usageCacheObservedResponseSchema,
  usageCallsResponseSchema,
  usageSummaryResponseSchema,
  type UsageActivitiesQuery,
  type UsageCallsQuery,
  type UsageSummaryQuery,
} from "../../shared/dto/usage-analytics.ts";
import { webSearchProfileDtoSchema, webSearchTestResultSchema, type WebSearchProfilePut } from "../../shared/dto/web-search.ts";
import { noteKeys } from "../notes/note-keys.ts";
import { useApi } from "./context.tsx";

/**
 * Query keys shared across areas. Feature modules add their own keys under a distinct
 * first segment; task events invalidate by these prefixes.
 */
export const queryKeys = {
  version: ["version"] as const,
  me: ["me"] as const,
  setup: ["setup"] as const,
  settings: ["settings"] as const,
  contents: (filters: ContentFilters = {}) => ["contents", filters] as const,
  contentsAll: ["contents"] as const,
  content: (id: string) => ["content", id] as const,
  collections: ["collections"] as const,
  collection: (id: string) => ["collection", id] as const,
  collectionDetails: ["collection"] as const,
  providers: ["providers"] as const,
  asrProfiles: ["asr-profiles"] as const,
  otherModels: ["other-models"] as const,
  /** Every usage read (totals and pages). */
  usage: ["usage"] as const,
  platformAccounts: ["platform-accounts"] as const,
  /** Every task list read (the unfinished tasks and the finished-task history). */
  tasksAll: ["tasks"] as const,
  unfinishedTasks: ["tasks", "unfinished"] as const,
  taskHistory: ["tasks", "history"] as const,
  instanceSettings: ["instance-settings"] as const,
  /** Every trash read (the list and its pages). */
  trash: ["trash"] as const,
  webSearch: ["web-search"] as const,
};

export interface ContentFilters {
  status?: string;
  source?: string;
  collectionId?: string;
  /** Only Contents that belong to no collection. */
  uncollected?: boolean;
  importBatchId?: string;
  limit?: number;
  /** Numbered page (1-based) of `limit` rows; never sent together with a cursor. */
  page?: number;
  /** Comma-separated Content ids: only these, at most `CONTENT_LIST_IDS_MAX`. */
  ids?: string;
}

/** Empty and `false` values are left out; `true` is sent as the API's `1` flag. */
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "" && value !== false) {
      search.set(key, value === true ? "1" : String(value));
    }
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

export function useVersion() {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.version, queryFn: () => client.get("/api/version", versionDtoSchema), staleTime: Infinity });
}

export function useMe() {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.me, queryFn: () => client.get("/api/auth/me", authMeDtoSchema, { authRedirect: false }), staleTime: Infinity });
}

/**
 * Whether the server instance still awaits its first administrator.
 * `GET /api/setup` answers `{ initialized: true }` to anyone once initialized; before that
 * a request without the setup token gets 401 `unauthenticated.setup_token`. Local mode does
 * not register the route (404). The 401 is expected here, so it must not end the session.
 */
export function useSetupStatus() {
  const client = useApi();
  return useQuery({
    queryKey: queryKeys.setup,
    queryFn: () => client.get("/api/setup", setupStatusDtoSchema, { authRedirect: false }),
    staleTime: Infinity,
    retry: false,
  });
}

/** The user's platform logins, one row per supported platform. */
export function usePlatformAccounts() {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.platformAccounts, queryFn: () => client.get("/api/platform-accounts", platformAccountListDtoSchema) });
}

export function useSettings() {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => client.get("/api/settings", userSettingsDtoSchema) });
}

export function usePatchSettings() {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UserSettingsPatch) => client.patch("/api/settings", userSettingsDtoSchema, { body: patch }),
    onSuccess: (settings: UserSettingsDto) => queryClient.setQueryData(queryKeys.settings, settings),
  });
}

export function useContents(filters: ContentFilters = {}) {
  const client = useApi();
  return useQuery<ContentListDto>({
    queryKey: queryKeys.contents(filters),
    queryFn: () => client.get(`/api/contents${queryString({ ...filters })}`, contentListDtoSchema),
  });
}

export function useCollections() {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.collections, queryFn: () => client.get("/api/collections", collectionListDtoSchema) });
}

export function useProviders() {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.providers, queryFn: () => client.get("/api/providers", providerListDtoSchema) });
}

/** The user's ASR profiles in their own order, each with its models. */
export function useAsrProfiles(enabled = true) {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.asrProfiles, queryFn: () => client.get("/api/asr-profiles", asrProfileListDtoSchema), enabled });
}

/**
 * Writes to the ASR profiles. Each refreshes the list and the settings, whose default may
 * have been cleared together with a deleted profile or a removed model.
 */
export function useAsrProfileMutations() {
  const client = useApi();
  const queryClient = useQueryClient();
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.asrProfiles });
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  };
  const path = (id: string): string => `/api/asr-profiles/${encodeURIComponent(id)}`;
  return {
    create: useMutation({
      mutationFn: (body: AsrProfileCreate) => client.post("/api/asr-profiles", asrProfileDtoSchema, { body }),
      onSuccess: refresh,
    }),
    patch: useMutation({
      mutationFn: (input: { id: string; patch: AsrProfilePatch }) => client.patch(path(input.id), asrProfileDtoSchema, { body: input.patch }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.delete(path(id), z.undefined()),
      onSuccess: refresh,
    }),
    credential: useMutation({
      mutationFn: (input: { id: string; value: string }) => client.put(`${path(input.id)}/credential`, asrProfileDtoSchema, { body: { value: input.value } }),
      onSuccess: refresh,
    }),
    probe: useMutation({
      mutationFn: (id: string) => client.post(`${path(id)}/probe`, asrProbeDtoSchema),
    }),
  };
}

/**
 * "Test connection" of one ASR model: transcribes a short generated sound, so
 * it may cost a little; each row holds its own mutation, so rows test independently. The
 * profile list is refreshed for the stored test time, the usage for the recorded call.
 */
export function useAsrModelTest(profileId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) =>
      client.post(`/api/asr-profiles/${encodeURIComponent(profileId)}/test`, asrModelTestResultDtoSchema, { body: { modelId } }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.asrProfiles });
      await queryClient.invalidateQueries({ queryKey: queryKeys.usage });
    },
  });
}

/** Profile resources whose models carry a user-entered price. */
export type PricedResource = "providers" | "asr-profiles" | "other-models";

const PRICED_RESOURCE_KEYS: Record<PricedResource, readonly string[]> = {
  providers: queryKeys.providers,
  "asr-profiles": queryKeys.asrProfiles,
  "other-models": queryKeys.otherModels,
};

/** Sets (or with `pricing: null` clears) one model's price; the model id travels in the body. */
export function useSetModelPricing(resource: PricedResource) {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { profileId: string } & ModelPricingRequest): Promise<void> => {
      const path = `/api/${resource}/${encodeURIComponent(input.profileId)}/model-pricing`;
      const options = { body: { modelId: input.modelId, pricing: input.pricing } };
      // Each answers with its own updated profile; the list is re-read below.
      if (resource === "providers") await client.put(path, providerProfileDtoSchema, options);
      else if (resource === "asr-profiles") await client.put(path, asrProfileDtoSchema, options);
      else await client.put(path, otherModelProfileDtoSchema, options);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PRICED_RESOURCE_KEYS[resource] }),
  });
}

/** The user's register of models Amber does not call, in their own order. */
export function useOtherModels() {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.otherModels, queryFn: () => client.get("/api/other-models", otherModelProfileListDtoSchema) });
}

export function useOtherModelMutations() {
  const client = useApi();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.otherModels });
  const path = (id: string): string => `/api/other-models/${encodeURIComponent(id)}`;
  return {
    create: useMutation({
      mutationFn: (body: OtherModelProfileCreate) => client.post("/api/other-models", otherModelProfileDtoSchema, { body }),
      onSuccess: refresh,
    }),
    patch: useMutation({
      mutationFn: (input: { id: string; patch: OtherModelProfilePatch }) => client.patch(path(input.id), otherModelProfileDtoSchema, { body: input.patch }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.delete(path(id), z.undefined()),
      onSuccess: refresh,
    }),
  };
}

export function useUnfinishedTasks() {
  const client = useApi();
  return useQuery({
    queryKey: queryKeys.unfinishedTasks,
    queryFn: () => client.get("/api/tasks?unfinished=1", taskListDtoSchema),
  });
}

/**
 * The task panel's history: finished tasks the user has not removed from it, newest first,
 * one page of `TASK_HISTORY_PAGE_SIZE` at a time.
 */
export function useTaskHistory() {
  const client = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.taskHistory,
    queryFn: ({ pageParam, signal }) =>
      client.get(`/api/tasks${queryString({ history: true, limit: TASK_HISTORY_PAGE_SIZE, cursor: pageParam })}`, taskListDtoSchema),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** What removing tasks from the history did: how many were hidden and the batches that undo it. */
export interface HistoryRemoval {
  hidden: number;
  batchIds: string[];
}

type HistoryPages = InfiniteData<TaskListDto, string | undefined>;

/** Applies `edit` to every loaded history page; `undefined` data (nothing loaded) stays so. */
function editHistory(data: HistoryPages | undefined, edit: (page: TaskListDto) => TaskListDto): HistoryPages | undefined {
  return data === undefined ? undefined : { ...data, pages: data.pages.map(edit) };
}

/**
 * The shared shape of the history mutations: the visible list is changed at once, put back
 * when the call fails, and read again from the server either way (the server alone knows
 * which tasks a removal really hid).
 */
function useHistoryMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
  optimistic: (data: HistoryPages | undefined, input: TInput) => HistoryPages | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TInput, { previous: HistoryPages | undefined }>({
    mutationFn,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.taskHistory });
      const previous = queryClient.getQueryData<HistoryPages>(queryKeys.taskHistory);
      queryClient.setQueryData<HistoryPages | undefined>(queryKeys.taskHistory, optimistic(previous, input));
      return { previous };
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData(queryKeys.taskHistory, context?.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.taskHistory }),
  });
}

/**
 * Removes finished tasks from the task panel's history; the tasks and their results stay.
 * One request takes at most `TASK_HISTORY_HIDE_MAX` ids, so a longer selection goes out in
 * several, each with its own undo batch.
 */
export function useHideTaskHistory() {
  const client = useApi();
  return useHistoryMutation<string[], HistoryRemoval>(
    async (taskIds) => {
      const removal: HistoryRemoval = { hidden: 0, batchIds: [] };
      for (let from = 0; from < taskIds.length; from += TASK_HISTORY_HIDE_MAX) {
        const body: TaskHistoryHideRequest = { taskIds: taskIds.slice(from, from + TASK_HISTORY_HIDE_MAX) };
        const answer = await client.post("/api/tasks/history/hide", taskHistoryHiddenDtoSchema, { body });
        removal.hidden += answer.hidden;
        if (answer.hidden > 0) removal.batchIds.push(answer.batchId);
      }
      return removal;
    },
    (data, taskIds) => {
      const gone = new Set(taskIds);
      return editHistory(data, (page) => ({ ...page, items: page.items.filter((task) => !gone.has(task.id)) }));
    },
  );
}

/** Removes every task the history lists from it (the server decides the range). */
export function useClearTaskHistory() {
  const client = useApi();
  return useHistoryMutation<void, HistoryRemoval>(
    async () => {
      const answer = await client.post("/api/tasks/history/clear", taskHistoryHiddenDtoSchema);
      return { hidden: answer.hidden, batchIds: answer.hidden > 0 ? [answer.batchId] : [] };
    },
    // Nothing is left to page through, so the cursor goes with the items.
    (data) => editHistory(data, ({ nextCursor: _cursor, ...page }) => ({ ...page, items: [] })),
  );
}

/** Puts back exactly the tasks the given removals hid. */
export function useRestoreTaskHistory() {
  const client = useApi();
  return useHistoryMutation<string[], number>(
    async (batchIds) => {
      let restored = 0;
      for (const batchId of batchIds) {
        const body: TaskHistoryRestoreRequest = { batchId };
        restored += (await client.post("/api/tasks/history/restore", taskHistoryRestoredDtoSchema, { body })).restored;
      }
      return restored;
    },
    (data) => data,
  );
}

/**
 * Renames (`title`, `null` restores the original) or pins a Content. Every view that shows
 * its title or order is refreshed: lists, the detail and collection lecture lists, and on a
 * rename the notes, whose groups and cards carry the Content's title.
 */
export function usePatchContent() {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contentId: string; patch: ContentPatchRequest }) =>
      client.patch(`/api/contents/${encodeURIComponent(input.contentId)}`, contentDtoSchema, { body: input.patch }),
    onSuccess: async (_content, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.content(input.contentId), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll }),
        input.patch.title === undefined ? undefined : queryClient.invalidateQueries({ queryKey: noteKeys.all }),
      ]);
    },
  });
}

/**
 * Renames a Collection (or changes its description). The detail is replaced with the
 * answer; lists and Content details name their collections, so they are refreshed too.
 */
export function usePatchCollection() {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { collectionId: string; patch: CollectionPatchRequest }) =>
      client.patch(`/api/collections/${encodeURIComponent(input.collectionId)}`, collectionDetailDtoSchema, { body: input.patch }),
    onSuccess: async (updated, input) => {
      queryClient.setQueryData(queryKeys.collection(input.collectionId), updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.collections }),
        queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll }),
        // Only the Content details themselves (`["content", id]`), not their transcripts and artifacts.
        queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "content" && query.queryKey.length === 2 }),
      ]);
    },
  });
}

/** `GET /api/instance-settings` (admin only); disabled for callers who would be refused. */
export function useInstanceSettings(enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: queryKeys.instanceSettings,
    queryFn: () => client.get("/api/instance-settings", instanceSettingsDtoSchema),
    enabled,
  });
}

/** `GET /api/web-search`: the chat's search service and whether its key is stored, never the key. */
export function useWebSearchProfile(enabled = true) {
  const client = useApi();
  return useQuery({ queryKey: queryKeys.webSearch, queryFn: () => client.get("/api/web-search", webSearchProfileDtoSchema), enabled });
}

/**
 * Writes of the web search settings. The key is write-only: it goes out once and only the
 * stored status is read back. "Test" sends one real search, which uses up a search credit.
 */
export function useWebSearchMutations() {
  const client = useApi();
  const queryClient = useQueryClient();
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: queryKeys.webSearch });
  return {
    service: useMutation({
      mutationFn: (body: WebSearchProfilePut) => client.put("/api/web-search", z.unknown(), { body }),
      onSuccess: refresh,
    }),
    credential: useMutation({
      mutationFn: async (input: { value: string; service: WebSearchProfilePut["service"] | undefined; fallback: WebSearchProfilePut["service"] }) => {
        // The row is created by choosing a service; a key alone has nothing to attach to.
        if (input.service === undefined) await client.put("/api/web-search", z.unknown(), { body: { service: input.fallback } });
        await client.put("/api/web-search/credential", z.unknown(), { body: { value: input.value } });
      },
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: () => client.delete("/api/web-search", z.unknown()),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: () => client.post("/api/web-search/test", webSearchTestResultSchema),
    }),
  };
}

/**
 * The usage analysis reads. Each one keeps the previous answer on screen while a changed
 * filter loads, so the page does not collapse into a skeleton on every click.
 */
export function useUsageSummary(query: UsageSummaryQuery) {
  const client = useApi();
  return useQuery({
    queryKey: [...queryKeys.usage, "summary", query] as const,
    queryFn: () => client.get(`/api/usage/summary${queryString({ ...query })}`, usageSummaryResponseSchema),
    placeholderData: keepPreviousData,
  });
}

export function useUsageActivities(query: UsageActivitiesQuery, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: [...queryKeys.usage, "activities", query] as const,
    queryFn: () => client.get(`/api/usage/activities${queryString({ ...query })}`, usageActivitiesResponseSchema),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** The individual calls of one activity group; fetched when its row is expanded. */
export function useUsageCalls(query: UsageCallsQuery, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: [...queryKeys.usage, "calls", query] as const,
    queryFn: () => client.get(`/api/usage/calls${queryString({ ...query })}`, usageCallsResponseSchema),
    enabled,
  });
}

/** LLM models whose calls ever reported a cache read; the price dialog uses it to hint at a missing cache price. */
export function useUsageCacheObserved(enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: [...queryKeys.usage, "cache-observed"] as const,
    queryFn: () => client.get("/api/usage/cache-observed", usageCacheObservedResponseSchema),
    enabled,
  });
}

/** Whether calls of this LLM model have ever reported a cache read. */
export function useCacheObservedModel(profileId: string, modelId: string): boolean {
  const observed = useUsageCacheObserved();
  return (observed.data?.models ?? []).some((entry) => {
    const parts = decodeModelKey(entry.modelKey);
    return parts !== undefined && parts[0] === "llm" && parts[1] === profileId && parts[2] === modelId;
  });
}
