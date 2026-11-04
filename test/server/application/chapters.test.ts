import { afterEach, describe, expect, it } from "vitest";
import type { StageRun, Task } from "../../../src/server/domain/task.ts";
import type { StageStatus } from "../../../src/shared/enums.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** The current chapter revision of each Content below is made at this time. */
const CURRENT_AT = 100;

function setup(options: { withCurrent?: boolean } = {}) {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  if (options.withCurrent !== false) {
    const revisionId = h.newId();
    h.repository.withTransaction((scope) => {
      scope.chapters.insertPlatformRevision(LOCAL.userId, contentId, {
        id: revisionId,
        artifactId: h.newId(),
        chapters: [{ startMs: 0, endMs: 1000, title: "t" }],
        createdAt: CURRENT_AT,
      });
      scope.chapters.setCurrent(LOCAL.userId, contentId, revisionId);
    });
  }
  /** A Task with the given latest stage statuses, written directly. */
  const addTask = (
    kind: Task["kind"],
    projection: Task["statusProjection"],
    createdAt: number,
    stages: Partial<Record<StageRun["stage"], StageStatus | { status: StageStatus; finishedAt?: number; reasons?: string[] }>>,
  ): string => {
    const id = h.newId();
    const terminal = projection === "succeeded" || projection === "failed" || projection === "cancelled";
    h.repository.withTransaction((scope) => {
      scope.tasks.insert({ id, userId: LOCAL.userId, contentId, kind, requestJson: "{}", statusProjection: projection, createdAt, ...(terminal ? { finishedAt: createdAt + 1 } : {}) });
      for (const [stage, value] of Object.entries(stages)) {
        const spec = typeof value === "string" ? { status: value } : (value as { status: StageStatus; finishedAt?: number; reasons?: string[] });
        scope.stageRuns.insert(LOCAL.userId, {
          id: h.newId(),
          taskId: id,
          stage: stage as StageRun["stage"],
          attempt: 1,
          status: spec.status,
          progress: 0,
          dependencies: [],
          ...(spec.finishedAt === undefined ? {} : { finishedAt: spec.finishedAt }),
          ...(spec.reasons === undefined ? {} : { resultJson: JSON.stringify({ reasons: spec.reasons }) }),
        });
      }
    });
    return id;
  };
  const read = () => h.chapters.get(LOCAL, contentId);
  return { h, contentId, addTask, read };
}

describe("chapter section: activeStage", () => {
  it("is absent without an unfinished Task holding the chapter lane", () => {
    const { addTask, read } = setup();
    addTask("regenerate_chapters", "succeeded", 1, { chapter: "succeeded" });
    addTask("regenerate_summary", "running", 2, { summary: "running" });
    const dto = read();
    expect(dto).not.toHaveProperty("activeTaskId");
    expect(dto).not.toHaveProperty("activeStage");
  });

  it("is queued while a chapter regeneration waits to start", () => {
    const { addTask, read } = setup();
    const id = addTask("regenerate_chapters", "queued", 1, { chapter: "pending" });
    expect(read()).toMatchObject({ activeTaskId: id, activeStage: "queued" });
  });

  it("is running while a chapter regeneration runs", () => {
    const { addTask, read } = setup();
    const id = addTask("regenerate_chapters", "running", 1, { chapter: "running" });
    expect(read()).toMatchObject({ activeTaskId: id, activeStage: "running" });
  });

  it("is running while the processing Task's chapter stage runs, waiting before it", () => {
    const { addTask, read } = setup();
    const id = addTask("process_content", "running", 1, { source: "succeeded", asr: "succeeded", chapter: "running", summary: "pending" });
    expect(read()).toMatchObject({ activeTaskId: id, activeStage: "running" });

    const second = setup();
    const before = second.addTask("process_content", "running", 1, { source: "succeeded", asr: "running", chapter: "pending", summary: "pending" });
    expect(second.read()).toMatchObject({ activeTaskId: before, activeStage: "waiting" });
  });

  it("is waiting while a regeneration waits for configuration", () => {
    const { addTask, read } = setup();
    const id = addTask("regenerate_chapters", "waiting", 1, { chapter: "waiting_configuration" });
    expect(read()).toMatchObject({ activeTaskId: id, activeStage: "waiting" });
  });
});

describe("chapter section: lastFailedTaskId", () => {
  it("names the latest chapter Task whose chapter stage failed after the current revision", () => {
    const { addTask, read } = setup();
    addTask("regenerate_chapters", "succeeded", 1, { chapter: "succeeded" });
    const failed = addTask("regenerate_chapters", "failed", 200, { chapter: { status: "failed", finishedAt: 201 } });
    expect(read().lastFailedTaskId).toBe(failed);
  });

  it("ignores a failure older than the current revision, and compares nothing without one", () => {
    const older = setup();
    older.addTask("regenerate_chapters", "failed", 10, { chapter: { status: "failed", finishedAt: 11 } });
    expect(older.read()).not.toHaveProperty("lastFailedTaskId");

    const bare = setup({ withCurrent: false });
    const failed = bare.addTask("regenerate_chapters", "failed", 10, { chapter: { status: "failed", finishedAt: 11 } });
    expect(bare.read().lastFailedTaskId).toBe(failed);
  });

  it("does not count a chapter stage skipped or cancelled because an earlier stage failed", () => {
    const skipped = setup();
    skipped.addTask("process_content", "failed", 200, {
      source: "succeeded",
      asr: { status: "failed", finishedAt: 201 },
      chapter: { status: "skipped", finishedAt: 201, reasons: ["dependency_failed"] },
    });
    expect(skipped.read()).not.toHaveProperty("lastFailedTaskId");

    const cancelled = setup();
    cancelled.addTask("process_content", "cancelled", 200, { asr: { status: "cancelled", finishedAt: 201 }, chapter: { status: "cancelled", finishedAt: 201 } });
    expect(cancelled.read()).not.toHaveProperty("lastFailedTaskId");
  });

  it("is hidden by a later chapter Task that succeeded, and by one still under way", () => {
    const { addTask, read } = setup();
    addTask("process_content", "failed", 200, { asr: "succeeded", chapter: { status: "failed", finishedAt: 201 }, summary: "succeeded" });
    expect(read().lastFailedTaskId).toBeDefined();
    const retry = addTask("regenerate_chapters", "queued", 300, { chapter: "pending" });
    expect(read()).toMatchObject({ activeTaskId: retry, activeStage: "queued" });
    expect(read()).not.toHaveProperty("lastFailedTaskId");

    const later = setup();
    later.addTask("regenerate_chapters", "failed", 200, { chapter: { status: "failed", finishedAt: 201 } });
    later.addTask("regenerate_chapters", "succeeded", 300, { chapter: { status: "succeeded", finishedAt: 301 } });
    // Unrelated Tasks after it do not hide nor surface anything.
    later.addTask("regenerate_summary", "failed", 400, { summary: { status: "failed", finishedAt: 401 } });
    expect(later.read()).not.toHaveProperty("lastFailedTaskId");
  });
});
