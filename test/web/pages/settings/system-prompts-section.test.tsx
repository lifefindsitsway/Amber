import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PROMPT_CUSTOM_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import type { PromptDto } from "../../../../src/shared/dto/prompt.ts";
import { promptProblems, SystemPromptsSection } from "../../../../src/web/pages/settings/system-prompts-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const KEYS: Array<[id: string, key: string]> = [
  ["proofread.text", "proofreadText"],
  ["proofread.audio", "proofreadAudio"],
  ["translate.subtitles", "translateSubtitles"],
  ["summary.envelope", "summaryEnvelope"],
  ["chapter.ai", "chapterAi"],
  ["highlight.default", "highlightDefault"],
  ["rollup.partial", "rollupPartial"],
  ["rollup.carry", "rollupCarry"],
  ["rollup.final", "rollupFinal"],
  ["rollup.final.collection", "rollupFinalCollection"],
  ["rollup.goal.collection", "rollupGoalCollection"],
  ["chat.system", "chatSystem"],
  ["chat.system.metadata", "chatSystemMetadata"],
];

const NAMES = [
  "字幕校对",
  "字幕校对 · 音频说明",
  "字幕翻译",
  "总结信封（包裹总结模板）",
  "AI 切章",
  "AI 高光",
  "长内容归纳 · 分组",
  "长内容归纳 · 压缩",
  "长内容归纳 · 总归纳",
  "合集归纳 · 总归纳",
  "合集归纳 · 目标",
  "对话（有字幕）",
  "对话（字幕未就绪）",
];

function prompt(id: string, key: string, overrides: Partial<PromptDto> = {}): PromptDto {
  return {
    id,
    nameKey: `settings.systemPrompts.items.${key}.name`,
    descriptionKey: `settings.systemPrompts.items.${key}.description`,
    slots: [],
    protocol: [],
    builtin: { version: 1, text: `builtin ${id}` },
    customized: false,
    ...overrides,
  };
}

/** The chapter prompt, customized: two slots and two protocol fragments, all present in its text. */
const CHAPTER = prompt("chapter.ai", "chapterAi", {
  slots: ["{{transcript}}", "{{output_language}}"],
  protocol: ['"chapters"', "只输出 JSON"],
  builtin: { version: 2, text: 'BUILTIN {{transcript}} {{output_language}} "chapters" 只输出 JSON' },
  current: { version: 3, text: 'MINE {{transcript}} {{output_language}} "chapters" 只输出 JSON', createdAt: Date.UTC(2026, 9, 1, 4, 0) },
  customized: true,
});

function list(): PromptDto[] {
  return KEYS.map(([id, key]) => (id === CHAPTER.id ? CHAPTER : prompt(id, key)));
}

function row(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-prompt="${id}"]`) as HTMLElement;
}

async function openEditor(container: HTMLElement, id: string): Promise<HTMLTextAreaElement> {
  await waitFor(() => expect(row(container, id)).toBeTruthy());
  fireEvent.click(within(row(container, id)).getByRole("button", { name: "编辑" }));
  return (await screen.findByLabelText("提示词全文")) as HTMLTextAreaElement;
}

function requiredItem(item: string): HTMLElement {
  return screen.getByTestId("prompt-required").querySelector(`[data-required='${item}']`) as HTMLElement;
}

describe("promptProblems", () => {
  it("lists the required items a text lacks and the placeholders the prompt does not know", () => {
    expect(promptProblems(CHAPTER, '{{transcript}} "chapters" {{extra}} {{extra}}')).toEqual({ missing: ["{{output_language}}", "只输出 JSON"], unknown: ["{{extra}}"] });
    expect(promptProblems(CHAPTER, CHAPTER.builtin.text)).toEqual({ missing: [], unknown: [] });
  });
});

describe("SystemPromptsSection", () => {
  it("lists every prompt in the order served, with its description and whether it is customized", async () => {
    mockApi({ "GET /api/prompts": { body: { items: list() } } });
    const { container } = renderApp(<SystemPromptsSection />);
    await waitFor(() => expect(container.querySelectorAll("[data-prompt]")).toHaveLength(13));
    const rows = [...container.querySelectorAll<HTMLElement>("[data-prompt]")];
    expect(rows.map((element) => element.dataset["prompt"])).toEqual(KEYS.map(([id]) => id));
    rows.forEach((element, index) => expect(element.textContent).toContain(NAMES[index]));
    expect(row(container, "proofread.text").textContent).toContain("校对语音识别字幕时发给模型的说明");
    expect(row(container, "chapter.ai").textContent).toContain("已自定义");
    expect(row(container, "chapter.ai").textContent).not.toContain("内置");
    expect(row(container, "rollup.partial").textContent).toContain("内置");
    expect(screen.getByRole("heading", { name: "系统提示词" })).toBeTruthy();
  });

  it("opens the text in effect with its length, the limit, what must stay and the scope note", async () => {
    mockApi({ "GET /api/prompts": { body: { items: list() } } });
    const { container } = renderApp(<SystemPromptsSection />);
    const text = await openEditor(container, "chapter.ai");
    expect(text.value).toBe(CHAPTER.current?.text);
    expect(screen.getByTestId("prompt-count").textContent).toBe(`${CHAPTER.current?.text.length} / ${PROMPT_CUSTOM_MAX_CHARS} 字`);
    for (const item of [...CHAPTER.slots, ...CHAPTER.protocol]) {
      expect(requiredItem(item).dataset["missing"]).toBe("false");
    }
    expect(screen.getByTestId("prompt-scope").textContent).toBe(
      "检查只保证模型能收到必要的格式说明，不保证结果质量；改坏的提示词会让任务失败或结果变差并照常计费。恢复内置只影响之后新建的任务、重跑的步骤与新的回答，已生成的内容需要主动重新生成；失败的任务可在恢复后从失败的步骤重跑。",
    );
    // Unchanged text has nothing to save.
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(text, { target: { value: "{{transcript}} 只输出 JSON {{extra}}" } });
    expect(requiredItem("{{output_language}}").dataset["missing"]).toBe("true");
    expect(requiredItem("{{output_language}}").textContent).toContain("缺失");
    expect(requiredItem('"chapters"').dataset["missing"]).toBe("true");
    expect(requiredItem("{{transcript}}").dataset["missing"]).toBe("false");
    expect(screen.getByTestId("prompt-unknown").textContent).toContain("多余：{{extra}}");
  });

  it("prefills the builtin text of a prompt that is not customized and keeps 「恢复内置」 off", async () => {
    mockApi({ "GET /api/prompts": { body: { items: list() } } });
    const { container } = renderApp(<SystemPromptsSection />);
    const text = await openEditor(container, "rollup.final");
    expect(text.value).toBe("builtin rollup.final");
    expect(screen.getByText("这条提示词没有必须保留的内容")).toBeTruthy();
    expect((screen.getByRole("button", { name: "恢复内置" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks a text over the limit and does not let it be saved", async () => {
    mockApi({ "GET /api/prompts": { body: { items: list() } } });
    const { container } = renderApp(<SystemPromptsSection />);
    const text = await openEditor(container, "rollup.final");
    fireEvent.change(text, { target: { value: "字".repeat(PROMPT_CUSTOM_MAX_CHARS + 1) } });
    const count = screen.getByTestId("prompt-count");
    expect(count.textContent).toBe(`${PROMPT_CUSTOM_MAX_CHARS + 1} / ${PROMPT_CUSTOM_MAX_CHARS} 字`);
    expect(count.className).toContain("text-danger");
    expect(screen.getByText(`超过 ${PROMPT_CUSTOM_MAX_CHARS} 字上限，请删减后再保存`)).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the text with PUT and reloads the list", async () => {
    const edited = `${CHAPTER.current?.text} 再补一句`;
    const { calls } = mockApi({
      "GET /api/prompts": { body: { items: list() } },
      "PUT /api/prompts/chapter.ai": { body: { ...CHAPTER, current: { version: 4, text: edited, createdAt: 2 } } },
    });
    const { container } = renderApp(<SystemPromptsSection />);
    const text = await openEditor(container, "chapter.ai");
    fireEvent.change(text, { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ text: edited }));
    expect(calls.find((call) => call.method === "PUT")?.path).toBe("/api/prompts/chapter.ai");
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.path === "/api/prompts")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByLabelText("提示词全文")).toBeNull());
  });

  it("marks what the server reports missing and lists unknown placeholders as extra", async () => {
    mockApi({
      "GET /api/prompts": { body: { items: list() } },
      "PUT /api/prompts/chapter.ai": {
        status: 400,
        body: {
          error: {
            class: "invalid_request",
            code: "invalid_request.prompt_protocol",
            retryDisposition: "never",
            userMessage: "提示词缺少必须保留的内容，或含有无法识别的插值槽",
            details: { missing: ['"chapters"'], unknown: ["{{ghost}}"] },
          },
        },
      },
    });
    const { container } = renderApp(<SystemPromptsSection />);
    const text = await openEditor(container, "chapter.ai");
    // Locally complete, so only the server's verdict can mark anything.
    fireEvent.change(text, { target: { value: `${CHAPTER.current?.text} 改一下` } });
    expect(screen.queryByTestId("prompt-unknown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(requiredItem('"chapters"').dataset["missing"]).toBe("true"));
    expect(requiredItem("{{transcript}}").dataset["missing"]).toBe("false");
    expect(screen.getByTestId("prompt-unknown").textContent).toContain("多余：{{ghost}}");
    expect(screen.getByLabelText("提示词全文")).toBeTruthy();
  });

  it("restores the builtin with DELETE after a confirmation", async () => {
    const { calls } = mockApi({
      "GET /api/prompts": { body: { items: list() } },
      "DELETE /api/prompts/chapter.ai": { body: { ...CHAPTER, current: undefined, customized: false } },
    });
    const { container } = renderApp(<SystemPromptsSection />);
    await openEditor(container, "chapter.ai");
    fireEvent.click(screen.getByRole("button", { name: "恢复内置" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(await screen.findByText("将「AI 切章」恢复为内置提示词？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(calls.find((call) => call.method === "DELETE")?.path).toBe("/api/prompts/chapter.ai"));
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.path === "/api/prompts")).toHaveLength(2));
  });

  it("loads the versions only when the history is opened, newest first with the current one marked", async () => {
    const { calls } = mockApi({
      "GET /api/prompts": { body: { items: list() } },
      "GET /api/prompts/chapter.ai/versions": {
        body: {
          items: [
            { version: 1, text: "FIRST TEXT", createdAt: Date.UTC(2026, 8, 1, 4, 0), current: false },
            { version: 3, text: "THIRD TEXT", createdAt: Date.UTC(2026, 9, 1, 4, 0), current: true },
          ],
        },
      },
    });
    const { container } = renderApp(<SystemPromptsSection />);
    await openEditor(container, "chapter.ai");
    expect(calls.some((call) => call.path.endsWith("/versions"))).toBe(false);
    const history = screen.getByTestId("prompt-versions") as HTMLDetailsElement;
    history.open = true;
    fireEvent(history, new Event("toggle"));
    await waitFor(() => expect(history.querySelectorAll("[data-version]")).toHaveLength(2));
    expect(calls.filter((call) => call.path === "/api/prompts/chapter.ai/versions")).toHaveLength(1);
    const versions = [...history.querySelectorAll<HTMLElement>("[data-version]")];
    expect(versions.map((element) => element.dataset["version"])).toEqual(["3", "1"]);
    expect(versions[0]?.textContent).toContain("版本 3");
    expect(versions[0]?.textContent).toContain("当前");
    expect(versions[0]?.textContent).toContain("THIRD TEXT");
    expect(versions[1]?.textContent).not.toContain("当前");
    expect(versions[1]?.querySelector("pre")?.textContent).toBe("FIRST TEXT");
  });

  it("says so when there is no version yet", async () => {
    mockApi({
      "GET /api/prompts": { body: { items: list() } },
      "GET /api/prompts/rollup.final/versions": { body: { items: [] } },
    });
    const { container } = renderApp(<SystemPromptsSection />);
    await openEditor(container, "rollup.final");
    const history = screen.getByTestId("prompt-versions") as HTMLDetailsElement;
    history.open = true;
    fireEvent(history, new Event("toggle"));
    expect(await within(history).findByText("还没有自定义版本")).toBeTruthy();
  });
});
