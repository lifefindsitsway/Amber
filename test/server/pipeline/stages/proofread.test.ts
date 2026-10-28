import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef, PromptRef } from "../../../../src/server/domain/model-ref.ts";
import {
  BUILTIN_PROMPT_HISTORY,
  composeProofreadAudioPrompt,
  customPromptRef,
  PROOFREAD_AUDIO_PROMPT,
  PROOFREAD_TEXT_PROMPT,
  renderPrompt,
} from "../../../../src/server/domain/prompts.ts";
import { termsSection } from "../../../../src/server/domain/terminology.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { transact } from "../../../../src/server/pipeline/publish.ts";
import { ProofreadStageExecutor, stripInlineParagraphMarks } from "../../../../src/server/pipeline/stages/proofread.ts";
import { refreshProjection } from "../../../../src/server/pipeline/task-state.ts";
import type { LocalMediaIngest } from "../../../../src/server/ports/local-media-ingest.ts";
import type { LlmStreamOptions } from "../../../../src/server/ports/llm-provider.ts";
import {
  PROOFREAD_AUDIO_MAX_MB,
  PROOFREAD_CHUNK_SENTENCES,
  PROOFREAD_CONTEXT_SENTENCES,
  PROOFREAD_SPLIT_MAX_EXTRA_UNITS,
  PROOFREAD_SPLIT_MAX_UNITS_PER_ROOT,
  RETRY_MAX,
} from "../../../../src/shared/defaults.ts";
import { isUlid, type SegmentId } from "../../../../src/shared/ids.ts";
import { BYTES_PER_MB } from "../../../../src/shared/units.ts";
import { FAKE_USAGE, FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import {
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  stageRunsOf,
  stageStatuses,
  taskOf,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

const TARGET_HEADER = /【待校对（请逐行输出这些句，共 (\d+) 句）】\n([\s\S]*?)\n\n【只读上下文（后）】/;

function promptOf(request: LlmRequest): string {
  const part = request.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
}

/** The `[s<n>] text` target lines of a proofread request, in order. */
function targetsOf(request: LlmRequest): Array<{ alias: number; text: string }> {
  const match = TARGET_HEADER.exec(promptOf(request));
  if (match === null) {
    throw new Error("not a proofread request");
  }
  return (match[2] ?? "").split("\n").map((line) => {
    const [, alias, text] = /^\[s(\d+)\] (.*)$/.exec(line) as RegExpExecArray;
    return { alias: Number(alias), text: text as string };
  });
}

/** `<first>-<last>` aliases of the range a request proofreads. */
function rangeKeyOf(request: LlmRequest): string {
  const targets = targetsOf(request);
  return `${targets[0]?.alias}-${targets.at(-1)?.alias}`;
}

/** Index of the chunk a request proofreads, from its first target alias. */
function chunkOf(request: LlmRequest): number {
  return Math.floor(((targetsOf(request)[0]?.alias ?? 1) - 1) / PROOFREAD_CHUNK_SENTENCES);
}

type Answer = (targets: Array<{ alias: number; text: string }>, request: LlmRequest, opts: LlmStreamOptions) => string | Promise<string>;

/** Answers every proofread request: by default each target line with `校:` prepended. */
const corrected: Answer = (targets) => targets.map(({ alias, text }) => `[s${alias}] 校:${text}`).join("\n");

function responder(answer: Answer = corrected) {
  return (request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> =>
    (async function* () {
      const text = await answer(targetsOf(request), request, opts);
      yield* reply(text);
    })();
}

/** A provider answering every call with `answer` (stateful answers see each call in turn). */
function fakeProvider(answer: Answer = corrected, audioMimeTypes: readonly string[] = []): FakeLlmProvider {
  const fake = new FakeLlmProvider({ audioMimeTypes });
  fake.script(...Array.from({ length: 200 }, () => responder(answer)));
  return fake;
}

/** Writes bytes for every tool call; `clipBytes` is the size of each clip. */
class StubIngest implements LocalMediaIngest {
  clipBytes = 1024;
  /** Overrides `clipBytes` for some clip ranges. */
  clipBytesFor?: (range: { startMs: number; endMs: number }) => number | undefined;
  readonly clips: Array<{ range: { startMs: number; endMs: number }; mimeType: string }> = [];
  /** How long each clip takes, and the most clips ever cut at once. */
  clipDelayMs = 0;
  clipPeak = 0;
  private clipping = 0;

  async probe(): Promise<never> {
    throw new Error("not used");
  }

  async transcodeAudio(): Promise<never> {
    throw new Error("not used");
  }

  async extractAudio(_input: { path: string }, output: { path: string }) {
    writeFileSync(output.path, Buffer.alloc(2048, 1));
    return { sizeBytes: 2048, durationMs: 60_000 };
  }

  async clipAudio(_input: { path: string }, output: { path: string }, range: { startMs: number; endMs: number }, mimeType: string) {
    this.clipping += 1;
    this.clipPeak = Math.max(this.clipPeak, this.clipping);
    try {
      if (this.clipDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.clipDelayMs));
      }
      this.clips.push({ range, mimeType });
      const size = this.clipBytesFor?.(range) ?? this.clipBytes;
      writeFileSync(output.path, Buffer.alloc(size, 2));
      return { sizeBytes: size };
    } finally {
      this.clipping -= 1;
    }
  }
}

interface Setup {
  h: Harness;
  fake: FakeLlmProvider;
  ingest: StubIngest;
  files: LocalFileStore;
  modelRef: ModelRef;
}

function setup(fake: FakeLlmProvider, options: { file?: string } = {}): Setup {
  const h = createHarness({ llmProviders: [fake], executors: {}, ...(options.file === undefined ? {} : { file: options.file }) });
  open.push(h);
  const files = new LocalFileStore(h.dir);
  const ingest = new StubIngest();
  h.executors.proofread = new ProofreadStageExecutor({ repository: h.repository, files, ingest, newId: h.newId });
  return { h, fake, ingest, files, modelRef: options.file === undefined ? configureLlm(h) : modelOf(h) };
}

function modelOf(h: Harness): ModelRef {
  const row = h.db.prepare("SELECT profile_id, model_id FROM model_capability LIMIT 1").get() as { profile_id: string; model_id: string };
  return { providerProfileId: row.profile_id, modelId: row.model_id };
}

function setAudioInput(h: Harness, modelRef: ModelRef, audioInput: "supported" | "unsupported" | "unknown"): void {
  h.db
    .prepare("UPDATE model_capability SET flags_user_override_json = ? WHERE profile_id = ? AND model_id = ?")
    .run(JSON.stringify({ audioInput }), modelRef.providerProfileId, modelRef.modelId);
}

/** A Content whose primary is an `asr` original of `count` sentences. */
function seedContent(
  h: Harness,
  count: number,
  textOf: (ordinal: number) => string = (ordinal) => `第${ordinal + 1}句\n原文`,
): { contentId: string; revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const contentId = createLocalContent(h);
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = Array.from({ length: count }, (_, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId,
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text: textOf(ordinal),
    ...(ordinal % 2 === 0 ? { speakerId: "a" } : {}),
    sourceSegmentIds: [],
  }));
  const revision: TranscriptRevision = {
    id: revisionId,
    contentId,
    kind: "asr",
    language: "zh-CN",
    timingFidelity: "exact_words",
    generation: { kind: "asr", asrProfileId: "asr-profile", modelId: "scribe" },
    segmentCount: count,
    createdAt: 1,
  };
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 2);
  });
  return { contentId, revision, segments };
}

/** Registers an available original so the Task can extract audio from it. */
function seedOriginal(h: Harness, contentId: string): void {
  h.repository.withTransaction((scope) =>
    scope.mediaAssets.insert({
      id: h.newId(),
      userId: LOCAL.userId,
      contentId,
      kind: "managed_upload",
      storageRef: `assets/${LOCAL.userId}/${contentId}/original`,
      mimeType: "video/mp4",
      sizeBytes: 10,
      fingerprint: `sha256:${contentId}`,
      availability: "available",
      retentionPolicy: "keep",
      createdAt: 1,
    }),
  );
}

function reproofread(s: Setup, contentId: string, baseRevisionId: string): string {
  return createTaskOfKind(s.h, "reproofread", { modelRef: s.modelRef, baseRevisionId }, { contentId });
}

async function settled(h: Harness, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId)["proofread"] ?? "") || taskOf(h, taskId).statusProjection === "waiting");
  return stageStatuses(h, taskId)["proofread"] as string;
}

function resultOf(
  h: Harness,
  taskId: string,
): {
  revisionId: string;
  baseRevisionId: string;
  chunks: Array<{ i: number; promptRef: { id: string }; audio: boolean; split: boolean; acceptedLeafCount: number; audioMode: string }>;
  ranges: Array<{ firstAlias: number; lastAlias: number; depth: number; kind: string; promptRef: { id: string }; audio: boolean; invocationId: string }>;
  paragraphMarks: { moved: number; droppedAtEnd: number };
  reasons: string[];
} {
  const run = stageRunsOf(h, taskId).filter((candidate) => candidate.stage === "proofread").at(-1);
  return JSON.parse(run?.resultJson ?? "{}");
}

function payloadOf(h: Harness, workUnitId: string): Record<string, unknown> {
  const row = h.db.prepare("SELECT payload_json FROM work_unit_result WHERE work_unit_id = ?").get(workUnitId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

function revision(h: Harness, revisionId: string): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  return h.repository.withTransaction((scope) => ({
    revision: scope.transcripts.getRevision(LOCAL.userId, revisionId) as TranscriptRevision,
    segments: scope.transcripts.listSegments(LOCAL.userId, revisionId),
  }));
}

function chunkCalls(fake: FakeLlmProvider): number[] {
  return fake.calls.map((call) => chunkOf(call.request));
}

const TWO_CHUNKS = PROOFREAD_CHUNK_SENTENCES + 20;
const THREE_CHUNKS = 2 * PROOFREAD_CHUNK_SENTENCES + 5;

describe("proofread stage", () => {
  it("keeps the sentence count, gives every sentence a new ULID pointing at exactly its parent, takes primary and attributes usage", async () => {
    const s = setup(fakeProvider());
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const result = resultOf(s.h, taskId);
    const { revision: out, segments } = revision(s.h, result.revisionId);
    expect(out).toMatchObject({ kind: "corrected", parentRevisionId: base.revision.id, language: "zh-CN", timingFidelity: "inherited_segment", segmentCount: TWO_CHUNKS });
    expect(out.generation).toMatchObject({
      kind: "llm",
      modelRef: { ...s.modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: s.modelRef.modelId },
      promptRef: { id: "proofread.text", version: 5 },
    });
    expect(segments).toHaveLength(base.segments.length);
    const parentIds = new Set(base.segments.map((segment) => segment.id));
    segments.forEach((segment, position) => {
      const parent = base.segments[position] as TranscriptSegment;
      expect(isUlid(segment.id)).toBe(true);
      expect(parentIds.has(segment.id)).toBe(false);
      expect(segment.sourceSegmentIds).toEqual([parent.id]);
      expect(segment).toMatchObject({ ordinal: parent.ordinal, startMs: parent.startMs, endMs: parent.endMs });
      expect(segment.speakerId).toBe(parent.speakerId);
      expect(segment.words).toBeUndefined();
      // The wire form is one line per sentence; the stored base text keeps its newline.
      expect(segment.text).toBe(`校:${parent.text.replace("\n", " ")}`);
    });
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length);
    expect(s.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, base.contentId))?.primaryTranscriptRevisionId).toBe(out.id);

    expect(result).toMatchObject({ baseRevisionId: base.revision.id, reasons: [] });
    // A chunk never split reads as before, with where it lies and that it was proofread whole.
    const whole = { split: false, acceptedLeafCount: 1, promptRef: { id: "proofread.text", version: 5 }, audio: false, audioMode: "text" };
    expect(result.chunks).toEqual([
      { i: 0, firstAlias: 1, lastAlias: PROOFREAD_CHUNK_SENTENCES, ...whole },
      { i: 1, firstAlias: PROOFREAD_CHUNK_SENTENCES + 1, lastAlias: TWO_CHUNKS, ...whole },
    ]);
    expect(result.ranges.map((range) => [range.firstAlias, range.lastAlias, range.depth, range.kind])).toEqual([
      [1, PROOFREAD_CHUNK_SENTENCES, 0, "accepted"],
      [PROOFREAD_CHUNK_SENTENCES + 1, TWO_CHUNKS, 0, "accepted"],
    ]);
    const usage = s.h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId, { taskId }));
    expect(usage).toHaveLength(2);
    expect(usage.every((row) => row.artifactRevisionId === out.id && row.feature === "proofread" && row.workUnitId !== undefined)).toBe(true);

    // Aliases are global and context lines carry them too.
    const second = s.fake.calls.find((call) => chunkOf(call.request) === 1)?.request as LlmRequest;
    expect(targetsOf(second)[0]?.alias).toBe(PROOFREAD_CHUNK_SENTENCES + 1);
    expect(promptOf(second)).toContain(`【只读上下文（前）】\n[s${PROOFREAD_CHUNK_SENTENCES - PROOFREAD_CONTEXT_SENTENCES + 1}] `);
    expect(second.system).toBe("");
    expect(workUnitsOf(s.h, taskId).map((unit) => [unit.key, unit.billing])).toEqual([
      [`proofread:range:1-${PROOFREAD_CHUNK_SENTENCES}`, "llm"],
      [`proofread:range:${PROOFREAD_CHUNK_SENTENCES + 1}-${TWO_CHUNKS}`, "llm"],
    ]);
  });

  it("a chunk answered without one of its ids is split, not retried whole: both halves are asked once, the other chunk is not re-run", async () => {
    const dropped = PROOFREAD_CHUNK_SENTENCES + 5;
    let broken = false;
    const fake = fakeProvider((targets) => {
      const lines = targets.map(({ alias, text }) => `[s${alias}] ${text}`);
      if (!broken && targets.some(({ alias }) => alias === dropped)) {
        broken = true;
        // Two fragments merged into one line: one alias goes missing, nothing else is wrong.
        return lines.filter((line) => !line.startsWith(`[s${dropped}]`)).join("\n");
      }
      return lines.join("\n");
    });
    const s = setup(fake);
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const left = `${PROOFREAD_CHUNK_SENTENCES + 1}-${PROOFREAD_CHUNK_SENTENCES + 10}`;
    const right = `${PROOFREAD_CHUNK_SENTENCES + 11}-${TWO_CHUNKS}`;
    expect(fake.calls.map((call) => rangeKeyOf(call.request)).sort()).toEqual(
      [`1-${PROOFREAD_CHUNK_SENTENCES}`, `${PROOFREAD_CHUNK_SENTENCES + 1}-${TWO_CHUNKS}`, left, right].sort(),
    );
    const units = workUnitsOf(s.h, taskId);
    expect(units.map((unit) => [unit.key, unit.status, unit.retryCount])).toEqual([
      [`proofread:range:1-${PROOFREAD_CHUNK_SENTENCES}`, "succeeded", 0],
      [`proofread:range:${PROOFREAD_CHUNK_SENTENCES + 1}-${TWO_CHUNKS}`, "succeeded", 0],
      [`proofread:range:${left}`, "succeeded", 0],
      [`proofread:range:${right}`, "succeeded", 0],
    ]);
    const parent = payloadOf(s.h, units[1]?.id as string);
    expect(parent).toMatchObject({ kind: "split", diagnostic: { expectedCount: 20, validUniqueAliasCount: 19, missingAliases: [dropped], invalidLineCount: 0, stopReason: "stop", truncatedTail: false } });
    // The decision keeps counts and aliases only, never text.
    expect(JSON.stringify(parent)).not.toMatch(/原文|第\d+句/);

    const result = resultOf(s.h, taskId);
    const { revision: out, segments } = revision(s.h, result.revisionId);
    expect(segments.map((segment) => segment.text)).toEqual(base.segments.map((segment) => segment.text.replace("\n", " ")));
    expect(result.reasons).toEqual(["proofread_split:1"]);
    expect(result.chunks[1]).toMatchObject({ i: 1, split: true, acceptedLeafCount: 2, audio: false, audioMode: "text", promptRef: { id: "proofread.text" } });
    expect(result.ranges.map((range) => [range.firstAlias, range.lastAlias, range.depth, range.kind])).toEqual([
      [1, PROOFREAD_CHUNK_SENTENCES, 0, "accepted"],
      [PROOFREAD_CHUNK_SENTENCES + 1, TWO_CHUNKS, 0, "split"],
      [PROOFREAD_CHUNK_SENTENCES + 1, PROOFREAD_CHUNK_SENTENCES + 10, 1, "accepted"],
      [PROOFREAD_CHUNK_SENTENCES + 11, TWO_CHUNKS, 1, "accepted"],
    ]);
    // The call that decided the split is recorded but did not produce the revision.
    const usage = s.h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId, { taskId }));
    expect(usage).toHaveLength(4);
    expect(usage.filter((row) => row.artifactRevisionId === out.id).map((row) => row.workUnitId).sort()).toEqual(
      [units[0]?.id, units[2]?.id, units[3]?.id].sort(),
    );
    expect(usage.find((row) => row.workUnitId === units[1]?.id)?.artifactRevisionId).toBeUndefined();
  });

  it("fails without publishing when its base transcript is deleted while the model answers", async () => {
    let base: ReturnType<typeof seedContent> | undefined;
    let gone = false;
    const s = setup(
      fakeProvider((targets, request, opts) => {
        if (!gone) {
          gone = true;
          const { contentId, revision: old, segments } = base as ReturnType<typeof seedContent>;
          // Another revision takes over as primary and the base goes, as a delete would leave it.
          const replacementId = s.h.newId();
          s.h.repository.withTransaction((scope) => {
            scope.transcripts.insertRevision(
              LOCAL.userId,
              { ...old, id: replacementId, createdAt: 3 },
              segments.map((segment) => ({ ...segment, id: s.h.newId() as SegmentId, revisionId: replacementId })),
            );
            scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, replacementId, 3);
            scope.transcripts.deleteRevision(LOCAL.userId, old.id);
          });
        }
        return corrected(targets, request, opts);
      }),
    );
    base = seedContent(s.h, 5);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(stageRunsOf(s.h, taskId).find((run) => run.stage === "proofread")?.error?.code).toBe("not_found");
    expect(s.h.db.prepare("SELECT count(*) AS n FROM transcript_revision WHERE kind = 'corrected'").get()).toEqual({ n: 0 });
  });

  it("a half that fails publishes nothing; the next attempt reuses the split and the half that was done", async () => {
    const dropped = PROOFREAD_CHUNK_SENTENCES + 5;
    let rejectOnce = true;
    const fake = fakeProvider((targets) => {
      const lines = targets.map(({ alias, text }) => `[s${alias}] ${text}`);
      if (targets.length === 20) {
        return lines.filter((line) => !line.startsWith(`[s${dropped}]`)).join("\n");
      }
      if (rejectOnce && targets[0]?.alias === PROOFREAD_CHUNK_SENTENCES + 11) {
        rejectOnce = false;
        throw amberError("llm_failed", "rejected", { code: "llm_failed.invalid_request" });
      }
      return lines.join("\n");
    });
    const s = setup(fake);
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(fake.calls).toHaveLength(4);
    expect(s.h.db.prepare("SELECT count(*) AS n FROM transcript_revision WHERE kind = 'corrected'").get()).toEqual({ n: 0 });

    s.h.tasks.retryStage(LOCAL, taskId, { stage: "proofread" });
    await waitFor(() => taskOf(s.h, taskId).statusProjection === "succeeded");
    // Only the failed half is asked again; the root, the split chunk and the other half are reused.
    expect(fake.calls.slice(4).map((call) => rangeKeyOf(call.request))).toEqual([`${PROOFREAD_CHUNK_SENTENCES + 11}-${TWO_CHUNKS}`]);
    const attempts = stageRunsOf(s.h, taskId).filter((run) => run.stage === "proofread");
    const second = workUnitsOf(s.h, taskId).filter((unit) => unit.stageRunId === attempts[1]?.id);
    expect(second.map((unit) => [unit.key, unit.status])).toEqual([
      [`proofread:range:1-${PROOFREAD_CHUNK_SENTENCES}`, "succeeded"],
      [`proofread:range:${PROOFREAD_CHUNK_SENTENCES + 1}-${TWO_CHUNKS}`, "succeeded"],
      [`proofread:range:${PROOFREAD_CHUNK_SENTENCES + 1}-${PROOFREAD_CHUNK_SENTENCES + 10}`, "succeeded"],
      [`proofread:range:${PROOFREAD_CHUNK_SENTENCES + 11}-${TWO_CHUNKS}`, "succeeded"],
    ]);
    expect(revision(s.h, resultOf(s.h, taskId).revisionId).segments).toHaveLength(TWO_CHUNKS);
  });

  it("after a crash mid-way only the missing chunk is re-sent, once the user confirms; finished chunks come from WorkUnitResult", async () => {
    const fake = fakeProvider(async (targets, _request, opts) => {
      if ((targets[0]?.alias ?? 0) === PROOFREAD_CHUNK_SENTENCES + 1) {
        // The middle chunk is in flight when the process dies.
        await new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
      }
      return corrected(targets, _request, opts);
    });
    const first = setup(fake);
    const base = seedContent(first.h, THREE_CHUNKS);
    const taskId = reproofread(first, base.contentId, base.revision.id);
    first.h.scheduler.start();
    await waitFor(() => workUnitsOf(first.h, taskId).filter((unit) => unit.status === "succeeded").length === 2);
    await first.h.scheduler.stop();
    const file = first.h.file;
    await first.h.close();
    open.splice(open.indexOf(first.h), 1);

    const fake2 = fakeProvider();
    const second = setup(fake2, { file });
    second.h.scheduler.start();
    await settled(second.h, taskId);
    const parked = workUnitsOf(second.h, taskId).find((unit) => unit.status === "waiting_user_action");
    expect(parked?.key).toBe(`proofread:range:${PROOFREAD_CHUNK_SENTENCES + 1}-${2 * PROOFREAD_CHUNK_SENTENCES}`);
    expect(parked?.error?.class).toBe("llm_outcome_unknown");
    expect(fake2.calls).toHaveLength(0);

    second.h.tasks.confirmResend(LOCAL, taskId, parked?.id as string);
    await waitFor(() => taskOf(second.h, taskId).statusProjection === "succeeded");

    expect(chunkCalls(fake2)).toEqual([1]);
    const units = workUnitsOf(second.h, taskId);
    expect(units).toHaveLength(3);
    expect(units.find((unit) => unit.key === `proofread:range:1-${PROOFREAD_CHUNK_SENTENCES}`)?.attempt).toBe(1);
    expect(units.find((unit) => unit.key === `proofread:range:${2 * PROOFREAD_CHUNK_SENTENCES + 1}-${THREE_CHUNKS}`)?.attempt).toBe(1);
    const { segments } = revision(second.h, resultOf(second.h, taskId).revisionId);
    expect(segments).toHaveLength(THREE_CHUNKS);
    expect(segments.every((segment) => segment.text.startsWith("校:"))).toBe(true);
  });

  it("re-running a failed stage reuses the earlier attempt's finished chunks without calling out again", async () => {
    let failOnce = true;
    const fake = fakeProvider((targets, request, opts) => {
      if (failOnce && (targets[0]?.alias ?? 0) > PROOFREAD_CHUNK_SENTENCES) {
        failOnce = false;
        throw amberError("llm_failed", "rejected", { code: "llm_failed.invalid_request" });
      }
      return corrected(targets, request, opts);
    });
    const s = setup(fake);
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(chunkCalls(fake).sort()).toEqual([0, 1]);

    s.h.tasks.retryStage(LOCAL, taskId, { stage: "proofread" });
    await waitFor(() => taskOf(s.h, taskId).statusProjection === "succeeded");
    expect(chunkCalls(fake).sort()).toEqual([0, 1, 1]);
    const attempts = stageRunsOf(s.h, taskId).filter((run) => run.stage === "proofread");
    expect(attempts.map((run) => run.attempt)).toEqual([1, 2]);
    const reused = workUnitsOf(s.h, taskId).filter((unit) => unit.stageRunId === attempts[1]?.id);
    expect(reused.map((unit) => [unit.key, unit.status])).toEqual([
      [`proofread:range:1-${PROOFREAD_CHUNK_SENTENCES}`, "succeeded"],
      [`proofread:range:${PROOFREAD_CHUNK_SENTENCES + 1}-${TWO_CHUNKS}`, "succeeded"],
    ]);
    expect(revision(s.h, resultOf(s.h, taskId).revisionId).segments).toHaveLength(TWO_CHUNKS);
  });

  it("keeps the original of an empty answer line, and sends the effective terminology, which is part of the input digest", async () => {
    const fake = fakeProvider((targets) => targets.map(({ alias, text }) => (alias === 2 ? "[s2]" : `[s${alias}] ${text}!`)).join("\n\n"));
    const s = setup(fake);
    const base = seedContent(s.h, 3);
    const first = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, first)).toBe("succeeded");
    const result = resultOf(s.h, first);
    expect(result.reasons).toEqual(["proofread_empty_lines"]);
    expect(revision(s.h, result.revisionId).segments.map((segment) => segment.text)).toEqual(["第1句 原文!", "第2句\n原文", "第3句 原文!"]);
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).not.toContain("【术语表】");

    s.h.repository.withTransaction((scope) =>
      scope.terminology.put({
        id: s.h.newId(),
        userId: LOCAL.userId,
        scope: { kind: "global" },
        entries: [
          { id: s.h.newId(), ordinal: 0, term: "RAG", normalizedKey: "rag", translation: "检索增强生成" },
          { id: s.h.newId(), ordinal: 1, term: "Prompt Engineering", normalizedKey: "prompt engineering", rule: "keep_original" },
        ],
      }),
    );
    const second = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.kick();
    expect(await settled(s.h, second)).toBe("succeeded");
    expect(promptOf(s.fake.calls[1]?.request as LlmRequest)).toContain("【术语表】\nRAG = 检索增强生成\nPrompt Engineering（保持原文）");
    const digest = (taskId: string) => workUnitsOf(s.h, taskId)[0]?.inputDigest;
    expect(digest(second)).not.toBe(digest(first));
    const generation = revision(s.h, resultOf(s.h, second).revisionId).revision.generation;
    expect(generation.kind === "llm" && generation.promptSnapshot).toContain("RAG = 检索增强生成");
  });
});

describe("safety refusals", () => {
  it("fails the stage with llm_failed.refused after one call of the refused chunk, keeping the other chunk's result", async () => {
    const fake = new FakeLlmProvider();
    const answer = responder();
    fake.script(
      ...Array.from({ length: 10 }, () => (request: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> =>
        chunkOf(request) === 1
          ? (async function* (): AsyncGenerator<LlmStreamEvent> {
              yield { type: "done", stopReason: "refused", raw: "refusal: cyber" };
            })()
          : answer(request, opts),
      ),
    );
    const s = setup(fake);
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(chunkCalls(fake).sort()).toEqual([0, 1]);
    const run = stageRunsOf(s.h, taskId).find((candidate) => candidate.stage === "proofread");
    expect(run?.error).toMatchObject({ code: "llm_failed.refused", retryDisposition: "never", upstreamMessage: "refusal: cyber" });
    const units = workUnitsOf(s.h, taskId);
    expect(units.find((unit) => unit.key === `proofread:range:1-${PROOFREAD_CHUNK_SENTENCES}`)?.status).toBe("succeeded");
    expect(units.find((unit) => unit.key === `proofread:range:${PROOFREAD_CHUNK_SENTENCES + 1}-${TWO_CHUNKS}`)?.error?.code).toBe("llm_failed.refused");
  });
});

describe("proofread prompt version", () => {
  it("v5 and the split strategy enter every range's input digest, so a range proofread under v4 is never reused", async () => {
    const s = setup(fakeProvider());
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    const [unit] = workUnitsOf(s.h, taskId);
    const digestWith = (promptRef: PromptRef): string =>
      `sha256:${createHash("sha256")
        .update(
          canonicalJson({
            baseRevisionId: base.revision.id,
            firstAlias: 1,
            lastAlias: 3,
            splitStrategy: 1,
            targetSegmentIds: base.segments.map((segment) => segment.id),
            targetTexts: base.segments.map((segment) => segment.text),
            contextIds: [],
            termsSection: termsSection([]),
            promptRef,
            modelRef: s.modelRef,
          }),
        )
        .digest("hex")}`;
    expect(PROOFREAD_TEXT_PROMPT.ref).toEqual({ id: "proofread.text", version: 5 });
    expect(unit?.key).toBe("proofread:range:1-3");
    expect(unit?.inputDigest).toBe(digestWith(PROOFREAD_TEXT_PROMPT.ref));
    expect(unit?.inputDigest).not.toBe(digestWith({ id: "proofread.text", version: 4 }));
  });
});

describe("audio assistance follows the effective audioInput capability", () => {
  async function run(audioInput: "supported" | "unsupported" | "unknown", clipBytes?: number) {
    const fake = fakeProvider(corrected, ["audio/wav"]);
    const s = setup(fake);
    setAudioInput(s.h, s.modelRef, audioInput);
    if (clipBytes !== undefined) {
      s.ingest.clipBytes = clipBytes;
    }
    const base = seedContent(s.h, TWO_CHUNKS);
    seedOriginal(s.h, base.contentId);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    const audioParts = fake.calls.map((call) => call.request.messages[0]?.content.filter((part) => part.type === "audio") ?? []);
    return { s, taskId, base, audioParts, result: resultOf(s.h, taskId) };
  }

  it("supported: every chunk carries its own clip, context sentences included, and the audio prompt", async () => {
    const { s, taskId, base, audioParts, result } = await run("supported");
    expect(audioParts.map((parts) => parts.length)).toEqual([1, 1]);
    expect(audioParts.flat().every((part) => part.type === "audio" && part.mimeType === "audio/wav")).toBe(true);
    expect(s.ingest.clips.map((clip) => clip.range).sort((a, b) => a.startMs - b.startMs)).toEqual([
      { startMs: 0, endMs: base.segments[PROOFREAD_CHUNK_SENTENCES + PROOFREAD_CONTEXT_SENTENCES - 1]?.endMs },
      { startMs: base.segments[PROOFREAD_CHUNK_SENTENCES - PROOFREAD_CONTEXT_SENTENCES]?.startMs, endMs: base.segments.at(-1)?.endMs },
    ]);
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toMatch(/^我会同时提供这段字幕对应的音频和识别文本。/);
    expect(result.chunks.map((chunk) => [chunk.promptRef.id, chunk.audio])).toEqual([
      ["proofread.audio", true],
      ["proofread.audio", true],
    ]);
    expect(result.reasons).toEqual([]);
    expect(revision(s.h, result.revisionId).revision.generation).toMatchObject({ promptRef: { id: "proofread.audio" } });
    // Clips are scratch: nothing of them stays once the chunks are done.
    expect((await s.files.list(`tmp/tasks/${taskId}`)).filter((ref) => ref.includes("proofread-"))).toEqual([]);
  });

  it("cuts each chunk's clip only once its call was admitted, in a heavy-job slot: never more clips at once than the task count", async () => {
    const fake = fakeProvider(corrected, ["audio/wav"]);
    const s = setup(fake);
    setAudioInput(s.h, s.modelRef, "supported");
    s.ingest.clipDelayMs = 15;
    // Six chunks, all queued at once; the lane admits more than two as answers come back.
    const base = seedContent(s.h, PROOFREAD_CHUNK_SENTENCES * 6);
    seedOriginal(s.h, base.contentId);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(s.ingest.clips).toHaveLength(6);
    // CONCURRENCY_PIPELINE (2) is the governor's capacity.
    expect(s.ingest.clipPeak).toBeLessThanOrEqual(s.h.settings.effective().concurrencyPipeline);
    expect(s.ingest.clipPeak).toBeGreaterThan(1);
    expect(resultOf(s.h, taskId).chunks.every((chunk) => chunk.audio)).toBe(true);
  });

  it.each(["unsupported", "unknown"] as const)("%s: no request carries audio and nothing is extracted", async (audioInput) => {
    const { s, audioParts, result } = await run(audioInput);
    expect(audioParts.map((parts) => parts.length)).toEqual([0, 0]);
    expect(s.ingest.clips).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.chunks.every((chunk) => chunk.promptRef.id === "proofread.text" && !chunk.audio)).toBe(true);
  });

  it("a clip over PROOFREAD_AUDIO_MAX_MB downgrades its chunk to text and records the reason", async () => {
    const { s, audioParts, result } = await run("supported", PROOFREAD_AUDIO_MAX_MB * BYTES_PER_MB + 1);
    expect(audioParts.map((parts) => parts.length)).toEqual([0, 0]);
    expect(result.reasons).toEqual(["audio_downgraded:0", "audio_downgraded:1"]);
    expect(revision(s.h, result.revisionId).revision.generation).toMatchObject({ promptRef: { id: "proofread.text" } });
  });

  it("a protocol that encodes no audio downgrades every chunk even when the model is declared able to take it", async () => {
    const fake = fakeProvider(corrected, []);
    const s = setup(fake);
    setAudioInput(s.h, s.modelRef, "supported");
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(resultOf(s.h, taskId).reasons).toEqual(["audio_downgraded:0"]);
    expect(fake.calls[0]?.request.messages[0]?.content.some((part) => part.type === "audio")).toBe(false);
  });

  it("without any media to take audio from every chunk is downgraded", async () => {
    const fake = fakeProvider(corrected, ["audio/wav"]);
    const s = setup(fake);
    setAudioInput(s.h, s.modelRef, "supported");
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(resultOf(s.h, taskId).reasons).toEqual(["audio_downgraded:0"]);
    expect(fake.calls[0]?.request.messages[0]?.content.some((part) => part.type === "audio")).toBe(false);
  });
});

describe("stripInlineParagraphMarks", () => {
  it.each([
    ["拿下来的。¶ 势单害权，", "拿下来的。势单害权，"],
    ["end.¶ Next", "end. Next"],
    ["A ¶ B", "A B"],
    ["A¶ B", "A B"],
    ["A¶B", "AB"],
    ["中郎¶将", "中郎将"],
    ["老师 ¶ 和牛逼的网课", "老师和牛逼的网课"],
    ["用 ¶ React", "用 React"],
    ["A¶", "A"],
    ["¶¶", ""],
    ["A¶¶B", "AB"],
    ["A ¶¶ B", "A B"],
  ])("%s → %s", (input, output) => {
    expect(stripInlineParagraphMarks(input)).toBe(output);
  });
});

describe("paragraph marks (the `proofread.text` prompt, v5)", () => {
  /** Marks every fourth sentence but the first, one without spaces, one with an empty text; the rest unmarked. */
  const marking: Answer = (targets) =>
    targets
      .map(({ alias, text }) => {
        if (alias === 3) return `[s3]¶校:${text}`;
        if (alias === 6) return "[s6] ¶";
        return alias % 4 === 1 && alias !== 1 ? `[s${alias}] ¶ 校:${text}` : `[s${alias}] 校:${text}`;
      })
      .join("\n");

  it("stores the model's paragraph starts, forces the revision's first sentence open and leaves a chunk's first sentence to the model", async () => {
    const s = setup(fakeProvider(marking));
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    const result = resultOf(s.h, taskId);
    const { segments } = revision(s.h, result.revisionId);
    expect(segments.every((segment) => typeof segment.paragraphStart === "boolean")).toBe(true);
    expect(segments[0]?.paragraphStart).toBe(true);
    segments.slice(1).forEach((segment, index) => {
      const alias = index + 2;
      expect(segment.paragraphStart).toBe(alias === 3 || alias === 6 || alias % 4 === 1);
    });
    // The second chunk's first sentence (alias 151) is unmarked, so it does not open a paragraph.
    expect(segments[PROOFREAD_CHUNK_SENTENCES]?.paragraphStart).toBe(false);
    // An empty marked line keeps its original text and still opens a paragraph.
    expect(segments[5]).toMatchObject({ text: "第6句\n原文", paragraphStart: true });
    expect(result.reasons).toEqual(["proofread_empty_lines"]);
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toContain("\n- 按内容划分自然段：");
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toContain("¶ 只能紧跟句标记，表示这一整句是新段落的第一句");
  });

  it("rejects a line that is only a mark as output_mismatch.proofread_lines, with a text-free diagnostic, after RETRY_MAX retries", async () => {
    const fake = fakeProvider((targets) => targets.flatMap(({ alias, text }) => (alias === 2 ? ["¶", `[s2] 校:${text}`] : [`[s${alias}] 校:${text}`])).join("\n"));
    const s = setup(fake);
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(fake.calls).toHaveLength(1 + RETRY_MAX);
    const [unit] = workUnitsOf(s.h, taskId);
    expect(unit?.status).toBe("failed");
    expect(unit?.error).toMatchObject({
      class: "output_mismatch",
      code: "output_mismatch.proofread_lines",
      retryDisposition: "policy",
      details: {
        expectedCount: 3,
        nonBlankLineCount: 4,
        validUniqueAliasCount: 3,
        missingAliases: [],
        duplicateAliases: [],
        outOfRangeAliases: [],
        invalidLineCount: 1,
        stopReason: "stop",
        truncatedTail: false,
      },
    });
  });

  it.each([
    ["no usable line at all", () => ["无法校对这段内容。"], { validUniqueAliasCount: 0, missingAliases: ["s1", "s2", "s3"], invalidLineCount: 1, nonBlankLineCount: 1 }],
    ["a repeated alias", (lines: string[]) => [...lines, "[s3] 又一行"], { validUniqueAliasCount: 3, duplicateAliases: ["s3"], nonBlankLineCount: 4 }],
    ["an alias outside the chunk", (lines: string[]) => [...lines, "[s9] 多一行"], { validUniqueAliasCount: 3, outOfRangeAliases: ["s9"], nonBlankLineCount: 4 }],
    ["a note around the lines", (lines: string[]) => ["以下是校对结果：", "```", ...lines, "```"], { validUniqueAliasCount: 3, invalidLineCount: 3, nonBlankLineCount: 6 }],
  ])("rejects %s as a whole without splitting, naming it in the details", async (_name, mangle, expected) => {
    const fake = fakeProvider((targets) => mangle(targets.map(({ alias, text }) => `[s${alias}] 校:${text}`)).join("\n"));
    const s = setup(fake);
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(fake.calls).toHaveLength(1 + RETRY_MAX);
    expect(workUnitsOf(s.h, taskId)).toHaveLength(1);
    const details = workUnitsOf(s.h, taskId)[0]?.error?.details;
    expect(details).toMatchObject({ expectedCount: 3, ...expected });
    // Counts and aliases only: no sentence text travels in the diagnostic.
    expect(JSON.stringify(details)).not.toMatch(/校|原文|一行|结果/);
    expect(details?.["truncatedTail"]).toBe(false);
  });

  it("takes a mark inside a sentence out and opens the paragraph at the next sentence, across chunks and not past the end", async () => {
    const last = TWO_CHUNKS;
    const fake = fakeProvider((targets) =>
      targets
        .map(({ alias }) => {
          if (alias === 4) return "[s4] 拿下来的。¶ 势单害权，";
          if (alias === 7) return "[s7] 中郎¶将";
          if (alias === PROOFREAD_CHUNK_SENTENCES) return `[s${alias}] end.¶ Next`;
          if (alias === last) return `[s${alias}] 结尾¶`;
          return `[s${alias}] 句${alias}`;
        })
        .join("\n"),
    );
    const s = setup(fake);
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(fake.calls).toHaveLength(2);
    const result = resultOf(s.h, taskId);
    const { segments } = revision(s.h, result.revisionId);
    expect(segments[3]).toMatchObject({ text: "拿下来的。势单害权，", paragraphStart: false });
    expect(segments[4]?.paragraphStart).toBe(true);
    expect(segments[6]).toMatchObject({ text: "中郎将", paragraphStart: false });
    expect(segments[7]?.paragraphStart).toBe(true);
    // The mark on a chunk's last sentence opens the next chunk's first one.
    expect(segments[PROOFREAD_CHUNK_SENTENCES - 1]?.text).toBe("end. Next");
    expect(segments[PROOFREAD_CHUNK_SENTENCES]?.paragraphStart).toBe(true);
    expect(segments[last - 1]?.text).toBe("结尾");
    expect(segments).toHaveLength(TWO_CHUNKS);
    expect(segments.filter((segment) => segment.paragraphStart).length).toBe(4);
    expect(result.paragraphMarks).toEqual({ moved: 3, droppedAtEnd: 1 });
    expect(result.reasons).toEqual(["proofread_paragraph_mark_moved", "proofread_paragraph_mark_dropped_at_end"]);
    const stored = s.h.db.prepare("SELECT payload_json FROM work_unit_result").all() as Array<{ payload_json: string }>;
    expect(stored.map((row) => JSON.parse(row.payload_json).paragraphBreakAfterAliases)).toEqual(
      expect.arrayContaining([
        [4, 7, PROOFREAD_CHUNK_SENTENCES],
        [last],
      ]),
    );
  });

  it("counts several marks in one sentence once, keeps a leading mark, and keeps the original when only marks remain", async () => {
    const fake = fakeProvider((targets) =>
      targets
        .map(({ alias, text }) => {
          if (alias === 1) return "[s1] ¶ A¶B¶C";
          if (alias === 2) return "[s2] ¶¶";
          return `[s${alias}] ${text}`;
        })
        .reverse()
        .join("\n"),
    );
    const s = setup(fake);
    const base = seedContent(s.h, 4);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    const result = resultOf(s.h, taskId);
    const { segments } = revision(s.h, result.revisionId);
    expect(segments.map((segment) => [segment.text, segment.paragraphStart])).toEqual([
      ["ABC", true],
      ["第2句\n原文", true],
      ["第3句 原文", true],
      ["第4句 原文", false],
    ]);
    expect(result.paragraphMarks).toEqual({ moved: 2, droppedAtEnd: 0 });
    expect(result.reasons).toEqual(["proofread_empty_lines", "proofread_paragraph_mark_moved"]);
    // Answered in reverse order, the stored aliases are still ascending.
    const stored = s.h.db.prepare("SELECT payload_json FROM work_unit_result").get() as { payload_json: string };
    expect(JSON.parse(stored.payload_json).paragraphBreakAfterAliases).toEqual([1, 2]);
  });

  it("rejects a stored range whose mark aliases are out of order, or that does not say whether it was accepted or split", async () => {
    const fake = fakeProvider((targets) => targets.map(({ alias, text }) => (alias === 1 ? "[s1] A¶B" : `[s${alias}] ${text}`)).join("\n"));
    const s = setup(fake);
    const base = seedContent(s.h, 3);
    const first = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, first)).toBe("succeeded");

    const rewrite = (change: (payload: Record<string, unknown>) => void): void => {
      for (const row of s.h.db.prepare("SELECT work_unit_id, payload_json FROM work_unit_result").all() as Array<{ work_unit_id: string; payload_json: string }>) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        change(payload);
        // Rewritten with a matching digest, as an older build would have stored it.
        const payloadJson = JSON.stringify(payload);
        const digest = `sha256:${createHash("sha256").update(payloadJson).digest("hex")}`;
        s.h.db.prepare("UPDATE work_unit_result SET payload_json = ?, output_digest = ? WHERE work_unit_id = ?").run(payloadJson, digest, row.work_unit_id);
        s.h.db.prepare("UPDATE work_unit SET output_digest = ? WHERE id = ?").run(digest, row.work_unit_id);
      }
    };
    const proofreadAgain = async (): Promise<string> => {
      s.h.db.prepare("UPDATE stage_run SET status = 'failed' WHERE stage = 'proofread'").run();
      s.h.db.prepare("UPDATE task SET status_projection = 'failed', finished_at = 1").run();
      s.h.tasks.retryStage(LOCAL, first, { stage: "proofread" });
      s.h.scheduler.kick();
      await waitFor(() => stageRunsOf(s.h, first).filter((run) => run.stage === "proofread").every((run) => run.status !== "running" && run.status !== "pending"));
      return stageRunsOf(s.h, first).filter((run) => run.stage === "proofread").at(-1)?.status as string;
    };

    rewrite((payload) => (payload["paragraphBreakAfterAliases"] = [2, 1]));
    expect(await proofreadAgain()).toBe("failed");
    expect(stageRunsOf(s.h, first).at(-1)?.error?.class).toBe("internal");

    rewrite((payload) => {
      payload["paragraphBreakAfterAliases"] = [1];
      delete payload["kind"];
    });
    expect(await proofreadAgain()).toBe("failed");
    expect(stageRunsOf(s.h, first).at(-1)?.error?.class).toBe("internal");
    expect(fake.calls).toHaveLength(1);
  });

  it("scrubs the mark from the sentences it sends, so an echoed input cannot breach the protocol", async () => {
    const s = setup(fakeProvider());
    const base = seedContent(s.h, 2, (ordinal) => (ordinal === 1 ? "带¶符号" : "第1句"));
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(targetsOf(s.fake.calls[0]?.request as LlmRequest).map((target) => target.text)).toEqual(["第1句", "带 符号"]);
    expect(revision(s.h, resultOf(s.h, taskId).revisionId).segments.map((segment) => segment.paragraphStart)).toEqual([true, false]);
  });
});

/** Answers each range with its lines, minus `drop`'s choice while the range has more than one sentence. */
function dropping(drop: (targets: Array<{ alias: number; text: string }>) => number | undefined): Answer {
  return (targets) => {
    const gone = targets.length > 1 ? drop(targets) : undefined;
    return targets
      .filter(({ alias }) => alias !== gone)
      .map(({ alias, text }) => `[s${alias}] 校:${text}`)
      .join("\n");
  };
}

/** A provider whose answers end as `answer` says, with the stop reason it gives. */
function stoppingProvider(answer: (targets: Array<{ alias: number; text: string }>) => { text: string; stopReason: "stop" | "length" }): FakeLlmProvider {
  const fake = new FakeLlmProvider();
  fake.script(
    ...Array.from({ length: 200 }, () => (request: LlmRequest): AsyncIterable<LlmStreamEvent> =>
      (async function* (): AsyncGenerator<LlmStreamEvent> {
        const { text, stopReason } = answer(targetsOf(request));
        yield { type: "text_delta", delta: text };
        yield { type: "usage", usage: FAKE_USAGE };
        yield { type: "done", stopReason };
      })(),
    ),
  );
  return fake;
}

describe("range splitting", () => {
  it("splits wave by wave down to the single sentence a model keeps merging, and keeps every other range's answer", async () => {
    const merged = PROOFREAD_CHUNK_SENTENCES + 15;
    const fake = fakeProvider(dropping((targets) => (targets[0]?.alias !== merged && targets.some(({ alias }) => alias === merged) ? merged : undefined)));
    const s = setup(fake);
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const result = resultOf(s.h, taskId);
    const tree = result.ranges.map((range) => `${range.depth}:${range.firstAlias}-${range.lastAlias}:${range.kind}`);
    const first = PROOFREAD_CHUNK_SENTENCES + 1;
    expect(tree).toEqual([
      `0:1-${PROOFREAD_CHUNK_SENTENCES}:accepted`,
      `0:${first}-${TWO_CHUNKS}:split`,
      `1:${first}-${first + 9}:accepted`,
      `1:${first + 10}-${TWO_CHUNKS}:split`,
      `2:${first + 10}-${first + 14}:split`,
      `2:${first + 15}-${TWO_CHUNKS}:accepted`,
      `3:${first + 10}-${first + 12}:accepted`,
      `3:${first + 13}-${first + 14}:split`,
      `4:${merged - 1}-${merged - 1}:accepted`,
      `4:${merged}-${merged}:accepted`,
    ]);
    expect(fake.calls).toHaveLength(tree.length);
    expect(result.chunks[1]).toMatchObject({ split: true, acceptedLeafCount: 5 });
    expect(result.reasons).toEqual(["proofread_split:1"]);
    const { segments } = revision(s.h, result.revisionId);
    expect(segments.map((segment) => segment.text)).toEqual(base.segments.map((segment) => `校:${segment.text.replace("\n", " ")}`));
    expect(segments.map((segment) => segment.sourceSegmentIds[0])).toEqual(base.segments.map((segment) => segment.id));
    // Each half is sent with its own read-only context, as a root is.
    const single = fake.calls.find((call) => rangeKeyOf(call.request) === `${merged}-${merged}`)?.request as LlmRequest;
    expect(promptOf(single)).toContain(`【只读上下文（前）】\n[s${merged - PROOFREAD_CONTEXT_SENTENCES}] `);
    expect(promptOf(single)).toContain(`【待校对（请逐行输出这些句，共 1 句）】\n[s${merged}] `);
    // Progress counts accepted sentences and ends complete.
    expect(stageRunsOf(s.h, taskId).find((run) => run.stage === "proofread")?.progress).toBe(1);
  });

  it("a single sentence that still comes back wrong fails the stage after RETRY_MAX retries and publishes nothing", async () => {
    const fake = fakeProvider((targets) => (targets.length === 1 && targets[0]?.alias === 2 ? "" : dropping((all) => (all.some(({ alias }) => alias === 2) ? 2 : undefined))(targets, {} as LlmRequest, {} as LlmStreamOptions)));
    const s = setup(fake);
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    const units = workUnitsOf(s.h, taskId);
    expect(units.map((unit) => [unit.key, unit.status])).toEqual([
      ["proofread:range:1-3", "succeeded"],
      ["proofread:range:1-2", "succeeded"],
      ["proofread:range:3-3", "succeeded"],
      ["proofread:range:1-1", "succeeded"],
      ["proofread:range:2-2", "failed"],
    ]);
    expect(units.at(-1)?.error).toMatchObject({ code: "output_mismatch.proofread_lines", details: { expectedCount: 1, validUniqueAliasCount: 0, missingAliases: ["s2"] } });
    expect(fake.calls).toHaveLength(4 + 1 + RETRY_MAX);
    expect(s.h.db.prepare("SELECT count(*) AS n FROM transcript_revision WHERE kind = 'corrected'").get()).toEqual({ n: 0 });
    expect(s.h.db.prepare("SELECT count(*) AS n FROM token_usage WHERE artifact_revision_id IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("a wave with a failed range starts no further wave, even for a range of it that split", async () => {
    const fake = fakeProvider((targets, request, opts) => {
      if ((targets[0]?.alias ?? 0) > PROOFREAD_CHUNK_SENTENCES) {
        throw amberError("llm_failed", "rejected", { code: "llm_failed.invalid_request" });
      }
      return dropping((all) => all.at(-1)?.alias)(targets, request, opts);
    });
    const s = setup(fake);
    const base = seedContent(s.h, TWO_CHUNKS);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(fake.calls.map((call) => rangeKeyOf(call.request)).sort()).toEqual([`1-${PROOFREAD_CHUNK_SENTENCES}`, `${PROOFREAD_CHUNK_SENTENCES + 1}-${TWO_CHUNKS}`]);
    expect(stageRunsOf(s.h, taskId).find((run) => run.stage === "proofread")?.error?.code).toBe("llm_failed.invalid_request");
  });

  it("known limit: an answer with every alias but its texts moved one line down is accepted as it stands", async () => {
    // Structure checks cannot see misplaced text; this pins the boundary, it does not endorse it.
    const fake = fakeProvider((targets) => targets.map(({ alias }, index) => `[s${alias}] ${targets[index - 1]?.text ?? ""}`).join("\n"));
    const s = setup(fake);
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(fake.calls).toHaveLength(1);
    expect(revision(s.h, resultOf(s.h, taskId).revisionId).segments.map((segment) => segment.text)).toEqual(["第1句\n原文", "第1句 原文", "第2句 原文"]);
  });

  it("a range first answered with a note, then with a missing line, is split on its second call", async () => {
    let calls = 0;
    const fake = fakeProvider((targets) => {
      calls += 1;
      const lines = targets.map(({ alias, text }) => `[s${alias}] ${text}`);
      if (calls === 1) return ["以下是校对结果：", ...lines].join("\n");
      if (calls === 2) return lines.slice(0, -1).join("\n");
      return lines.join("\n");
    });
    const s = setup(fake);
    const base = seedContent(s.h, 4);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    const [root] = workUnitsOf(s.h, taskId);
    expect(root).toMatchObject({ key: "proofread:range:1-4", status: "succeeded", retryCount: 1 });
    expect(payloadOf(s.h, root?.id as string)).toMatchObject({ kind: "split", diagnostic: { missingAliases: [4] } });
    expect(fake.calls).toHaveLength(4);
  });

  describe("an answer cut off by the output limit", () => {
    it("splits when only its last line is broken, and records the cut", async () => {
      const fake = stoppingProvider((targets) =>
        targets.length > 1
          ? { text: [...targets.slice(0, -1).map(({ alias, text }) => `[s${alias}] ${text}`), "[s"].join("\n"), stopReason: "length" }
          : { text: `[s${targets[0]?.alias}] ${targets[0]?.text}`, stopReason: "stop" },
      );
      const s = setup(fake);
      const base = seedContent(s.h, 4);
      const taskId = reproofread(s, base.contentId, base.revision.id);
      s.h.scheduler.start();
      expect(await settled(s.h, taskId)).toBe("succeeded");
      const [root] = workUnitsOf(s.h, taskId);
      expect(payloadOf(s.h, root?.id as string)).toMatchObject({
        kind: "split",
        diagnostic: { stopReason: "length", truncatedTail: true, invalidLineCount: 1, missingAliases: [4] },
      });
    });

    it("does not accept it even with every line there, since the last text may be cut short", async () => {
      const fake = stoppingProvider((targets) => ({
        text: targets.map(({ alias, text }) => `[s${alias}] ${text}`).join("\n"),
        stopReason: targets.length > 1 ? "length" : "stop",
      }));
      const s = setup(fake);
      const base = seedContent(s.h, 2);
      const taskId = reproofread(s, base.contentId, base.revision.id);
      s.h.scheduler.start();
      expect(await settled(s.h, taskId)).toBe("succeeded");
      expect(workUnitsOf(s.h, taskId).map((unit) => unit.key)).toEqual(["proofread:range:1-2", "proofread:range:1-1", "proofread:range:2-2"]);
    });

    it("fails a single sentence cut off, without splitting", async () => {
      const fake = stoppingProvider((targets) => ({ text: `[s${targets[0]?.alias}] ${targets[0]?.text}`, stopReason: "length" }));
      const s = setup(fake);
      const base = seedContent(s.h, 1);
      const taskId = reproofread(s, base.contentId, base.revision.id);
      s.h.scheduler.start();
      expect(await settled(s.h, taskId)).toBe("failed");
      expect(workUnitsOf(s.h, taskId)[0]?.error).toMatchObject({ code: "output_mismatch.proofread_lines", details: { stopReason: "length", truncatedTail: false } });
      expect(fake.calls).toHaveLength(1 + RETRY_MAX);
    });
  });

  it("stops at PROOFREAD_SPLIT_MAX_UNITS_PER_ROOT: no child past the budget, a never-retried failure naming the range", async () => {
    // Every range of more than one sentence loses its last line, so a chunk would split down to 150 single sentences.
    const fake = fakeProvider(dropping((targets) => targets.at(-1)?.alias));
    const events: string[] = [];
    const s = setup(fake);
    s.h.bus.subscribe(({ event }) => events.push(event.type));
    const base = seedContent(s.h, PROOFREAD_CHUNK_SENTENCES);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");

    expect(PROOFREAD_SPLIT_MAX_UNITS_PER_ROOT).toBe(31);
    // Waves of 1, 2, 4, 8 and 16 ranges fill the budget; the fifth wave would need two more.
    expect(fake.calls).toHaveLength(31);
    expect(workUnitsOf(s.h, taskId)).toHaveLength(31);
    const run = stageRunsOf(s.h, taskId).find((candidate) => candidate.stage === "proofread");
    expect(run?.error).toMatchObject({
      code: "output_mismatch.proofread_split_limit",
      retryDisposition: "never",
      details: {
        rootIndex: 0,
        firstAlias: 1,
        lastAlias: 10,
        depth: 4,
        rootUnitsUsed: 31,
        stageExtraUnitsUsed: 30,
        rootUnitLimit: 31,
        stageExtraUnitLimit: PROOFREAD_SPLIT_MAX_EXTRA_UNITS,
        missingAliases: ["s10"],
      },
    });
    expect(s.h.db.prepare("SELECT count(*) AS n FROM transcript_revision WHERE kind = 'corrected'").get()).toEqual({ n: 0 });
    // One call each: queued, running, settled.
    expect(events.filter((type) => type === "workunit.updated")).toHaveLength(31 * 3);
  });

  it("stops at PROOFREAD_SPLIT_MAX_EXTRA_UNITS across chunks, reserving in chunk and alias order", async () => {
    const fake = fakeProvider(dropping((targets) => targets.at(-1)?.alias));
    const s = setup(fake);
    const base = seedContent(s.h, 3 * PROOFREAD_CHUNK_SENTENCES);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");

    expect(PROOFREAD_SPLIT_MAX_EXTRA_UNITS).toBe(64);
    // Waves of 3, 6, 12 and 24 ranges; the 24 splits of the last wave find room for 11 pairs only.
    expect(fake.calls).toHaveLength(45);
    const run = stageRunsOf(s.h, taskId).find((candidate) => candidate.stage === "proofread");
    expect(run?.error).toMatchObject({
      code: "output_mismatch.proofread_split_limit",
      details: { rootIndex: 1, firstAlias: PROOFREAD_CHUNK_SENTENCES + 58, depth: 3, rootUnitsUsed: 21, stageExtraUnitsUsed: 64 },
    });
  });

  it("grows the same tree whatever order the answers come back in", async () => {
    const shapes: string[][] = [];
    for (const seed of [1, 7]) {
      const fake = fakeProvider(async (targets, request, opts) => {
        await new Promise((resolve) => setTimeout(resolve, ((targets[0]?.alias ?? 0) * seed) % 13));
        return dropping((all) => (all.length > 40 ? all.at(-1)?.alias : undefined))(targets, request, opts);
      });
      const s = setup(fake);
      const base = seedContent(s.h, TWO_CHUNKS + PROOFREAD_CHUNK_SENTENCES);
      const taskId = reproofread(s, base.contentId, base.revision.id);
      s.h.scheduler.start();
      expect(await settled(s.h, taskId)).toBe("succeeded");
      shapes.push(resultOf(s.h, taskId).ranges.map((range) => `${range.depth}:${range.firstAlias}-${range.lastAlias}:${range.kind}`));
    }
    expect(shapes[1]).toEqual(shapes[0]);
  });

  it("a half waiting for its retry time defers the stage; the re-entry asks only that half again", async () => {
    let limited = false;
    const fake = fakeProvider((targets, request, opts) => {
      if (!limited && targets.length === 1 && targets[0]?.alias === 3) {
        limited = true;
        throw amberError("llm_rate_limited", "requests per minute", { code: "llm_rate_limited.retry_after", details: { retryAfterMs: 10 } });
      }
      return dropping((all) => (all.some(({ alias }) => alias === 3) ? 3 : undefined))(targets, request, opts);
    });
    const s = setup(fake);
    const base = seedContent(s.h, 3);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    await waitFor(() => taskOf(s.h, taskId).statusProjection === "succeeded", 10_000);
    expect(fake.calls.map((call) => rangeKeyOf(call.request))).toEqual(["1-3", "1-2", "3-3", "3-3"]);
    expect(workUnitsOf(s.h, taskId).find((unit) => unit.key === "proofread:range:3-3")).toMatchObject({ status: "succeeded", retryCount: 1 });
  });

  it("audio: each half carries its own clip; a split chunk with one half downgraded reads as mixed", async () => {
    const fake = fakeProvider(dropping((targets) => (targets.length === 20 ? targets.at(-1)?.alias : undefined)), ["audio/wav"]);
    const s = setup(fake);
    setAudioInput(s.h, s.modelRef, "supported");
    const base = seedContent(s.h, TWO_CHUNKS);
    seedOriginal(s.h, base.contentId);
    const rightHalfStart = (base.segments[PROOFREAD_CHUNK_SENTENCES + 10 - PROOFREAD_CONTEXT_SENTENCES] as TranscriptSegment).startMs;
    s.ingest.clipBytesFor = (range) => (range.startMs === rightHalfStart ? PROOFREAD_AUDIO_MAX_MB * BYTES_PER_MB + 1 : undefined);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const result = resultOf(s.h, taskId);
    expect(result.chunks.map((chunk) => [chunk.i, chunk.split, chunk.audioMode, chunk.audio, chunk.promptRef.id])).toEqual([
      [0, false, "audio", true, "proofread.audio"],
      [1, true, "mixed", false, "proofread.audio"],
    ]);
    expect(result.reasons).toEqual(["audio_downgraded:1", "proofread_split:1"]);
    expect(revision(s.h, result.revisionId).revision.generation).toMatchObject({ promptRef: { id: "proofread.audio" } });
    // The left half's clip runs from its own context to its own context.
    const left = base.segments.slice(PROOFREAD_CHUNK_SENTENCES - PROOFREAD_CONTEXT_SENTENCES, PROOFREAD_CHUNK_SENTENCES + 20);
    expect(s.ingest.clips.map((clip) => clip.range)).toContainEqual({ startMs: left[0]?.startMs, endMs: left.at(-1)?.endMs });
  });
});

describe("range splitting: interruptions", () => {
  /** Answers every range, losing s15 while a range holds it after its first sentence, and hangs on `hang` until aborted. */
  function hangingOn(hang: string): Answer {
    return async (targets, request, opts) => {
      if (rangeKeyOf(request) === hang) {
        await new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
      }
      return dropping((all) => (all[0]?.alias !== 15 && all.some(({ alias }) => alias === 15) ? 15 : undefined))(targets, request, opts);
    };
  }

  it("a cancel while a wave runs starts no further wave and publishes nothing", async () => {
    const fake = fakeProvider(hangingOn("11-20"));
    const s = setup(fake);
    const base = seedContent(s.h, 20);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    await waitFor(() => fake.calls.some((call) => rangeKeyOf(call.request) === "11-20") && workUnitsOf(s.h, taskId).some((unit) => unit.key === "proofread:range:1-10" && unit.status === "succeeded"));

    s.h.tasks.cancel(LOCAL, taskId);
    await waitFor(() => stageStatuses(s.h, taskId)["proofread"] === "cancelled");
    await s.h.scheduler.whenIdle();
    expect(fake.calls.map((call) => rangeKeyOf(call.request))).toEqual(["1-20", "1-10", "11-20"]);
    expect(workUnitsOf(s.h, taskId).map((unit) => [unit.key, unit.status])).toEqual([
      ["proofread:range:1-20", "succeeded"],
      ["proofread:range:1-10", "succeeded"],
      ["proofread:range:11-20", "cancelled"],
    ]);
    expect(s.h.db.prepare("SELECT count(*) AS n FROM transcript_revision WHERE kind = 'corrected'").get()).toEqual({ n: 0 });
  });

  it("after a crash mid-split only the half that was in flight is re-sent, once the user confirms; the split and the finished half are kept", async () => {
    const fake = fakeProvider(hangingOn("11-20"));
    const first = setup(fake);
    const base = seedContent(first.h, 20);
    const taskId = reproofread(first, base.contentId, base.revision.id);
    first.h.scheduler.start();
    await waitFor(() => fake.calls.some((call) => rangeKeyOf(call.request) === "11-20") && workUnitsOf(first.h, taskId).some((unit) => unit.key === "proofread:range:1-10" && unit.status === "succeeded"));
    await first.h.scheduler.stop();
    const file = first.h.file;
    await first.h.close();
    open.splice(open.indexOf(first.h), 1);

    const fake2 = fakeProvider(dropping((all) => (all[0]?.alias !== 15 && all.some(({ alias }) => alias === 15) ? 15 : undefined)));
    const second = setup(fake2, { file });
    second.h.scheduler.start();
    await settled(second.h, taskId);
    const parked = workUnitsOf(second.h, taskId).find((unit) => unit.status === "waiting_user_action");
    expect(parked?.key).toBe("proofread:range:11-20");
    expect(fake2.calls).toHaveLength(0);

    second.h.tasks.confirmResend(LOCAL, taskId, parked?.id as string);
    await waitFor(() => taskOf(second.h, taskId).statusProjection === "succeeded");
    // The confirmed half splits on its own answer; the root's split and the left half are not asked again.
    expect(fake2.calls.map((call) => rangeKeyOf(call.request))).toEqual(["11-20", "11-15", "16-20", "11-13", "14-15", "14-14", "15-15"]);
    const units = workUnitsOf(second.h, taskId);
    expect(units.find((unit) => unit.key === "proofread:range:1-20")?.attempt).toBe(1);
    expect(units.find((unit) => unit.key === "proofread:range:1-10")?.attempt).toBe(1);
    const { segments } = revision(second.h, resultOf(second.h, taskId).revisionId);
    expect(segments.map((segment) => segment.text)).toEqual(base.segments.map((segment) => `校:${segment.text.replace("\n", " ")}`));
  });
});

describe("range splitting at the budget's scale", () => {
  it("22 chunks, 4 of them split to the end of PROOFREAD_SPLIT_MAX_EXTRA_UNITS, every range asked 1 + RETRY_MAX times: 86 units, 344 calls", async () => {
    const roots = 22;
    const splitRoots = 4;
    // The sentence 101 of a chunk keeps a halving going for 8 waves: 17 ranges per chunk.
    const merged = new Set(Array.from({ length: splitRoots }, (_, root) => root * PROOFREAD_CHUNK_SENTENCES + 101));
    const asked = new Map<string, number>();
    const fake = new FakeLlmProvider();
    fake.script(
      ...Array.from({ length: 400 }, () => (request: LlmRequest): AsyncIterable<LlmStreamEvent> =>
        (async function* (): AsyncGenerator<LlmStreamEvent> {
          const targets = targetsOf(request);
          const key = rangeKeyOf(request);
          const count = (asked.get(key) ?? 0) + 1;
          asked.set(key, count);
          const lines = targets.map(({ alias, text }) => `[s${alias}] ${text}`);
          const gone = targets.length > 1 ? targets.slice(1).find(({ alias }) => merged.has(alias))?.alias : undefined;
          // Three answers wrapped in a note (asked again whole), then the real one.
          const text = count <= RETRY_MAX ? ["以下是校对结果：", ...lines].join("\n") : lines.filter((line) => !line.startsWith(`[s${gone}]`)).join("\n");
          yield* reply(text);
        })(),
      ),
    );
    const events: string[] = [];
    const s = setup(fake);
    s.h.bus.subscribe(({ event }) => events.push(event.type));
    const base = seedContent(s.h, roots * PROOFREAD_CHUNK_SENTENCES, (ordinal) => `第${ordinal + 1}句`);
    const taskId = reproofread(s, base.contentId, base.revision.id);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const units = workUnitsOf(s.h, taskId);
    expect(units).toHaveLength(roots + PROOFREAD_SPLIT_MAX_EXTRA_UNITS);
    expect(units.every((unit) => unit.status === "succeeded" && unit.retryCount === RETRY_MAX)).toBe(true);
    expect(fake.calls).toHaveLength(units.length * (1 + RETRY_MAX));
    const result = resultOf(s.h, taskId);
    expect(result.reasons).toEqual(["proofread_split:0", "proofread_split:1", "proofread_split:2", "proofread_split:3"]);
    expect(Math.max(...result.ranges.map((range) => range.depth))).toBe(8);
    expect(revision(s.h, result.revisionId).segments).toHaveLength(roots * PROOFREAD_CHUNK_SENTENCES);
    // Per unit: queued, then running and settled for each of its four calls, the three
    // immediate re-asks each recorded as a failed attempt.
    const perUnit = events.filter((type) => type === "workunit.updated").length / units.length;
    expect(perUnit).toBe(9);

    // The detail a client loads for this Task carries every unit; its size is recorded, not bounded.
    const detail = s.h.tasks.get(LOCAL, taskId);
    expect(detail.workUnits).toHaveLength(units.length);
    const detailBytes = Buffer.byteLength(JSON.stringify(detail));
    // Each unit write rebuilds the projection from the Task's runs and units; time it at this size.
    const rounds = 200;
    const started = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      transact(s.h.repository, s.h.bus, (scope, outbox) => refreshProjection(scope, outbox, LOCAL.userId, taskId, Date.now()));
    }
    const projectionMs = (performance.now() - started) / rounds;
    console.info(`proofread scale: ${units.length} units, ${fake.calls.length} calls, ${events.length} events, task detail ${detailBytes} bytes, refreshProjection ${projectionMs.toFixed(3)} ms`);
  }, 60_000);
});

describe("custom proofread prompts", () => {
  const TEXT_CUSTOM = `${PROOFREAD_TEXT_PROMPT.text}\n自定义文本标记：保留口头禅。`;
  const PREAMBLE_CUSTOM = "自定义前置段：音频里可能有背景音乐。";
  const AUDIO_CUSTOM = `${PREAMBLE_CUSTOM}\n\n{{proofread_text}}`;
  const BUILTIN_PREAMBLE = PROOFREAD_AUDIO_PROMPT.text.replace("\n\n{{proofread_text}}", "");
  const TEXT_REF = customPromptRef("proofread.text", 1);
  const AUDIO_REF = customPromptRef("proofread.audio", 1);

  type Generation = { promptRef: PromptRef; promptRefs: PromptRef[]; promptSnapshot: string };
  const generationOf = (h: Harness, taskId: string) => revision(h, resultOf(h, taskId).revisionId).revision.generation as unknown as Generation;
  const audioPartsOf = (request: LlmRequest) => request.messages[0]?.content.filter((part) => part.type === "audio") ?? [];
  const hasAudio = (request: LlmRequest) => audioPartsOf(request).length > 0;

  /** The slot values of the one range of a Content shorter than a chunk: no context lines, no terminology. */
  function slotsOf(segments: readonly TranscriptSegment[]): Record<string, string> {
    return {
      terms_section: termsSection([]),
      context_before: "",
      count: String(segments.length),
      target_lines: segments.map((segment, index) => `[s${index + 1}] ${segment.text.replace("\n", " ")}`).join("\n"),
      context_after: "",
    };
  }

  /** A three-sentence Content; with `audio` the model takes audio and an original is there to extract it from. */
  function prepared(fake: FakeLlmProvider, options: { audio?: boolean; count?: number } = {}) {
    const s = setup(fake);
    if (options.audio === true) setAudioInput(s.h, s.modelRef, "supported");
    const base = seedContent(s.h, options.count ?? 3);
    if (options.audio === true) seedOriginal(s.h, base.contentId);
    return { s, base };
  }

  /** A reproofread Task created through the service, which freezes the prompts in effect. */
  async function submit(s: Setup, contentId: string): Promise<string> {
    return (await s.h.derivedTasks.proofread(LOCAL, contentId, { modelRef: s.modelRef })).body.taskId;
  }

  it("a custom proofread.text is sent, its line answer parsed, and the revision records it alone", async () => {
    const { s, base } = prepared(fakeProvider());
    s.h.prompts.update(LOCAL, "proofread.text", { text: TEXT_CUSTOM });
    const taskId = await submit(s, base.contentId);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    expect(s.fake.calls).toHaveLength(1);
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toBe(renderPrompt(TEXT_CUSTOM, slotsOf(base.segments)));
    const result = resultOf(s.h, taskId);
    expect(revision(s.h, result.revisionId).segments.map((segment) => segment.text)).toEqual(base.segments.map((segment) => `校:${segment.text.replace("\n", " ")}`));
    const generation = generationOf(s.h, taskId);
    expect(generation.promptRef).toEqual(TEXT_REF);
    expect(generation.promptRefs).toEqual([TEXT_REF]);
    expect(generation.promptSnapshot).toBe(renderPrompt(TEXT_CUSTOM, { terms_section: termsSection([]) }));
    expect(generation.promptSnapshot).toContain("自定义文本标记：保留口头禅。");
    expect(result.ranges.map((range) => range.promptRef)).toEqual([TEXT_REF]);
  });

  it.each([
    ["only the preamble is custom", { audio: true, text: false }],
    ["only the text prompt is custom", { audio: false, text: true }],
    ["both are custom", { audio: true, text: true }],
  ])("audio proofreading when %s sends the preamble, a blank line and the rendered text prompt", async (_case, custom) => {
    const { s, base } = prepared(fakeProvider(corrected, ["audio/wav"]), { audio: true });
    if (custom.audio) s.h.prompts.update(LOCAL, "proofread.audio", { text: AUDIO_CUSTOM });
    if (custom.text) s.h.prompts.update(LOCAL, "proofread.text", { text: TEXT_CUSTOM });
    const taskId = await submit(s, base.contentId);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const audioText = custom.audio ? AUDIO_CUSTOM : PROOFREAD_AUDIO_PROMPT.text;
    const textText = custom.text ? TEXT_CUSTOM : PROOFREAD_TEXT_PROMPT.text;
    const request = s.fake.calls[0]?.request as LlmRequest;
    expect(s.fake.calls).toHaveLength(1);
    expect(audioPartsOf(request)).toHaveLength(1);
    expect(promptOf(request)).toBe(`${custom.audio ? PREAMBLE_CUSTOM : BUILTIN_PREAMBLE}\n\n${renderPrompt(textText, slotsOf(base.segments))}`);

    const audioRef = custom.audio ? AUDIO_REF : PROOFREAD_AUDIO_PROMPT.ref;
    const textRef = custom.text ? TEXT_REF : PROOFREAD_TEXT_PROMPT.ref;
    const generation = generationOf(s.h, taskId);
    expect(generation.promptRef).toEqual(audioRef);
    expect(generation.promptRefs).toEqual([audioRef, textRef]);
    expect(generation.promptSnapshot).toBe(renderPrompt(composeProofreadAudioPrompt(audioText, textText), { terms_section: termsSection([]) }));
    expect(resultOf(s.h, taskId).ranges.map((range) => [range.promptRef, range.audio])).toEqual([[audioRef, true]]);
  });

  it("the builtin audio prompt composes to exactly the text of the historical proofread.audio v5", async () => {
    const historical = BUILTIN_PROMPT_HISTORY.find((prompt) => prompt.ref.id === "proofread.audio" && prompt.ref.version === 5);
    expect(historical).toBeDefined();
    const { s, base } = prepared(fakeProvider(corrected, ["audio/wav"]), { audio: true });
    const taskId = await submit(s, base.contentId);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");
    expect(promptOf(s.fake.calls[0]?.request as LlmRequest)).toBe(renderPrompt(historical?.text as string, slotsOf(base.segments)));
    expect(generationOf(s.h, taskId).promptRefs).toEqual([PROOFREAD_AUDIO_PROMPT.ref, PROOFREAD_TEXT_PROMPT.ref]);
  });

  it.each([
    ["the clip is over the size limit", "oversized"],
    ["the adapter refuses the audio as a capability problem", "refused"],
  ] as const)("a range that falls back to text when %s is sent and recorded with the text prompt only", async (_case, how) => {
    const answer: Answer = (targets, request, opts) => {
      if (how === "refused" && hasAudio(request)) throw amberError("llm_capability", "audio input rejected");
      return corrected(targets, request, opts);
    };
    const { s, base } = prepared(fakeProvider(answer, ["audio/wav"]), { audio: true });
    if (how === "oversized") s.ingest.clipBytes = PROOFREAD_AUDIO_MAX_MB * BYTES_PER_MB + 1;
    s.h.prompts.update(LOCAL, "proofread.audio", { text: AUDIO_CUSTOM });
    s.h.prompts.update(LOCAL, "proofread.text", { text: TEXT_CUSTOM });
    const taskId = await submit(s, base.contentId);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    const textCalls = s.fake.calls.filter((call) => !hasAudio(call.request));
    expect(textCalls).toHaveLength(1);
    expect(promptOf(textCalls[0]?.request as LlmRequest)).toBe(renderPrompt(TEXT_CUSTOM, slotsOf(base.segments)));
    const result = resultOf(s.h, taskId);
    expect(result.ranges.map((range) => [range.promptRef, range.audio])).toEqual([[TEXT_REF, false]]);
    const generation = generationOf(s.h, taskId);
    expect(generation.promptRef).toEqual(TEXT_REF);
    expect(generation.promptRefs).toEqual([TEXT_REF]);
    expect(generation.promptSnapshot).not.toContain(PREAMBLE_CUSTOM);
  });

  it.each([
    ["nothing changed: the finished audio range is reused", false],
    ["only the text prompt changed: the finished audio range is asked again", true],
  ])("re-running a failed audio proofread when %s", async (_case, changeText) => {
    let failOnce = true;
    const fake = fakeProvider((targets, request, opts) => {
      if (failOnce && (targets[0]?.alias ?? 0) > PROOFREAD_CHUNK_SENTENCES) {
        failOnce = false;
        throw amberError("llm_failed", "rejected", { code: "llm_failed.invalid_request" });
      }
      return corrected(targets, request, opts);
    }, ["audio/wav"]);
    const { s, base } = prepared(fake, { audio: true, count: TWO_CHUNKS });
    const taskId = await submit(s, base.contentId);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(chunkCalls(fake).sort()).toEqual([0, 1]);
    expect(fake.calls.every((call) => hasAudio(call.request))).toBe(true);

    if (changeText) s.h.prompts.update(LOCAL, "proofread.text", { text: TEXT_CUSTOM });
    s.h.tasks.retryStage(LOCAL, taskId, { stage: "proofread" });
    await waitFor(() => taskOf(s.h, taskId).statusProjection === "succeeded");
    expect(chunkCalls(fake).sort()).toEqual(changeText ? [0, 0, 1, 1] : [0, 1, 1]);

    const attempts = stageRunsOf(s.h, taskId).filter((run) => run.stage === "proofread");
    const firstKey = `proofread:range:1-${PROOFREAD_CHUNK_SENTENCES}`;
    const digestIn = (runId: string | undefined) => workUnitsOf(s.h, taskId).find((unit) => unit.stageRunId === runId && unit.key === firstKey)?.inputDigest;
    expect(digestIn(attempts[1]?.id) === digestIn(attempts[0]?.id)).toBe(!changeText);
    expect(generationOf(s.h, taskId).promptRefs).toEqual([PROOFREAD_AUDIO_PROMPT.ref, changeText ? TEXT_REF : PROOFREAD_TEXT_PROMPT.ref]);
  });

  it("after restoring the builtin text a new reproofread Task is back on the builtin version", async () => {
    const { s, base } = prepared(fakeProvider());
    s.h.prompts.update(LOCAL, "proofread.text", { text: TEXT_CUSTOM });
    const first = await submit(s, base.contentId);
    s.h.scheduler.start();
    expect(await settled(s.h, first)).toBe("succeeded");
    expect(generationOf(s.h, first).promptRefs).toEqual([TEXT_REF]);

    s.h.prompts.restore(LOCAL, "proofread.text");
    const second = await submit(s, base.contentId);
    expect(await settled(s.h, second)).toBe("succeeded");
    expect(promptOf(s.fake.calls.at(-1)?.request as LlmRequest)).not.toContain("自定义文本标记");
    const generation = generationOf(s.h, second);
    expect(generation.promptRef).toEqual(PROOFREAD_TEXT_PROMPT.ref);
    expect(generation.promptRefs).toEqual([PROOFREAD_TEXT_PROMPT.ref]);
  });
});
