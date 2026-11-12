import { createHash } from "node:crypto";
import type { LlmRequest, LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import { ChapterStageExecutor } from "../../../src/server/pipeline/stages/chapter.ts";
import { HighlightStageExecutor } from "../../../src/server/pipeline/stages/highlight.ts";
import { SummaryStageExecutor } from "../../../src/server/pipeline/stages/summary.ts";
import { CONTEXT_SAFETY_RATIO } from "../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../llm/fake-llm.ts";
import { insertRow } from "../../tools/sqlite.ts";
import { createHarness, LOCAL, stageStatuses, taskOf, waitFor, workUnitsOf, type Harness } from "./harness.ts";

/**
 * Deterministic Contents for the speaker-context tests: every id is fixed, so the exact
 * requests a stage sends and the digests of its units can be compared across runs and
 * across builds.
 */

export const FIXED_PROFILE_ID = "01JPR0F11E000000000000000A";
export const FIXED_CONTENT_ID = "01JC0NTENT0000000000000000";
export const FIXED_REVISION_ID = "01JREV1S10N000000000000000";
export const MAX_OUTPUT = 10;

/** A window leaving `room` tokens of input. */
export const windowFor = (room: number): number => Math.ceil((room + MAX_OUTPUT) / CONTEXT_SAFETY_RATIO);

export function fixedSegmentId(position: number): SegmentId {
  return `01JSEG${String(position).padStart(20, "0")}` as SegmentId;
}

export function fixedSpeakerId(index: number): string {
  return `01JSPK${String(index).padStart(20, "0")}`;
}

/** 120 sentences of plain lecture text: long enough to split into several windows and rolling groups under a small room. */
export const LECTURE: readonly string[] = Array.from(
  { length: 120 },
  (_, index) => `第${index + 1}句：检索增强生成把外部知识接入模型，这一句讲到第${index + 1}个要点。`,
);

export type Kind = "envelope" | "partial" | "carry" | "final" | "repair" | "chapter" | "highlight";

export function promptOf(request: LlmRequest): string {
  const part = request.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
}

export function kindOf(request: LlmRequest): Kind {
  const prompt = promptOf(request);
  if (prompt.startsWith("以下引用标记")) return "repair";
  if (prompt.startsWith("你在为一个合集或一段长内容做连贯的归纳")) return "partial";
  if (prompt.startsWith("把「已有压缩摘要」")) return "carry";
  if (prompt.startsWith("下面是一段长内容各组的归纳")) return "final";
  if (prompt.includes('"chapters"')) return "chapter";
  if (prompt.includes('"highlights"')) return "highlight";
  return "envelope";
}

/** Aliases at the start of a line after `marker`: the transcript lines, never the instructions. */
export function lineAliases(request: LlmRequest, marker = ""): number[] {
  const prompt = promptOf(request);
  const at = marker === "" ? 0 : prompt.lastIndexOf(marker);
  return [...prompt.slice(Math.max(at, 0)).matchAll(/^\[\[s(\d+)\]\]/gm)].map((match) => Number(match[1]));
}

/** Any alias after `marker`, line start or not (partials cite inline). */
function anyAliases(request: LlmRequest, marker: string): number[] {
  const prompt = promptOf(request);
  const at = prompt.lastIndexOf(marker);
  return [...prompt.slice(Math.max(at, 0)).matchAll(/\[\[s(\d+)\]\]/g)].map((match) => Number(match[1]));
}

export type Answer = (kind: Kind, request: LlmRequest) => string;

/** A valid answer for every call: summaries cite the first lines they were given, chapters and highlights start at the window's first line. */
export const validAnswer: Answer = (kind, request) => {
  const first = lineAliases(request)[0] ?? 1;
  switch (kind) {
    case "envelope":
      return `## 摘要\n讲了 RAG [[s${first}]]。`;
    case "partial":
      return `本组讲了 [[s${first}]]`;
    case "carry":
      return `压缩 [[s${anyAliases(request, "【新增归纳】")[0] ?? 1}]]`;
    case "final":
      return `总归纳 ${anyAliases(request, "【各组归纳】").map((alias) => `[[s${alias}]]`).join(" ")}`;
    case "repair":
      return "{}";
    case "chapter":
      return JSON.stringify({ chapters: [{ startAlias: `s${first}`, title: `章${first}`, summary: "概要" }] });
    case "highlight":
      return JSON.stringify({ highlights: [{ alias: `s${first}`, score: 80, text: "重要" }] });
  }
};

export function scriptedProvider(answer: Answer = validAnswer): FakeLlmProvider {
  const fake = new FakeLlmProvider();
  fake.script(
    ...Array.from({ length: 400 }, () => (request: LlmRequest) =>
      (async function* (): AsyncGenerator<LlmStreamEvent> {
        yield* reply(answer(kindOf(request), request));
      })(),
    ),
  );
  return fake;
}

/**
 * A harness with the summary, chapter and highlight stages and one model under a fixed id.
 * The scheduler starts at once unless `start` is false (to change things between submission and run).
 */
export function speakerHarness(fake: FakeLlmProvider, room: number | undefined, options: { start?: boolean } = {}): { h: Harness; modelRef: ModelRef } {
  const h = createHarness({ llmProviders: [fake], executors: {} });
  h.executors.summary = new SummaryStageExecutor({ repository: h.repository, newId: h.newId });
  h.executors.chapter = new ChapterStageExecutor({ repository: h.repository, newId: h.newId });
  h.executors.highlight = new HighlightStageExecutor({ repository: h.repository, newId: h.newId });
  const credentialRef = h.secrets.store(LOCAL.userId, "<placeholder-llm-key>");
  insertRow(h.db, "provider_profile", {
    id: FIXED_PROFILE_ID,
    user_id: LOCAL.userId,
    name: "relay",
    protocol: "openai_compatible",
    base_url: "https://llm.invalid/v1",
    credential_ref: credentialRef,
    created_at: 1,
  });
  const unknown = { stream: "unknown", tools: "unknown", structuredOutput: "unsupported", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
  insertRow(h.db, "model_capability", {
    profile_id: FIXED_PROFILE_ID,
    model_id: "model-a",
    position: 0,
    flags_declared_json: JSON.stringify(unknown),
    limits_declared_json: "{}",
  });
  const modelRef = { providerProfileId: FIXED_PROFILE_ID, modelId: "model-a" };
  setRoom(h, room);
  if (options.start !== false) {
    h.scheduler.start();
  }
  return { h, modelRef };
}

/** Input room of the fixed model; `undefined` = unknown window. */
export function setRoom(h: Harness, room: number | undefined): void {
  const limits = room === undefined ? null : JSON.stringify({ contextWindowTokens: windowFor(room), maxOutputTokens: MAX_OUTPUT });
  h.db.prepare("UPDATE model_capability SET limits_user_override_json = ? WHERE profile_id = ?").run(limits, FIXED_PROFILE_ID);
}

export interface SpeakerSpec {
  name?: string;
  /** The name is confirmed (given to models); ignored without a name. */
  confirmed?: boolean;
}

export interface SeedOptions {
  texts?: readonly string[];
  /** Speakers registered on the Content, by index. */
  speakers?: readonly SpeakerSpec[];
  /** Speaker index of each sentence; `undefined` = unassigned. Absent = no sentence has a speaker. */
  assign?: (position: number) => number | undefined;
  /** The revision's speakers are marked reviewed. */
  reviewed?: boolean;
}

/** The fixed Content with one imported primary revision of fixed ids. */
export function seedContent(h: Harness, options: SeedOptions = {}): { contentId: string; revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const texts = options.texts ?? LECTURE;
  const segments: TranscriptSegment[] = texts.map((text, ordinal) => {
    const speaker = options.assign?.(ordinal);
    return {
      id: fixedSegmentId(ordinal),
      revisionId: FIXED_REVISION_ID,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text,
      sourceSegmentIds: [],
      ...(speaker === undefined ? {} : { speakerId: fixedSpeakerId(speaker) }),
    };
  });
  const revision: TranscriptRevision = {
    id: FIXED_REVISION_ID,
    contentId: FIXED_CONTENT_ID,
    kind: "imported",
    language: "zh-CN",
    timingFidelity: "segment_only",
    generation: { kind: "imported", format: "srt" },
    segmentCount: segments.length,
    createdAt: 1,
  };
  h.repository.withTransaction((scope) => {
    scope.contents.insert({ id: FIXED_CONTENT_ID, userId: LOCAL.userId, source: { kind: "local" }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 });
    if (options.speakers !== undefined && options.speakers.length > 0) {
      scope.speakers.insert(
        LOCAL.userId,
        FIXED_CONTENT_ID,
        options.speakers.map((speaker, index) => ({
          id: fixedSpeakerId(index),
          ...(speaker.name === undefined ? {} : { name: speaker.name }),
          ...(speaker.name !== undefined && speaker.confirmed === true ? { nameConfirmedAt: 5 } : {}),
        })),
        1,
      );
    }
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, FIXED_CONTENT_ID, FIXED_REVISION_ID, 2);
    if (options.reviewed === true) {
      scope.speakerConfirmations.set(LOCAL.userId, FIXED_CONTENT_ID, FIXED_REVISION_ID, 7);
    }
  });
  return { contentId: FIXED_CONTENT_ID, revision, segments };
}

/** Waits until the Task's only stage succeeded or failed (or the Task waits for the user). */
export async function settle(h: Harness, taskId: string, stage: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId)[stage] ?? "") || taskOf(h, taskId).statusProjection === "waiting");
  return stageStatuses(h, taskId)[stage] as string;
}

/**
 * What a Task sent and keyed: every request as the adapter received it (sorted, since
 * parallel windows finish in any order) and every unit's key with its input digest.
 */
export function traffic(h: Harness, fake: FakeLlmProvider, taskId: string): { requests: string[]; units: string[] } {
  return {
    requests: fake.calls.map((call) => JSON.stringify(call.request)).sort(),
    units: workUnitsOf(h, taskId)
      .map((unit) => `${unit.key} ${unit.inputDigest}`)
      .sort(),
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
