import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { UserSettings } from "../../../../../src/server/domain/runtime-support.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "summary_template", { id: "mine", user_id: "alice", builtin: 0, name: "mine", current_version: 1 });
  insertRow(db, "asr_provider_profile", { id: "asr", user_id: "alice", name: "ElevenLabs", provider: "elevenlabs", models_json: '[{"modelId":"scribe_v2"}]', created_at: T0 });
});

const full: UserSettings = {
  userId: "alice",
  theme: "dark",
  language: "en",
  defaultSummaryTemplateId: "mine",
  shortcuts: { omnibox: "Alt+K" },
  chatModelRef: { providerProfileId: "p", modelId: "a" },
  defaultModelRef: { providerProfileId: "p", modelId: "b" },
  defaultAsrModelRef: { asrProfileId: "asr", modelId: "scribe_v2" },
  defaultOutputLanguage: "ja",
  platformCookieBrowser: "edge",
  chatWebSearchMode: "auto",
  updatedAt: T0,
};

const get = (owner: string) => repository.withTransaction((scope) => scope.userSettings.get(owner));

describe("user settings repository", () => {
  it("reads values outside the known sets as unset, as a restored backup may hold them", () => {
    insertRow(db, "user_settings", {
      user_id: "alice", theme: "blue", language: "zh-CN", shortcuts_json: "{}", platform_cookie_browser: "chrome:/tmp/elsewhere", chat_web_search_mode: "force", updated_at: T0,
    });
    expect(get("alice")).toEqual({ userId: "alice", theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: T0 });
  });

  it("round-trips the eye-care themes", () => {
    for (const theme of ["bean-green", "parchment"] as const) {
      repository.withTransaction((scope) => scope.userSettings.put({ ...full, theme }));
      expect(get("alice")?.theme).toBe(theme);
    }
  });

  it("round-trips every field per owner, and absent optional fields stay absent", () => {
    repository.withTransaction((scope) => scope.userSettings.put(full));
    expect(get("alice")).toEqual(full);
    expect(get("bob")).toBeUndefined();
    const minimal: UserSettings = { userId: "bob", theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: T0 };
    repository.withTransaction((scope) => scope.userSettings.put(minimal));
    expect(get("bob")).toEqual(minimal);
  });

  it("clears the default ASR model for its profile, or only when it names a model outside the kept ones", () => {
    repository.withTransaction((scope) => scope.userSettings.put(full));
    repository.withTransaction((scope) => scope.userSettings.clearAsrModelRefs("alice", "asr", ["scribe_v2", "scribe_v2_medical"]));
    expect(get("alice")?.defaultAsrModelRef).toEqual(full.defaultAsrModelRef);
    repository.withTransaction((scope) => scope.userSettings.clearAsrModelRefs("bob", "asr"));
    repository.withTransaction((scope) => scope.userSettings.clearAsrModelRefs("alice", "other"));
    expect(get("alice")?.defaultAsrModelRef).toEqual(full.defaultAsrModelRef);
    repository.withTransaction((scope) => scope.userSettings.clearAsrModelRefs("alice", "asr", ["scribe_v2_medical"]));
    expect(get("alice")).not.toHaveProperty("defaultAsrModelRef");
    expect(get("alice")?.defaultModelRef).toEqual(full.defaultModelRef);
    repository.withTransaction((scope) => scope.userSettings.put(full));
    repository.withTransaction((scope) => scope.userSettings.clearAsrModelRefs("alice", "asr"));
    expect(get("alice")).not.toHaveProperty("defaultAsrModelRef");
  });

  it("clears model references to a Profile, or only those outside the kept models", () => {
    repository.withTransaction((scope) => scope.userSettings.put(full));
    repository.withTransaction((scope) => scope.userSettings.clearModelRefs("alice", "p", ["b"]));
    expect(get("alice")).not.toHaveProperty("chatModelRef");
    expect(get("alice")?.defaultModelRef).toEqual(full.defaultModelRef);
    repository.withTransaction((scope) => scope.userSettings.clearModelRefs("bob", "p"));
    expect(get("alice")?.defaultModelRef).toEqual(full.defaultModelRef);
    repository.withTransaction((scope) => scope.userSettings.clearModelRefs("alice", "other"));
    expect(get("alice")?.defaultModelRef).toEqual(full.defaultModelRef);
    repository.withTransaction((scope) => scope.userSettings.clearModelRefs("alice", "p"));
    expect(get("alice")).not.toHaveProperty("defaultModelRef");
  });

  it("clears the default template only when it names that template", () => {
    repository.withTransaction((scope) => scope.userSettings.put(full));
    repository.withTransaction((scope) => scope.userSettings.clearDefaultTemplate("alice", "summary.core"));
    expect(get("alice")?.defaultSummaryTemplateId).toBe("mine");
    repository.withTransaction((scope) => scope.userSettings.clearDefaultTemplate("alice", "mine"));
    expect(get("alice")).not.toHaveProperty("defaultSummaryTemplateId");
  });
});
