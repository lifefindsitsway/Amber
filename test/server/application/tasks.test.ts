import { afterEach, describe, expect, it } from "vitest";
import { jsonRequestDigest } from "../../../src/server/application/idempotency.ts";
import { CONFIRM_RESEND_ROUTE, TaskService } from "../../../src/server/application/tasks.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { AsrModelRef, ModelRef } from "../../../src/server/domain/model-ref.ts";
import { latestAttempts } from "../../../src/server/pipeline/projection.ts";
import type { Repository } from "../../../src/server/ports/repository.ts";
import type { TaskEvent } from "../../../src/shared/sse/events.ts";
import {
  BOB,
  configureAsr,
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  credentialRefOf,
  gate,
  LOCAL,
  LOCAL_TOKEN,
  stageInputsOf,
  stageRunsOf,
  stageStatuses,
  taskOf,
  unconfiguredLlm,
  waitFor,
  type Harness,
} from "../../fixtures/pipeline/harness.ts";
import { insertSummary, seedTranscripts } from "../../fixtures/pipeline/summary-data.ts";
import { countRows, insertRow } from "../../tools/sqlite.ts";

const LINK = "https://www.bilibili.com/video/BV1xx411c7mD";
const open: Harness[] = [];
function harness(...args: Parameters<typeof createHarness>): Harness {
  const created = createHarness(...args);
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A model of one of the user's ASR profiles, with a usable key unless `keyed` is false. */
function asrProfile(h: Harness, userId = LOCAL.userId, keyed = true): AsrModelRef {
  const id = h.newId();
  const credentialRef = keyed ? h.secrets.store(userId, "<placeholder-asr-key>") : undefined;
  h.repository.withTransaction((scope) =>
    scope.asrProfiles.insert({
      id, userId, name: id, provider: "dashscope", models: [{ modelId: "fun-asr" }, { modelId: "qwen-audio-3.1-asr-flash-filetrans" }], ...(credentialRef === undefined ? {} : { credentialRef }), createdAt: 1,
    }),
  );
  return { asrProfileId: id, modelId: "fun-asr" };
}

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

describe("waiting_configuration never resumes by itself", () => {
  it("stays waiting after configuration is saved, with zero LLM calls, and resumes only through retry-stage", async () => {
    const h = harness();
    const imported = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { autoProofread: true } });
    const taskId = imported.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();
    const proofread = () => latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "proofread");
    expect(proofread()).toMatchObject({ status: "waiting_configuration", error: { class: "llm_unconfigured", action: "configure_llm" } });
    expect(taskOf(h, taskId).statusProjection).toBe("waiting");

    const modelRef = configureLlm(h);
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    expect(proofread()?.status).toBe("waiting_configuration");
    expect((h.executors.proofread as unknown as { calls: number }).calls).toBe(0);

    const { app } = await h.app();
    const resumed = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/retry-stage`,
      headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
      payload: { stage: "proofread", modelRef },
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toEqual({ taskId });
    await h.scheduler.whenIdle();
    expect(proofread()).toMatchObject({ status: "succeeded", attempt: 1, inputJson: JSON.stringify({ modelRef }) });
    expect((h.executors.proofread as unknown as { calls: number }).calls).toBe(1);
  });

  it("accepts modelRef only to fill a gap, only for an owned model, and only once requirements are met", async () => {
    const h = harness();
    const imported = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { autoProofread: true } });
    const taskId = imported.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();

    const bare = unconfiguredLlm(h);
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef: bare }))).toBe("invalid_request");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "proofread" }))).toBe("invalid_request");
    const bobs = configureLlm(h, BOB.userId);
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef: bobs }))).toBe("invalid_request");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef: { ...configureLlm(h), modelId: "missing" } }))).toBe(
      "invalid_request",
    );
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "source" }))).toBe("conflict");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "highlight" }))).toBe("invalid_request");
    const proofread = latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "proofread");
    expect(proofread?.status).toBe("waiting_configuration");
    expect(proofread?.inputJson).toBeUndefined();
  });

  it("rejects modelRef when the frozen request already carries one", async () => {
    const h = harness();
    const modelRef = unconfiguredLlm(h);
    const imported = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { modelRef, autoProofread: true } });
    const taskId = imported.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId).proofread).toBe("waiting_configuration");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef: configureLlm(h) }))).toBe("invalid_request");
  });
});

describe("the chosen model serves the rest of the task, and bound stages recover", () => {
  const frozen = (modelRef: ModelRef) => JSON.stringify({ modelRef });
  const calls = (h: Harness, stage: "proofread" | "chapter" | "summary") => (h.executors[stage] as unknown as { calls: number }).calls;

  /** A task imported without a model, run until proofread waits for configuration. */
  async function waitingTask(h: Harness): Promise<{ taskId: string; contentId: string }> {
    const imported = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { autoProofread: true } });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    const taskId = imported.body.taskIds[0] as string;
    expect(stageStatuses(h, taskId).proofread).toBe("waiting_configuration");
    return { taskId, contentId: imported.body.contentIds[0] as string };
  }

  async function retryOverHttp(h: Harness, taskId: string, payload: Record<string, unknown>) {
    const { app } = await h.app();
    return app.inject({ method: "POST", url: `/api/tasks/${taskId}/retry-stage`, headers: { authorization: `Bearer ${LOCAL_TOKEN}` }, payload });
  }

  it("freezes the model into every other pending LLM stage of the task, in one go", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const modelRef = configureLlm(h);
    expect((await retryOverHttp(h, taskId, { stage: "proofread", modelRef })).statusCode).toBe(202);
    await h.scheduler.whenIdle();

    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
    expect(stageInputsOf(h, taskId)).toEqual({
      source: undefined, subtitle: undefined, asr: undefined,
      proofread: frozen(modelRef), chapter: frozen(modelRef), summary: frozen(modelRef),
    });
    expect([calls(h, "proofread"), calls(h, "chapter"), calls(h, "summary")]).toEqual([1, 1, 1]);
  });

  it("never overwrites a stage that already has a choice, nor a stage that is not pending", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const a = configureLlm(h);
    const b = configureLlm(h);
    await h.scheduler.stop();
    const chapter = latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "chapter");
    h.db.prepare("UPDATE stage_run SET input_json = ? WHERE id = ? AND input_json IS NULL").run(frozen(b), chapter?.id);

    h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef: a });
    expect(stageInputsOf(h, taskId)).toEqual({
      source: undefined, subtitle: undefined, asr: undefined,
      proofread: frozen(a), chapter: frozen(b), summary: frozen(a),
    });
  });

  it("stays within the task", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const other = createTaskOfKind(h, "regenerate_summary", {});
    const modelRef = configureLlm(h);
    await h.scheduler.stop();
    h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef });
    expect(stageInputsOf(h, taskId).summary).toBe(frozen(modelRef));
    expect(stageInputsOf(h, other)).toEqual({ summary: undefined });
  });

  it("propagates and resumes in one transaction: an injected failure leaves nothing behind", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const modelRef = configureLlm(h);
    await h.scheduler.stop();
    // Fails on the second StageRun write of the transaction: the first propagation target.
    const failing: Repository = {
      withTransaction: (work) =>
        h.repository.withTransaction((scope) => {
          let updates = 0;
          const stageRuns = {
            ...scope.stageRuns,
            update: (owner: string, run: Parameters<typeof scope.stageRuns.update>[1]) => {
              updates += 1;
              if (updates === 2) {
                throw new Error("injected failure inside the retry transaction");
              }
              scope.stageRuns.update(owner, run);
            },
          };
          return work({ ...scope, stageRuns });
        }),
    };
    const service = new TaskService({ repository: failing, bus: h.bus, control: { kick: () => undefined, abortTask: () => undefined }, secrets: h.secrets });

    expect(() => service.retryStage(LOCAL, taskId, { stage: "proofread", modelRef }, "atomic-1")).toThrow("injected failure");
    expect(stageStatuses(h, taskId).proofread).toBe("waiting_configuration");
    expect(Object.values(stageInputsOf(h, taskId))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(countRows(h.db, "idempotency_record")).toBe(0);
  });

  it("keeps the propagated choice across a restart", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const modelRef = configureLlm(h);
    await h.scheduler.stop();
    h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef });
    await h.close();

    const again = harness({ file: h.file });
    again.scheduler.start();
    await again.scheduler.whenIdle();
    expect(taskOf(again, taskId).statusProjection).toBe("succeeded");
    expect(stageInputsOf(again, taskId)).toMatchObject({ chapter: frozen(modelRef), summary: frozen(modelRef) });
    expect([calls(again, "chapter"), calls(again, "summary")]).toEqual([1, 1]);
  });

  it("re-running a failed stage inherits its model, and so do the stages reopened with it", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const modelRef = configureLlm(h);
    let chapterRuns = 0;
    h.executors.chapter = {
      async run() {
        chapterRuns += 1;
        if (chapterRuns === 1) throw amberError("llm_capability");
        return {};
      },
    };
    h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef });
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId)).toMatchObject({ chapter: "failed", summary: "skipped" });

    h.tasks.retryStage(LOCAL, taskId, { stage: "chapter" });
    await h.scheduler.whenIdle();
    const latest = latestAttempts(stageRunsOf(h, taskId));
    expect(latest.filter((run) => run.stage === "chapter" || run.stage === "summary")).toMatchObject([
      { stage: "chapter", attempt: 2, status: "succeeded", inputJson: frozen(modelRef) },
      { stage: "summary", attempt: 2, status: "succeeded", inputJson: frozen(modelRef) },
    ]);
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });

  it("still evaluates each later stage's skip condition", async () => {
    const h = harness();
    const { taskId, contentId } = await waitingTask(h);
    const modelRef = configureLlm(h);
    const hold = gate();
    h.executors.proofread = { run: async () => (await hold.promise, {}) };
    h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef });
    await waitFor(() => stageStatuses(h, taskId).proofread === "running");
    // Platform chapters arrive while proofreading runs; the model choice does not force AI chapters.
    insertRow(h.db, "chapter_artifact", { id: "ca", content_id: contentId });
    insertRow(h.db, "chapter_revision", {
      id: "cr", artifact_id: "ca", inputs_json: "[]", quality: "fresh", origin_json: '{"kind":"platform"}', chapters_json: "[]", created_at: 1,
    });
    hold.open();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId)).toMatchObject({ proofread: "succeeded", chapter: "skipped", summary: "succeeded" });
    expect(calls(h, "chapter")).toBe(0);
  });

  it("re-checks the requirement when a later stage is reached, and a bound stage recovers without choosing again", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const modelRef = configureLlm(h);
    const credentialRef = credentialRefOf(h, modelRef);
    const hold = gate();
    h.executors.proofread = { run: async () => (await hold.promise, {}) };
    h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef });
    await waitFor(() => stageStatuses(h, taskId).proofread === "running");
    h.markCredentialUnavailable(credentialRef);
    hold.open();
    await h.scheduler.whenIdle();

    const chapter = () => latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "chapter");
    expect(chapter()).toMatchObject({ status: "waiting_configuration", error: { class: "llm_unconfigured" }, inputJson: frozen(modelRef) });
    expect(stageInputsOf(h, taskId).summary).toBe(frozen(modelRef));
    expect(calls(h, "chapter")).toBe(0);

    // Bound already: no model may be supplied, the same one included.
    for (const supplied of [modelRef, configureLlm(h)]) {
      expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "chapter", modelRef: supplied }))).toBe("invalid_request");
    }
    // Still unmet without the credential.
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "chapter" }))).toBe("invalid_request");
    expect(chapter()?.inputJson).toBe(frozen(modelRef));

    h.restoreCredential(credentialRef);
    expect((await retryOverHttp(h, taskId, { stage: "chapter" })).statusCode).toBe(202);
    await h.scheduler.whenIdle();
    expect(chapter()).toMatchObject({ status: "succeeded", attempt: 1, inputJson: frozen(modelRef) });
    expect(stageStatuses(h, taskId).summary).toBe("succeeded");
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });

  it("refuses to complete an input that exists without a model, leaving everything as it was", async () => {
    const h = harness();
    const { taskId } = await waitingTask(h);
    const modelRef = configureLlm(h);
    await h.scheduler.stop();
    const summary = latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "summary");
    h.db.prepare("UPDATE stage_run SET input_json = '{}' WHERE id = ? AND input_json IS NULL").run(summary?.id);

    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef }))).toBe("internal");
    expect(stageStatuses(h, taskId).proofread).toBe("waiting_configuration");
    expect(stageInputsOf(h, taskId)).toMatchObject({ proofread: undefined, chapter: undefined, summary: "{}" });
  });
});

describe("retry-stage on a failed stage", () => {
  it("opens a new attempt, reopens the stages skipped because of it, clears finishedAt and keeps history", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    let sourceRuns = 0;
    h.executors.source = {
      async run() {
        sourceRuns += 1;
        if (sourceRuns === 1) throw amberError("paid_content");
        return {};
      },
    };
    const imported = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { modelRef, autoProofread: true } });
    const taskId = imported.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(taskOf(h, taskId)).toMatchObject({ statusProjection: "failed", finishedAt: expect.any(Number) });

    await h.scheduler.stop();
    h.tasks.retryStage(LOCAL, taskId, { stage: "source" });
    const reopened = taskOf(h, taskId);
    expect(reopened.statusProjection).toBe("queued");
    expect(reopened.finishedAt).toBeUndefined();
    expect(latestAttempts(stageRunsOf(h, taskId)).map((run) => [run.stage, run.attempt, run.status])).toEqual([
      ["source", 2, "pending"],
      ["subtitle", 2, "pending"],
      ["asr", 2, "pending"],
      ["proofread", 2, "pending"],
      ["chapter", 2, "pending"],
      ["summary", 2, "pending"],
    ]);
    expect(stageRunsOf(h, taskId)).toHaveLength(12);
  });

  it("refuses with conflict.mutation_lane while another unfinished task holds the same stages", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.executors.source = { run: async () => Promise.reject(amberError("paid_content")) };
    const first = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { modelRef, autoProofread: true } });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    await h.scheduler.stop();
    // A failed Task does not block a new one with a different intent on the same Content.
    const second = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { modelRef, autoProofread: false } });
    expect(second.body.taskIds[0]).not.toBe(first.body.taskIds[0]);
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, first.body.taskIds[0] as string, { stage: "source" }))).toBe(
      "conflict.mutation_lane",
    );
    let refusal: string | undefined;
    try {
      h.tasks.retryStage(LOCAL, first.body.taskIds[0] as string, { stage: "source" });
    } catch (error) {
      refusal = isAmberError(error) ? error.appError.userMessage : undefined;
    }
    expect(refusal).toBe("已有一个「处理视频」任务正在进行，与这次操作冲突；请等它结束，或在左下角「任务」里取消后再试");
  });

  const calls = (h: Harness, stage: "chapter" | "summary") => (h.executors[stage] as unknown as { calls: number }).calls;

  /** A task imported with model `a` whose proofread fails once, leaving chapter and summary skipped. */
  async function failedProofread(h: Harness, a: ModelRef): Promise<string> {
    let proofreadRuns = 0;
    h.executors.proofread = {
      async run() {
        proofreadRuns += 1;
        if (proofreadRuns === 1) throw amberError("llm_capability");
        return {};
      },
    };
    const imported = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { modelRef: a, autoProofread: true } });
    const taskId = imported.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId)).toMatchObject({ proofread: "failed", chapter: "skipped", summary: "skipped" });
    return taskId;
  }

  it("re-runs a failed LLM stage with an explicitly chosen model, binding the LLM stages reopened with it", async () => {
    const h = harness();
    const a = configureLlm(h);
    const b = configureLlm(h);
    const taskId = await failedProofread(h, a);
    const requestJson = taskOf(h, taskId).requestJson;
    const before = latestAttempts(stageRunsOf(h, taskId)).filter((run) => run.stage === "source" || run.stage === "subtitle" || run.stage === "asr");

    h.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef: b });
    const latest = latestAttempts(stageRunsOf(h, taskId));
    expect(latest.map((run) => [run.stage, run.attempt, run.inputJson])).toEqual([
      ["source", 1, undefined],
      ["subtitle", 1, undefined],
      ["asr", 1, undefined],
      ["proofread", 2, JSON.stringify({ modelRef: b })],
      ["chapter", 2, JSON.stringify({ modelRef: b })],
      ["summary", 2, JSON.stringify({ modelRef: b })],
    ]);
    expect(latest.filter((run) => run.stage === "source" || run.stage === "subtitle" || run.stage === "asr")).toEqual(before);
    expect(taskOf(h, taskId).requestJson).toBe(requestJson);
    expect(h.tasks.get(LOCAL, taskId).stageRuns.filter((run) => run.attempt === 2).map((run) => run.engine)).toEqual([
      { kind: "llm", modelRef: b },
      { kind: "llm", modelRef: b },
      { kind: "llm", modelRef: b },
    ]);

    await h.scheduler.whenIdle();
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
    expect(calls(h, "summary")).toBe(1);
  });

  it("refuses a model for a failed stage that needs none, and a model the user does not own, writing nothing", async () => {
    const h = harness();
    const a = configureLlm(h);
    h.executors.source = { run: async () => Promise.reject(amberError("paid_content")) };
    const imported = await h.importContent.import(LOCAL, { items: [{ url: LINK }], settings: { modelRef: a, autoProofread: true } });
    const sourceFailed = imported.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();
    await h.scheduler.stop();
    expect(stageStatuses(h, sourceFailed).source).toBe("failed");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, sourceFailed, { stage: "source", modelRef: a }))).toBe("invalid_request");
    expect(stageRunsOf(h, sourceFailed)).toHaveLength(6);

    const h2 = harness();
    const own = configureLlm(h2);
    const taskId = await failedProofread(h2, own);
    const runs = stageRunsOf(h2, taskId).length;
    for (const modelRef of [configureLlm(h2, BOB.userId), { ...own, modelId: "missing" }, { ...own, providerProfileId: "missing" }]) {
      expect(await codeOf(() => h2.tasks.retryStage(LOCAL, taskId, { stage: "proofread", modelRef }))).toBe("invalid_request");
    }
    expect(stageRunsOf(h2, taskId)).toHaveLength(runs);
    expect(stageStatuses(h2, taskId)).toMatchObject({ proofread: "failed", chapter: "skipped", summary: "skipped" });
    expect(countRows(h2.db, "idempotency_record")).toBe(0);
  });

  it("replays an identical retry under the same Idempotency-Key without a second attempt", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.executors.summary = { run: async () => Promise.reject(amberError("llm_capability")) };
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    await h.scheduler.stop();
    expect(h.tasks.retryStage(LOCAL, taskId, { stage: "summary" }, "retry-1")).toEqual({ taskId });
    expect(h.tasks.retryStage(LOCAL, taskId, { stage: "summary" }, "retry-1")).toEqual({ taskId });
    expect(stageRunsOf(h, taskId)).toHaveLength(2);
  });
});

describe("cancel, confirm-resend and reads", () => {
  it("scopes every task operation to its owner", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    expect(await codeOf(() => h.tasks.get(BOB, taskId))).toBe("not_found");
    expect(await codeOf(() => h.tasks.cancel(BOB, taskId))).toBe("not_found");
    expect(await codeOf(() => h.tasks.retryStage(BOB, taskId, { stage: "summary" }))).toBe("not_found");
    expect(h.tasks.list(BOB, { limit: 10 }).items).toEqual([]);
  });

  it("cancels unfinished work, and refuses to cancel a finished task", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    const detail = h.tasks.cancel(LOCAL, taskId);
    expect(detail).toMatchObject({ statusProjection: "cancelled", stageRuns: [{ status: "cancelled" }] });
    expect(await codeOf(() => h.tasks.cancel(LOCAL, taskId))).toBe("conflict");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "summary" }))).toBe("conflict");
  });

  it("confirm-resend only applies to a unit waiting for the user", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.executors.summary = {
      async run(context) {
        await context.runUnit({ key: "u", inputDigest: "d", run: async () => ({}) });
        return {};
      },
    };
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    const unitId = h.tasks.get(LOCAL, taskId).workUnits[0]?.id as string;
    expect(await codeOf(() => h.tasks.confirmResend(LOCAL, taskId, unitId))).toBe("conflict");
    expect(await codeOf(() => h.tasks.confirmResend(LOCAL, taskId, "missing"))).toBe("not_found");
  });

  it("lists newest first with a cursor and the event sequence read before the snapshot", () => {
    const h = harness();
    const ids = [1000, 2000, 3000].map((createdAt) => createTaskOfKind(h, "cache_media", {}, { createdAt }));
    const first = h.tasks.list(LOCAL, { limit: 2 });
    expect(first.items.map((task) => task.id)).toEqual([ids[2], ids[1]]);
    expect(first.eventSeq).toBe(h.bus.currentSeq());
    const second = h.tasks.list(LOCAL, { limit: 2, cursor: first.nextCursor as string });
    expect(second.items.map((task) => task.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeUndefined();
    expect(() => h.tasks.list(LOCAL, { limit: 2, cursor: "not-a-cursor" })).toThrow();
  });

  it("narrows to unfinished or finished Tasks and to one target, naming each target", async () => {
    const h = harness();
    const contentId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.contents.insert({ id: contentId, userId: LOCAL.userId, source: { kind: "local" }, title: "Lecture 1", processingStatus: "queued", createdAt: 1, updatedAt: 1 }),
    );
    const done = createTaskOfKind(h, "cache_media", {}, { contentId, createdAt: 1000 });
    const running = createTaskOfKind(h, "cache_media", {}, { contentId, createdAt: 2000 });
    const elsewhere = createTaskOfKind(h, "cache_media", {}, { createdAt: 3000 });
    await h.tasks.cancel(LOCAL, done);
    const collection = h.collections.create(LOCAL, { name: "Course" });
    h.db.prepare("INSERT INTO task (id, user_id, collection_id, kind, request_json, status_projection, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("collection-task", LOCAL.userId, collection.id, "summarize_collection", "{}", "queued", 4000);

    const ids = (query: Omit<Parameters<Harness["tasks"]["list"]>[1], "limit">) => h.tasks.list(LOCAL, { limit: 10, ...query }).items.map((task) => task.id);
    expect(ids({ unfinished: true })).toEqual(["collection-task", elsewhere, running]);
    expect(ids({ contentId })).toEqual([running, done]);
    expect(ids({ contentId, unfinished: true })).toEqual([running]);
    expect(ids({ finished: true })).toEqual([done]);
    expect(ids({ collectionId: collection.id, finished: true })).toEqual([]);
    expect(ids({ collectionId: collection.id })).toEqual(["collection-task"]);
    expect(h.tasks.list(BOB, { limit: 10, contentId }).items).toEqual([]);

    const titles = Object.fromEntries(h.tasks.list(LOCAL, { limit: 10 }).items.map((task) => [task.id, task.targetTitle]));
    expect(titles).toEqual({ "collection-task": "Course", [elsewhere]: undefined, [running]: "Lecture 1", [done]: "Lecture 1" });
    expect(h.tasks.get(LOCAL, running).targetTitle).toBe("Lecture 1");
  });
});

describe("stage engines", () => {
  it("name the effective model of LLM stages and the bound ASR model, in snapshots and in stage events", () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const asrModelRef = asrProfile(h);
    const { asrProfileId } = asrModelRef;
    const events: TaskEvent[] = [];
    const unsubscribe = h.bus.subscribe(({ event }) => void events.push(event));
    const withModel = createTaskOfKind(h, "reproofread", { modelRef, baseRevisionId: "r" });
    const withoutModel = createTaskOfKind(h, "regenerate_summary", { baseRevisionId: "r" });
    const asr = createTaskOfKind(h, "retranscribe", { asrModelRef });
    const unboundAsr = createTaskOfKind(h, "retranscribe", {});
    const media = createTaskOfKind(h, "cache_media", {});
    unsubscribe();

    const engineOf = (taskId: string) => h.tasks.get(LOCAL, taskId).stageRuns[0]?.engine;
    expect(engineOf(withModel)).toEqual({ kind: "llm", modelRef });
    expect(engineOf(withoutModel)).toBeUndefined();
    expect(engineOf(asr)).toEqual({ kind: "asr", asrModelRef, provider: "dashscope" });
    expect(engineOf(unboundAsr)).toBeUndefined();
    expect(engineOf(media)).toBeUndefined();
    const stageEvent = events.find((event) => event.type === "stage.updated" && event.stageRun.taskId === withModel);
    expect(stageEvent).toMatchObject({ stageRun: { engine: { kind: "llm", modelRef } } });

    // A model frozen into the stage input wins over the request.
    const other = { ...modelRef, modelId: "model-b" };
    const run = h.repository.withTransaction((scope) => scope.stageRuns.listByTask(LOCAL.userId, withoutModel)[0]);
    h.db.prepare("UPDATE stage_run SET input_json = ? WHERE id = ?").run(JSON.stringify({ modelRef: other }), run?.id);
    expect(engineOf(withoutModel)).toEqual({ kind: "llm", modelRef: other });

    // Once the profile is gone, the Task's usage record still names what did the work.
    h.tasks.cancel(LOCAL, asr);
    h.repository.withTransaction((scope) => {
      scope.asrUsage.insert({
        id: h.newId(), userId: LOCAL.userId, asrProfileId, provider: "dashscope", model: "fun-asr", feature: "transcribe", outcome: "succeeded", audioMs: 1000, taskId: asr, createdAt: 1,
      });
      scope.asrProfiles.delete(LOCAL.userId, asrProfileId);
    });
    expect(engineOf(asr)).toEqual({ kind: "asr", asrModelRef, provider: "dashscope" });
  });
});

describe("the ASR model of a stage", () => {
  it("is supplied through retry-stage only for an ASR stage waiting without one, and only as a listed model of the user's own profiles", async () => {
    const h = harness();
    const mine = asrProfile(h);
    const unkeyed = asrProfile(h, LOCAL.userId, false);
    const bobs = asrProfile(h, BOB.userId);
    const taskId = createTaskOfKind(h, "retranscribe", {});
    const summary = createTaskOfKind(h, "regenerate_summary", { baseRevisionId: "r" });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    await h.scheduler.stop();
    const asr = () => latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "asr");
    expect(asr()).toMatchObject({ status: "waiting_configuration", error: { class: "asr_unconfigured" } });

    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "asr" }))).toBe("invalid_request");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: bobs }))).toBe("invalid_request");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: unkeyed }))).toBe("invalid_request");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: { ...mine, modelId: "scribe_v2" } }))).toBe("invalid_request");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "asr", modelRef: configureLlm(h) }))).toBe("invalid_request");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, summary, { stage: "summary", asrModelRef: mine }))).toBe("invalid_request");
    expect(asr()).toMatchObject({ status: "waiting_configuration" });
    expect(asr()?.inputJson).toBeUndefined();

    h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: mine });
    expect(asr()).toMatchObject({ status: "pending", attempt: 1, inputJson: JSON.stringify({ asrModelRef: mine }) });
  });

  it("is refused through retry-stage when the request already binds one", async () => {
    const h = harness();
    const unkeyed = asrProfile(h, LOCAL.userId, false);
    const other = asrProfile(h);
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef: unkeyed });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    await h.scheduler.stop();
    expect(stageStatuses(h, taskId).asr).toBe("waiting_configuration");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: other }))).toBe("invalid_request");
  });

  it("is switched when a failed ASR stage is re-run, and otherwise inherited", async () => {
    const h = harness();
    const first = asrProfile(h);
    const second = asrProfile(h);
    h.executors.asr = { run: async () => Promise.reject(amberError("asr_failed", "job failed", { code: "asr_failed.job_failed" })) };
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef: first });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId).asr).toBe("failed");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: asrProfile(h, BOB.userId) }))).toBe("invalid_request");

    h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: second });
    const latest = () => latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "asr");
    expect(latest()).toMatchObject({ attempt: 2, status: "pending", inputJson: JSON.stringify({ asrModelRef: second }) });
    expect(h.tasks.get(LOCAL, taskId).stageRuns.find((run) => run.attempt === 2)?.engine).toMatchObject({ asrModelRef: second });

    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId).asr).toBe("failed");
    h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(latest()).toMatchObject({ attempt: 3, inputJson: JSON.stringify({ asrModelRef: second }) });
    await h.scheduler.whenIdle();
  });
});

describe("cancelling a Task whose ASR job was submitted", () => {
  function submittedJob(h: Harness, asrModelRef: AsrModelRef, awaited: "pending" | "succeeded") {
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    const run = stageRunsOf(h, taskId)[0];
    const handle = { version: 1, provider: "dashscope", jobId: "job-1", submittedAt: 1 };
    h.repository.withTransaction((scope) => {
      scope.stageRuns.update(LOCAL.userId, { ...(run as NonNullable<typeof run>), status: "running" });
      const submit = { id: h.newId(), stageRunId: run?.id as string, key: "asr:submit", status: "succeeded" as const, attempt: 1, retryCount: 0, inputDigest: "d", billing: "asr" as const };
      const payloadJson = JSON.stringify(handle);
      scope.workUnits.insert(LOCAL.userId, { ...submit, outputDigest: "sha256:x" });
      scope.workUnits.putResult(LOCAL.userId, { workUnitId: submit.id, payloadJson, outputDigest: "sha256:x", createdAt: 1 });
      scope.workUnits.insert(LOCAL.userId, { id: h.newId(), stageRunId: run?.id as string, key: "asr:await", status: awaited, attempt: 1, retryCount: 0, inputDigest: "a" });
    });
    return { taskId, handle };
  }

  function service(h: Harness, cancel: (handle: unknown) => Promise<"cancelled">) {
    const logged: Array<{ message: string; fields: unknown }> = [];
    const logger = {
      debug: () => undefined,
      info: (message: string, fields?: unknown) => void logged.push({ message, fields }),
      warn: (message: string, fields?: unknown) => void logged.push({ message, fields }),
      error: () => undefined,
      child: () => logger,
    };
    const created: string[] = [];
    const tasks = new TaskService({
      repository: h.repository,
      bus: h.bus,
      control: h.scheduler,
      secrets: h.secrets,
      logger,
      asr: () => ({
        descriptor: {} as never,
        probe: async () => ({}),
        create: (profile, modelId) => {
          created.push(`${profile.id}:${modelId}`);
          return {
            id: "fake-job",
            capabilities: { delivery: "job" } as never,
            submit: async () => Promise.reject(new Error("not used")),
            poll: async () => Promise.reject(new Error("not used")),
            cancel: async (handle) => cancel(handle),
          };
        },
      }),
    });
    return { tasks, logged, created };
  }

  it("asks the provider to cancel the job after the local cancellation, and only logs what it answered", async () => {
    const h = harness();
    const ref = asrProfile(h);
    const { taskId, handle } = submittedJob(h, ref, "pending");
    const seen: unknown[] = [];
    const { tasks, logged, created } = service(h, async (received) => {
      seen.push(received);
      expect(taskOf(h, taskId).statusProjection).toBe("cancelled");
      return "cancelled";
    });
    expect(tasks.cancel(LOCAL, taskId).statusProjection).toBe("cancelled");
    await tasks.settleRemoteCancels();
    expect(created).toEqual([`${ref.asrProfileId}:${ref.modelId}`]);
    expect(seen).toEqual([handle]);
    expect(logged).toEqual([{ message: "asr_job_cancel", fields: { taskId, outcome: "cancelled" } }]);
  });

  it("keeps the cancellation when the provider fails, and asks nothing once the result arrived", async () => {
    const h = harness();
    const ref = asrProfile(h);
    const failing = submittedJob(h, ref, "pending");
    const { tasks, logged } = service(h, async () => Promise.reject(new Error("boom")));
    expect(tasks.cancel(LOCAL, failing.taskId).statusProjection).toBe("cancelled");
    await tasks.settleRemoteCancels();
    expect(logged.map((entry) => entry.message)).toEqual(["asr_job_cancel_failed"]);

    const done = submittedJob(h, ref, "succeeded");
    const quiet = service(h, async () => "cancelled");
    quiet.tasks.cancel(LOCAL, done.taskId);
    await quiet.tasks.settleRemoteCancels();
    expect(quiet.created).toEqual([]);
    expect(quiet.logged).toEqual([]);
  });
});

describe("Tasks of a Content in the trash", () => {
  function trash(h: Harness, contentId: string): void {
    h.trash.trash(LOCAL, contentId);
  }

  it("are unknown to get, cancel, retry-stage, confirm-resend and the content filter, idempotent replays included", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.executors.summary = { run: async () => Promise.reject(amberError("llm_capability")) };
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    const contentId = taskOf(h, taskId).contentId as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(h.tasks.retryStage(LOCAL, taskId, { stage: "summary" }, "retry-1")).toEqual({ taskId });
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    await h.scheduler.stop();
    expect(taskOf(h, taskId).statusProjection).toBe("failed");
    const unitId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.idempotency.insert({
        userId: LOCAL.userId, route: CONFIRM_RESEND_ROUTE, key: "resend-1", requestDigest: jsonRequestDigest({ taskId, workUnitId: unitId }),
        responseStatus: 202, responseBodyJson: JSON.stringify({ taskId }), resourceRefsJson: "[]", createdAt: 1,
      }),
    );
    trash(h, contentId);

    expect(await codeOf(() => h.tasks.get(LOCAL, taskId))).toBe("not_found");
    expect(await codeOf(() => h.tasks.cancel(LOCAL, taskId))).toBe("not_found");
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "summary" }))).toBe("not_found");
    // The stored answers of earlier requests are not replayed for a Task that is gone.
    expect(await codeOf(() => h.tasks.retryStage(LOCAL, taskId, { stage: "summary" }, "retry-1"))).toBe("not_found");
    expect(await codeOf(() => h.tasks.confirmResend(LOCAL, taskId, unitId, "resend-1"))).toBe("not_found");
    expect(await codeOf(() => h.tasks.list(LOCAL, { limit: 10, contentId }))).toBe("not_found");
    expect(h.tasks.list(LOCAL, { limit: 10 }).items.map((task) => task.id)).not.toContain(taskId);
    // Another user naming it learns nothing either.
    expect(h.tasks.list(BOB, { limit: 10, contentId }).items).toEqual([]);

    h.trash.restore(LOCAL, contentId);
    expect(h.tasks.get(LOCAL, taskId).id).toBe(taskId);
  });

  it("refuse a collection summary retry, replay included, while a frozen member is in the trash", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const collection = h.collections.create(LOCAL, { name: "Course" });
    const members: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const contentId = createLocalContent(h);
      const fixture = seedTranscripts(h, contentId);
      insertSummary(h, { contentId, transcriptRevisionId: fixture.asr.revision.id });
      await h.collections.addItem(LOCAL, collection.id, { contentId });
      members.push(contentId);
    }
    h.executors.collection_summary = { run: async () => Promise.reject(amberError("llm_capability")) };
    const { body } = await h.collections.createSummary(LOCAL, collection.id, { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(h.tasks.retryStage(LOCAL, body.taskId, { stage: "collection_summary" }, "again-1")).toEqual({ taskId: body.taskId });
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    await h.scheduler.stop();
    expect(taskOf(h, body.taskId).statusProjection).toBe("failed");

    trash(h, members[1] as string);
    for (const key of [undefined, "again-1"]) {
      const error = await errorOf(() => h.tasks.retryStage(LOCAL, body.taskId, { stage: "collection_summary" }, key));
      expect(error).toMatchObject({ code: "invalid_request.collection_summary_missing", details: { missingContentIds: [members[1]] } });
    }
    h.trash.restore(LOCAL, members[1] as string);
    expect(h.tasks.retryStage(LOCAL, body.taskId, { stage: "collection_summary" })).toEqual({ taskId: body.taskId });
  });
});

async function errorOf(work: () => unknown) {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  return undefined;
}
