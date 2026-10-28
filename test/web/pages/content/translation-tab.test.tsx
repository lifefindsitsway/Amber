import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX } from "../../../../src/shared/defaults.ts";
import type { TranslationsDto } from "../../../../src/shared/dto/translation.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { targetLanguageChoices, translateFailureDismissedKey } from "../../../../src/web/pages/content/translation-tab.tsx";
import { contentRoutes, revision } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";
import { stageRun, taskDetail } from "../../../fixtures/web/shell-data.ts";

const EMPTY_CAPABILITY = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
const PROVIDERS = {
  body: {
    items: [
      {
        id: "p1",
        name: "P",
        protocol: "openai_compatible",
        baseURL: "https://x",
        credentialStatus: "configured",
        hasCredential: true,
        models: [{ modelId: "m1", flags: { declared: EMPTY_CAPABILITY }, limits: { declared: {} }, effective: { flags: EMPTY_CAPABILITY, limits: {} } }],
        createdAt: 1,
      },
    ],
  },
};
const TRANSLATED = revision("t-en", { kind: "translated", language: "en", parentRevisionId: "r0", createdAt: new Date(2026, 9, 4, 12, 26).getTime() });

function translations(overrides: Partial<TranslationsDto> = {}): { body: TranslationsDto } {
  return {
    body: {
      translations: [{ artifactId: "ta1", targetLanguage: "en", current: TRANSLATED, revisions: [TRANSLATED], stale: true, staleReason: "transcript_changed" }],
      activeTasks: [],
      ...overrides,
    },
  };
}

const LATEST = "/api/tasks?contentId=c1&kind=translate&limit=1";
const FAILURE = { class: "llm_failed", code: "llm_failed", retryDisposition: "policy", userMessage: "AI 模型调用失败" } as const;
const FAILED_TASK = { id: "x1", kind: "translate", statusProjection: "failed", contentId: "c1", createdAt: 1 } as const;
const latest = (task: object | undefined) => ({ body: { items: task === undefined ? [] : [task], eventSeq: 0 } });
const FAILED_DETAIL = {
  body: taskDetail("x1", [stageRun("x1", "translate", "failed", { error: FAILURE, engine: { kind: "llm", modelRef: { providerProfileId: "p1", modelId: "m1" } } })], {
    kind: "translate",
    contentId: "c1",
    statusProjection: "failed",
  }),
};

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
});

describe("targetLanguageChoices", () => {
  it("leaves out every tag of the source's language", () => {
    const choices = targetLanguageChoices("zh-CN");
    expect(choices).toContain("en");
    expect(choices.some((tag) => tag.startsWith("zh"))).toBe(false);
    expect(targetLanguageChoices(undefined)).toContain("zh-CN");
  });
});

describe("TranslationTab", () => {
  it("translates the chosen languages with the chosen model on the first click", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/translations": translations({ translations: [] }),
      "POST /api/contents/c1/translations": { status: 202, body: { taskId: "t9" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    await screen.findByTestId("translation-tab");
    expect(screen.queryByTestId("translation-language-zh-CN")).toBeNull();
    const start = await screen.findByTestId("translation-start");
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("translation-language-en"));
    fireEvent.change(screen.getByLabelText("其它语言", { exact: false }), { target: { value: "vi" } });
    fireEvent.click(screen.getByText("添加"));
    await waitFor(() => expect((screen.getByTestId("translation-language-vi") as HTMLInputElement).checked).toBe(true));
    fireEvent.click(start);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({ targetLanguages: ["en", "vi"], modelRef: { providerProfileId: "p1", modelId: "m1" } }),
    );
  });

  it("refuses an invalid or same-language custom tag", async () => {
    mockApi({ ...contentRoutes(), "GET /api/providers": PROVIDERS });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    const input = await screen.findByLabelText("其它语言", { exact: false });
    for (const value of ["not a tag", "zh-TW"]) {
      fireEvent.change(input, { target: { value } });
      expect((screen.getByText("添加").closest("button") as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("lists each language's current version, flags a stale one and opens it in the subtitles tab", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/translations": translations(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), TRANSLATED] } },
      "GET /api/transcript/revisions/t-en/segments": { body: { revision: TRANSLATED, items: [] } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    const entry = await screen.findByTestId("translation-entry");
    expect(entry.getAttribute("data-language")).toBe("en");
    expect(within(entry).getByTestId("translation-stale").textContent).toBe("基于旧字幕版本");
    fireEvent.click(within(entry).getByTestId("translation-open"));
    const version = (await screen.findByTestId("subtitles-version")) as HTMLSelectElement;
    expect(version.value).toBe("t-en");
    expect(version.selectedOptions[0]?.textContent).toBe("翻译 · 英语 · 10-04 12:26");
  });

  it("offers the last failed translation for a re-run until closed, and not again after a reload", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/translations": translations(),
      [`GET ${LATEST}`]: latest(FAILED_TASK),
      "GET /api/tasks/x1": FAILED_DETAIL,
      "POST /api/tasks/x1/retry-stage": { status: 202, body: { taskId: "x1" } },
    });
    const first = renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    const notice = await screen.findByTestId("translation-failed");
    expect(within(notice).getByText("上次翻译失败，可从失败的步骤重跑")).toBeTruthy();
    expect((await within(notice).findByTestId("stage-translate")).dataset["status"]).toBe("failed");
    fireEvent.click(within(notice).getByRole("button", { name: "从这步重跑" }));
    await waitFor(() => expect(calls.find((call) => call.path === "/api/tasks/x1/retry-stage")?.body).toEqual({ stage: "translate" }));
    fireEvent.click(within(notice).getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("translation-failed")).toBeNull();
    expect(localStorage.getItem(translateFailureDismissedKey("c1"))).toBe("x1");
    first.unmount();

    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    await screen.findByTestId("translation-entry");
    await waitFor(() => expect(calls.filter((call) => call.path === LATEST)).toHaveLength(2));
    expect(screen.queryByTestId("translation-failed")).toBeNull();
  });

  it("offers nothing when the last translation succeeded, or while a translation runs", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/translations": translations(),
      [`GET ${LATEST}`]: latest({ ...FAILED_TASK, statusProjection: "succeeded" }),
    });
    const done = renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    await screen.findByTestId("translation-entry");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("translation-failed")).toBeNull();
    done.unmount();

    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/translations": translations({ activeTasks: [{ taskId: "x2", targetLanguages: ["en"] }] }),
      [`GET ${LATEST}`]: latest(FAILED_TASK),
      "GET /api/tasks/x1": FAILED_DETAIL,
      "GET /api/tasks/x2": { body: taskDetail("x2", [stageRun("x2", "translate", "running")], { kind: "translate", contentId: "c1" }) },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    expect(await screen.findByTestId("translation-running")).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.path === LATEST)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("translation-failed")).toBeNull();
  });

  it("follows a re-run: a task event reads the translations and the last Task again", async () => {
    let rerun = false;
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/translations": () => translations(rerun ? { activeTasks: [{ taskId: "x1", targetLanguages: ["en"] }] } : {}),
      [`GET ${LATEST}`]: () => latest({ ...FAILED_TASK, statusProjection: rerun ? "running" : "failed" }),
      "GET /api/tasks/x1": FAILED_DETAIL,
    });
    const stream = taskStream();
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    await screen.findByTestId("translation-failed");
    await waitFor(() => expect(stream.opened()).toBe(true));
    rerun = true;
    stream.frame("task.updated", { task: { ...FAILED_TASK, statusProjection: "running" } });
    await waitFor(() => expect(screen.queryByTestId("translation-failed")).toBeNull());
    expect(await screen.findByTestId("translation-running")).toBeTruthy();
    expect(calls.filter((call) => call.path === LATEST).length).toBeGreaterThanOrEqual(2);
  });
});

/** Answers the task stream with one the test writes frames into; other calls keep the route table. */
function taskStream() {
  const routed = globalThis.fetch;
  let push: ((text: string) => void) | undefined;
  let seq = 0;
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
  return {
    opened: () => push !== undefined,
    frame: (type: string, data: object) => {
      seq += 1;
      push?.(`event: ${type}\ndata: ${JSON.stringify(data)}\nid: ${seq}\n\n`);
    },
  };
}
