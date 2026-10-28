import { describe, expect, it } from "vitest";
import {
  allowedDetailsKeys,
  appErrorSchema,
  CACHE_DIR_REASONS,
  ERROR_ACTIONS,
  ERROR_CLASS_DEFAULTS,
  ERROR_CLASSES,
  REFINED_ERROR_CODE_REGISTRY,
  REFINED_ERROR_CODES,
  RETRY_DISPOSITIONS,
  isCacheDirReason,
  type RefinedErrorCodeSpec,
} from "../../src/shared/errors.ts";
import { cacheDirErrors, refinedErrors } from "../../src/shared/i18n/zh-CN/errors.ts";
import { EXPECTED_CACHE_DIR_REASONS, EXPECTED_ERROR_CLASSES, EXPECTED_REFINED_CODES } from "../fixtures/spec/errors.ts";

describe("error classes", () => {
  it("declares exactly the catalogue classes in catalogue order", () => {
    expect(EXPECTED_ERROR_CLASSES).toHaveLength(43);
    expect([...ERROR_CLASSES]).toEqual(EXPECTED_ERROR_CLASSES.map((entry) => entry.name));
  });

  it.each(EXPECTED_ERROR_CLASSES)("$name defaults to $retryDisposition / $action", ({ name, retryDisposition, action }) => {
    const defaults = ERROR_CLASS_DEFAULTS[name];
    expect({ retryDisposition: defaults.retryDisposition, action: defaults.action ?? null }).toEqual({ retryDisposition, action });
  });

  it("keeps the four retry dispositions and the seven actions", () => {
    expect([...RETRY_DISPOSITIONS]).toEqual(["safe", "policy", "outcome_unknown", "never"]);
    expect([...ERROR_ACTIONS]).toEqual(["retry_stage", "configure_llm", "configure_asr", "configure_web_search", "login_platform", "confirm_resend", "none"]);
  });
});

describe("appErrorSchema", () => {
  const valid = { class: "asr_timeout", code: "asr.timeout", retryDisposition: "outcome_unknown", userMessage: "…" };

  it("accepts a well-formed error", () => {
    expect(appErrorSchema.parse({ ...valid, action: "confirm_resend" })).toEqual({ ...valid, action: "confirm_resend" });
  });

  it("rejects unknown classes and a boolean retry flag", () => {
    expect(appErrorSchema.safeParse({ ...valid, class: "timeout" }).success).toBe(false);
    expect(appErrorSchema.safeParse({ ...valid, retryDisposition: true }).success).toBe(false);
  });

  it("rejects an explicitly undefined optional field", () => {
    expect(appErrorSchema.safeParse({ ...valid, upstreamMessage: undefined }).success).toBe(false);
  });
});

describe("REFINED_ERROR_CODES", () => {
  it("are lower snake `<class>.<detail>` refinements of classes that may be raised", () => {
    for (const code of REFINED_ERROR_CODES) {
      const [errorClass, detail] = code.split(".");
      expect(ERROR_CLASSES).toContain(errorClass);
      expect(detail).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(ERROR_CLASS_DEFAULTS[errorClass as (typeof ERROR_CLASSES)[number]].retryDisposition).not.toBeNull();
    }
  });
});

describe("REFINED_ERROR_CODE_REGISTRY", () => {
  it("registers exactly the catalogue refined codes", () => {
    expect(EXPECTED_REFINED_CODES).toHaveLength(88);
    expect([...REFINED_ERROR_CODES].sort()).toEqual(EXPECTED_REFINED_CODES.map((entry) => entry.code).sort());
  });

  it.each(EXPECTED_REFINED_CODES)("$code carries its details keys and overrides", ({ code, detailsKeys, retryDisposition, action }) => {
    const spec: RefinedErrorCodeSpec = REFINED_ERROR_CODE_REGISTRY[code];
    expect({ detailsKeys: [...allowedDetailsKeys(code)], retryDisposition: spec.retryDisposition ?? null, action: spec.action ?? null }).toEqual({
      detailsKeys: [...detailsKeys],
      retryDisposition,
      action,
    });
  });

  it("overrides the class default for exactly 23 codes", () => {
    const overriding = EXPECTED_REFINED_CODES.filter((entry) => entry.retryDisposition !== null || entry.action !== null).map((entry) => entry.code);
    expect(overriding).toHaveLength(23);
    expect(REFINED_ERROR_CODES.filter((code) => "retryDisposition" in REFINED_ERROR_CODE_REGISTRY[code] || "action" in REFINED_ERROR_CODE_REGISTRY[code]).sort()).toEqual(
      [...overriding].sort(),
    );
  });

  it("overrides only with valid dispositions and actions", () => {
    for (const spec of Object.values(REFINED_ERROR_CODE_REGISTRY)) {
      if ("retryDisposition" in spec) {
        expect(["safe", "policy", "outcome_unknown", "never"]).toContain(spec.retryDisposition);
      }
      if ("action" in spec) {
        expect(["retry_stage", "configure_llm", "configure_asr", "configure_web_search", "login_platform", "confirm_resend", "none"]).toContain(spec.action);
      }
    }
    expect(REFINED_ERROR_CODE_REGISTRY["llm_failed.auth"]).toEqual({ retryDisposition: "never", action: "configure_llm" });
    expect(allowedDetailsKeys("conflict.duplicate_file")).toEqual(["duplicateOfContentId", "trashed"]);
    expect(allowedDetailsKeys("conflict")).toEqual([]);
  });
});

describe("appErrorSchema details", () => {
  const base = { class: "conflict", code: "conflict.duplicate_file", retryDisposition: "never", userMessage: "…" };

  it("accepts registered details keys and rejects unregistered ones", () => {
    expect(appErrorSchema.safeParse({ ...base, details: { duplicateOfContentId: "01J" } }).success).toBe(true);
    expect(appErrorSchema.safeParse({ ...base, details: { path: "/tmp/x" } }).success).toBe(false);
    expect(appErrorSchema.safeParse({ ...base, code: "conflict", details: { duplicateOfContentId: "01J" } }).success).toBe(false);
    expect(appErrorSchema.safeParse({ ...base, details: { duplicateOfContentId: { nested: true } } }).success).toBe(false);
  });
});

describe("invalid_request.cache_dir", () => {
  it("is registered with a reason detail and fills its message from the reason text", () => {
    expect(REFINED_ERROR_CODE_REGISTRY["invalid_request.cache_dir"]).toEqual({ detailsKeys: ["reason"] });
    expect(allowedDetailsKeys("invalid_request.cache_dir")).toEqual(["reason"]);
    expect(refinedErrors["invalid_request.cache_dir"]).toBe("{{message}}");
  });

  it("has a short, device-neutral text for every reason and for an unknown one", () => {
    for (const key of [...CACHE_DIR_REASONS, "unknown"] as const) {
      const text = cacheDirErrors[key];
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[A-Za-z]:\\/);
      expect(text).not.toMatch(/[A-Z] 盘/);
    }
    expect(Object.keys(cacheDirErrors).sort()).toEqual([...CACHE_DIR_REASONS, "unknown"].sort());
  });

  it("lists exactly the catalogue reasons", () => {
    expect([...CACHE_DIR_REASONS]).toEqual([...EXPECTED_CACHE_DIR_REASONS]);
  });

  it("accepts only the listed reasons", () => {
    for (const reason of CACHE_DIR_REASONS) expect(isCacheDirReason(reason)).toBe(true);
    for (const value of ["unknown", "", "NOT_EMPTY", 1, undefined]) expect(isCacheDirReason(value)).toBe(false);
  });
});
