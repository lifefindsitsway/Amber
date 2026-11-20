import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0035: the preset an LLM profile was created from", () => {
  it("adds an empty preset to existing profiles and leaves everything else as it was", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const before = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 34) });
    insertRow(before.db, "user", { id: "alice", role: "user", status: "active", created_at: T0 });
    insertRow(before.db, "provider_profile", { id: "p", user_id: "alice", name: "relay", protocol: "openai_compatible", base_url: "https://api.moonshot.cn/v1", created_at: T0 });
    insertRow(before.db, "model_capability", { profile_id: "p", model_id: "m", position: 0, flags_declared_json: "{}", limits_declared_json: "{}" });
    before.db.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 35) });
    expect({ from, to }).toEqual({ from: 34, to: 35 });
    // An official address is not taken as a vendor: a relay may sit behind the same host name.
    expect(db.prepare("SELECT id, base_url, preset_id FROM provider_profile").all()).toEqual([{ id: "p", base_url: "https://api.moonshot.cn/v1", preset_id: null }]);
    const profile = new SqliteRepository(db).withTransaction((scope) => scope.providerProfiles.get("alice", "p"));
    expect(profile).toMatchObject({ id: "p", baseURL: "https://api.moonshot.cn/v1", models: [{ modelId: "m" }] });
    expect(profile).not.toHaveProperty("presetId");
    db.close();
  });
});
