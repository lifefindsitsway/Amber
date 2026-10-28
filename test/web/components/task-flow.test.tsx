import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentTaskFlow, contentFlowRows, latestStageRuns, runningStep, TaskFlow } from "../../../src/web/components/task-flow.tsx";
import { baseRoutes, provider, stageRun, taskDetail } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const FAILURE = { class: "llm_failed", code: "llm_failed", retryDisposition: "policy", userMessage: "AI 模型调用失败", upstreamMessage: "upstream said 500" } as const;

describe("latestStageRuns", () => {
  it("keeps the latest attempt of each stage in pipeline order", () => {
    const runs = latestStageRuns({
      stageRuns: [stageRun("t", "summary", "pending"), stageRun("t", "source", "succeeded"), stageRun("t", "proofread", "failed"), stageRun("t", "proofread", "running", { attempt: 2 })],
    });
    expect(runs.map((run) => `${run.stage}#${run.attempt}`)).toEqual(["source#1", "proofread#2", "summary#1"]);
  });
});

describe("runningStep", () => {
  const unit = (id: string, stageRunId: string, key: string, status: "running" | "succeeded" | "waiting_user_action") => ({ id, stageRunId, key, status, attempt: 1, retryCount: 0 });

  it("names the step of the run's running unit, preferring the latest listed one", () => {
    const workUnits = [
      unit("w1", "r1", "media:fetch_audio", "succeeded"),
      unit("w2", "r1", "media:extract_audio", "running"),
      unit("w3", "r1", "asr:submit", "running"),
      unit("w4", "r2", "media:fetch_audio", "running"),
    ];
    expect(runningStep({ workUnits }, "r1")).toBe("transcribe");
    expect(runningStep({ workUnits }, "r2")).toBe("fetchAudio");
  });

  it("names nothing for a run whose running units have no step, or that has only parked units", () => {
    expect(runningStep({ workUnits: [unit("w1", "r1", "proofread:0", "running")] }, "r1")).toBeUndefined();
    expect(runningStep({ workUnits: [unit("w1", "r1", "asr:submit", "waiting_user_action")] }, "r1")).toBeUndefined();
  });
});

describe("TaskFlow", () => {
  it("shows the running step after the stage status, without offering a resend", async () => {
    const run = stageRun("t6", "asr", "running", { progress: 0.2 });
    const detail = taskDetail("t6", [run], {
      workUnits: [{ id: "w1", stageRunId: run.id, key: "media:fetch_audio", status: "running", attempt: 1, retryCount: 0 }],
    });
    mockApi({ ...baseRoutes(), "GET /api/tasks/t6": { body: detail } });
    renderApp(<TaskFlow taskId="t6" />);
    await waitFor(() => expect(screen.getByTestId("stage-asr").textContent).toContain("下载音频"));
    expect(screen.getByTestId("stage-asr").textContent).toContain(" · 下载音频");
    expect(screen.queryByTestId("resend-prompt")).toBeNull();
  });

  it("explains the wait for the transcription service only while uploading and transcribing", async () => {
    const run = stageRun("t7", "asr", "running", { progress: 0.75 });
    const detail = taskDetail("t7", [run], {
      workUnits: [{ id: "w1", stageRunId: run.id, key: "asr:submit", status: "running", attempt: 1, retryCount: 0 }],
    });
    mockApi({ ...baseRoutes(), "GET /api/tasks/t7": { body: detail } });
    renderApp(<TaskFlow taskId="t7" />);
    await waitFor(() => expect(screen.getByTestId("stage-asr").textContent).toContain(" · 上传并转写"));
    expect(within(screen.getByTestId("stage-asr")).getByTestId("step-hint").textContent).toContain("要等转写服务返回结果");
  });

  it("gives no waiting hint to other steps", async () => {
    const run = stageRun("t8", "asr", "running", { progress: 0.45 });
    const detail = taskDetail("t8", [run], {
      workUnits: [{ id: "w1", stageRunId: run.id, key: "media:extract_audio", status: "running", attempt: 1, retryCount: 0 }],
    });
    mockApi({ ...baseRoutes(), "GET /api/tasks/t8": { body: detail } });
    renderApp(<TaskFlow taskId="t8" />);
    await waitFor(() => expect(screen.getByTestId("stage-asr").textContent).toContain(" · 提取音轨"));
    expect(screen.queryByTestId("step-hint")).toBeNull();
  });

  it("renders stages, the failure in three layers, and re-runs from the failed stage", async () => {
    const detail = taskDetail("t1", [
      stageRun("t1", "source", "succeeded"),
      stageRun("t1", "summary", "failed", { error: FAILURE, engine: { kind: "llm", modelRef: { providerProfileId: "p1", modelId: "m1" } } }),
    ]);
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1"])] } },
      "GET /api/tasks/t1": { body: detail },
      "POST /api/tasks/t1/retry-stage": { status: 202, body: { taskId: "t1" } },
    });
    renderApp(<TaskFlow taskId="t1" />);
    const summary = await screen.findByTestId("stage-summary");
    expect(summary.dataset["status"]).toBe("failed");
    expect(screen.getByTestId("stage-source").dataset["status"]).toBe("succeeded");
    expect(summary.textContent).toContain("AI 模型调用失败");
    await waitFor(() => expect(summary.textContent).toContain("我的模型 · m1"));
    fireEvent.click(screen.getByRole("button", { name: "上游原文" }));
    expect(summary.textContent).toContain("upstream said 500");

    const model = screen.getByLabelText<HTMLSelectElement>("重跑所用模型");
    expect(model.value).toBe(JSON.stringify(["p1", "m1"]));
    expect(summary.textContent).not.toContain("换模型将重新处理本阶段全部内容");

    expect(summary.textContent).toContain("重跑会采用当前的提示词设置");

    fireEvent.click(screen.getByRole("button", { name: "从这步重跑" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/tasks/t1/retry-stage")).toBe(true));
    const post = calls.find((call) => call.path === "/api/tasks/t1/retry-stage");
    expect(post?.body).toEqual({ stage: "summary" });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
  });

  it("re-runs a failed LLM stage with another model only after the user picks one", async () => {
    const detail = taskDetail("t6", [
      stageRun("t6", "proofread", "failed", { error: FAILURE, engine: { kind: "llm", modelRef: { providerProfileId: "p1", modelId: "m1" } } }),
    ]);
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1", "m2"]), provider("p2", "备用", ["x1"])] } },
      "GET /api/tasks/t6": { body: detail },
      "POST /api/tasks/t6/retry-stage": { status: 202, body: { taskId: "t6" } },
    });
    renderApp(<TaskFlow taskId="t6" />);
    const proofread = await screen.findByTestId("stage-proofread");
    const model = await screen.findByLabelText<HTMLSelectElement>("重跑所用模型");
    await waitFor(() => expect(model.options).toHaveLength(3));
    expect(model.value).toBe(JSON.stringify(["p1", "m1"]));

    fireEvent.change(model, { target: { value: JSON.stringify(["p2", "x1"]) } });
    expect(proofread.textContent).toContain("换模型将重新处理本阶段全部内容");
    fireEvent.click(screen.getByRole("button", { name: "从这步重跑" }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === "/api/tasks/t6/retry-stage")?.body).toEqual({ stage: "proofread", modelRef: { providerProfileId: "p2", modelId: "x1" } }),
    );
  });

  it("keeps a bound model selectable even when its profile no longer lists it", async () => {
    const detail = taskDetail("t7", [
      stageRun("t7", "chapter", "failed", { error: FAILURE, engine: { kind: "llm", modelRef: { providerProfileId: "gone", modelId: "old" } } }),
    ]);
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1"])] } },
      "GET /api/tasks/t7": { body: detail },
      "POST /api/tasks/t7/retry-stage": { status: 202, body: { taskId: "t7" } },
    });
    renderApp(<TaskFlow taskId="t7" />);
    const model = await screen.findByLabelText<HTMLSelectElement>("重跑所用模型");
    await waitFor(() => expect(model.options).toHaveLength(2));
    expect(model.value).toBe(JSON.stringify(["gone", "old"]));
    fireEvent.click(screen.getByRole("button", { name: "从这步重跑" }));
    await waitFor(() => expect(calls.find((call) => call.path === "/api/tasks/t7/retry-stage")?.body).toEqual({ stage: "chapter" }));
  });

  it("lets a waiting LLM stage continue with a chosen model", async () => {
    const detail = taskDetail("t2", [stageRun("t2", "proofread", "waiting_configuration")], { statusProjection: "waiting" });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/providers": { body: { items: [provider("p1", "我的模型", ["m1", "m2"])] } },
      "GET /api/tasks/t2": { body: detail },
      "POST /api/tasks/t2/retry-stage": { status: 202, body: { taskId: "t2" } },
    });
    renderApp(<TaskFlow taskId="t2" />);
    const select = await screen.findByLabelText("选择用于这一步的模型");
    fireEvent.change(select, { target: { value: JSON.stringify(["p1", "m2"]) } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(calls.find((call) => call.path === "/api/tasks/t2/retry-stage")?.body).toEqual({ stage: "proofread", modelRef: { providerProfileId: "p1", modelId: "m2" } }));
    expect(screen.getByRole("link", { name: "配置 AI 模型" }).getAttribute("href")).toBe("/settings/models");
  });

  it("asks for explicit confirmation before resending a paid call whose outcome is unknown", async () => {
    const run = stageRun("t3", "asr", "running");
    const detail = taskDetail("t3", [run], {
      statusProjection: "waiting",
      workUnits: [{ id: "w1", stageRunId: run.id, key: "asr:submit", status: "waiting_user_action", attempt: 1, retryCount: 0 }],
    });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks/t3": { body: detail },
      "POST /api/tasks/t3/work-units/w1/confirm-resend": { status: 202, body: { taskId: "t3" } },
    });
    renderApp(<TaskFlow taskId="t3" />);
    expect(await screen.findByText(/可能再次计费/)).toBeTruthy();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认重新发送（1）" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path === "/api/tasks/t3/work-units/w1/confirm-resend")).toBe(true));
  });

  it("confirms every parked unit of a stage with one button", async () => {
    const run = stageRun("t5", "proofread", "running");
    const detail = taskDetail("t5", [run], {
      statusProjection: "waiting",
      workUnits: [
        { id: "w1", stageRunId: run.id, key: "proofread:0", status: "waiting_user_action", attempt: 1, retryCount: 0 },
        { id: "w2", stageRunId: run.id, key: "proofread:1", status: "waiting_user_action", attempt: 1, retryCount: 0 },
      ],
    });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks/t5": { body: detail },
      "POST /api/tasks/t5/work-units/w1/confirm-resend": { status: 202, body: { taskId: "t5" } },
      "POST /api/tasks/t5/work-units/w2/confirm-resend": { status: 202, body: { taskId: "t5" } },
    });
    renderApp(<TaskFlow taskId="t5" />);
    expect(await screen.findByText(/2 个请求已发出但结果未知/)).toBeTruthy();
    expect(screen.getAllByTestId("resend-prompt")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /确认重新发送/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "确认重新发送（2）" }));
    const posts = () => calls.filter((call) => call.method === "POST").map((call) => call.path);
    await waitFor(() => expect(posts()).toEqual(["/api/tasks/t5/work-units/w1/confirm-resend", "/api/tasks/t5/work-units/w2/confirm-resend"]));
  });

  it("points a failure that needs a platform login to the account settings", async () => {
    const authRequired = { class: "auth_required", code: "auth_required", retryDisposition: "never", userMessage: "" } as const;
    const detail = taskDetail("t4", [stageRun("t4", "source", "failed", { error: authRequired })]);
    mockApi({ ...baseRoutes(), "GET /api/tasks/t4": { body: detail } });
    renderApp(<TaskFlow taskId="t4" />);
    const link = await screen.findByRole("link", { name: "去平台账号设置" });
    expect(link.getAttribute("href")).toBe("/settings/platform-accounts");
    expect(screen.getByRole("button", { name: "从这步重跑" })).toBeTruthy();
    expect(screen.queryByLabelText("重跑所用模型")).toBeNull();
  });
});

describe("TaskFlow ASR stage", () => {
  const ASR_FAILURE = { class: "asr_failed", code: "asr_failed.job_failed", retryDisposition: "never", userMessage: "转写失败" } as const;
  const asr = (id: string, name: string, models = ["qwen-audio-3.1-asr-flash-filetrans", "fun-asr"]) => ({
    id,
    name,
    provider: "dashscope",
    models: models.map((modelId) => ({ modelId, available: true })),
    credentialStatus: "configured",
    hasCredential: true,
    inUse: false,
    createdAt: 1,
  });
  const key = (asrProfileId: string, modelId: string) => JSON.stringify([asrProfileId, modelId]);

  it("names the step of a unit that waits between two queries of an ASR job", () => {
    const waiting = { id: "w2", stageRunId: "r1", key: "asr:await", status: "pending" as const, attempt: 2, retryCount: 0, retryNotBefore: 9_000 };
    const submitted = { id: "w1", stageRunId: "r1", key: "asr:submit", status: "succeeded" as const, attempt: 1, retryCount: 0 };
    expect(runningStep({ workUnits: [submitted, waiting] }, "r1")).toBe("awaitResult");
  });

  it("lets a waiting ASR stage continue with a chosen model, the default preselected", async () => {
    const detail = taskDetail("t3", [stageRun("t3", "asr", "waiting_configuration")], { statusProjection: "waiting" });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号"), asr("a2", "二号")] } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, defaultAsrModelRef: { asrProfileId: "a2", modelId: "fun-asr" }, updatedAt: 1 } },
      "GET /api/tasks/t3": { body: detail },
      "POST /api/tasks/t3/retry-stage": { status: 202, body: { taskId: "t3" } },
    });
    renderApp(<TaskFlow taskId="t3" />);
    const select = await screen.findByLabelText<HTMLSelectElement>("选择转录模型");
    await waitFor(() => expect(select.value).toBe(key("a2", "fun-asr")));
    fireEvent.change(select, { target: { value: key("a1", "qwen-audio-3.1-asr-flash-filetrans") } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === "/api/tasks/t3/retry-stage")?.body).toEqual({
        stage: "asr",
        asrModelRef: { asrProfileId: "a1", modelId: "qwen-audio-3.1-asr-flash-filetrans" },
      }),
    );
    expect(screen.getByRole("link", { name: "配置转录模型" }).getAttribute("href")).toBe("/settings/transcription");
  });

  it("keeps a waiting ASR stage from continuing until a model is chosen when there is no default", async () => {
    const detail = taskDetail("t6", [stageRun("t6", "asr", "waiting_configuration")], { statusProjection: "waiting" });
    mockApi({
      ...baseRoutes(),
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号")] } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      "GET /api/tasks/t6": { body: detail },
    });
    renderApp(<TaskFlow taskId="t6" />);
    const select = await screen.findByLabelText<HTMLSelectElement>("选择转录模型");
    expect(select.value).toBe("");
    const button = screen.getByRole("button", { name: "继续" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(select, { target: { value: key("a1", "fun-asr") } });
    expect(button.disabled).toBe(false);
  });

  it("re-runs a failed ASR stage with its bound model unless the user picks another", async () => {
    const detail = taskDetail("t4", [
      stageRun("t4", "asr", "failed", { error: ASR_FAILURE, engine: { kind: "asr", asrModelRef: { asrProfileId: "a1", modelId: "fun-asr" }, provider: "dashscope" } }),
    ]);
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/asr-profiles": { body: { items: [asr("a1", "一号")] } },
      "GET /api/tasks/t4": { body: detail },
      "POST /api/tasks/t4/retry-stage": { status: 202, body: { taskId: "t4" } },
    });
    renderApp(<TaskFlow taskId="t4" />);
    const stage = await screen.findByTestId("stage-asr");
    await waitFor(() => expect(stage.textContent).toContain("语音转写 · 一号 · fun-asr"));
    const select = await screen.findByLabelText<HTMLSelectElement>("重跑所用转录模型");
    expect(select.value).toBe(key("a1", "fun-asr"));
    fireEvent.change(select, { target: { value: key("a1", "qwen-audio-3.1-asr-flash-filetrans") } });
    expect(stage.textContent).toContain("换用其它转录模型会重新提交音频");
    // Transcription sends no prompt, so its re-run says nothing about prompt settings.
    expect(stage.textContent).not.toContain("重跑会采用当前的提示词设置");
    fireEvent.click(screen.getByRole("button", { name: "从这步重跑" }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === "/api/tasks/t4/retry-stage")?.body).toEqual({
        stage: "asr",
        asrModelRef: { asrProfileId: "a1", modelId: "qwen-audio-3.1-asr-flash-filetrans" },
      }),
    );
  });

  it("names a deleted profile's service and the bound model", async () => {
    const detail = taskDetail("t5", [
      stageRun("t5", "asr", "failed", { error: ASR_FAILURE, engine: { kind: "asr", asrModelRef: { asrProfileId: "gone", modelId: "fun-asr" }, provider: "dashscope" } }),
    ]);
    mockApi({
      ...baseRoutes(),
      "GET /api/asr-profiles": { body: { items: [] } },
      "GET /api/tasks/t5": { body: detail },
    });
    renderApp(<TaskFlow taskId="t5" />);
    const stage = await screen.findByTestId("stage-asr");
    await waitFor(() => expect(stage.textContent).toContain("阿里云百炼 · fun-asr（配置已删除）"));
  });
});

/** Routes the task stream to a stream the test pushes frames into; everything else to the route table. */
function pushableEvents(): (frame: string) => void {
  const routed = globalThis.fetch;
  let push: (text: string) => void = () => undefined;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/api/tasks/events")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return routed(input, init);
  });
  return (frame) => push(frame);
}

describe("contentFlowRows", () => {
  // The processing Task started its proofread stage at 100 and its summary stage at 300.
  const main = taskDetail(
    "p",
    [
      stageRun("p", "asr", "succeeded", { startedAt: 50 }),
      stageRun("p", "proofread", "skipped"),
      stageRun("p", "chapter", "succeeded", { startedAt: 200 }),
      stageRun("p", "summary", "succeeded", { startedAt: 300 }),
    ],
    { createdAt: 10, statusProjection: "succeeded" },
  );
  const redo = (id: string, kind: "retranscribe" | "reproofread" | "regenerate_chapters" | "regenerate_summary", stage: "asr" | "proofread" | "chapter" | "summary", createdAt: number) =>
    taskDetail(id, [stageRun(id, stage, "running")], { kind, createdAt });

  it("keeps the processing Task's own rows without redos", () => {
    const rows = contentFlowRows(main, {});
    expect(rows.map((row) => `${row.run.stage}:${row.owner.id}`)).toEqual(["asr:p", "proofread:p", "chapter:p", "summary:p"]);
    expect(rows.some((row) => row.redone === true)).toBe(false);
  });

  it("shows a later redo's run, also over a stage that never started, and keeps earlier ones out", () => {
    const rows = contentFlowRows(main, {
      proofread: redo("r1", "reproofread", "proofread", 20),
      chapter: redo("r2", "regenerate_chapters", "chapter", 150),
      summary: redo("r3", "regenerate_summary", "summary", 400),
    });
    expect(rows.map((row) => `${row.run.stage}:${row.owner.id}:${row.run.status}`)).toEqual(["asr:p:succeeded", "proofread:r1:running", "chapter:p:succeeded", "summary:r3:running"]);
    expect(rows.filter((row) => row.redone === true).map((row) => row.owner.id)).toEqual(["r1", "r3"]);
  });

  it("adds no row for a stage the processing Task does not have", () => {
    const platform = taskDetail("q", [stageRun("q", "source", "succeeded", { startedAt: 5 }), stageRun("q", "summary", "failed", { startedAt: 30 })], { createdAt: 1 });
    const rows = contentFlowRows(platform, { asr: redo("r4", "retranscribe", "asr", 99) });
    expect(rows.map((row) => row.run.stage)).toEqual(["source", "summary"]);
  });
});

describe("ContentTaskFlow", () => {
  const processing = (status: "succeeded" | "running" = "succeeded") =>
    taskDetail(
      "p1",
      [stageRun("p1", "asr", "succeeded", { startedAt: 1_000 }), stageRun("p1", "proofread", "skipped"), stageRun("p1", "summary", "succeeded", { startedAt: 2_000 })],
      { createdAt: 500, statusProjection: status },
    );

  it("reads like TaskFlow without redos", async () => {
    mockApi({ ...baseRoutes(), "GET /api/tasks/p1": { body: processing() } });
    renderApp(<ContentTaskFlow taskId="p1" redos={{}} />);
    const proofread = await screen.findByTestId("stage-proofread");
    expect(proofread.dataset.status).toBe("skipped");
    expect(screen.queryByTestId("stage-source")).toBeNull();
    expect(screen.getByTestId("task-flow").dataset.status).toBe("succeeded");
    expect(screen.getByTestId("task-flow").textContent).toContain("处理进度 · 已完成");
  });

  it("shows a later reproofread live in the proofread row, names it, and titles the flow running until it ends", async () => {
    const startedAt = new Date(2026, 9, 17, 14, 29).getTime();
    const redo = taskDetail("r1", [stageRun("r1", "proofread", "running", { startedAt, progress: 0.4 })], { kind: "reproofread", createdAt: startedAt, statusProjection: "running" });
    mockApi({ ...baseRoutes(), "GET /api/tasks/p1": { body: processing() }, "GET /api/tasks/r1": { body: redo } });
    const push = pushableEvents();
    renderApp(<ContentTaskFlow taskId="p1" redos={{ proofread: "r1" }} />);
    await waitFor(() => expect(screen.getByTestId("stage-proofread").dataset.status).toBe("running"));
    const row = screen.getByTestId("stage-proofread");
    expect(within(row).getByTestId("stage-source").textContent).toMatch(/^重新校对 · .*29/);
    expect(row.textContent).toContain("40%");
    const flow = screen.getByTestId("task-flow");
    expect(flow.dataset.status).toBe("running");
    expect(flow.textContent).toContain("处理进度 · 处理中");
    // Cancelling stays with the finished processing Task, so the title offers none.
    expect(within(flow).queryByRole("button", { name: "取消任务" })).toBeNull();

    push(`event: stage.updated\ndata: ${JSON.stringify({ stageRun: stageRun("r1", "proofread", "succeeded", { startedAt, progress: 1 }) })}\nid: 1\n\n`);
    await waitFor(() => expect(screen.getByTestId("stage-proofread").dataset.status).toBe("succeeded"));
    push(`event: task.finished\ndata: ${JSON.stringify({ task: { ...redo, stageRuns: undefined, workUnits: undefined, eventSeq: undefined, statusProjection: "succeeded" } })}\nid: 2\n\n`);
    await waitFor(() => expect(screen.getByTestId("task-flow").dataset.status).toBe("succeeded"));
    expect(within(screen.getByTestId("stage-proofread")).getByTestId("stage-source")).toBeTruthy();
  });

  it("re-runs and resends on the redo Task that owns the row", async () => {
    const redo = taskDetail("r2", [stageRun("r2", "proofread", "failed", { error: FAILURE, startedAt: 3_000 })], {
      kind: "reproofread",
      createdAt: 3_000,
      statusProjection: "failed",
    });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks/p1": { body: processing() },
      "GET /api/tasks/r2": { body: redo },
      "POST /api/tasks/r2/retry-stage": { status: 202, body: { taskId: "r2" } },
    });
    renderApp(<ContentTaskFlow taskId="p1" redos={{ proofread: "r2" }} />);
    await waitFor(() => expect(screen.getByTestId("stage-proofread").dataset.status).toBe("failed"));
    fireEvent.click(within(screen.getByTestId("stage-proofread")).getByRole("button", { name: "从这步重跑" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.path).toBe("/api/tasks/r2/retry-stage"));
    expect(calls.some((call) => call.path === "/api/tasks/p1/retry-stage")).toBe(false);
  });

  it("keeps an earlier redo out, and cancels only the processing Task from the title", async () => {
    const earlier = taskDetail("r3", [stageRun("r3", "asr", "failed", { error: FAILURE, startedAt: 400 })], { kind: "retranscribe", createdAt: 400, statusProjection: "failed" });
    const { calls } = mockApi({
      ...baseRoutes(),
      "GET /api/tasks/p1": { body: processing("running") },
      "GET /api/tasks/r3": { body: earlier },
      "POST /api/tasks/p1/cancel": { body: processing("running") },
    });
    renderApp(<ContentTaskFlow taskId="p1" redos={{ asr: "r3" }} />);
    const asr = await screen.findByTestId("stage-asr");
    await waitFor(() => expect(calls.some((call) => call.path === "/api/tasks/r3")).toBe(true));
    expect(asr.dataset.status).toBe("succeeded");
    expect(within(asr).queryByTestId("stage-source")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.path).toBe("/api/tasks/p1/cancel"));
  });
});
