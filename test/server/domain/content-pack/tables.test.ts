import { afterAll, describe, expect, it } from "vitest";
import { PACK_TABLE_ROLES } from "../../../../src/server/domain/content-pack/tables.ts";
import { openTempDatabase } from "../../../tools/sqlite.ts";

const opened = openTempDatabase();
afterAll(() => opened.db.close());

describe("content pack table roles", () => {
  it("places every table of the migrated library exactly once", () => {
    const tables = (opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index_%' ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    const placed = [...PACK_TABLE_ROLES.carried, ...PACK_TABLE_ROLES.dependency, ...PACK_TABLE_ROLES.not_carried];
    expect(placed.filter((name, index) => placed.indexOf(name) !== index), "placed twice").toEqual([]);
    expect(tables.filter((name) => !placed.includes(name as never)), "tables without a role").toEqual([]);
    expect(placed.filter((name) => !tables.includes(name)), "roles for tables that do not exist").toEqual([]);
  });
});
