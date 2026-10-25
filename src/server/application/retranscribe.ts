import { monotonicFactory } from "ulid";
import type { TaskAcceptedDto } from "../../shared/dto/task.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import { isPlatform } from "../domain/platform.ts";
import type { RetranscribeRequest } from "../domain/task-request.ts";
import type { AsrModelRef } from "../domain/model-ref.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository } from "../ports/repository.ts";
import { diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import { laneConflict, laneKeys, mutationLaneError } from "../pipeline/lane.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { transact } from "../pipeline/publish.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import { availableMediaSource } from "../pipeline/stages/source-media.ts";
import { createTask } from "../pipeline/task-state.ts";
import { jsonRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";
import { asrModelRefForSubmission } from "./settings.ts";
import type { TaskControl } from "./tasks.ts";

export const RETRANSCRIBE_ROUTE = "POST /api/contents/:id/transcript/retranscribe";

export interface RetranscribeServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  disk: DiskUsageProbe;
  settings: InstanceSettingsSource;
  now?: () => number;
  newId?: () => string;
}

/**
 * "Transcribe again" (`retranscribe`): a Task with a single `asr`
 * stage that produces a new `asr` revision and leaves downstream artifacts stale. It
 * needs media to take audio from — the original or a cached file of a local Content; a
 * platform Content can always download its audio — and is refused up front otherwise, so
 * nothing is queued that could only fail. The ASR profile is frozen into the request.
 */
export class RetranscribeService {
  private readonly options: RetranscribeServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: RetranscribeServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  async retranscribe(
    principal: RequestPrincipal,
    contentId: string,
    idempotencyKey?: string,
    asrModelRef?: AsrModelRef,
  ): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const context = {
      userId: owner,
      route: RETRANSCRIBE_ROUTE,
      key: idempotencyKey,
      requestDigest: jsonRequestDigest(asrModelRef === undefined ? { contentId } : { contentId, asrModelRef }),
    };
    const replay = this.options.repository.withTransaction((scope) =>
      idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, RETRANSCRIBE_ROUTE, idempotencyKey),
    );
    if (replay === undefined) {
      const low = await diskLowError(this.options.disk, this.options.settings.effective());
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark");
      }
    }
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
      runIdempotent(scope, context, this.now(), () => {
        const content = scope.contents.get(owner, contentId);
        if (content === undefined) {
          throw amberError("not_found", `content ${contentId}`);
        }
        // Frozen at submission: the requested model; without one the stage waits for the
        // user to choose one. The default is the picker's business, not ours.
        const frozen = asrModelRefForSubmission(scope, owner, asrModelRef);
        const request: RetranscribeRequest = { requestSchemaVersion: 1, kind: "retranscribe", ...(frozen === undefined ? {} : { asrModelRef: frozen }) };
        const requestJson = canonicalJson(request);
        if (!isPlatform(content.source.kind) && availableMediaSource(scope, owner, contentId) === undefined) {
          throw amberError("media_missing", "no media to take audio from");
        }
        const candidate = { id: "", kind: "retranscribe" as const, requestJson };
        const others = scope.tasks
          .listByContent(owner, contentId)
          .filter((task) => !isTerminalProjection(task.statusProjection))
          .map((task) => ({ task, keys: laneKeys(task, content.source.kind) }));
        const blocking = laneConflict(laneKeys(candidate, content.source.kind), others);
        if (blocking !== undefined) {
          throw mutationLaneError(blocking, "another unfinished task works on the same stages");
        }
        const task = createTask(scope, outbox, {
          task: { id: this.newId(), userId: owner, contentId, kind: "retranscribe", requestJson, createdAt: this.now() },
          sourceKind: content.source.kind,
          newId: this.newId,
        });
        return { status: 202, body: { taskId: task.id }, resourceRefs: [task.id] };
      }),
    );
    if (!result.replayed) {
      this.options.control.kick();
    }
    return result;
  }
}
