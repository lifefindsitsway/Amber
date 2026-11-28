import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { COVER_BACKFILL_POLL_MS } from "../../../shared/defaults.ts";
import { coverBackfillStatusDtoSchema, type CoverBackfillJobDto, type CoverBackfillStartRequest, type CoverBackfillStatusDto } from "../../../shared/dto/cover-backfill.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";

export const coverBackfillKey = ["cover-backfill"] as const;

/** Whether the job is still working, so its progress is worth polling. */
export function coverBackfillActive(job: CoverBackfillJobDto | undefined): boolean {
  return job?.state === "running" || job?.state === "stopping";
}

/** Marks every list and page that shows covers stale, so newly saved local copies replace the platform's links. */
function refreshCoverViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
  void queryClient.invalidateQueries({ queryKey: queryKeys.collections });
  void queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails });
  void queryClient.invalidateQueries({ queryKey: ["content"] });
}

/**
 * The caller's cover backfill status. While a job works it is polled every
 * `COVER_BACKFILL_POLL_MS`; the query library holds polls back while the page is hidden. Each
 * poll that finds more covers saved, and the job's end, refreshes the views that show covers:
 * at most once per poll, however many covers arrived in between.
 */
export function useCoverBackfill() {
  const client = useApi();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: coverBackfillKey,
    queryFn: () => client.get("/api/covers/backfill", coverBackfillStatusDtoSchema),
    refetchInterval: (query) => (coverBackfillActive(query.state.data?.job) ? COVER_BACKFILL_POLL_MS : false),
  });
  const seen = useRef<{ jobId: string; saved: number; active: boolean } | undefined>(undefined);
  const job = status.data?.job;
  useEffect(() => {
    if (job === undefined) {
      seen.current = undefined;
      return;
    }
    const active = coverBackfillActive(job);
    const before = seen.current;
    seen.current = { jobId: job.id, saved: job.saved, active };
    if (before === undefined || before.jobId !== job.id) {
      return;
    }
    if (job.saved > before.saved || (before.active && !active && job.saved > 0)) {
      refreshCoverViews(queryClient);
    }
  }, [job, queryClient]);
  return status;
}

export type CoverBackfillAction = { kind: "start"; request: CoverBackfillStartRequest } | { kind: "cancel"; jobId: string } | { kind: "remove"; jobId: string };

/** Starts, stops or closes a job; the answer is the new status and replaces the cached one. */
export function useCoverBackfillAction() {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: CoverBackfillAction): Promise<CoverBackfillStatusDto> => {
      switch (action.kind) {
        case "start":
          return client.post("/api/covers/backfill", coverBackfillStatusDtoSchema, { body: action.request });
        case "cancel":
          return client.post(`/api/covers/backfill/${encodeURIComponent(action.jobId)}/cancel`, coverBackfillStatusDtoSchema);
        case "remove":
          return client.delete(`/api/covers/backfill/${encodeURIComponent(action.jobId)}`, coverBackfillStatusDtoSchema);
      }
    },
    onSuccess: (next) => queryClient.setQueryData(coverBackfillKey, next),
    // A refusal (another tab started a job meanwhile) leaves the cached status behind: read it again.
    onError: () => void queryClient.invalidateQueries({ queryKey: coverBackfillKey }),
  });
}
