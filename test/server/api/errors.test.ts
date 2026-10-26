import { describe, expect, it } from "vitest";
import { httpStatusOf } from "../../../src/server/api/errors.ts";
import { appError } from "../../../src/server/domain/errors.ts";
import { EXPECTED_ERROR_CLASSES } from "../../fixtures/spec/errors.ts";

/** Classes with their own HTTP status; every other class that can be raised is 422. */
const HTTP_STATUS = [
  ["unauthenticated", 401],
  ["forbidden", 403],
  ["not_found", 404],
  ["invalid_request", 400],
  ["conflict", 409],
  ["idempotency_conflict", 409],
  ["rate_limited", 429],
  ["media_too_large", 413],
  ["disk_low", 507],
  ["storage_quota_exceeded", 507],
  ["internal", 500],
] as const;

describe("httpStatusOf", () => {
  it.each(HTTP_STATUS)("maps %s to %i", (name, status) => {
    expect(httpStatusOf(appError(name))).toBe(status);
  });

  it("maps an unsatisfiable range to 416 although its class is 400", () => {
    expect(httpStatusOf(appError("invalid_request", { code: "invalid_request.range_not_satisfiable" }))).toBe(416);
  });

  it("maps every other business class to 422", () => {
    const mapped = new Set<string>(HTTP_STATUS.map(([name]) => name));
    // Status-only classes are never raised, so they have no HTTP status.
    const business = EXPECTED_ERROR_CLASSES.filter((entry) => entry.retryDisposition !== null && !mapped.has(entry.name));
    expect(business).toHaveLength(27);
    for (const { name } of business) {
      expect([name, httpStatusOf(appError(name))]).toEqual([name, 422]);
    }
  });
});
