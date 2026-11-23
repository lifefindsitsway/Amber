import { afterEach, describe, expect, it } from "vitest";
import { TrashService } from "../../../../src/server/application/trash.ts";
import { CONTENT_TRASH_BATCH_MAX } from "../../../../src/shared/defaults.ts";
import { contentTrashPlanDtoSchema, contentTrashResultDtoSchema } from "../../../../src/shared/dto/trash.ts";
import { BOB, BOB_TOKEN, createHarness, createLocalContent, createTaskOfKind, LOCAL, LOCAL_TOKEN, silentLogger, taskOf, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** The app with a trash service that cancels through the task service and waits on the harness scheduler. */
async function setup() {
  const h = createHarness();
  open.push(h);
  const trash = new TrashService({
    repository: h.repository,
    deleteContent: h.deleteContent,
    fileDeleter: h.fileDeleter,
    chat: h.chat,
    logger: silentLogger,
    tasks: h.tasks,
    execution: h.scheduler,
  });
  const { app } = await h.app({ trash });
  return { h, app };
}

function finishedContent(h: Harness, userId = LOCAL.userId): string {
  const contentId = createLocalContent(h, userId);
  const taskId = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId, userId });
  h.repository.withTransaction((scope) => scope.tasks.setProjection(userId, taskId, "succeeded", 2));
  return contentId;
}

describe("POST /api/contents/trash-plan and /api/contents/trash", () => {
  it("plans, then cancels and moves; another user's Content is missing for the caller", async () => {
    const { h, app } = await setup();
    const ready = finishedContent(h);
    const busy = finishedContent(h);
    const taskId = createTaskOfKind(h, "process_content", { autoProofread: false }, { contentId: busy });
    const bobs = finishedContent(h, BOB.userId);

    const plan = await app.inject({ method: "POST", url: "/api/contents/trash-plan", headers: auth, payload: { contentIds: [ready, busy, bobs] } });
    expect(plan.statusCode).toBe(200);
    expect(contentTrashPlanDtoSchema.parse(plan.json())).toEqual({
      items: [
        { contentId: ready, state: "ready" },
        { contentId: busy, state: "tasks", unfinishedTaskCount: 1 },
        { contentId: bobs, state: "missing" },
      ],
    });

    const moved = await app.inject({ method: "POST", url: "/api/contents/trash", headers: auth, payload: { contentIds: [ready, busy, bobs], cancelTasks: true } });
    expect(moved.statusCode).toBe(200);
    expect(contentTrashResultDtoSchema.parse(moved.json())).toEqual({
      trashedIds: [ready, busy],
      alreadyTrashedIds: [],
      failed: [{ contentId: bobs, reason: "missing" }],
      cancelledTaskCount: 1,
    });
    expect(taskOf(h, taskId).statusProjection).toBe("cancelled");
    expect((await app.inject({ method: "GET", url: "/api/trash", headers: auth })).json()).toMatchObject({ total: 2 });
    // Bob's own view: his Content is untouched.
    expect((await app.inject({ method: "GET", url: `/api/contents/${bobs}`, headers: bob })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/api/contents/trash", headers: auth, payload: { contentIds: [ready, busy], cancelTasks: false } });
    expect(again.json()).toEqual({ trashedIds: [], alreadyTrashedIds: [ready, busy], failed: [], cancelledTaskCount: 0 });
  });

  it("validates the body and refuses more than the batch limit", async () => {
    const { app } = await setup();
    for (const [url, payload] of [
      ["/api/contents/trash-plan", { contentIds: [] }],
      ["/api/contents/trash-plan", { contentIds: ["a", "a"] }],
      ["/api/contents/trash", { contentIds: ["a"] }],
      ["/api/contents/trash", { contentIds: ["a"], cancelTasks: true, extra: 1 }],
    ] as const) {
      const response = await app.inject({ method: "POST", url, headers: auth, payload });
      expect([url, response.statusCode, response.json().error.class]).toEqual([url, 400, "invalid_request"]);
    }
    const contentIds = Array.from({ length: CONTENT_TRASH_BATCH_MAX + 1 }, (_, index) => `c${index}`);
    for (const [url, payload] of [
      ["/api/contents/trash-plan", { contentIds }],
      ["/api/contents/trash", { contentIds, cancelTasks: false }],
    ] as const) {
      const response = await app.inject({ method: "POST", url, headers: auth, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        code: "invalid_request.batch_too_large",
        details: { itemCount: CONTENT_TRASH_BATCH_MAX + 1, limit: CONTENT_TRASH_BATCH_MAX },
      });
    }
  });
});
