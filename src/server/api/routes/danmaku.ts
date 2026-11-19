import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { danmakuFetchResultDtoSchema, danmakuSnapshotDtoSchema } from "../../../shared/dto/danmaku.ts";
import type { DanmakuService } from "../../application/danmaku.ts";
import { isAmberError } from "../../domain/errors.ts";
import { principalOf } from "../auth.ts";
import { requestSignal } from "./contents.ts";
import { parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** Danmaku snapshots: reading never reaches the platform; only `fetch` does, once per click. */
export function registerDanmakuRoutes(app: FastifyInstance, deps: { danmaku: DanmakuService }): void {
  app.get("/api/contents/:id/danmaku", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, danmakuSnapshotDtoSchema, deps.danmaku.get(principalOf(request), id));
  });

  app.post("/api/contents/:id/danmaku/fetch", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    try {
      return sendValidated(reply, 200, danmakuFetchResultDtoSchema, await deps.danmaku.fetch(principalOf(request), id, requestSignal(reply)));
    } catch (error) {
      // A cooldown answers 429 with the standard header as well as `details.retryAfterMs`.
      const retryAfterMs = isAmberError(error) && error.appError.code === "rate_limited.danmaku_cooldown" ? error.appError.details?.["retryAfterMs"] : undefined;
      if (typeof retryAfterMs === "number") {
        void reply.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      }
      throw error;
    }
  });
}
