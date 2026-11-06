import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { AsrUsage } from "../../../../../src/server/domain/usage.ts";
import type { AsrJobReportFill, AsrUsageQuery } from "../../../../../src/server/ports/repository.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) {
    insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
    insertRow(db, "content", { id: `c-${id}`, user_id: id, source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    insertRow(db, "task", { id: `t-${id}`, user_id: id, content_id: `c-${id}`, kind: "retranscribe", request_json: "{}", status_projection: "running", created_at: T0 });
    insertRow(db, "asr_provider_profile", { id: `a-${id}`, user_id: id, name: "ElevenLabs", provider: "elevenlabs", models_json: '[{"modelId":"scribe_v2"}]', created_at: T0 });
  }
});

function usage(id: string, extra: Partial<AsrUsage> = {}): AsrUsage {
  return { id, userId: "alice", asrProfileId: "a-alice", provider: "elevenlabs", model: "scribe_v2", feature: "transcribe", outcome: "succeeded", audioMs: 60_000, createdAt: T0, ...extra };
}

const code = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
};

describe("ASR usage repository", () => {
  it("lists the owner's rows oldest first, filtered by task, content and time", () => {
    repository.withTransaction((scope) => {
      scope.asrUsage.insert(usage("u2", { taskId: "t-alice", contentId: "c-alice", outcome: "outcome_unknown", createdAt: T0 + 2 }));
      scope.asrUsage.insert(usage("u1", { createdAt: T0 + 1, rawUsageJson: '{"seconds":60}' }));
      scope.asrUsage.insert(usage("b1", { userId: "bob", asrProfileId: "a-bob", taskId: "t-bob", createdAt: T0 }));
    });
    const list = (query?: AsrUsageQuery) =>
      repository.withTransaction((scope) => scope.asrUsage.list("alice", query)).map((row) => row.id);
    expect(list()).toEqual(["u1", "u2"]);
    expect(list({ taskId: "t-alice" })).toEqual(["u2"]);
    expect(list({ contentId: "c-alice" })).toEqual(["u2"]);
    expect(list({ since: T0 + 2 })).toEqual(["u2"]);
    expect(list({ until: T0 + 2 })).toEqual(["u1"]);
    expect(list({ since: T0 + 1, until: T0 + 1 })).toEqual([]);
    // Another user's task id finds nothing.
    expect(list({ taskId: "t-bob" })).toEqual([]);
    expect(repository.withTransaction((scope) => scope.asrUsage.list("alice"))[0]).toEqual(usage("u1", { createdAt: T0 + 1, rawUsageJson: '{"seconds":60}' }));
  });

  it("refuses references to another user's profile, task or content", () => {
    for (const extra of [{ asrProfileId: "a-bob" }, { taskId: "t-bob" }, { contentId: "c-bob" }]) {
      expect(code(() => repository.withTransaction((scope) => scope.asrUsage.insert(usage("x", extra))))).toBe("not_found");
    }
  });

  it("round-trips what each row was for; a row written without one is a transcription; nothing else is accepted", () => {
    repository.withTransaction((scope) => {
      scope.asrUsage.insert(usage("u1", { createdAt: T0 + 1 }));
      scope.asrUsage.insert(usage("u2", { feature: "test_connection", createdAt: T0 + 2 }));
    });
    insertRow(db, "asr_usage", { id: "u3", user_id: "alice", provider: "elevenlabs", model: "scribe_v2", outcome: "succeeded", audio_ms: 1, created_at: T0 + 3 });
    const rows = repository.withTransaction((scope) => scope.asrUsage.list("alice"));
    expect(rows.map((row) => [row.id, row.feature])).toEqual([["u1", "transcribe"], ["u2", "test_connection"], ["u3", "transcribe"]]);
    expect(() => insertRow(db, "asr_usage", { id: "u4", user_id: "alice", provider: "elevenlabs", model: "scribe_v2", feature: "probe", outcome: "succeeded", audio_ms: 1, created_at: T0 })).toThrow(/CHECK/);
  });

  it("keeps the provider and model snapshot when the profile is deleted", () => {
    repository.withTransaction((scope) => scope.asrUsage.insert(usage("u1")));
    expect(repository.withTransaction((scope) => scope.asrProfiles.delete("alice", "a-alice"))).toBe(true);
    const [row] = repository.withTransaction((scope) => scope.asrUsage.list("alice"));
    expect(row).toMatchObject({ id: "u1", provider: "elevenlabs", model: "scribe_v2" });
    expect(row?.asrProfileId).toBeUndefined();
  });

  it("round-trips the profile snapshot, send-time snapshots, job id and outcome, and billed quantities", () => {
    const full = usage("u1", {
      profileIdSnapshot: "a-alice",
      profileNameSnapshot: "百炼",
      jobId: "task-123",
      jobOutcome: "succeeded",
      billedInputTokens: 150,
      billedOutputTokens: 39,
      billedAudioMs: 12_000,
      sentAt: T0 - 3_000,
      credentialVersion: "version-1",
      credentialSetAt: T0 - 86_400_000,
      priceSnapshot: { currency: "CNY", items: [{ unit: "audio_per_second", amount: "0.00022" }] },
      rawUsageJson: '{"duration":12}',
    });
    repository.withTransaction((scope) => {
      scope.asrUsage.insert(full);
      scope.asrUsage.insert(usage("u2", { createdAt: T0 + 1 }));
    });
    const [first, second] = repository.withTransaction((scope) => scope.asrUsage.list("alice"));
    expect(first).toEqual(full);
    expect(second).toEqual(usage("u2", { createdAt: T0 + 1 }));
    for (const key of ["jobId", "jobOutcome", "billedInputTokens", "billedAudioMs", "sentAt", "credentialVersion", "priceSnapshot", "profileIdSnapshot"]) {
      expect(second).not.toHaveProperty(key);
    }
  });

  it("keeps the profile snapshot after the profile is deleted, and the snapshot id is not a foreign key", () => {
    repository.withTransaction((scope) => scope.asrUsage.insert(usage("u1", { profileIdSnapshot: "a-alice", profileNameSnapshot: "ElevenLabs" })));
    repository.withTransaction((scope) => scope.asrProfiles.delete("alice", "a-alice"));
    const [row] = repository.withTransaction((scope) => scope.asrUsage.list("alice"));
    expect(row).toMatchObject({ profileIdSnapshot: "a-alice", profileNameSnapshot: "ElevenLabs" });
    expect(row?.asrProfileId).toBeUndefined();
  });

  describe("fillJobReport", () => {
    const fill = (id: string, report: AsrJobReportFill, owner = "alice") => repository.withTransaction((scope) => scope.asrUsage.fillJobReport(owner, id, report));
    const row = (id: string) => repository.withTransaction((scope) => scope.asrUsage.list("alice")).find((candidate) => candidate.id === id);

    it("completes a row field by field and reports whether the row exists for that owner", () => {
      repository.withTransaction((scope) => scope.asrUsage.insert(usage("u1", { jobId: "job-1" })));
      expect(fill("u1", { jobOutcome: "succeeded", billedInputTokens: 150, billedOutputTokens: 39, billedAudioMs: 12_000, rawUsageJson: '{"duration":12}' })).toBe(true);
      expect(row("u1")).toMatchObject({ jobId: "job-1", jobOutcome: "succeeded", billedInputTokens: 150, billedOutputTokens: 39, billedAudioMs: 12_000, rawUsageJson: '{"duration":12}' });
      expect(fill("missing", { jobOutcome: "failed" })).toBe(false);
    });

    it("only fills empty fields: a later report cannot overwrite, and a job outcome never changes once set", () => {
      repository.withTransaction((scope) => scope.asrUsage.insert(usage("u1", { jobId: "job-1" })));
      fill("u1", { jobOutcome: "succeeded", billedAudioMs: 12_000 });
      fill("u1", { jobOutcome: "failed", billedAudioMs: 1, billedInputTokens: 150, rawUsageJson: '{"input_tokens":150}' });
      expect(row("u1")).toMatchObject({ jobOutcome: "succeeded", billedAudioMs: 12_000, billedInputTokens: 150, rawUsageJson: '{"input_tokens":150}' });
      fill("u1", { jobOutcome: "cancelled", billedInputTokens: 9, rawUsageJson: '{"x":1}' });
      expect(row("u1")).toMatchObject({ jobOutcome: "succeeded", billedInputTokens: 150, rawUsageJson: '{"input_tokens":150}' });
    });

    it("keeps a zero as a value and an empty report as no change", () => {
      repository.withTransaction((scope) => scope.asrUsage.insert(usage("u1")));
      fill("u1", { billedAudioMs: 0 });
      fill("u1", { billedAudioMs: 5_000 });
      expect(row("u1")?.billedAudioMs).toBe(0);
      expect(fill("u1", {})).toBe(true);
      expect(row("u1")).not.toHaveProperty("jobOutcome");
    });

    it("touches nothing of another owner's row", () => {
      repository.withTransaction((scope) => scope.asrUsage.insert(usage("u1")));
      expect(fill("u1", { jobOutcome: "failed" }, "bob")).toBe(false);
      expect(row("u1")).not.toHaveProperty("jobOutcome");
    });
  });
});
