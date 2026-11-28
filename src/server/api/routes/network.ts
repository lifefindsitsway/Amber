import type { FastifyInstance } from "fastify";
import { networkStatusDtoSchema, type NetworkStatusDto } from "../../../shared/dto/network.ts";
import type { RunMode } from "../../../shared/enums.ts";
import type { NetworkStatusReader } from "../../ports/network-route.ts";
import { principalOf } from "../auth.ts";
import { sendValidated } from "../validation.ts";

/**
 * `GET /api/network/status`: the proxy configuration state and the outcome of the latest request
 * that went through the proxy, read only and never probed. The proxy address is the machine
 * owner's own setting in local mode; a server keeps its deployment's address to itself.
 */
export function registerNetworkRoutes(app: FastifyInstance, deps: { network: NetworkStatusReader; mode: RunMode }): void {
  app.get("/api/network/status", async (request, reply) => {
    principalOf(request);
    const status = deps.network.status();
    const body: NetworkStatusDto = deps.mode === "local" ? status : withoutProxy(status);
    return sendValidated(reply, 200, networkStatusDtoSchema, body);
  });
}

function withoutProxy(status: NetworkStatusDto): NetworkStatusDto {
  const { proxy: _proxy, ...rest } = status;
  return rest;
}
