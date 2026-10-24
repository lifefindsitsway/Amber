import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../src/server/adapters/sqlite/migrations.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import {
  defaultInstanceSettings,
  ensureInstanceSettings,
  InstanceSettingsService,
  readInstanceSettingsEnv,
} from "../../../src/server/application/instance-settings.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { CONCURRENCY_PIPELINE, CONCURRENCY_PIPELINE_MAX, MAX_DATA_GB } from "../../../src/shared/defaults.ts";
import { instanceSettingsDtoSchema, instanceSettingsPatchSchema } from "../../../src/shared/dto/instance-settings.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows, insertRow, tempDataDir } from "../../tools/sqlite.ts";

const open: Harness[] = [];
function harness(): Harness {
  const created = createHarness();
  open.push(created);
  return created;
}
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

describe("instance settings", () => {
  it("writes the named defaults once and never overwrites an existing row", () => {
    const h = harness();
    expect(ensureInstanceSettings(h.repository, () => 5)).toEqual(defaultInstanceSettings(5));
    h.db.prepare("UPDATE instance_settings SET concurrency_pipeline = 4").run();
    expect(ensureInstanceSettings(h.repository, () => 9).concurrencyPipeline).toBe(4);
    expect(countRows(h.db, "instance_settings")).toBe(1);
  });

  it("reads environment overrides and refuses invalid ones", () => {
    expect(readInstanceSettingsEnv({ AMBER_CONCURRENCY_PIPELINE: "4", AMBER_UPLOAD_RETENTION_DEFAULT: "discard_after_audio", AMBER_MAX_DATA_GB: "" })).toEqual({
      concurrencyPipeline: 4,
      uploadRetentionDefault: "discard_after_audio",
    });
    expect(() => readInstanceSettingsEnv({ AMBER_CONCURRENCY_PIPELINE: "0" })).toThrow(/AMBER_CONCURRENCY_PIPELINE/);
    expect(() => readInstanceSettingsEnv({ AMBER_LOW_WATER_FREE_RATIO: "1.5" })).toThrow(/AMBER_LOW_WATER_FREE_RATIO/);
    expect(() => readInstanceSettingsEnv({ AMBER_UPLOAD_RETENTION_DEFAULT: "never_delete" })).toThrow();
  });

  it("accepts the concurrency override up to its limit and refuses one more", () => {
    expect(readInstanceSettingsEnv({ AMBER_CONCURRENCY_PIPELINE: String(CONCURRENCY_PIPELINE_MAX) })).toEqual({ concurrencyPipeline: CONCURRENCY_PIPELINE_MAX });
    expect(() => readInstanceSettingsEnv({ AMBER_CONCURRENCY_PIPELINE: String(CONCURRENCY_PIPELINE_MAX + 1) })).toThrow(/AMBER_CONCURRENCY_PIPELINE/);
  });

  it.each(["AMBER_CONCURRENCY_HEAVY", "AMBER_CONCURRENCY_LLM"])("refuses to start while the removed %s is set, naming it", (name) => {
    for (const value of ["2", "0", "abc"]) {
      expect(() => readInstanceSettingsEnv({ [name]: value })).toThrow(new RegExp(`${name} is no longer supported and must be removed`));
    }
    expect(() => readInstanceSettingsEnv({ AMBER_CONCURRENCY_PIPELINE: "2", [name]: "3" })).toThrow(new RegExp(name));
    // Unset or blank counts as absent, like every other instance-setting variable.
    expect(readInstanceSettingsEnv({ [name]: "" })).toEqual({});
    expect(readInstanceSettingsEnv({ [name]: "  " })).toEqual({});
  });

  it("rejects a patch that carries a removed concurrency setting", () => {
    for (const payload of [{ concurrencyHeavy: 2 }, { concurrencyLlm: 2 }, { concurrencyPipeline: 2, concurrencyHeavy: 2 }]) {
      expect(instanceSettingsPatchSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });

  it("reads a stored concurrency above its limit as the limit and writes the limit back on the next save", () => {
    const h = harness();
    // A row written before the limits existed; the table only checks `>= 1`.
    ensureInstanceSettings(h.repository);
    h.db
      .prepare("UPDATE instance_settings SET concurrency_pipeline = ?")
      .run(CONCURRENCY_PIPELINE_MAX + 3);
    const service = new InstanceSettingsService({ repository: h.repository, overrides: {} });
    const limits = { concurrencyPipeline: CONCURRENCY_PIPELINE_MAX };
    expect(service.effective()).toMatchObject(limits);
    const dto = service.get(LOCAL);
    expect(dto).toMatchObject(limits);
    expect(instanceSettingsDtoSchema.safeParse(dto).success).toBe(true);
    const stored = () => h.repository.withTransaction((scope) => scope.instanceSettings.get());
    expect(stored()).toMatchObject({ concurrencyPipeline: CONCURRENCY_PIPELINE_MAX + 3 });
    // Any save, even of another field, writes the clamped values back.
    expect(service.patch(LOCAL, { maxDataGB: MAX_DATA_GB + 1 })).toMatchObject(limits);
    expect(stored()).toMatchObject(limits);
  });

  it("lets the environment win, marks those keys read-only and rejects patching them", () => {
    const h = harness();
    let changes = 0;
    const service = new InstanceSettingsService({ repository: h.repository, overrides: { concurrencyPipeline: 5 }, onChange: () => (changes += 1) });
    const dto = service.get(LOCAL);
    expect(dto).toMatchObject({ concurrencyPipeline: 5, envOverridden: ["concurrencyPipeline"] });
    expect(dto).not.toHaveProperty("concurrencyHeavy");
    expect(dto).not.toHaveProperty("concurrencyLlm");
    expect(codeOf(() => service.patch(LOCAL, { concurrencyPipeline: 1 }))).toBe("conflict.setting_env_overridden");

    const patched = service.patch(LOCAL, { maxDataGB: MAX_DATA_GB + 5, lowWaterFreeRatio: 0.3 });
    expect(patched).toMatchObject({ maxDataGB: MAX_DATA_GB + 5, lowWaterFreeRatio: 0.3, concurrencyPipeline: 5 });
    expect(service.effective().lowWaterFreeRatio).toBe(0.3);
    expect(changes).toBe(1);
    const stored = h.repository.withTransaction((scope) => scope.instanceSettings.get());
    expect(stored).toMatchObject({ maxDataGB: MAX_DATA_GB + 5, lowWaterFreeRatio: 0.3, concurrencyPipeline: CONCURRENCY_PIPELINE });
  });

  it("is for administrators only", () => {
    const h = harness();
    expect(codeOf(() => h.settings.get(BOB))).toBe("forbidden");
    expect(codeOf(() => h.settings.patch(BOB, { concurrencyPipeline: 3 }))).toBe("forbidden");
  });

  it("keeps the cache root and the migration marker out of the DTO, even when set", () => {
    const h = harness();
    const marker = { id: "m1", from: "/data", to: "/mnt/Amber Cache", phase: "copying" as const };
    h.settings.updateCacheRoot({ cacheRoot: "/mnt/Amber Cache", cacheMigration: marker });
    const dto = h.settings.get(LOCAL);
    expect(dto).not.toHaveProperty("cacheRoot");
    expect(dto).not.toHaveProperty("cacheMigration");
    expect(dto).not.toHaveProperty("credentialsResetAt");
    expect(instanceSettingsDtoSchema.safeParse(dto).success).toBe(true);
    expect(h.settings.patch(LOCAL, { concurrencyPipeline: 3 })).not.toHaveProperty("cacheRoot");
    // A patch of the editable fields leaves the cache fields as they were.
    expect(h.settings.effective()).toMatchObject({ concurrencyPipeline: 3, cacheRoot: "/mnt/Amber Cache", cacheMigration: marker });
  });

  it("updateCacheRoot writes through and refreshes the cached effective settings at once", () => {
    const h = harness();
    expect(h.settings.effective().cacheRoot).toBeUndefined();
    const marker = { id: "m1", from: "/data", to: "/mnt/Amber Cache", phase: "cleanup_pending" as const };
    const updated = h.settings.updateCacheRoot({ cacheRoot: "/mnt/Amber Cache", cacheMigration: marker });
    expect(updated).toMatchObject({ cacheRoot: "/mnt/Amber Cache", cacheMigration: marker });
    expect(h.settings.effective()).toMatchObject({ cacheRoot: "/mnt/Amber Cache", cacheMigration: marker });
    expect(h.repository.withTransaction((scope) => scope.instanceSettings.get())).toMatchObject({ cacheRoot: "/mnt/Amber Cache", cacheMigration: marker });
    expect(h.db.prepare("SELECT cache_root AS root, cache_migration_json AS marker FROM instance_settings").get()).toEqual({
      root: "/mnt/Amber Cache",
      marker: JSON.stringify(marker),
    });

    // An explicit `undefined` clears a field; an absent key leaves it alone.
    h.settings.updateCacheRoot({ cacheMigration: undefined });
    expect(h.settings.effective()).toMatchObject({ cacheRoot: "/mnt/Amber Cache" });
    expect(h.settings.effective().cacheMigration).toBeUndefined();
    h.settings.updateCacheRoot({ cacheRoot: undefined });
    expect(h.settings.effective().cacheRoot).toBeUndefined();
    expect(h.db.prepare("SELECT cache_root AS root FROM instance_settings").get()).toEqual({ root: null });
  });

  it("fails closed on a corrupt migration marker", () => {
    const h = harness();
    h.settings.effective();
    h.db.prepare("UPDATE instance_settings SET cache_migration_json = ?").run(JSON.stringify({ id: "m", phase: "flying" }));
    expect(() => h.repository.withTransaction((scope) => scope.instanceSettings.get())).toThrow(/cache migration marker/);
  });

  it("keeps a low-water ratio saved by an earlier version through the upgrade, while a fresh instance starts at 0", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    // The settings row as the version before the archive and cache-quality migrations left it.
    const { db: previous } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 19) });
    insertRow(previous, "instance_settings", {
      id: 1, concurrency_pipeline: 2, max_data_gb: 30, low_water_free_gb: 10, low_water_free_ratio: 0.2,
      upload_retention_default: "keep", updated_at: 1_790_000_000_000,
    });
    previous.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    try {
      expect({ from, to }).toEqual({ from: 19, to: latestSchemaVersion() });
      const service = new InstanceSettingsService({ repository: new SqliteRepository(db), overrides: {} });
      expect(service.effective().lowWaterFreeRatio).toBe(0.2);
      expect(service.get(LOCAL).lowWaterFreeRatio).toBe(0.2);
      expect(db.prepare("SELECT low_water_free_ratio AS ratio FROM instance_settings").get()).toEqual({ ratio: 0.2 });
    } finally {
      db.close();
    }

    const fresh = harness();
    expect(fresh.settings.effective().lowWaterFreeRatio).toBe(0);
    expect(fresh.db.prepare("SELECT low_water_free_ratio AS ratio FROM instance_settings").get()).toEqual({ ratio: 0 });
  });
});
