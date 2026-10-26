import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageDto } from "../../../src/shared/dto/chat.ts";
import { ChatMessageFooter } from "../../../src/web/chat/chat-message-footer.tsx";

const ANSWER: ChatMessageDto = {
  id: "a1",
  role: "assistant",
  text: "回答",
  status: "complete",
  citations: [],
  createdAt: Date.UTC(2026, 9, 26, 15, 0),
  finishedAt: Date.UTC(2026, 9, 26, 16, 5),
  modelRef: { providerProfileId: "p1", modelId: "m-chat", providerNameSnapshot: "Relay", modelDisplaySnapshot: "m-chat", protocolSnapshot: "anthropic_messages" },
};

const original = process.env["TZ"];
afterEach(() => {
  if (original === undefined) delete process.env["TZ"];
  else process.env["TZ"] = original;
});

function renderFooter(answer: ChatMessageDto, extra: Partial<Parameters<typeof ChatMessageFooter>[0]> = {}) {
  const props = { answer, askedAt: Date.UTC(2026, 9, 26, 14, 59), copy: () => "复制的文字", copyable: true, onDelete: vi.fn(), busy: false, ...extra };
  render(<ChatMessageFooter {...props} />);
  return props;
}

describe("ChatMessageFooter", () => {
  it("shows the Profile, the model with its protocol on hover, and the finish time in Beijing time", () => {
    process.env["TZ"] = "America/Los_Angeles";
    renderFooter(ANSWER);
    const model = screen.getByTestId("chat-turn-model");
    expect(model.textContent).toBe("Relay · m-chat");
    expect(model.getAttribute("title")).toBe("Anthropic Messages 接口");
    const time = screen.getByTestId("chat-turn-time");
    // 16:05 UTC is past midnight in Beijing, still the 26th in Los Angeles.
    expect(time.textContent).toBe("2026-10-27 00:05");
    // The footer shows minutes; the hover names the moment to the second.
    expect(time.getAttribute("title")).toBe("回答完成时间：2026-10-27 00:05:00");
  });

  it("falls back to the question's time, saying so on hover, for answers stored without a finish time", () => {
    const { finishedAt: _finished, ...older } = ANSWER;
    renderFooter({ ...older, modelRef: { ...ANSWER.modelRef!, protocolSnapshot: "openai_compatible" } });
    const time = screen.getByTestId("chat-turn-time");
    expect(time.textContent).toBe("2026-10-26 22:59");
    expect(time.getAttribute("title")).toBe("提问时间：2026-10-26 22:59:00（升级前的回答没有记录完成时间）");
    expect(screen.getByTestId("chat-turn-model").getAttribute("title")).toBe("OpenAI 兼容接口");
  });

  it("offers retry only when asked to, and disables it and delete while busy", () => {
    const onRetry = vi.fn();
    const first = renderFooter(ANSWER, { onRetry });
    fireEvent.click(screen.getByTestId("chat-turn-retry"));
    fireEvent.click(screen.getByTestId("chat-turn-delete"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(first.onDelete).toHaveBeenCalledTimes(1);
  });

  it("has no retry without a handler and greys out actions while busy", () => {
    renderFooter(ANSWER, { busy: true });
    expect(screen.queryByTestId("chat-turn-retry")).toBeNull();
    expect((screen.getByTestId("chat-turn-delete") as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies the text it is given", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderFooter(ANSWER);
    fireEvent.click(screen.getByTestId("chat-turn-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("复制的文字"));
    await waitFor(() => expect(screen.getByTestId("chat-turn-copy").getAttribute("title")).toBe("已复制"));
  });
});
