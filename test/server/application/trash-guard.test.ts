import { afterEach, describe, expect, it } from "vitest";
import {
  cancelTasks,
  frozenBySummaries,
  settleWithin,
  trashBlockers,
  trashFailureReason,
} from "../../../src/server/application/trash-guard.ts";
import { canonicalJson } from "../../../src/server/domain/canonical-json.ts";
import { amberError } from "../../../src/server/domain/errors.ts";
import { createHarness, createLocalContent, createTaskOfKind, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

function insertSummary(h: Harness, id: string, collectionId: string, contentIds: readonly string[], statusProjection: "running" | "succeeded"): void {
  h.repository.withTransaction((scope) =>
    scope.tasks.insert({
      id,
      userId: LOCAL.userId,
      collectionId,
      kind: "summarize_collection",
      requestJson: canonicalJson({
        requestSchemaVersion: 1,
        kind: "summarize_collection",
        outputLanguage: "zh-CN",
        inputItems: contentIds.map((contentId, position) => ({ collectionItemId: `i${position}`, contentId, summaryRevisionId: "s", transcriptRevisionId: "t", position })),
      }),
      statusProjection,
      createdAt: 1,
      ...(statusProjection === "succeeded" ? { finishedAt: 2 } : {}),
    }),
  );
}

describe("frozenBySummaries", () => {
  it("maps each frozen Content to the collections whose unfinished summary froze it, leaving one collection out on request", () => {
    const h = harness();
    const [a, b] = [createLocalContent(h), createLocalContent(h)];
    const first = h.collections.create(LOCAL, { name: "First" }).id;
    const second = h.collections.create(LOCAL, { name: "Second" }).id;
    insertSummary(h, "s1", first, [a, b], "running");
    insertSummary(h, "s2", second, [a], "running");
    insertSummary(h, "s3", second, [b], "succeeded");
    const frozen = h.repository.withTransaction((scope) => frozenBySummaries(scope, LOCAL.userId));
    expect(Object.fromEntries(frozen)).toEqual({ [a]: [first, second], [b]: [first] });
    const without = h.repository.withTransaction((scope) => frozenBySummaries(scope, LOCAL.userId, first));
    expect(Object.fromEntries(without)).toEqual({ [a]: [second] });
  });
});

describe("trashBlockers", () => {
  it("separates unfinished Tasks from cancelled ones still executing, and reports the most binding reason", () => {
    const h = harness();
    const contentId = createLocalContent(h);
    const unfinished = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId });
    const stopping = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId });
    const done = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId });
    h.repository.withTransaction((scope) => {
      scope.tasks.setProjection(LOCAL.userId, stopping, "cancelled", 2);
      scope.tasks.setProjection(LOCAL.userId, done, "succeeded", 2);
    });
    const blockers = h.repository.withTransaction((scope) =>
      trashBlockers(scope, LOCAL.userId, contentId, new Map([[contentId, ["c1"]]]), { isExecuting: (id) => id === stopping }),
    );
    expect(blockers).toEqual({ unfinishedTaskIds: [unfinished], stoppingTaskIds: [stopping], summarizingCollectionIds: ["c1"] });
    expect(trashFailureReason(blockers)).toBe("summarizing");
    expect(trashFailureReason({ ...blockers, summarizingCollectionIds: [] })).toBe("tasks");
    expect(trashFailureReason({ ...blockers, summarizingCollectionIds: [], unfinishedTaskIds: [] })).toBe("stopping");
    expect(trashFailureReason({ summarizingCollectionIds: [], unfinishedTaskIds: [], stoppingTaskIds: [] })).toBeUndefined();
  });
});

describe("cancelTasks", () => {
  it("counts the cancelled ones, skips Tasks that ended or vanished meanwhile, and reports other failures", () => {
    const failures: string[] = [];
    const cancelled = cancelTasks(
      {
        cancel: (_principal, taskId) => {
          if (taskId === "ended") throw amberError("conflict", "already finished");
          if (taskId === "gone") throw amberError("not_found", "task");
          if (taskId === "broken") throw new Error("boom");
          return {} as ReturnType<Parameters<typeof cancelTasks>[0]["cancel"]>;
        },
      },
      LOCAL,
      ["a", "ended", "gone", "broken", "b"],
      (taskId) => failures.push(taskId),
    );
    expect(cancelled).toBe(2);
    expect(failures).toEqual(["broken"]);
  });
});

describe("settleWithin", () => {
  it("tells a settled wait from one that ran out of time; a failed wait counts as settled", async () => {
    expect(await settleWithin(Promise.resolve(), 1000)).toBe(true);
    expect(await settleWithin(Promise.reject(new Error("x")), 1000)).toBe(true);
    expect(await settleWithin(new Promise(() => undefined), 10)).toBe(false);
  });
});
