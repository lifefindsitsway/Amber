import { request } from "node:http";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_HISTORY_HIDE_MAX } from "../../../../src/shared/defaults.ts";
import { taskDetailDtoSchema, taskHistoryHiddenDtoSchema, taskHistoryRestoredDtoSchema, taskListDtoSchema } from "../../../../src/shared/dto/task.ts";
import { BOB_TOKEN, configureLlm, createHarness, LOCAL_TOKEN, taskOf, waitFor, type Harness } from "../../../fixtures/pipeline/harness.ts";

const LINK = "https://www.bilibili.com/video/BV1xx411c7mD";
const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(): Promise<{ h: Harness; app: Awaited<ReturnType<Harness["app"]>>["app"]; lines: string[] }> {
  const h = createHarness();
  open.push(h);
  const lines: string[] = [];
  const { app } = await h.app({ log: { write: (line) => void lines.push(line) } });
  return { h, app, lines };
}

/** Reads from an SSE stream until `predicate` holds for the text received so far; the stream stays open. */
async function readUntil(stream: Readable, predicate: (text: string) => boolean): Promise<string> {
  let text = "";
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    text += String(chunk);
    if (predicate(text)) {
      return text;
    }
  }
  return text;
}

describe("the SSE stream is observation only", () => {
  const errorLines = (lines: string[]) => lines.map((line) => JSON.parse(line) as { level: number }).filter((entry) => entry.level >= 50);

  it("inject: the client closes the response stream and the task still finishes without error logs", async () => {
    const { h, app, lines } = await setup();
    const modelRef = configureLlm(h);
    const response = await app.inject({ method: "GET", url: "/api/tasks/events", headers: auth, payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/event-stream/);
    const stream = response.stream();
    await readUntil(stream, (text) => text.includes(": connected"));
    stream.destroy();

    const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }], settings: { modelRef } } });
    expect(created.statusCode).toBe(202);
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(taskOf(h, created.json().taskIds[0]).statusProjection).toBe("succeeded");
    expect(errorLines(lines)).toEqual([]);
  });

  it("real socket: a client disconnect releases the subscription; the task finishes without error logs", async () => {
    const { h, app, lines } = await setup();
    const modelRef = configureLlm(h);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as { port: number };
    await new Promise<void>((resolve, reject) => {
      const client = request({ host: "127.0.0.1", port, path: "/api/tasks/events", headers: auth }, (response) => {
        response.once("data", () => {
          client.destroy();
          resolve();
        });
      });
      client.on("error", (error) => (client.destroyed ? undefined : reject(error)));
      client.end();
    });
    await waitFor(() => h.bus.subscriberCount() === 0);

    const created = await h.importContent.import({ userId: "local", mode: "local", role: "admin", mustChangePassword: false }, { items: [{ url: LINK }], settings: { modelRef, autoProofread: true } });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(taskOf(h, created.body.taskIds[0] as string).statusProjection).toBe("succeeded");
    expect(errorLines(lines)).toEqual([]);
  });

  it("streams only the caller's events, framed with the bus sequence as id", async () => {
    const { h, app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/tasks/events", headers: auth, payloadAsStream: true });
    const stream = response.stream();
    await readUntil(stream, (text) => text.includes(": connected"));
    expect(h.bus.subscriberCount()).toBe(1);

    await h.importContent.import({ userId: "bob", mode: "local", role: "user", mustChangePassword: false }, { items: [{ url: LINK }], settings: { autoProofread: true } });
    const mine = await h.importContent.import({ userId: "local", mode: "local", role: "admin", mustChangePassword: false }, { items: [{ url: LINK }], settings: { autoProofread: true } });
    const text = await readUntil(stream, (received) => received.includes(mine.body.taskIds[0] as string) && received.includes("stage.updated"));
    stream.destroy();

    const frames = text.split("\n\n").filter((frame) => frame.startsWith("event: "));
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).toMatch(/^event: (task\.updated|stage\.updated|workunit\.updated|task\.finished)\ndata: \{.*\}\nid: \d+$/);
      expect(frame).not.toContain('"userId"');
    }
    const firstId = Number(/id: (\d+)/.exec(frames[0] as string)?.[1]);
    // Bob's import published events first; the caller's stream skips them.
    expect(firstId).toBeGreaterThan(1);
  });
});

describe("/api/tasks", () => {
  it("serves list and detail snapshots with eventSeq, scoped to the caller", async () => {
    const { app } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }] } });
    const taskId = created.json().taskIds[0] as string;

    const list = await app.inject({ method: "GET", url: "/api/tasks?limit=10", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(taskListDtoSchema.parse(list.json()).items.map((task) => task.id)).toEqual([taskId]);

    const detail = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: auth });
    const parsed = taskDetailDtoSchema.parse(detail.json());
    expect(parsed.stageRuns.map((run) => run.stage)).toEqual(["source", "subtitle", "asr", "proofread", "chapter", "summary"]);
    expect(parsed.eventSeq).toBeGreaterThan(0);

    const bobs = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: { authorization: `Bearer ${BOB_TOKEN}` } });
    expect(bobs.statusCode).toBe(404);
    expect(bobs.json().error.class).toBe("not_found");
  });

  it("validates bodies and queries and maps conflicts to 409", async () => {
    const { app } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }] } });
    const taskId = created.json().taskIds[0] as string;

    const badLimit = await app.inject({ method: "GET", url: "/api/tasks?limit=0", headers: auth });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json().error).toMatchObject({ class: "invalid_request", userMessage: expect.stringContaining("query.limit") });

    const badStage = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/retry-stage`, headers: auth, payload: { stage: "nope" } });
    expect(badStage.statusCode).toBe(400);

    const pending = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/retry-stage`, headers: auth, payload: { stage: "source" } });
    expect(pending.statusCode).toBe(409);

    const cancelled = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel`, headers: auth });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().statusProjection).toBe("cancelled");
    const again = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel`, headers: auth });
    expect(again.statusCode).toBe(409);
  });
});

describe("GET /api/tasks filters", () => {
  it("accepts unfinished=1 with a target filter and rejects other values", async () => {
    const { h, app } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }], settings: {} } });
    const contentId = created.json().contentIds[0] as string;
    const list = await app.inject({ method: "GET", url: `/api/tasks?unfinished=1&contentId=${contentId}`, headers: auth });
    expect(list.statusCode).toBe(200);
    expect(taskListDtoSchema.parse(list.json()).items.map((task) => task.id)).toEqual(created.json().taskIds);
    expect((await app.inject({ method: "GET", url: `/api/tasks?collectionId=${contentId}`, headers: auth })).json().items).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/tasks?unfinished=yes", headers: auth })).statusCode).toBe(400);
    expect(h.bus.subscriberCount()).toBe(0);
  });

  it("accepts finished=1, which excludes unfinished=1, and rejects other values", async () => {
    const { app } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }], settings: {} } });
    const taskId = created.json().taskIds[0] as string;
    const ids = async (query: string) =>
      taskListDtoSchema.parse((await app.inject({ method: "GET", url: `/api/tasks?${query}`, headers: auth })).json()).items.map((task) => task.id);
    expect(await ids("finished=1")).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel`, headers: auth })).statusCode).toBe(200);
    expect(await ids("finished=1")).toEqual([taskId]);
    expect(await ids("finished=0&unfinished=1")).toEqual([]);
    expect(await ids("finished=1&unfinished=0")).toEqual([taskId]);

    const both = await app.inject({ method: "GET", url: "/api/tasks?finished=1&unfinished=1", headers: auth });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toMatchObject({ class: "invalid_request", userMessage: expect.stringContaining("query.finished") });
    const badValue = await app.inject({ method: "GET", url: "/api/tasks?finished=yes", headers: auth });
    expect(badValue.statusCode).toBe(400);
    expect(badValue.json().error).toMatchObject({ class: "invalid_request", userMessage: expect.stringContaining("query.finished") });
  });

  it("narrows to one Task kind and rejects an unknown kind as invalid_request", async () => {
    const { app } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: LINK }], settings: {} } });
    const contentId = created.json().contentIds[0] as string;
    const ids = async (query: string) =>
      taskListDtoSchema.parse((await app.inject({ method: "GET", url: `/api/tasks?${query}`, headers: auth })).json()).items.map((task) => task.id);
    expect(await ids(`contentId=${contentId}&kind=process_content`)).toEqual(created.json().taskIds);
    expect(await ids(`contentId=${contentId}&kind=process_content&unfinished=1`)).toEqual(created.json().taskIds);
    expect(await ids(`contentId=${contentId}&kind=cache_media`)).toEqual([]);

    const badKind = await app.inject({ method: "GET", url: "/api/tasks?kind=nope", headers: auth });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error).toMatchObject({ class: "invalid_request", userMessage: expect.stringContaining("query.kind") });
  });
});

describe("task history routes", () => {
  const bobAuth = { authorization: `Bearer ${BOB_TOKEN}` };

  /** Two cancelled (finished) Tasks and one still queued, on separate Contents. */
  async function seeded() {
    const { h, app } = await setup();
    const finished: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await app.inject({ method: "POST", url: "/api/contents/import", headers: auth, payload: { items: [{ url: `https://www.bilibili.com/video/BV1xx411c7m${"ABC"[index]}` }], settings: {} } });
      expect(created.statusCode).toBe(202);
      const taskId = created.json().taskIds[0] as string;
      if (index < 2) {
        expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel`, headers: auth })).statusCode).toBe(200);
        finished.push(taskId);
      }
    }
    const ids = async (query: string, headers: Record<string, string> = auth) =>
      taskListDtoSchema.parse((await app.inject({ method: "GET", url: `/api/tasks?${query}`, headers })).json()).items.map((task) => task.id);
    return { h, app, finished, ids };
  }

  it("lists history=1 as finished and shown, exclusive with finished=1 and unfinished=1", async () => {
    const { app, finished, ids } = await seeded();
    expect(await ids("history=1")).toEqual([...finished].reverse());
    for (const query of ["history=1&finished=1", "history=1&unfinished=1", "history=1&finished=1&unfinished=1"]) {
      const refused = await app.inject({ method: "GET", url: `/api/tasks?${query}`, headers: auth });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.class).toBe("invalid_request");
    }
    expect((await app.inject({ method: "GET", url: "/api/tasks?history=yes", headers: auth })).statusCode).toBe(400);
    expect(await ids("history=0&finished=1")).toEqual([...finished].reverse());
  });

  it("hides, clears and restores by batch without touching finished=1, details or other users", async () => {
    const { app, finished, ids } = await seeded();
    const [first, second] = finished as [string, string];
    const hide = await app.inject({ method: "POST", url: "/api/tasks/history/hide", headers: auth, payload: { taskIds: [first, first, "01JUNKNOWNTASKID000000000"] } });
    expect(hide.statusCode).toBe(200);
    const hideBody = taskHistoryHiddenDtoSchema.parse(hide.json());
    expect(hideBody.hidden).toBe(1);
    expect(await ids("history=1")).toEqual([second]);
    expect(await ids("finished=1")).toEqual([second, first]);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${first}`, headers: auth })).statusCode).toBe(200);

    // Another user's attempt looks like a removal of nothing.
    const foreign = await app.inject({ method: "POST", url: "/api/tasks/history/hide", headers: bobAuth, payload: { taskIds: [second] } });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toMatchObject({ hidden: 0 });
    expect(await ids("history=1")).toEqual([second]);

    for (const payload of [undefined, {}]) {
      const clear = await app.inject({ method: "POST", url: "/api/tasks/history/clear", headers: auth, ...(payload === undefined ? {} : { payload }) });
      expect(clear.statusCode).toBe(200);
      expect(taskHistoryHiddenDtoSchema.parse(clear.json()).hidden).toBe(payload === undefined ? 1 : 0);
      if (payload === undefined) {
        const restore = await app.inject({ method: "POST", url: "/api/tasks/history/restore", headers: auth, payload: { batchId: clear.json().batchId } });
        expect(restore.statusCode).toBe(200);
        expect(taskHistoryRestoredDtoSchema.parse(restore.json())).toEqual({ restored: 1 });
        expect(await ids("history=1")).toEqual([second]);
        expect((await app.inject({ method: "POST", url: "/api/tasks/history/clear", headers: auth, payload: {} })).json().hidden).toBe(1);
      }
    }
    expect(await ids("history=1")).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/tasks/history/restore", headers: auth, payload: { batchId: hideBody.batchId } })).json()).toEqual({ restored: 1 });
    expect(await ids("history=1")).toEqual([first]);
  });

  it("validates the history bodies", async () => {
    const { app } = await seeded();
    const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth, payload: payload as object });
    expect((await post("/api/tasks/history/hide", { taskIds: [] })).statusCode).toBe(400);
    expect((await post("/api/tasks/history/hide", { taskIds: Array.from({ length: TASK_HISTORY_HIDE_MAX + 1 }, (_, i) => `t${i}`) })).statusCode).toBe(400);
    expect((await post("/api/tasks/history/hide", {})).statusCode).toBe(400);
    expect((await post("/api/tasks/history/clear", { all: true })).statusCode).toBe(400);
    expect((await post("/api/tasks/history/restore", {})).statusCode).toBe(400);
  });
});
