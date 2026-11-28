import { afterEach, describe, expect, it, vi } from "vitest";
import { coverBackfillStatusDtoSchema } from "../../../../src/shared/dto/cover-backfill.ts";
import { registerCoverBackfillRoutes } from "../../../../src/server/api/routes/covers.ts";
import { CoverBackfillService } from "../../../../src/server/application/cover-backfill.ts";
import { createAdmin } from "../../../fixtures/pipeline/admin.ts";
import { BOB, BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, waitFor, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { coverRig, rigContent } from "../../../fixtures/platform/covers.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const IMAGE = Buffer.from("cover-image");
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const rig = coverRig(h);
  const backfill = new CoverBackfillService({ repository: h.repository, covers: rig.covers, disk: h.disk, settings: h.settings, sleep: async () => undefined });
  const { app } = await h.app({ extraRoutes: (instance) => registerCoverBackfillRoutes(instance, { coverBackfill: backfill }) });
  return { h, app, rig, backfill };
}

describe("/api/covers/backfill", () => {
  it("starts, reports, stops and closes the caller's job, answering the status each time", async () => {
    const { h, app, rig } = await setup();
    const ids = [rigContent(h), rigContent(h)];
    const empty = await app.inject({ method: "GET", url: "/api/covers/backfill", headers: auth });
    expect([empty.statusCode, empty.json()]).toEqual([200, { candidates: 2 }]);

    const started = await app.inject({ method: "POST", url: "/api/covers/backfill", headers: auth, payload: { mode: "stored" } });
    expect(started.statusCode).toBe(200);
    const job = coverBackfillStatusDtoSchema.parse(started.json()).job;
    expect(job).toMatchObject({ mode: "stored", state: "running", total: 2 });
    const jobId = job?.id as string;
    await waitFor(() => rig.calls.length === 1);

    const again = await app.inject({ method: "POST", url: "/api/covers/backfill", headers: auth, payload: { mode: "stored" } });
    expect([again.statusCode, again.json().error.code]).toEqual([409, "conflict.cover_backfill_active"]);
    const closing = await app.inject({ method: "DELETE", url: `/api/covers/backfill/${jobId}`, headers: auth });
    expect([closing.statusCode, closing.json().error.code]).toEqual([409, "conflict.cover_backfill_active"]);

    const stopping = await app.inject({ method: "POST", url: `/api/covers/backfill/${jobId}/cancel`, headers: auth });
    expect([stopping.statusCode, stopping.json().job.state]).toEqual([200, "stopping"]);
    rig.calls[0]?.answer(IMAGE);
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/covers/backfill", headers: auth })).json().job.state).toBe("stopped"));
    const stopped = (await app.inject({ method: "GET", url: "/api/covers/backfill", headers: auth })).json();
    expect(stopped).toMatchObject({ candidates: 1, job: { state: "stopped", saved: 1, remaining: 1, nextAfterId: ids[0] } });

    const closed = await app.inject({ method: "DELETE", url: `/api/covers/backfill/${jobId}`, headers: auth });
    expect([closed.statusCode, closed.json()]).toEqual([200, { candidates: 1 }]);
  });

  it("treats another user's job id as unknown, and a retry without the caller's job as not_found", async () => {
    const { h, app, rig } = await setup();
    rigContent(h);
    const started = await app.inject({ method: "POST", url: "/api/covers/backfill", headers: auth, payload: { mode: "stored" } });
    const jobId = started.json().job.id as string;
    await waitFor(() => rig.calls.length === 1);
    for (const request of [
      { method: "POST" as const, url: `/api/covers/backfill/${jobId}/cancel` },
      { method: "DELETE" as const, url: `/api/covers/backfill/${jobId}` },
      { method: "POST" as const, url: "/api/covers/backfill", payload: { mode: "retry", jobId } },
    ]) {
      const response = await app.inject({ ...request, headers: bob });
      expect([request.url, response.statusCode, response.json().error.class]).toEqual([request.url, 404, "not_found"]);
    }
    expect((await app.inject({ method: "GET", url: "/api/covers/backfill", headers: bob })).json()).toEqual({ candidates: 0 });
    rig.calls[0]?.answer(IMAGE);
  });

  it("validates the request body", async () => {
    const { app } = await setup();
    for (const payload of [{}, { mode: "all" }, { mode: "stored", extra: 1 }, { mode: "stored", afterId: "" }]) {
      const response = await app.inject({ method: "POST", url: "/api/covers/backfill", headers: auth, payload });
      expect([JSON.stringify(payload), response.statusCode]).toEqual([JSON.stringify(payload), 400]);
    }
  });

  it("drops a user's job when the user is deleted", async () => {
    const { h, app, rig, backfill } = await setup();
    rigContent(h, { owner: BOB.userId });
    const started = await app.inject({ method: "POST", url: "/api/covers/backfill", headers: bob, payload: { mode: "stored" } });
    expect(started.statusCode).toBe(200);
    await waitFor(() => rig.calls.length === 1);
    const { admin } = createAdmin(h, { coverBackfill: backfill });
    await admin.deleteUser(LOCAL, BOB.userId);
    expect(backfill.status(BOB)).toEqual({ candidates: 0 });
    expect(rig.calls[0]?.signal.aborted).toBe(true);
  });
});
