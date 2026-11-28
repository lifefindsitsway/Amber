import { afterEach, describe, expect, it } from "vitest";
import { fromProxyEnv, fromSystemMessage } from "../../../../src/server/adapters/system-proxy/config.ts";
import { SystemProxyState } from "../../../../src/server/adapters/system-proxy/state.ts";
import { registerNetworkRoutes } from "../../../../src/server/api/routes/network.ts";
import type { RunMode } from "../../../../src/shared/enums.ts";
import { networkStatusDtoSchema } from "../../../../src/shared/dto/network.ts";
import { createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(state: SystemProxyState, mode: RunMode) {
  const h = createHarness();
  open.push(h);
  const { app } = await h.app({ extraRoutes: (instance) => registerNetworkRoutes(instance, { network: state, mode }) });
  return app;
}

describe("GET /api/network/status", () => {
  it("reports the configuration and the latest proxied outcome, which a configuration change drops", async () => {
    let clock = 5_000;
    const manual = (seq: number) => ({ v: 1 as const, type: "system_proxy" as const, seq, config: { state: "manual" as const, http: "127.0.0.1:7890", https: "127.0.0.1:7890", bypass: [] } });
    const state = new SystemProxyState(fromSystemMessage(manual(1)), { now: () => clock });
    const app = await setup(state, "local");
    const read = async () => {
      const response = await app.inject({ method: "GET", url: "/api/network/status", headers: auth });
      expect(response.statusCode).toBe(200);
      return networkStatusDtoSchema.parse(response.json());
    };
    expect(await read()).toEqual({ source: "system", state: "manual", proxy: { http: "127.0.0.1:7890", https: "127.0.0.1:7890" } });

    state.recordProxyOutcome(1, false);
    expect((await read()).lastProxyOutcome).toEqual({ ok: false, at: 5_000, seq: 1 });
    clock = 6_000;
    state.recordProxyOutcome(1, true);
    expect((await read()).lastProxyOutcome).toEqual({ ok: true, at: 6_000, seq: 1 });
    state.recordProxyOutcome(1, false);
    state.apply(manual(2));
    expect(await read()).toEqual({ source: "system", state: "manual", proxy: { http: "127.0.0.1:7890", https: "127.0.0.1:7890" } });

    expect((await app.inject({ method: "GET", url: "/api/network/status" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/network/status", headers: auth })).statusCode).toBe(404);
  });

  it("keeps the proxy address and its credentials out in server mode", async () => {
    const state = new SystemProxyState(fromProxyEnv({ HTTPS_PROXY: "http://proxy-user:proxy-pass@10.0.0.8:3128" }));
    state.recordProxyOutcome(0, false);
    const server = await setup(state, "server");
    const response = await server.inject({ method: "GET", url: "/api/network/status", headers: auth });
    expect(response.json()).toEqual({ source: "env", state: "manual", lastProxyOutcome: { ok: false, at: expect.any(Number), seq: 0 } });
    expect(response.body).not.toMatch(/10\.0\.0\.8|proxy-user|proxy-pass/);

    const local = await setup(state, "local");
    const body = (await local.inject({ method: "GET", url: "/api/network/status", headers: auth })).body;
    expect(JSON.parse(body)).toMatchObject({ proxy: { https: "10.0.0.8:3128" } });
    expect(body).not.toMatch(/proxy-user|proxy-pass/);
  });
});
