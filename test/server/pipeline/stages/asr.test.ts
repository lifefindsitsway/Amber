import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiarizationRequest } from "../../../../src/shared/dto/speaker.ts";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import { RetranscribeService } from "../../../../src/server/application/retranscribe.ts";
import { SpeakerService } from "../../../../src/server/application/speakers.ts";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import type { AsrModelRef } from "../../../../src/server/domain/model-ref.ts";
import { assDialogue } from "../../../../src/server/domain/export/ass.ts";
import { checkTranscriptInvariants, type TranscriptRevision } from "../../../../src/server/domain/transcript.ts";
import { latestAttempts, taskWait } from "../../../../src/server/pipeline/projection.ts";
import { asrPollDelayMs, AsrStageExecutor, JOB_ENDED_CODES, normalizeSentences } from "../../../../src/server/pipeline/stages/asr.ts";
import { ASR_JOB_MAX_WAIT_HOURS, ASR_POLL_INTERVAL_MAX_MS, ASR_POLL_INTERVAL_MS, RETRY_MAX, SPEAKERS_PER_CONTENT_MAX } from "../../../../src/shared/defaults.ts";
import type { LocalMediaIngest } from "../../../../src/server/ports/local-media-ingest.ts";
import { isUlid } from "../../../../src/shared/ids.ts";
import { fakeAsrResult, FakeAsrFactory } from "../../../fixtures/asr/fake-asr.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import {
  configureAsr,
  configureLlm,
  countingExecutor,
  createHarness,
  LOCAL,
  stageRunsOf,
  stageStatuses,
  taskOf,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { countRows, insertRow, tempDataDir } from "../../../tools/sqlite.ts";

const open: MediaStack[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
  for (const h of harnesses.splice(0)) await h.close();
});

/** Every progress value the `asr` stage published, in order. */
function asrProgressEvents(h: Harness): number[] {
  const values: number[] = [];
  h.bus.subscribe(({ event }) => {
    if (event.type === "stage.updated" && event.stageRun.stage === "asr") {
      values.push(event.stageRun.progress);
    }
  });
  return values;
}

/** Extraction without ffmpeg that reports half-way and done, as the real adapter does with a duration hint. */
function reportingIngest(): LocalMediaIngest {
  return {
    probe: async () => Promise.reject(new Error("not used")),
    transcodeAudio: async () => Promise.reject(new Error("not used")),
    async extractAudio(input, output, _signal, options) {
      const bytes = Buffer.concat([Buffer.from("flac:"), await readFile(input.path)]);
      options?.onProgress?.(0.5);
      await writeFile(output.path, bytes);
      options?.onProgress?.(1);
      return { sizeBytes: bytes.length, durationMs: 3000 };
    },
    clipAudio: async () => Promise.reject(new Error("not used")),
  };
}

type StageDeps = ConstructorParameters<typeof AsrStageExecutor>[0];

function setup(extra: Partial<StageDeps> = {}): { stack: MediaStack; fake: FakeAsrFactory } {
  const fake = new FakeAsrFactory();
  const stack = createMediaStack();
  open.push(stack);
  stack.h.executors.asr = new AsrStageExecutor({
    repository: stack.h.repository,
    files: stack.files,
    ingest: stack.ingest,
    asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
    newId: stack.h.newId,
    ...extra,
  });
  configureAsr(stack.h);
  return { stack, fake };
}

/**
 * Imports the 3 s fixture without auto-proofreading, choosing the given ASR model, else the
 * user's default as the new-Task page preselects it; returns the Task and Content ids.
 */
async function importFixture(
  stack: MediaStack,
  options: { subtitle?: string; asrModelRef?: AsrModelRef; diarization?: DiarizationRequest } = {},
): Promise<{ taskId: string; contentId: string }> {
  const { withAudio } = mediaFixtures();
  let initialSubtitle: { path: string; grant: ReturnType<MediaStack["grant"]>; language: string } | undefined;
  if (options.subtitle !== undefined) {
    const path = join(tempDataDir("amber-sub-"), "sub.srt");
    writeFileSync(path, options.subtitle);
    initialSubtitle = { path, grant: stack.grant(path, "local_file"), language: "zh-CN" };
  }
  const asrModelRef = options.asrModelRef ?? stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef);
  const created = await stack.localImport.importLocalFile(LOCAL, {
    path: withAudio.path,
    grant: stack.grant(withAudio.path),
    settings: { autoProofread: false, ...(asrModelRef === undefined ? {} : { asrModelRef }), ...(options.diarization === undefined ? {} : { diarization: options.diarization }) },
    allowDuplicate: true,
    ...(initialSubtitle === undefined ? {} : { initialSubtitle }),
  });
  return { taskId: created.body.taskIds[0] as string, contentId: created.body.contentIds[0] as string };
}

async function asrSettled(stack: MediaStack, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed", "skipped"].includes(stageStatuses(stack.h, taskId)["asr"] ?? "") || taskOf(stack.h, taskId).statusProjection === "waiting" && workUnitsOf(stack.h, taskId).some((unit) => unit.status === "waiting_user_action"));
  return stageStatuses(stack.h, taskId)["asr"] as string;
}

function revisionsOf(stack: MediaStack, contentId: string): TranscriptRevision[] {
  return stack.h.repository.withTransaction((scope) => scope.transcripts.listRevisions(LOCAL.userId, contentId));
}

function contentOf(stack: MediaStack, contentId: string) {
  return stack.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
}

function usageOf(stack: MediaStack, taskId: string) {
  return stack.h.repository.withTransaction((scope) => scope.asrUsage.list(LOCAL.userId, { taskId }));
}

const PRICE = { currency: "CNY", items: [{ unit: "audio_per_second", amount: "0.00022" }] } as const;

/** Prices the ASR model the Task is bound to, as a user would in settings. */
function priceModel(stack: MediaStack, asrModelRef: AsrModelRef, pricing: object | null): void {
  stack.h.repository.withTransaction((scope) => {
    const profile = scope.asrProfiles.get(LOCAL.userId, asrModelRef.asrProfileId);
    scope.asrProfiles.update({
      ...profile!,
      models: profile!.models.map((model) => {
        const { pricing: _old, ...rest } = model;
        return model.modelId === asrModelRef.modelId && pricing !== null ? { ...rest, pricing: pricing as never } : rest;
      }),
    });
  });
}

function asrResultJson(stack: MediaStack, taskId: string): Record<string, unknown> {
  const run = stageRunsOf(stack.h, taskId).filter((candidate) => candidate.stage === "asr").at(-1);
  return JSON.parse(run?.resultJson ?? "{}") as Record<string, unknown>;
}

const SRT = "1\n00:00:00,000 --> 00:00:01,500\n用户导入的字幕\n";

describe("asr stage", () => {
  it("publishes an immutable exact_words revision with ULID segments, words by midpoint, and records usage", async () => {
    const { stack, fake } = setup();
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");

    const [revision] = revisionsOf(stack, contentId);
    expect(revision).toMatchObject({ kind: "asr", timingFidelity: "exact_words", language: "zh", segmentCount: 2 });
    expect(revision?.generation).toMatchObject({ kind: "asr", modelId: "scribe_v2" });
    expect(fake.calls.map((call) => call.modelId)).toEqual(["scribe_v2"]);
    const segments = stack.h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revision?.id as string));
    expect(segments.map((segment) => segment.text)).toEqual(["欢迎来到生成式软件工程。", "今天讲提示词。"]);
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(2);
    for (const segment of segments) {
      expect(isUlid(segment.id)).toBe(true);
      expect(segment.startMs).toBeLessThan(segment.endMs);
      expect(segment.sourceSegmentIds).toEqual([]);
    }
    expect(segments.map((segment) => segment.words?.map((word) => word.text))).toEqual([
      ["欢迎", "来到", "生成式软件工程。"],
      ["今天", "讲", "提示词。"],
    ]);
    // Committed revisions cannot be rewritten in place.
    expect(() => stack.h.db.prepare("UPDATE transcript_segment SET text = 'x' WHERE id = ?").run(segments[0]?.id)).toThrow(/immutable/);
    expect(() =>
      stack.h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision as TranscriptRevision, segments)),
    ).toThrow();

    const content = contentOf(stack, contentId);
    expect(content?.primaryTranscriptRevisionId).toBe(revision?.id);
    expect(content?.rawLanguage).toBe("zh");
    expect(asrResultJson(stack, taskId)).toMatchObject({ revisionId: revision?.id, reasons: [] });

    const usage = usageOf(stack, taskId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ outcome: "succeeded", provider: "elevenlabs", model: "scribe_v2", feature: "transcribe", contentId, taskId });
    expect(Math.abs((usage[0]?.audioMs ?? 0) - 3000)).toBeLessThanOrEqual(100);

    const unit = workUnitsOf(stack.h, taskId).find((candidate) => candidate.key === "asr:submit");
    expect(unit).toMatchObject({ status: "succeeded", billing: "asr", outputRef: `tmp/tasks/${taskId}/asr-${unit?.id}.json` });
    expect(fake.calls).toHaveLength(1);
    expect((fake.calls[0]?.input.audio as MediaAsset | undefined)?.kind).toBe("extracted_audio");
  });

  it("an imported primary is not displaced; a later retranscription replaces an asr primary", async () => {
    const { stack, fake } = setup();
    const imported = await importFixture(stack, { subtitle: SRT });
    stack.h.scheduler.start();
    // The user's own subtitle makes ASR unnecessary in process_content.
    expect(await asrSettled(stack, imported.taskId)).toBe("skipped");
    const importedPrimary = contentOf(stack, imported.contentId)?.primaryTranscriptRevisionId;
    // Its later stages wait for an LLM and hold the lane; the user gives up on them.
    stack.h.tasks.cancel(LOCAL, imported.taskId);

    const retranscribe = new RetranscribeService({ repository: stack.h.repository, bus: stack.h.bus, control: stack.h.scheduler, disk: stack.h.disk, settings: stack.h.settings, newId: stack.h.newId });
    const chosen = stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef);
    const first = await retranscribe.retranscribe(LOCAL, imported.contentId, undefined, chosen);
    await waitFor(() => taskOf(stack.h, first.body.taskId).statusProjection === "succeeded");
    expect(contentOf(stack, imported.contentId)?.primaryTranscriptRevisionId).toBe(importedPrimary);
    expect(revisionsOf(stack, imported.contentId).map((revision) => revision.kind)).toEqual(["imported", "asr"]);

    const plain = await importFixture(stack);
    await waitFor(() => stageStatuses(stack.h, plain.taskId)["asr"] === "succeeded");
    const firstAsr = contentOf(stack, plain.contentId)?.primaryTranscriptRevisionId;
    stack.h.tasks.cancel(LOCAL, plain.taskId);
    const again = await retranscribe.retranscribe(LOCAL, plain.contentId, undefined, chosen);
    await waitFor(() => taskOf(stack.h, again.body.taskId).statusProjection === "succeeded");
    const revisions = revisionsOf(stack, plain.contentId);
    expect(revisions.map((revision) => revision.kind)).toEqual(["asr", "asr"]);
    expect(contentOf(stack, plain.contentId)?.primaryTranscriptRevisionId).toBe(revisions[1]?.id);
    expect(revisions[1]?.id).not.toBe(firstAsr);
    expect(fake.calls).toHaveLength(3);
  });

  it("sends the truncated effective terminology and reports what was cut", async () => {
    const { stack, fake } = setup();
    const { taskId } = await importFixture(stack);
    const setId = stack.h.newId();
    insertRow(stack.h.db, "terminology_set", { id: setId, user_id: LOCAL.userId, scope_kind: "global" });
    const terms = ["生成式软件工程", "Claude Opus 4.5", "x".repeat(50), "too many words in this one term"];
    terms.forEach((term, ordinal) =>
      insertRow(stack.h.db, "terminology_entry", { id: stack.h.newId(), set_id: setId, ordinal, term, normalized_key: term.toLowerCase() }),
    );
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input.terminology.map((entry) => entry.term)).toEqual(["生成式软件工程", "Claude Opus 4.5"]);
    expect(asrResultJson(stack, taskId)).toMatchObject({ reasons: ["terminology_truncated"], terminology: { sent: 2, droppedTooLong: 2, cutOff: 0 } });
  });

  it("an unknown outcome parks the unit, records outcome_unknown usage and is not re-sent", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [amberError("asr_timeout", "connection lost after the last chunk")];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    await waitFor(() => workUnitsOf(stack.h, taskId).some((unit) => unit.key === "asr:submit" && unit.status === "waiting_user_action"));
    await stack.h.scheduler.whenIdle();
    expect(taskOf(stack.h, taskId).statusProjection).toBe("waiting");
    expect(fake.calls).toHaveLength(1);
    expect(usageOf(stack, taskId).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
  });

  it("a failure before the last chunk is retried and never recorded; a definite failure is recorded once", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [amberError("asr_failed", "refused", { code: "asr_failed.unreachable" }), fakeAsrResult()];
    const ok = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, ok.taskId)).toBe("succeeded");
    expect(fake.calls).toHaveLength(2);
    expect(usageOf(stack, ok.taskId).map((row) => row.outcome)).toEqual(["succeeded"]);

    fake.outcomes = [amberError("asr_failed", "bad key", { code: "asr_failed.auth" })];
    const bad = await importFixture(stack);
    expect(await asrSettled(stack, bad.taskId)).toBe("failed");
    expect(usageOf(stack, bad.taskId).map((row) => row.outcome)).toEqual(["failed"]);
  });

  it("refuses audio over the provider's limits locally, before anything is sent", async () => {
    const { stack, fake } = setup();
    fake.capabilities = { ...fake.capabilities, maxDurationSec: 1 };
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("failed");
    expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error?.class).toBe("media_too_long");
    expect(fake.calls).toHaveLength(0);
    expect(usageOf(stack, taskId)).toHaveLength(0);
  });

  it("a result without speech fails as media_no_audio; an instantaneous sentence is merged, not lost", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [fakeAsrResult({ text: "", segments: [{ startMs: 0, endMs: 900, text: "  " }], words: [] })];
    const silent = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, silent.taskId)).toBe("failed");
    expect(stageRunsOf(stack.h, silent.taskId).find((run) => run.stage === "asr")?.error?.class).toBe("media_no_audio");

    fake.outcomes = [
      fakeAsrResult({
        segments: [
          { startMs: 0, endMs: 1000, text: "第一句" },
          { startMs: 1000, endMs: 1000, text: "嗯" },
          { startMs: 1200, endMs: 2000, text: "Second one" },
        ],
        words: [
          { text: "第一句", startMs: 0, endMs: 1000 },
          { text: "嗯", startMs: 1000, endMs: 1000 },
          { text: "Second", startMs: 1200, endMs: 1500 },
          { text: "one", startMs: 1500, endMs: 2000 },
        ],
      }),
    ];
    const merged = await importFixture(stack);
    expect(await asrSettled(stack, merged.taskId)).toBe("succeeded");
    const revision = revisionsOf(stack, merged.contentId)[0] as TranscriptRevision;
    const segments = stack.h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revision.id));
    expect(segments.map((segment) => [segment.text, segment.startMs, segment.endMs])).toEqual([
      ["第一句嗯", 0, 1000],
      ["Second one", 1200, 2000],
    ]);
    expect(segments[0]?.words?.map((word) => word.text)).toEqual(["第一句", "嗯"]);
    expect(asrResultJson(stack, merged.taskId)).toMatchObject({ reasons: ["asr_segment_merged"] });
  });
});

describe("asr stage usage context", () => {
  it("records what the adapter reported as the request left, the profile snapshot and the price in force, and the outcome of a synchronous call", async () => {
    const { stack, fake } = setup();
    const ref = stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef) as AsrModelRef;
    priceModel(stack, ref, PRICE);
    fake.sentAt = 1_700_000_000_000;
    fake.credential = { versionId: "version-9", setAt: 1_690_000_000_000 };
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    const [row] = usageOf(stack, taskId);
    expect(row).toMatchObject({
      asrProfileId: ref.asrProfileId,
      profileIdSnapshot: ref.asrProfileId,
      profileNameSnapshot: "ElevenLabs",
      outcome: "succeeded",
      jobOutcome: "succeeded",
      sentAt: 1_700_000_000_000,
      credentialVersion: "version-9",
      credentialSetAt: 1_690_000_000_000,
      priceSnapshot: PRICE,
    });
    expect(row).not.toHaveProperty("jobId");
    expect(fake.requestStarts).toHaveLength(1);
  });

  it("sets the job outcome from a definite failure and leaves it empty for an unknown outcome", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [amberError("asr_failed", "bad key", { code: "asr_failed.auth" })];
    const failed = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, failed.taskId)).toBe("failed");
    expect(usageOf(stack, failed.taskId)[0]).toMatchObject({ outcome: "failed", jobOutcome: "failed" });

    fake.outcomes = [amberError("asr_timeout", "connection lost after the last chunk")];
    const unknown = await importFixture(stack);
    await waitFor(() => workUnitsOf(stack.h, unknown.taskId).some((unit) => unit.key === "asr:submit" && unit.status === "waiting_user_action"));
    const [row] = usageOf(stack, unknown.taskId);
    expect(row).toMatchObject({ outcome: "outcome_unknown", sentAt: expect.any(Number), credentialVersion: "key-version-1" });
    expect(row).not.toHaveProperty("jobOutcome");
  });

  it("keeps the send time when the row is written on the other side of Beijing midnight, and a price edited afterwards does not reach it", async () => {
    // 23:59:58 on 2026-11-05 in Beijing; the row is written 00:00:07 on the 6th.
    const sentAt = Date.UTC(2026, 10, 5, 15, 59, 58);
    const recordedAt = Date.UTC(2026, 10, 5, 16, 0, 7);
    const { stack, fake } = setup({ now: () => recordedAt });
    const ref = stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef) as AsrModelRef;
    priceModel(stack, ref, PRICE);
    fake.sentAt = sentAt;
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    priceModel(stack, ref, null);
    const [row] = usageOf(stack, taskId);
    expect(row).toMatchObject({ sentAt, createdAt: recordedAt, priceSnapshot: PRICE });
  });

  it("writes no context for a request that never left", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [amberError("asr_failed", "refused", { code: "asr_failed.unreachable" }), fakeAsrResult()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    // Two requests were reported, but only the one that answered is a row.
    expect(fake.requestStarts).toHaveLength(2);
    expect(usageOf(stack, taskId)).toHaveLength(1);
  });
});

describe("asr stage progress", () => {
  it("fills download 0–0.4, extraction 0.4–0.5 and transcription 0.5–1 of a platform Content, never moving back", async () => {
    const h = createHarness();
    harnesses.push(h);
    const fake = new FakeAsrFactory();
    fake.progressSteps = [0.5, 1];
    h.executors.subtitle = countingExecutor({ verdict: "invalid", reasons: ["subtitle_incomplete"] });
    h.executors.asr = new AsrStageExecutor({
      repository: h.repository,
      files: new LocalFileStore(h.dir),
      ingest: reportingIngest(),
      platforms: h.platformAccess,
      asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
      newId: h.newId,
    });
    const asrModelRef = configureAsr(h);
    const modelRef = configureLlm(h);
    const events = asrProgressEvents(h);
    const { body } = await h.importContent.import(LOCAL, { items: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }], settings: { autoProofread: false, modelRef, asrModelRef } });
    h.scheduler.start();
    await h.scheduler.whenIdle();

    const taskId = body.taskIds[0] as string;
    expect(stageStatuses(h, taskId).asr).toBe("succeeded");
    // The fake download and extraction each report 0.5 then 1, the provider 0.5 then 1; success writes 1 once more.
    expect(events.filter((progress) => progress > 0)).toEqual([0.2, 0.4, 0.45, 0.5, 0.75, 1, 1]);
    expect(events).toEqual([...events].sort((a, b) => a - b));
    expect(workUnitsOf(h, taskId).map((unit) => unit.key).sort()).toEqual(["asr:submit", "media:extract_audio", "media:fetch_audio"]);
  });

  it("gives a local file's extraction the download's share too, with nothing to download", async () => {
    const { stack, fake } = setup();
    stack.h.executors.asr = new AsrStageExecutor({
      repository: stack.h.repository,
      files: stack.files,
      ingest: reportingIngest(),
      asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
      newId: stack.h.newId,
    });
    const events = asrProgressEvents(stack.h);
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");

    const moved = events.filter((progress) => progress > 0);
    // The extraction's half-way report lands at 0.25 of 0–0.5 instead of 0.45 of 0.4–0.5.
    expect(Math.min(...moved)).toBe(0.25);
    expect(moved).toContain(0.5);
    expect(moved.at(-1)).toBe(1);
    expect(events).toEqual([...events].sort((a, b) => a - b));
  });
});

// These tests wait on real timers (scheduler kicks, retry delays), as long as `settledAttempt` allows.
describe("asr stage with a job provider", { timeout: 15_000 }, () => {
  /** A job provider whose pending answers ask for the next query at once. */
  function setupJob(models?: string[], extra: Partial<StageDeps> = {}): { stack: MediaStack; fake: FakeAsrFactory; asrModelRef: AsrModelRef } {
    const fake = new FakeAsrFactory();
    fake.delivery = "job";
    const stack = createMediaStack();
    open.push(stack);
    stack.h.executors.asr = new AsrStageExecutor({
      repository: stack.h.repository,
      files: stack.files,
      ingest: stack.ingest,
      asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
      newId: stack.h.newId,
      random: () => 0.5,
      ...extra,
    });
    const asrModelRef = configureAsr(stack.h, LOCAL.userId, models === undefined ? {} : { models });
    return { stack, fake, asrModelRef };
  }

  const soon = { state: "pending", retryAfterMs: 1 } as const;
  // Long enough for the test to observe the wait even when the file's other tests load the machine.
  const WATCHED_WAIT_MS = 1500;
  const done = (overrides: Parameters<typeof fakeAsrResult>[0] = {}) => ({ state: "done", result: fakeAsrResult(overrides) }) as const;
  const throttled = () => amberError("asr_failed", "throttled", { code: "asr_failed.rate_limited", details: { retryAfterMs: 1 } });

  function unitsByKey(stack: MediaStack, taskId: string, key: string) {
    return workUnitsOf(stack.h, taskId).filter((unit) => unit.key === key);
  }

  async function settledAttempt(stack: MediaStack, taskId: string, attempt: number): Promise<string> {
    await waitFor(() => {
      const run = latestAttempts(stageRunsOf(stack.h, taskId)).find((candidate) => candidate.stage === "asr");
      return run !== undefined && run.attempt === attempt && ["succeeded", "failed"].includes(run.status);
    }, 15_000);
    return stageStatuses(stack.h, taskId)["asr"] as string;
  }

  it("submits once, waits between queries without holding the Task, and publishes the result", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [{ state: "pending", retryAfterMs: WATCHED_WAIT_MS }, soon, done()];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.holdWakes();
    stack.h.scheduler.start();
    await waitFor(() => unitsByKey(stack, taskId, "asr:await")[0]?.retryNotBefore !== undefined);
    const waiting = stack.h.repository.withTransaction((scope) => taskWait(scope.stageRuns.listByTask(LOCAL.userId, taskId), scope.workUnits.listByTask(LOCAL.userId, taskId)));
    expect(waiting.waitingStep).toBe("awaitResult");
    expect(taskOf(stack.h, taskId).statusProjection).toBe("queued");
    stack.h.releaseWakes();

    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls.map((handle) => handle.jobId)).toEqual(["job-1", "job-1", "job-1"]);
    const [submit] = unitsByKey(stack, taskId, "asr:submit");
    expect(submit).toMatchObject({ status: "succeeded", billing: "asr" });
    expect(submit?.outputRef).toBeUndefined();
    const payload = stack.h.repository.withTransaction((scope) => scope.workUnits.getResult(LOCAL.userId, submit?.id as string));
    // The submission's record names its usage row next to the handle.
    expect(JSON.parse(payload?.payloadJson ?? "null")).toEqual({
      handle: { version: 1, provider: "fake", jobId: "job-1", submittedAt: expect.any(Number) },
      usageId: usageOf(stack, taskId)[0]?.id,
      // The import froze the setting's `preferred`; the fake model offers no identification.
      diarization: { effective: false, status: "unsupported" },
    });
    const [awaited] = unitsByKey(stack, taskId, "asr:await");
    expect(awaited).toMatchObject({ status: "succeeded", outputRef: `tmp/tasks/${taskId}/asr-${awaited?.id}.json` });
    expect(awaited?.billing).toBeUndefined();
    expect(revisionsOf(stack, contentId)[0]).toMatchObject({ kind: "asr", timingFidelity: "exact_words" });
    expect(usageOf(stack, taskId).map((row) => row.outcome)).toEqual(["succeeded"]);
  });

  it("does not submit again when the terminology changes while the job runs", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [{ state: "pending", retryAfterMs: WATCHED_WAIT_MS }, done()];
    const { taskId } = await importFixture(stack);
    stack.h.holdWakes();
    stack.h.scheduler.start();
    await waitFor(() => unitsByKey(stack, taskId, "asr:await")[0]?.retryNotBefore !== undefined);
    const setId = stack.h.newId();
    insertRow(stack.h.db, "terminology_set", { id: setId, user_id: LOCAL.userId, scope_kind: "global" });
    insertRow(stack.h.db, "terminology_entry", { id: stack.h.newId(), set_id: setId, ordinal: 0, term: "生成式软件工程", normalized_key: "生成式软件工程" });
    stack.h.releaseWakes();
    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls).toHaveLength(2);
  });

  it("a pending answer clears the retries transient failures spent", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [throttled(), throttled(), soon, throttled(), throttled(), done()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    // Four transient failures in all, never more than RETRY_MAX in a row.
    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(fake.polls).toHaveLength(6);
    expect(unitsByKey(stack, taskId, "asr:await")[0]?.retryCount).toBe(2);
  });

  it("fails once transient failures pass RETRY_MAX; a re-run takes the job over without submitting again", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    expect(fake.polls).toHaveLength(RETRY_MAX + 1);
    expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error?.code).toBe("asr_failed.rate_limited");

    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls.at(-1)?.jobId).toBe("job-1");
    expect(usageOf(stack, taskId)).toHaveLength(1);
  });

  it("a job that failed on the provider's side is submitted anew by a re-run", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [amberError("asr_failed", "job failed", { code: "asr_failed.job_failed" })];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    expect(JOB_ENDED_CODES.has("asr_failed.job_failed")).toBe(true);

    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(2);
    expect(fake.polls.at(-1)?.jobId).toBe("job-2");
    const digests = unitsByKey(stack, taskId, "asr:submit").map((unit) => unit.inputDigest);
    expect(new Set(digests).size).toBe(2);
  });

  it("re-running with another ASR profile submits anew", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    const other = configureAsr(stack.h, LOCAL.userId, { asDefault: false, name: "other" });
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: other });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits.map((call) => call.profileId)).toEqual([expect.any(String), other.asrProfileId]);
    expect(fake.submits[0]?.profileId).not.toBe(other.asrProfileId);
  });

  it("re-running with another model of the same profile submits anew under that model", async () => {
    const { stack, fake, asrModelRef } = setupJob(["scribe_v2", "fake-model"]);
    fake.pollOutcomes = [throttled()];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: { ...asrModelRef, modelId: "fake-model" } });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits.map((call) => [call.profileId, call.modelId])).toEqual([
      [asrModelRef.asrProfileId, "scribe_v2"],
      [asrModelRef.asrProfileId, "fake-model"],
    ]);
    expect(usageOf(stack, taskId).map((row) => row.model)).toEqual(["scribe_v2", "fake-model"]);
    const [revision] = revisionsOf(stack, contentId);
    expect(revision?.generation).toMatchObject({ kind: "asr", asrProfileId: asrModelRef.asrProfileId, modelId: "fake-model" });
  });

  it("renaming the profile or reordering its models keeps the submission: a re-run takes the job over", async () => {
    const { stack, fake, asrModelRef } = setupJob(["scribe_v2", "fake-model"]);
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    stack.h.repository.withTransaction((scope) => {
      const profile = scope.asrProfiles.get(LOCAL.userId, asrModelRef.asrProfileId);
      scope.asrProfiles.update({ ...profile!, name: "renamed", models: [{ modelId: "fake-model" }, { modelId: "scribe_v2" }] });
    });
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls.at(-1)?.jobId).toBe("job-1");
  });

  it("a job submitted to another endpoint is not queried at the new one: a re-run after the endpoint changed submits anew", async () => {
    const { stack, fake, asrModelRef } = setupJob();
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    stack.h.repository.withTransaction((scope) => {
      const profile = scope.asrProfiles.get(LOCAL.userId, asrModelRef.asrProfileId);
      scope.asrProfiles.update({ ...profile!, baseURL: "https://relay.example.test" });
    });
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(2);
    expect(fake.polls.at(-1)?.jobId).toBe("job-2");
  });

  it("a bound model the provider no longer offers fails as model_unavailable without submitting", async () => {
    const { stack, fake, asrModelRef } = setupJob(["scribe_v2", "retired-model"]);
    const { taskId } = await importFixture(stack, { asrModelRef: { ...asrModelRef, modelId: "retired-model" } });
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    const run = latestAttempts(stageRunsOf(stack.h, taskId)).find((candidate) => candidate.stage === "asr");
    expect(run?.error).toMatchObject({ code: "asr_failed.model_unavailable", retryDisposition: "never" });
    expect(fake.submits).toHaveLength(0);
    expect(usageOf(stack, taskId)).toHaveLength(0);
  });

  it("a typed-in model runs under its stored family; one whose family does not resolve fails as model_unavailable", async () => {
    const { stack, fake, asrModelRef } = setupJob();
    stack.h.repository.withTransaction((scope) => {
      const profile = scope.asrProfiles.get(LOCAL.userId, asrModelRef.asrProfileId);
      scope.asrProfiles.update({
        ...profile!,
        models: [{ modelId: "scribe_v2" }, { modelId: "custom/model:1", family: "fake_basic" }, { modelId: "orphan-model", family: "dropped_family" }],
      });
    });
    const custom = await importFixture(stack, { asrModelRef: { ...asrModelRef, modelId: "custom/model:1" } });
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, custom.taskId, 1)).toBe("succeeded");
    expect(fake.submits.map((call) => [call.modelId, call.family])).toEqual([["custom/model:1", "fake_basic"]]);
    expect(usageOf(stack, custom.taskId)).toEqual([expect.objectContaining({ model: "custom/model:1", feature: "transcribe", outcome: "succeeded" })]);

    const orphan = await importFixture(stack, { asrModelRef: { ...asrModelRef, modelId: "orphan-model" } });
    expect(await settledAttempt(stack, orphan.taskId, 1)).toBe("failed");
    const run = latestAttempts(stageRunsOf(stack.h, orphan.taskId)).find((candidate) => candidate.stage === "asr");
    expect(run?.error).toMatchObject({ code: "asr_failed.model_unavailable", retryDisposition: "never" });
    expect(fake.submits).toHaveLength(1);
    expect(usageOf(stack, orphan.taskId)).toHaveLength(0);
  });

  it("a job the provider no longer knows is given a grace query, then expires", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [{ state: "missing" }, done()];
    const recovered = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, recovered.taskId, 1)).toBe("succeeded");
    expect(fake.polls).toHaveLength(2);

    fake.pollOutcomes = [throttled(), throttled(), { state: "missing" }];
    const gone = await importFixture(stack);
    expect(await settledAttempt(stack, gone.taskId, 1)).toBe("failed");
    expect(stageRunsOf(stack.h, gone.taskId).find((run) => run.stage === "asr")?.error?.code).toBe("asr_failed.job_expired");
  });

  it("gives up on a job older than ASR_JOB_MAX_WAIT_HOURS without querying it", async () => {
    const { stack, fake } = setupJob();
    fake.submitOutcomes = [
      async (opts) => {
        opts.onRequestStart({ sentAt: Date.now(), credential: { versionId: "key-version-1", setAt: 1 } });
        return { version: 1, provider: "fake", jobId: "ancient", submittedAt: Date.now() - (ASR_JOB_MAX_WAIT_HOURS * 3_600_000 + 1) };
      },
    ];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error?.code).toBe("asr_failed.job_expired");
    expect(fake.polls).toHaveLength(0);
  });

  it("publishes sentence timing only when the provider's words were dropped", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [done({ words: [] })];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(revisionsOf(stack, contentId)[0]?.timingFidelity).toBe("segment_only");
    expect(asrResultJson(stack, taskId)).toMatchObject({ reasons: ["asr_words_dropped"] });
  });

  it("sends no terminology to a provider without terminology bias and says so only when there was some", async () => {
    const { stack, fake } = setupJob();
    fake.capabilities = { ...fake.capabilities, terminologyBias: false };
    const plain = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, plain.taskId, 1)).toBe("succeeded");
    expect(asrResultJson(stack, plain.taskId)).toMatchObject({ reasons: [] });

    const setId = stack.h.newId();
    insertRow(stack.h.db, "terminology_set", { id: setId, user_id: LOCAL.userId, scope_kind: "global" });
    insertRow(stack.h.db, "terminology_entry", { id: stack.h.newId(), set_id: setId, ordinal: 0, term: "生成式软件工程", normalized_key: "生成式软件工程" });
    const withTerms = await importFixture(stack);
    expect(await settledAttempt(stack, withTerms.taskId, 1)).toBe("succeeded");
    expect(fake.submits.at(-1)?.input.terminology).toEqual([]);
    expect(asrResultJson(stack, withTerms.taskId)).toMatchObject({ reasons: ["terminology_not_applied"], terminology: { sent: 0 } });
  });

  it("records usage only for a submission that reached the paid request", async () => {
    const { stack, fake } = setupJob();
    fake.failBeforeSend = true;
    fake.submitOutcomes = [amberError("asr_failed", "upload refused", { code: "asr_failed.invalid_audio" })];
    const unsent = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, unsent.taskId, 1)).toBe("failed");
    expect(usageOf(stack, unsent.taskId)).toHaveLength(0);

    fake.failBeforeSend = false;
    fake.submitOutcomes = [amberError("asr_failed", "refused", { code: "asr_failed.invalid_audio" })];
    const sent = await importFixture(stack);
    expect(await settledAttempt(stack, sent.taskId, 1)).toBe("failed");
    expect(usageOf(stack, sent.taskId).map((row) => row.outcome)).toEqual(["failed"]);
  });

  it("an unknown outcome of the creating request parks the submission", async () => {
    const { stack, fake } = setupJob();
    fake.submitOutcomes = [amberError("asr_timeout", "no answer to the creating request")];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    await waitFor(() => unitsByKey(stack, taskId, "asr:submit")[0]?.status === "waiting_user_action");
    expect(taskOf(stack.h, taskId).statusProjection).toBe("waiting");
    expect(usageOf(stack, taskId).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
    expect(fake.polls).toHaveLength(0);
  });
});

describe("asr stage job usage", { timeout: 15_000 }, () => {
  const soon = { state: "pending", retryAfterMs: 1 } as const;
  const done = () => ({ state: "done", result: fakeAsrResult() }) as const;
  const throttled = () => amberError("asr_failed", "throttled", { code: "asr_failed.rate_limited", details: { retryAfterMs: 1 } });
  const jobFailed = () => amberError("asr_failed", "job failed", { code: "asr_failed.job_failed" });

  function setupJob(extra: Partial<StageDeps> = {}) {
    const fake = new FakeAsrFactory();
    fake.delivery = "job";
    const stack = createMediaStack();
    open.push(stack);
    stack.h.executors.asr = new AsrStageExecutor({
      repository: stack.h.repository,
      files: stack.files,
      ingest: stack.ingest,
      asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
      newId: stack.h.newId,
      random: () => 0.5,
      ...extra,
    });
    const asrModelRef = configureAsr(stack.h);
    return { stack, fake, asrModelRef };
  }

  const submitUnits = (stack: MediaStack, taskId: string) => workUnitsOf(stack.h, taskId).filter((unit) => unit.key === "asr:submit");
  const awaitUnits = (stack: MediaStack, taskId: string) => workUnitsOf(stack.h, taskId).filter((unit) => unit.key === "asr:await");
  const recordOf = (stack: MediaStack, unitId: string): unknown => {
    const payload = stack.h.repository.withTransaction((scope) => scope.workUnits.getResult(LOCAL.userId, unitId));
    return JSON.parse(payload?.payloadJson ?? "null");
  };
  async function attemptSettled(stack: MediaStack, taskId: string, attempt: number): Promise<string> {
    await waitFor(() => {
      const run = latestAttempts(stageRunsOf(stack.h, taskId)).find((candidate) => candidate.stage === "asr");
      return run !== undefined && run.attempt === attempt && ["succeeded", "failed"].includes(run.status);
    }, 15_000);
    return stageStatuses(stack.h, taskId)["asr"] as string;
  }

  it("writes the creating request's row with the job id and its send-time context, and keeps its id in the submission record", async () => {
    const { stack, fake, asrModelRef } = setupJob();
    priceModel(stack, asrModelRef, PRICE);
    fake.sentAt = 1_700_000_000_000;
    fake.credential = { versionId: "version-3", setAt: 5 };
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, taskId, 1)).toBe("succeeded");
    const [row] = usageOf(stack, taskId);
    expect(row).toMatchObject({
      outcome: "succeeded",
      jobId: "job-1",
      profileIdSnapshot: asrModelRef.asrProfileId,
      profileNameSnapshot: "ElevenLabs",
      sentAt: 1_700_000_000_000,
      credentialVersion: "version-3",
      credentialSetAt: 5,
      priceSnapshot: PRICE,
    });
    // Nothing reported a remote end state, so none is claimed.
    expect(row).not.toHaveProperty("jobOutcome");
    const [submit] = submitUnits(stack, taskId);
    expect(recordOf(stack, submit?.id as string)).toEqual({
      handle: expect.objectContaining({ jobId: "job-1" }),
      usageId: row?.id,
      diarization: { effective: false, status: "unsupported" },
    });
  });

  it("fills the row from the remote end state the query reported, field by field", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [done()];
    fake.pollReports = [{ remote: "succeeded", usage: { billedInputTokens: 150, billedOutputTokens: 39, billedAudioMs: 12_000 }, rawUsageJson: '{"duration":12,"input_tokens":150,"output_tokens":39}' }];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, taskId, 1)).toBe("succeeded");
    expect(usageOf(stack, taskId)[0]).toMatchObject({
      outcome: "succeeded",
      jobOutcome: "succeeded",
      billedInputTokens: 150,
      billedOutputTokens: 39,
      billedAudioMs: 12_000,
      rawUsageJson: '{"duration":12,"input_tokens":150,"output_tokens":39}',
    });
  });

  it("never overwrites: a later report fills only what is still empty, and the job outcome stays as first reported", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [soon, done()];
    fake.pollReports = [
      { remote: "succeeded", usage: { billedAudioMs: 1_000 } },
      { remote: "failed", usage: { billedAudioMs: 2_000, billedInputTokens: 5 }, rawUsageJson: '{"input_tokens":5}' },
    ];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, taskId, 1)).toBe("succeeded");
    expect(usageOf(stack, taskId)[0]).toMatchObject({ jobOutcome: "succeeded", billedAudioMs: 1_000, billedInputTokens: 5, rawUsageJson: '{"input_tokens":5}' });
  });

  it("takes the job outcome only from the report: a remote failure is recorded as reported, a bare error code is not read as one", async () => {
    const reported = setupJob();
    reported.fake.pollOutcomes = [jobFailed()];
    reported.fake.pollReports = [{ remote: "failed" }];
    const failed = await importFixture(reported.stack);
    reported.stack.h.scheduler.start();
    expect(await attemptSettled(reported.stack, failed.taskId, 1)).toBe("failed");
    expect(usageOf(reported.stack, failed.taskId)[0]).toMatchObject({ outcome: "succeeded", jobOutcome: "failed" });
    expect(usageOf(reported.stack, failed.taskId)[0]).not.toHaveProperty("billedInputTokens");

    const bare = setupJob();
    bare.fake.pollOutcomes = [jobFailed()];
    const unreported = await importFixture(bare.stack);
    bare.stack.h.scheduler.start();
    expect(await attemptSettled(bare.stack, unreported.taskId, 1)).toBe("failed");
    expect(usageOf(bare.stack, unreported.taskId)[0]).not.toHaveProperty("jobOutcome");
  });

  it("records a remote success even when the result could not be used locally", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [amberError("asr_failed", "result unreadable", { code: "asr_failed.job_failed" })];
    fake.pollReports = [{ remote: "succeeded", usage: { billedAudioMs: 3_000 } }];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, taskId, 1)).toBe("failed");
    expect(usageOf(stack, taskId)[0]).toMatchObject({ jobOutcome: "succeeded", billedAudioMs: 3_000 });
  });

  it("is not disturbed when filling the row fails: the unit, the transcript and the retries are as without it", async () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error() {}, child: () => logger };
    const { stack, fake } = setupJob({ logger });
    stack.h.db.exec("CREATE TRIGGER refuse_fill BEFORE UPDATE ON asr_usage BEGIN SELECT RAISE(ABORT, 'locked'); END");
    fake.pollOutcomes = [throttled(), done()];
    fake.pollReports = [undefined, { remote: "succeeded", usage: { billedAudioMs: 3_000 } }] as never;
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, taskId, 1)).toBe("succeeded");
    expect(revisionsOf(stack, contentId)).toHaveLength(1);
    expect(awaitUnits(stack, taskId)[0]).toMatchObject({ status: "succeeded", retryCount: 1 });
    expect(usageOf(stack, taskId)[0]).not.toHaveProperty("jobOutcome");
    expect(warnings).toEqual(["asr_job_report_not_recorded"]);
  });

  it("still resumes a submission recorded as the handle alone, with the same await digest and no row to fill", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, taskId, 1)).toBe("failed");
    const [submit] = submitUnits(stack, taskId);
    const record = recordOf(stack, submit?.id as string) as { handle: unknown };
    // The record as an older version wrote it, with the digest a completed unit must still match.
    const legacy = JSON.stringify(record.handle);
    const digest = `sha256:${createHash("sha256").update(legacy).digest("hex")}`;
    stack.h.db.prepare("UPDATE work_unit_result SET payload_json = ?, output_digest = ? WHERE work_unit_id = ?").run(legacy, digest, submit?.id);
    stack.h.db.prepare("UPDATE work_unit SET output_digest = ? WHERE id = ?").run(digest, submit?.id);
    const digestBefore = awaitUnits(stack, taskId)[0]?.inputDigest;

    // The provider reports an end state again, but a record without a row has nothing to fill.
    fake.pollOutcomes = [done()];
    fake.pollReports = [{ remote: "succeeded", usage: { billedAudioMs: 3_000 } }];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await attemptSettled(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls.at(-1)?.jobId).toBe("job-1");
    expect(awaitUnits(stack, taskId).map((unit) => unit.inputDigest)).toEqual([digestBefore, digestBefore]);
    expect(usageOf(stack, taskId)).toHaveLength(1);
    expect(usageOf(stack, taskId)[0]).not.toHaveProperty("jobOutcome");
  });

  it("does not stumble on a submission record whose usage row is gone", async () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error() {}, child: () => logger };
    const { stack, fake } = setupJob({ logger });
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, taskId, 1)).toBe("failed");
    stack.h.db.prepare("DELETE FROM asr_usage").run();
    fake.pollOutcomes = [done()];
    fake.pollReports = [{ remote: "succeeded", usage: { billedAudioMs: 3_000 } }];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await attemptSettled(stack, taskId, 2)).toBe("succeeded");
    expect(usageOf(stack, taskId)).toEqual([]);
    expect(warnings).toEqual(["asr_job_report_without_usage_row"]);
  });

  it("records a creating request that failed after it left with its context but no job id, and none that failed before", async () => {
    const { stack, fake } = setupJob();
    fake.submitOutcomes = [amberError("asr_failed", "refused", { code: "asr_failed.invalid_audio" })];
    fake.sentAt = 1_700_000_000_000;
    const sent = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await attemptSettled(stack, sent.taskId, 1)).toBe("failed");
    const [row] = usageOf(stack, sent.taskId);
    expect(row).toMatchObject({ outcome: "failed", sentAt: 1_700_000_000_000, credentialVersion: "key-version-1", profileNameSnapshot: "ElevenLabs" });
    expect(row).not.toHaveProperty("jobId");
    expect(row).not.toHaveProperty("jobOutcome");

    fake.failBeforeSend = true;
    const unsent = await importFixture(stack);
    expect(await attemptSettled(stack, unsent.taskId, 1)).toBe("failed");
    expect(usageOf(stack, unsent.taskId)).toEqual([]);
  });
});

describe("asrPollDelayMs", () => {
  it("grows by half per query up to the cap, honours a bounded provider wait, and spreads by the jitter", () => {
    const middle = () => 0.5;
    expect(asrPollDelayMs(1, undefined, middle)).toBe(ASR_POLL_INTERVAL_MS);
    expect(asrPollDelayMs(2, undefined, middle)).toBe(ASR_POLL_INTERVAL_MS * 1.5);
    expect(asrPollDelayMs(50, undefined, middle)).toBe(ASR_POLL_INTERVAL_MAX_MS);
    expect(asrPollDelayMs(1, 1234, middle)).toBe(1234);
    expect(asrPollDelayMs(1, Number.MAX_SAFE_INTEGER, middle)).toBe(10 * ASR_POLL_INTERVAL_MAX_MS);
    expect(asrPollDelayMs(1, undefined, () => 0)).toBe(Math.round(ASR_POLL_INTERVAL_MS * 0.9));
    expect(asrPollDelayMs(1, undefined, () => 1)).toBe(Math.round(ASR_POLL_INTERVAL_MS * 1.1));
  });
});

describe("normalizeSentences", () => {
  const seg = (startMs: number, endMs: number, text: string, speakerId?: string) => ({ startMs, endMs, text, ...(speakerId === undefined ? {} : { speakerId }) });

  it("clips overlapping sentences to the previous end and merges an instant one into its neighbour, as before", () => {
    const { sentences, merged } = normalizeSentences([seg(0, 1000, "a"), seg(800, 1800, "b"), seg(1800, 1800, "c"), seg(1900, 2500, "d")]);
    expect(sentences).toEqual([seg(0, 1000, "a"), seg(1000, 1800, "b c"), seg(1900, 2500, "d")]);
    expect(merged).toBe(1);
  });

  it("gives the same result as the plain rules for any input without speakers, in whatever order it arrives", () => {
    let state = 11;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    // Reference: the clip-to-last-pushed and merge rules written out once more.
    const plain = (raw: ReadonlyArray<ReturnType<typeof seg>>) => {
      const ordered = raw
        .map((segment) => ({ startMs: Math.max(0, Math.round(segment.startMs)), endMs: Math.round(segment.endMs), text: segment.text.trim() }))
        .filter((segment) => segment.text !== "")
        .map((segment, index) => ({ segment, index }))
        .sort((a, b) => a.segment.startMs - b.segment.startMs || a.index - b.index)
        .map(({ segment }) => segment);
      const out: Array<{ startMs: number; endMs: number; text: string }> = [];
      let pending: { startMs: number; endMs: number; text: string } | undefined;
      let merged = 0;
      const join = (left: string, right: string): string => `${left} ${right}`;
      for (const segment of ordered) {
        const previous = out.at(-1);
        let current = { ...segment, startMs: previous === undefined ? segment.startMs : Math.max(segment.startMs, previous.endMs) };
        if (pending !== undefined) {
          current = { ...current, startMs: Math.min(pending.startMs, current.startMs), text: join(pending.text, current.text) };
          pending = undefined;
        }
        if (current.endMs > current.startMs) {
          out.push(current);
          continue;
        }
        merged += 1;
        if (previous === undefined) pending = current;
        else {
          previous.text = join(previous.text, current.text);
          previous.endMs = Math.max(previous.endMs, current.endMs);
        }
      }
      if (pending !== undefined) out.push({ ...pending, endMs: pending.startMs + 1 });
      return { sentences: out, merged };
    };
    for (let round = 0; round < 60; round += 1) {
      const raw = Array.from({ length: 12 }, (_, index) => {
        const startMs = Math.floor(next() * 5000);
        return seg(startMs, startMs + (next() < 0.2 ? 0 : Math.floor(next() * 1500)), `t${index}`);
      });
      expect(normalizeSentences(raw)).toEqual(plain(raw));
    }
  });

  it("keeps sentences of different speakers overlapping: no clipping, no merging", () => {
    const { sentences, merged } = normalizeSentences([seg(0, 5000, "long", "0"), seg(2000, 2600, "yes", "1"), seg(2600, 2600, "hm", "1"), seg(4000, 6000, "more", "0")]);
    expect(sentences).toEqual([seg(0, 5000, "long", "0"), seg(2000, 2600, "yes hm", "1"), seg(5000, 6000, "more", "0")]);
    expect(merged).toBe(1);
  });

  it("clips against the previous sentence of the same speaker, not the last one pushed", () => {
    const { sentences } = normalizeSentences([seg(0, 3000, "a", "0"), seg(1000, 1500, "b", "1"), seg(2000, 4000, "c", "0")]);
    expect(sentences.map((sentence) => [sentence.speakerId, sentence.startMs, sentence.endMs])).toEqual([
      ["0", 0, 3000],
      ["1", 1000, 1500],
      ["0", 3000, 4000],
    ]);
  });

  it("never merges an instant sentence into one of another speaker, and keeps it citable", () => {
    const { sentences, merged } = normalizeSentences([seg(0, 1000, "a", "0"), seg(500, 500, "ok", "1"), seg(1200, 2000, "b", "0")]);
    expect(sentences.map((sentence) => [sentence.speakerId, sentence.text, sentence.startMs, sentence.endMs])).toEqual([
      ["0", "a", 0, 1000],
      ["1", "ok", 500, 501],
      ["0", "b", 1200, 2000],
    ]);
    // Counted as repaired like a lone instant sentence always was, though nothing was merged into another speaker.
    expect(merged).toBe(1);
    for (const sentence of sentences) expect(sentence.endMs).toBeGreaterThan(sentence.startMs);
  });

  it("treats sentences without a speaker as a stream of their own, clipped only against each other", () => {
    const { sentences } = normalizeSentences([seg(0, 1000, "a", "0"), seg(900, 1500, "b"), seg(1200, 2000, "c")]);
    expect(sentences.map((sentence) => [sentence.speakerId, sentence.startMs, sentence.endMs])).toEqual([
      ["0", 0, 1000],
      [undefined, 900, 1500],
      [undefined, 1500, 2000],
    ]);
  });

  it("keeps a sentence without a speaker separate, with its own time, between sentences of speakers", () => {
    const { sentences, merged } = normalizeSentences([seg(0, 10_000, "A", "0"), seg(2000, 3000, "B", "1"), seg(4000, 5000, "U")]);
    expect(sentences).toEqual([seg(0, 10_000, "A", "0"), seg(2000, 3000, "B", "1"), seg(4000, 5000, "U")]);
    expect(merged).toBe(0);
  });

  it("keeps the overlap of a sentence without a speaker with one of a speaker", () => {
    const { sentences } = normalizeSentences([seg(0, 5000, "A", "0"), seg(4000, 6000, "U")]);
    expect(sentences).toEqual([seg(0, 5000, "A", "0"), seg(4000, 6000, "U")]);
  });

  it("does not let an instant sentence of a speaker pull a later sentence's start earlier", () => {
    const { sentences } = normalizeSentences([seg(0, 3000, "A", "0"), seg(1000, 1000, "B", "1"), seg(4000, 5000, "B2", "1")]);
    expect(sentences.map((sentence) => [sentence.speakerId, sentence.text, sentence.startMs, sentence.endMs])).toEqual([
      ["0", "A", 0, 3000],
      ["1", "B", 1000, 1001],
      ["1", "B2", 4000, 5000],
    ]);
  });

  it("still merges an instant sentence into the previous one of its own speaker", () => {
    const { sentences, merged } = normalizeSentences([seg(0, 1000, "a", "1"), seg(500, 900, "b", "0"), seg(1000, 1000, "c", "1")]);
    expect(sentences.map((sentence) => [sentence.speakerId, sentence.text, sentence.startMs, sentence.endMs])).toEqual([
      ["1", "a c", 0, 1000],
      ["0", "b", 500, 900],
    ]);
    expect(merged).toBe(1);
  });

  it("keeps a speakerless instant sentence waiting for the next speakerless one, but never merges it into a speaker's", () => {
    expect(normalizeSentences([seg(100, 100, "x"), seg(200, 900, "y")]).sentences).toEqual([seg(100, 900, "x y")]);
    expect(normalizeSentences([seg(100, 100, "x"), seg(200, 900, "y", "0")]).sentences).toEqual([seg(100, 101, "x"), seg(200, 900, "y", "0")]);
  });
});

describe("asr stage speaker identification", () => {
  const SUPPORT = { speakerCount: { min: 2, max: 8, semantics: "reference" as const }, recommendedMaxDurationSec: 60 };
  const TURNS = fakeAsrResult({
    segments: [
      { startMs: 0, endMs: 1200, text: "欢迎来到生成式软件工程。", speakerId: "1" },
      { startMs: 1500, endMs: 2600, text: "今天讲提示词。", speakerId: "0" },
    ],
    words: [
      { text: "欢迎", startMs: 0, endMs: 300, speakerId: "1" },
      { text: "来到", startMs: 300, endMs: 600, speakerId: "1" },
      { text: "生成式软件工程。", startMs: 600, endMs: 1200, speakerId: "1" },
      { text: "今天", startMs: 1500, endMs: 1800, speakerId: "0" },
      { text: "讲", startMs: 1800, endMs: 2000, speakerId: "0" },
      { text: "提示词。", startMs: 2000, endMs: 2600, speakerId: "0" },
    ],
  });

  function offering(extra: Partial<StageDeps> = {}, support: typeof SUPPORT | null = SUPPORT) {
    const made = setup(extra);
    if (support !== null) made.fake.capabilities = { ...made.fake.capabilities, diarization: support };
    return made;
  }

  function asrGeneration(stack: MediaStack, contentId: string) {
    return (revisionsOf(stack, contentId)[0] as TranscriptRevision).generation;
  }

  function speakersOf(stack: MediaStack, contentId: string) {
    return stack.h.repository.withTransaction((scope) => scope.speakers.list(LOCAL.userId, contentId));
  }

  function segmentsOf(stack: MediaStack, contentId: string) {
    const [revision] = revisionsOf(stack, contentId);
    return stack.h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revision?.id as string));
  }

  /** Rewrites a Task's request as one stored before speaker identification existed (no `diarization`). */
  function asLegacyRequest(stack: MediaStack, taskId: string): void {
    const { diarization: _gone, ...rest } = JSON.parse(taskOf(stack.h, taskId).requestJson) as Record<string, unknown>;
    stack.h.db.exec("DROP TRIGGER task_request_immutable");
    stack.h.db.prepare("UPDATE task SET request_json = ? WHERE id = ?").run(canonicalJson(rest), taskId);
  }

  function digestOfSubmit(stack: MediaStack, taskId: string): string {
    return workUnitsOf(stack.h, taskId).find((unit) => unit.key === "asr:submit")?.inputDigest as string;
  }

  it("sends the request with identification when the model offers it, and records status applied with the count asked for", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack, { diarization: { mode: "required", speakerCount: 3 } });
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input.diarization).toEqual({ speakerCount: 3 });
    expect(asrGeneration(stack, contentId)).toEqual({ kind: "asr", asrProfileId: expect.any(String), modelId: "scribe_v2", diarization: { status: "applied", requestedSpeakerCount: 3 } });
  });

  it("sends an empty request part when no count was given, and the setting's preferred mode identifies too", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input.diarization).toEqual({});
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "applied" } });
    expect(JSON.parse(taskOf(stack.h, taskId).requestJson)).toMatchObject({ diarization: { mode: "preferred" } });
  });

  it("registers one speaker per label in order of first appearance and stores only their ULIDs in the segments", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    const speakers = speakersOf(stack, contentId);
    expect(speakers.map((speaker) => speaker.ordinal)).toEqual([1, 2]);
    expect(speakers.every((speaker) => isUlid(speaker.id))).toBe(true);
    const segments = segmentsOf(stack, contentId);
    // The first label seen ("1") is the first speaker; the labels themselves are nowhere.
    expect(segments.map((segment) => segment.speakerId)).toEqual([speakers[0]?.id, speakers[1]?.id]);
    const stored = stack.h.db.prepare("SELECT speaker_id FROM transcript_segment").all() as Array<{ speaker_id: string | null }>;
    expect(stored.every((row) => row.speaker_id === null || isUlid(row.speaker_id))).toBe(true);
    expect(JSON.stringify(segments)).not.toContain('"speakerId":"1"');
  });

  it("publishes a revision with speakers as not reviewed, nothing confirmed for it or its names", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    const [revision] = revisionsOf(stack, contentId);
    expect(revision).toMatchObject({ kind: "asr" });
    expect(revision?.parentRevisionId).toBeUndefined();
    expect(segmentsOf(stack, contentId).every((segment) => segment.speakerId !== undefined)).toBe(true);
    expect(stack.h.repository.withTransaction((scope) => scope.speakerConfirmations.confirmedAt(LOCAL.userId, revision?.id as string))).toBeUndefined();
    expect(countRows(stack.h.db, "transcript_revision_speaker_confirmation")).toBe(0);
    const review = new SpeakerService({ repository: stack.h.repository, newId: stack.h.newId }).review(LOCAL, revision?.id as string);
    expect(review).not.toHaveProperty("confirmedAt");
    expect(review.speakers).toHaveLength(2);
    expect(speakersOf(stack, contentId).every((speaker) => speaker.nameConfirmedAt === undefined)).toBe(true);
  });

  it("records no_speakers when identification took place but the result names nobody", async () => {
    const { stack, fake } = offering();
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input.diarization).toEqual({});
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "no_speakers" } });
    expect(speakersOf(stack, contentId)).toEqual([]);
  });

  it("records off and sends nothing when the setting is off, whether or not the model offers identification", async () => {
    const { stack, fake } = offering();
    stack.h.userSettings.patch(LOCAL, { asrDiarization: false });
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input).not.toHaveProperty("diarization");
    expect(JSON.parse(taskOf(stack.h, taskId).requestJson)).toMatchObject({ diarization: { mode: "off" } });
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "off" } });
  });

  it("records unsupported and transcribes normally when preferred identification meets a model without it", async () => {
    const { stack, fake } = offering({}, null);
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input).not.toHaveProperty("diarization");
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "unsupported" } });
  });

  it("records over_recommended and transcribes normally when the audio is longer than the model recommends", async () => {
    const { stack, fake } = offering({}, { ...SUPPORT, recommendedMaxDurationSec: 2 });
    const { taskId, contentId } = await importFixture(stack, { diarization: { mode: "preferred", speakerCount: 3 } });
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input).not.toHaveProperty("diarization");
    expect(asrGeneration(stack, contentId)).toEqual(expect.objectContaining({ diarization: { status: "over_recommended", requestedSpeakerCount: 3 } }));
  });

  it("makes a speaker count outside the model's range unsatisfiable: preferred goes on without, never clamped", async () => {
    const { stack, fake } = offering({}, { ...SUPPORT, speakerCount: { min: 2, max: 2, semantics: "reference" } });
    const { taskId, contentId } = await importFixture(stack, { diarization: { mode: "preferred", speakerCount: 5 } });
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input).not.toHaveProperty("diarization");
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "unsupported", requestedSpeakerCount: 5 } });
  });

  it.each([
    ["the model does not offer it", null, undefined, "unsupported"],
    ["the audio is longer than recommended", { ...SUPPORT, recommendedMaxDurationSec: 2 }, undefined, "over_recommended"],
    ["the speaker count is outside the range", { ...SUPPORT, speakerCount: { min: 2, max: 3, semantics: "reference" as const } }, 5, "speaker_count"],
  ])("fails a required request before anything is sent when %s", async (_name, support, speakerCount, reason) => {
    const { stack, fake } = offering({}, support);
    const { taskId } = await importFixture(stack, { diarization: { mode: "required", ...(speakerCount === undefined ? {} : { speakerCount }) } });
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("failed");
    expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error).toMatchObject({
      code: "asr_failed.diarization_unavailable",
      retryDisposition: "never",
      details: { reason },
    });
    expect(fake.calls).toHaveLength(0);
    expect(fake.requestStarts).toHaveLength(0);
    expect(usageOf(stack, taskId)).toEqual([]);
  });

  it("keeps the digest it always had when identification does not take place, and changes it when it does", async () => {
    const { stack, fake } = offering({}, null);
    const off = await importFixture(stack, { diarization: { mode: "off" } });
    const unsupported = await importFixture(stack, { diarization: { mode: "preferred", speakerCount: 3 } });
    // A request stored before the field existed has none.
    const legacy = await importFixture(stack);
    asLegacyRequest(stack, legacy.taskId);
    stack.h.scheduler.start();
    for (const { taskId } of [off, unsupported, legacy]) expect(await asrSettled(stack, taskId)).toBe("succeeded");
    // The digest of a request without identification, pinned as the layout the stage has always
    // hashed: these keys in this order, and nothing about speakers.
    const [asset] = stack.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, off.contentId));
    const profileId = stack.h.repository.withTransaction((scope) => scope.asrProfiles.list(LOCAL.userId))[0]?.id;
    const pinned = `{"asrProfileId":"${profileId}","audio":"${asset?.fingerprint}","baseURL":null,"language":null,"model":"scribe_v2","provider":"elevenlabs","terms":[]}`;
    expect(digestOfSubmit(stack, off.taskId)).toBe(`sha256:${createHash("sha256").update(pinned).digest("hex")}`);
    expect(digestOfSubmit(stack, off.taskId)).toBe(digestOfSubmit(stack, legacy.taskId));
    expect(digestOfSubmit(stack, unsupported.taskId)).toBe(digestOfSubmit(stack, legacy.taskId));
    expect(fake.calls).toHaveLength(3);

    fake.capabilities = { ...fake.capabilities, diarization: SUPPORT };
    const counted3 = await importFixture(stack, { diarization: { mode: "preferred", speakerCount: 3 } });
    const counted4 = await importFixture(stack, { diarization: { mode: "preferred", speakerCount: 4 } });
    const uncounted = await importFixture(stack, { diarization: { mode: "preferred" } });
    for (const { taskId } of [counted3, counted4, uncounted]) expect(await asrSettled(stack, taskId)).toBe("succeeded");
    const digests = [counted3, counted4, uncounted].map(({ taskId }) => digestOfSubmit(stack, taskId));
    expect(new Set([...digests, digestOfSubmit(stack, legacy.taskId)]).size).toBe(4);
  });

  it("reads a request without the field as off", async () => {
    const { stack, fake } = offering();
    const { taskId, contentId } = await importFixture(stack);
    asLegacyRequest(stack, taskId);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input).not.toHaveProperty("diarization");
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "off" } });
  });

  it("keeps the frozen mode and count when a re-run switches to another model", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [amberError("asr_failed", "gone", { code: "asr_failed.model_unavailable" }), TURNS];
    const { taskId } = await importFixture(stack, { diarization: { mode: "required", speakerCount: 3 } });
    stack.h.scheduler.start();
    await waitFor(() => stageStatuses(stack.h, taskId)["asr"] === "failed");
    const other = configureAsr(stack.h, LOCAL.userId, { asDefault: false, name: "other" });
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: other });
    await waitFor(() => stageStatuses(stack.h, taskId)["asr"] === "succeeded");
    expect(fake.calls.map((call) => [call.profileId === other.asrProfileId, call.input.diarization])).toEqual([
      [false, { speakerCount: 3 }],
      [true, { speakerCount: 3 }],
    ]);
  });

  it("assigns words of overlapping sentences by speaker and drops, with a count, those it cannot place", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [
      fakeAsrResult({
        segments: [
          { startMs: 0, endMs: 5000, text: "我们来看一下这个方案", speakerId: "0" },
          { startMs: 2000, endMs: 3000, text: "好的", speakerId: "1" },
        ],
        words: [
          { text: "我们", startMs: 0, endMs: 1000, speakerId: "0" },
          { text: "好的", startMs: 2100, endMs: 2900, speakerId: "1" },
          { text: "来看", startMs: 2200, endMs: 2800, speakerId: "0" },
          { text: "一下", startMs: 2300, endMs: 2700 },
          { text: "方案", startMs: 3500, endMs: 4500, speakerId: "0" },
        ],
      }),
    ];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    const segments = segmentsOf(stack, contentId);
    expect(segments.map((segment) => [segment.startMs, segment.endMs])).toEqual([
      [0, 5000],
      [2000, 3000],
    ]);
    expect(segments.map((segment) => segment.words?.map((word) => word.text))).toEqual([["我们", "来看", "方案"], ["好的"]]);
    expect(revisionsOf(stack, contentId)[0]?.timingFidelity).toBe("exact_words");
    expect(asrResultJson(stack, taskId)).toMatchObject({ reasons: ["speaker_overlap_words_dropped"], speakerOverlapWordsDropped: 1 });
    // The labels that placed the words are not stored with them.
    expect(JSON.stringify(segments.flatMap((segment) => segment.words ?? []))).not.toContain("speakerId");
  });

  it("accepts a sentence left without words in an exact_words revision, and the karaoke line falls back to its text", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [
      fakeAsrResult({
        segments: [
          { startMs: 0, endMs: 5000, text: "第一人说话", speakerId: "0" },
          { startMs: 2000, endMs: 3000, text: "插话", speakerId: "1" },
        ],
        words: [
          { text: "第一人", startMs: 100, endMs: 1000, speakerId: "0" },
          { text: "说话", startMs: 3500, endMs: 4500, speakerId: "0" },
          { text: "插话", startMs: 2200, endMs: 2800 },
        ],
      }),
    ];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    const [revision] = revisionsOf(stack, contentId);
    const segments = segmentsOf(stack, contentId);
    expect(segments[1]?.words).toEqual([]);
    expect(checkTranscriptInvariants(revision as TranscriptRevision, segments)).toEqual([]);
    const cue = { startMs: 2000, endMs: 3000, text: "插话", words: segments[1]?.words ?? [] };
    expect(assDialogue(cue, { karaoke: true })).toBe(assDialogue({ startMs: 2000, endMs: 3000, text: "插话" }, { karaoke: false }));
  });

  it("registers no speaker rows when publishing fails after they were written", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [TURNS];
    stack.h.db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON transcript_revision BEGIN SELECT RAISE(ABORT, 'no revisions today'); END");
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("failed");
    expect(speakersOf(stack, contentId)).toEqual([]);
    expect(revisionsOf(stack, contentId)).toEqual([]);
  });

  it("leaves the labels beyond the Content's room unassigned and says so", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.repository.withTransaction((scope) =>
      scope.speakers.insert(
        LOCAL.userId,
        contentId,
        Array.from({ length: SPEAKERS_PER_CONTENT_MAX - 1 }, () => ({ id: stack.h.newId() })),
        1,
      ),
    );
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    const segments = segmentsOf(stack, contentId);
    // Only one id fit: the first label got it, the second stays unassigned.
    expect(speakersOf(stack, contentId)).toHaveLength(SPEAKERS_PER_CONTENT_MAX);
    expect(segments[0]?.speakerId).toBeDefined();
    expect(segments[1]?.speakerId).toBeUndefined();
    expect(asrResultJson(stack, taskId)["reasons"]).toContain("speakers_truncated");
  });

  it("records no_speakers when every label fell outside the Content's room", async () => {
    const { stack, fake } = offering();
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.repository.withTransaction((scope) =>
      scope.speakers.insert(LOCAL.userId, contentId, Array.from({ length: SPEAKERS_PER_CONTENT_MAX }, () => ({ id: stack.h.newId() })), 1),
    );
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(segmentsOf(stack, contentId).every((segment) => segment.speakerId === undefined)).toBe(true);
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "no_speakers" } });
    expect(asrResultJson(stack, taskId)["reasons"]).toContain("speakers_truncated");
  });

  it.each([
    ["off", { mode: "off" as const }, SUPPORT],
    ["unsupported", { mode: "preferred" as const }, null],
    ["over_recommended", { mode: "preferred" as const }, { ...SUPPORT, recommendedMaxDurationSec: 2 }],
  ])("registers no speakers when identification is %s even if the upstream names some", async (status, diarization, support) => {
    const { stack, fake } = offering({}, support);
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack, { diarization });
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(speakersOf(stack, contentId)).toEqual([]);
    const segments = segmentsOf(stack, contentId);
    expect(segments.every((segment) => segment.speakerId === undefined)).toBe(true);
    // The labels are gone from the words too, so overlap handling cannot see them.
    expect(JSON.stringify(segments)).not.toContain("speakerId");
    expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status } });
  });

  describe("with a job provider", { timeout: 15_000 }, () => {
    function offeringJob(support: typeof SUPPORT | null = SUPPORT) {
      const fake = new FakeAsrFactory();
      fake.delivery = "job";
      if (support !== null) fake.capabilities = { ...fake.capabilities, diarization: support };
      const stack = createMediaStack();
      open.push(stack);
      stack.h.executors.asr = new AsrStageExecutor({
        repository: stack.h.repository,
        files: stack.files,
        ingest: stack.ingest,
        asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
        newId: stack.h.newId,
        random: () => 0.5,
      });
      configureAsr(stack.h);
      return { stack, fake };
    }

    const submitRecord = (stack: MediaStack, taskId: string): Record<string, unknown> => {
      const [unit] = workUnitsOf(stack.h, taskId).filter((candidate) => candidate.key === "asr:submit");
      const payload = stack.h.repository.withTransaction((scope) => scope.workUnits.getResult(LOCAL.userId, unit?.id as string));
      return JSON.parse(payload?.payloadJson ?? "null") as Record<string, unknown>;
    };

    async function settled(stack: MediaStack, taskId: string): Promise<void> {
      await waitFor(() => stageStatuses(stack.h, taskId)["asr"] === "succeeded" || stageStatuses(stack.h, taskId)["asr"] === "failed", 15_000);
    }

    it("sends identification with the submission, keeps the decision in the submit record and publishes with it after waiting", async () => {
      const { stack, fake } = offeringJob();
      fake.pollOutcomes = [{ state: "pending", retryAfterMs: 1 }, { state: "done", result: TURNS }];
      const { taskId, contentId } = await importFixture(stack, { diarization: { mode: "preferred", speakerCount: 4 } });
      stack.h.scheduler.start();
      await settled(stack, taskId);
      expect(stageStatuses(stack.h, taskId)["asr"]).toBe("succeeded");
      expect(fake.submits[0]?.input.diarization).toEqual({ speakerCount: 4 });
      expect(submitRecord(stack, taskId)["diarization"]).toEqual({ effective: true, speakerCount: 4 });
      expect(fake.polls.length).toBeGreaterThan(1);
      expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "applied", requestedSpeakerCount: 4 } });
      expect(speakersOf(stack, contentId)).toHaveLength(2);
    });

    it("records over_recommended in the submit record and reuses it when the stage is re-entered", async () => {
      const { stack, fake } = offeringJob({ ...SUPPORT, recommendedMaxDurationSec: 2 });
      fake.pollOutcomes = [{ state: "pending", retryAfterMs: 1 }, { state: "done", result: fakeAsrResult() }];
      const { taskId, contentId } = await importFixture(stack);
      stack.h.scheduler.start();
      await settled(stack, taskId);
      expect(fake.submits[0]?.input).not.toHaveProperty("diarization");
      expect(submitRecord(stack, taskId)["diarization"]).toEqual({ effective: false, status: "over_recommended" });
      expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "over_recommended" } });
    });

    it("reads a submit record from before decisions were kept as submitted without identification", async () => {
      const { stack, fake } = offeringJob();
      fake.pollOutcomes = [{ state: "pending", retryAfterMs: 1500 }, { state: "done", result: TURNS }];
      const { taskId, contentId } = await importFixture(stack);
      stack.h.holdWakes();
      stack.h.scheduler.start();
      await waitFor(() => workUnitsOf(stack.h, taskId).some((unit) => unit.key === "asr:await" && unit.retryNotBefore !== undefined));
      const [unit] = workUnitsOf(stack.h, taskId).filter((candidate) => candidate.key === "asr:submit");
      const { diarization: _kept, ...older } = submitRecord(stack, taskId);
      stack.h.db.prepare("UPDATE work_unit_result SET payload_json = ? WHERE work_unit_id = ?").run(JSON.stringify(older), unit?.id);
      stack.h.releaseWakes();
      await settled(stack, taskId);
      expect(stageStatuses(stack.h, taskId)["asr"]).toBe("succeeded");
      expect(asrGeneration(stack, contentId)).toMatchObject({ diarization: { status: "off" } });
    });

    it("fails a required request before the upload when the model cannot identify speakers", async () => {
      const { stack, fake } = offeringJob(null);
      const { taskId } = await importFixture(stack, { diarization: { mode: "required" } });
      stack.h.scheduler.start();
      await settled(stack, taskId);
      expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error).toMatchObject({ code: "asr_failed.diarization_unavailable", details: { reason: "unsupported" } });
      expect(fake.submits).toHaveLength(0);
      expect(usageOf(stack, taskId)).toEqual([]);
    });
  });
});

describe("asr stage comparison transcription", () => {
  const SUPPORT = { speakerCount: { min: 2, max: 8, semantics: "reference" as const }, recommendedMaxDurationSec: 60 };
  const TURNS = fakeAsrResult({
    segments: [
      { startMs: 0, endMs: 1200, text: "欢迎来到生成式软件工程。", speakerId: "1" },
      { startMs: 1500, endMs: 2600, text: "今天讲提示词。", speakerId: "0" },
    ],
  });

  function service(stack: MediaStack): RetranscribeService {
    return new RetranscribeService({ repository: stack.h.repository, bus: stack.h.bus, control: stack.h.scheduler, disk: stack.h.disk, settings: stack.h.settings, newId: stack.h.newId });
  }

  /** A Content whose primary is an ASR transcription naming two speakers; its own Task is out of the way. */
  async function transcribed(stack: MediaStack, fake: FakeAsrFactory): Promise<string> {
    fake.capabilities = { ...fake.capabilities, diarization: SUPPORT };
    fake.outcomes = [TURNS];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    stack.h.tasks.cancel(LOCAL, taskId);
    await stack.h.scheduler.whenIdle();
    return contentId;
  }

  const searchRows = (stack: MediaStack, contentId: string) => stack.h.db.prepare("SELECT revision_id FROM search_index WHERE content_id = ?").all(contentId);

  it("stores the transcription marked for comparison with its speakers, and leaves the primary, the language and the search alone", async () => {
    const { stack, fake } = setup();
    const contentId = await transcribed(stack, fake);
    const primaryId = contentOf(stack, contentId)?.primaryTranscriptRevisionId;
    // A Content that had no original language yet, and whose projection was emptied: a sync or
    // a language write would show.
    stack.h.db.prepare("UPDATE content SET raw_language = NULL WHERE id = ?").run(contentId);
    stack.h.db.prepare("DELETE FROM search_index WHERE content_id = ?").run(contentId);
    fake.outcomes = [TURNS];
    const chosen = stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef);
    const accepted = await service(stack).retranscribe(LOCAL, contentId, undefined, chosen, undefined, true);
    expect(JSON.parse(taskOf(stack.h, accepted.body.taskId).requestJson)).toMatchObject({ comparison: true, diarization: { mode: "required" } });
    await waitFor(() => taskOf(stack.h, accepted.body.taskId).statusProjection === "succeeded");

    const revisions = revisionsOf(stack, contentId);
    expect(revisions.map((revision) => revision.kind)).toEqual(["asr", "asr"]);
    const comparison = revisions[1] as TranscriptRevision;
    expect(comparison.generation).toMatchObject({ kind: "asr", purpose: "comparison", diarization: { status: "applied" } });
    expect(revisions[0]?.generation).not.toHaveProperty("purpose");
    expect(fake.calls[1]?.input.diarization).toEqual({});
    const content = contentOf(stack, contentId);
    expect(content?.primaryTranscriptRevisionId).toBe(primaryId);
    expect(content?.rawLanguage).toBeUndefined();
    expect(searchRows(stack, contentId)).toEqual([]);

    // Its speakers are new rows, and flagged as named only by the comparison.
    const { speakers, comparisonOnly, named } = stack.h.repository.withTransaction((scope) => ({
      speakers: scope.speakers.list(LOCAL.userId, contentId),
      comparisonOnly: scope.speakers.comparisonOnlyIds(LOCAL.userId, contentId),
      named: new Set(scope.transcripts.listSegments(LOCAL.userId, comparison.id).map((segment) => segment.speakerId)),
    }));
    expect(speakers.map((speaker) => speaker.ordinal)).toEqual([1, 2, 3, 4]);
    expect([...comparisonOnly].sort()).toEqual([...named].sort());
    expect(comparisonOnly.size).toBe(2);
  });

  it("refuses a comparison the Content has no room for, before any ASR call or queued Task", async () => {
    const { stack, fake } = setup();
    const contentId = await transcribed(stack, fake);
    const calls = fake.calls.length;
    // The primary names 2 speakers, so 4 places are needed; leave 3.
    stack.h.repository.withTransaction((scope) => {
      const free = SPEAKERS_PER_CONTENT_MAX - scope.speakers.count(LOCAL.userId, contentId) - 3;
      scope.speakers.insert(LOCAL.userId, contentId, Array.from({ length: free }, () => ({ id: stack.h.newId() })), 5);
    });
    const tasks = () => stack.h.repository.withTransaction((scope) => scope.tasks.listByContent(LOCAL.userId, contentId)).length;
    const before = tasks();
    const chosen = stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef);
    await expect(service(stack).retranscribe(LOCAL, contentId, undefined, chosen, undefined, true)).rejects.toMatchObject({
      appError: { code: "conflict.speaker_capacity", details: { room: 3, required: 4 } },
    });
    expect(tasks()).toBe(before);
    await stack.h.scheduler.whenIdle();
    expect(fake.calls).toHaveLength(calls);

    // One more place is enough; an ordinary re-transcription never needed any.
    stack.h.repository.withTransaction((scope) => scope.speakers.delete(LOCAL.userId, contentId, [scope.speakers.list(LOCAL.userId, contentId).at(-1)?.id as string]));
    const accepted = await service(stack).retranscribe(LOCAL, contentId, undefined, chosen, undefined, true);
    expect(accepted.status).toBe(202);
  });

  it("refuses at the stage, before anything is sent, when the bound model cannot identify speakers", async () => {
    const { stack, fake } = setup();
    const contentId = await transcribed(stack, fake);
    const calls = fake.calls.length;
    const { diarization: _offered, ...without } = fake.capabilities;
    fake.capabilities = without;
    // No model chosen at submission: nothing could be checked there, the stage checks.
    const accepted = await service(stack).retranscribe(LOCAL, contentId, undefined, undefined, { mode: "off" }, true);
    expect(JSON.parse(taskOf(stack.h, accepted.body.taskId).requestJson)).toMatchObject({ comparison: true, diarization: { mode: "required" } });
    const chosen = stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef) as AsrModelRef;
    await waitFor(() => stageStatuses(stack.h, accepted.body.taskId)["asr"] === "waiting_configuration");
    stack.h.tasks.retryStage(LOCAL, accepted.body.taskId, { stage: "asr", asrModelRef: chosen });
    await waitFor(() => stageStatuses(stack.h, accepted.body.taskId)["asr"] === "failed");
    expect(stageRunsOf(stack.h, accepted.body.taskId)[0]?.error?.code).toBe("asr_failed.diarization_unavailable");
    expect(fake.calls).toHaveLength(calls);
    expect(revisionsOf(stack, contentId)).toHaveLength(1);
  });
});
