import {
  usageActivitiesQuerySchema,
  usageCallsQuerySchema,
  usageSummaryQuerySchema,
} from "../../../src/shared/dto/usage-analytics.ts";
import { activitiesResponse, cacheObservedResponse, callsResponse, summaryResponse } from "./engine.ts";
import type { FixtureScenario } from "./types.ts";

export interface UsageReply {
  status: number;
  body: unknown;
}

const BAD_REQUEST: UsageReply = {
  status: 400,
  body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "" } },
};

const SERVER_ERROR: UsageReply = {
  status: 500,
  body: { error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } },
};

/**
 * Answers one `GET /api/usage/*` request of the page from a scenario, validating the query with
 * the same schemas the server uses, so a page that asks for something the contract forbids fails.
 * `undefined` for paths that are not usage analysis.
 */
export function usageReply(scenario: FixtureScenario, pathWithQuery: string): UsageReply | undefined {
  const url = new URL(pathWithQuery, "http://localhost");
  const route = /^\/api\/usage\/(summary|activities|calls|cache-observed)$/.exec(url.pathname)?.[1];
  if (route === undefined) return undefined;
  if (scenario.failing === true) return SERVER_ERROR;
  const params = Object.fromEntries(url.searchParams);
  switch (route) {
    case "summary": {
      const query = usageSummaryQuerySchema.safeParse(params);
      return query.success ? { status: 200, body: summaryResponse(scenario, query.data) } : BAD_REQUEST;
    }
    case "activities": {
      const query = usageActivitiesQuerySchema.safeParse(params);
      return query.success ? { status: 200, body: activitiesResponse(scenario, query.data) } : BAD_REQUEST;
    }
    case "calls": {
      const query = usageCallsQuerySchema.safeParse(params);
      return query.success ? { status: 200, body: callsResponse(scenario, query.data) } : BAD_REQUEST;
    }
    default:
      return { status: 200, body: cacheObservedResponse(scenario) };
  }
}
