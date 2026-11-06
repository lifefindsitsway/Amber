import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PAGE_SIZE_DEFAULT, API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import { usageDtoSchema } from "../../../shared/dto/usage.ts";
import {
  usageActivitiesQuerySchema,
  usageActivitiesResponseSchema,
  usageCacheObservedResponseSchema,
  usageCallsQuerySchema,
  usageCallsResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
} from "../../../shared/dto/usage-analytics.ts";
import { TOKEN_USAGE_FEATURES } from "../../../shared/enums.ts";
import type { UsageAnalyticsService } from "../../application/usage-analytics.ts";
import type { UsageService } from "../../application/usage.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const timeSchema = z.coerce.number().int().nonnegative();
const usageQuerySchema = z
  .object({
    from: timeSchema.exactOptional(),
    to: timeSchema.exactOptional(),
    feature: z.enum(TOKEN_USAGE_FEATURES).exactOptional(),
    cursor: z.string().min(1).exactOptional(),
    limit: z.coerce.number().int().min(1).max(API_PAGE_SIZE_MAX).default(API_PAGE_SIZE_DEFAULT),
  })
  .strict();

/** `GET /api/usage`, and the analyses under `/api/usage/` when the analytics service is composed in. */
export function registerUsageRoutes(app: FastifyInstance, deps: { usage: UsageService; analytics?: UsageAnalyticsService }): void {
  app.get("/api/usage", async (request, reply) => {
    const query = parseInput(usageQuerySchema, request.query, "query");
    return sendValidated(reply, 200, usageDtoSchema, deps.usage.list(principalOf(request), query));
  });
  const analytics = deps.analytics;
  if (analytics === undefined) {
    return;
  }
  app.get("/api/usage/summary", async (request, reply) => {
    const query = parseInput(usageSummaryQuerySchema, request.query, "query");
    return sendValidated(reply, 200, usageSummaryResponseSchema, analytics.summary(principalOf(request), query));
  });
  app.get("/api/usage/activities", async (request, reply) => {
    const query = parseInput(usageActivitiesQuerySchema, request.query, "query");
    return sendValidated(reply, 200, usageActivitiesResponseSchema, analytics.activities(principalOf(request), query));
  });
  app.get("/api/usage/calls", async (request, reply) => {
    const query = parseInput(usageCallsQuerySchema, request.query, "query");
    return sendValidated(reply, 200, usageCallsResponseSchema, analytics.calls(principalOf(request), query));
  });
  app.get("/api/usage/cache-observed", async (request, reply) => {
    parseInput(z.object({}).strict(), request.query, "query");
    return sendValidated(reply, 200, usageCacheObservedResponseSchema, analytics.cacheObserved(principalOf(request)));
  });
}
