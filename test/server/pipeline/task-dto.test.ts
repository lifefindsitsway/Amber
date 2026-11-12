import { describe, expect, it } from "vitest";
import type { Task } from "../../../src/server/domain/task.ts";
import { toTaskDto } from "../../../src/server/pipeline/task-dto.ts";

const task = (statusProjection: Task["statusProjection"]): Task => ({
  id: "t", userId: "u", contentId: "c", kind: "process_content", requestJson: "{}", statusProjection, createdAt: 1,
});

describe("toTaskDto", () => {
  it("shows what a queued Task waits for, and nothing once it no longer only waits", () => {
    const wait = { retryNotBefore: 9000, waitingStep: "awaitResult" } as const;
    expect(toTaskDto(task("queued"), undefined, wait)).toMatchObject(wait);
    expect(toTaskDto(task("queued"), undefined, { retryNotBefore: 9000 })).not.toHaveProperty("waitingStep");
    const running = toTaskDto(task("running"), undefined, wait);
    expect(running).not.toHaveProperty("retryNotBefore");
    expect(running).not.toHaveProperty("waitingStep");
    expect(toTaskDto(task("queued"))).not.toHaveProperty("retryNotBefore");
  });

  it("names the summary template of summarizing Tasks only", () => {
    const base = task("succeeded");
    expect(toTaskDto(base).templateId).toBe("summary.core");
    expect(toTaskDto({ ...base, requestJson: JSON.stringify({ templateRef: { id: "custom.1", version: 2 } }) }).templateId).toBe("custom.1");
    expect(toTaskDto({ ...base, kind: "regenerate_summary", requestJson: JSON.stringify({ templateRef: { id: "summary.detailed", version: 1 } }) }).templateId).toBe("summary.detailed");
    expect(toTaskDto({ ...base, kind: "reproofread" })).not.toHaveProperty("templateId");
    expect(toTaskDto({ ...base, kind: "translate", requestJson: JSON.stringify({ templateRef: { id: "x", version: 1 } }) })).not.toHaveProperty("templateId");
  });

  it("marks a re-transcription made only to compare speakers with, from its frozen request", () => {
    const base: Task = { ...task("failed"), kind: "retranscribe", requestJson: JSON.stringify({ requestSchemaVersion: 1, kind: "retranscribe", comparison: true }) };
    expect(toTaskDto(base).comparison).toBe(true);
    expect(toTaskDto({ ...base, requestJson: JSON.stringify({ requestSchemaVersion: 1, kind: "retranscribe" }) })).not.toHaveProperty("comparison");
    // Only a re-transcription can be one.
    expect(toTaskDto({ ...base, kind: "reproofread" })).not.toHaveProperty("comparison");
  });
});
