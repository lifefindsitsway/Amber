import { afterAll, describe, expect, it } from "vitest";
import { compose, type Composition, type ComposeConfig } from "../../src/server/compose.ts";
import { tempDataDir } from "../tools/sqlite.ts";
import { API_ROUTES, type RunModeName } from "./routes.ts";

/**
 * The `/api` routes each run mode actually registers, compared with the route list in both
 * directions, fail-closed: a registered route missing from the list fails, and so does a
 * listed route the mode does not register.
 */

function key(method: string, path: string): string {
  return `${method} ${path}`;
}

const composed: Composition[] = [];
afterAll(async () => {
  for (const composition of composed.splice(0)) await composition.shutdown();
});

async function registeredRoutes(mode: RunModeName): Promise<string[]> {
  const dir = tempDataDir("amber-routes-");
  const common = { dataDir: dir, binDir: dir, logLevel: "error" as const, logDestination: { write: () => undefined }, env: {} };
  const config: ComposeConfig =
    mode === "local"
      ? { ...common, mode, token: "t".repeat(64), fileGrantKey: Buffer.alloc(32, 1) }
      : { ...common, mode, publicOrigin: "https://amber.example.com", trustedProxyCidrs: [] };
  const composition = await compose(config);
  composed.push(composition);
  return composition.routes.filter((route) => route.url.startsWith("/api/")).map((route) => key(route.method, route.url.slice("/api".length)));
}

describe("the route list", () => {
  it("names each method and path once", () => {
    const keys = API_ROUTES.map((route) => key(route.method, route.path));
    expect(keys.filter((entry, index) => keys.indexOf(entry) !== index)).toEqual([]);
    expect(keys).toHaveLength(157);
  });

  it("gives every route at least one run mode", () => {
    expect(API_ROUTES.filter((route) => route.modes.length === 0)).toEqual([]);
  });
});

describe.each(["server", "local"] as const)("%s mode routes", (mode) => {
  it("registers exactly the listed routes of the mode", async () => {
    const routes = await registeredRoutes(mode);
    const registered = new Set(routes);
    const expected = new Set(API_ROUTES.filter((route) => route.modes.includes(mode)).map((route) => key(route.method, route.path)));

    expect(routes.filter((route, index) => routes.indexOf(route) !== index), "registered twice").toEqual([]);
    expect([...registered].filter((route) => !expected.has(route)).sort(), "registered but not listed").toEqual([]);
    expect([...expected].filter((route) => !registered.has(route)).sort(), "listed but not registered").toEqual([]);
  });
});
