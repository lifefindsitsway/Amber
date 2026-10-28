import { afterEach, describe, expect, it } from "vitest";
import { ensureBuiltinSummaryTemplates, resolveTemplateRef } from "../../../src/server/application/summary-templates.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { BUILTIN_SUMMARY_TEMPLATES } from "../../../src/server/domain/prompts.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { EXPECTED_SUMMARY_TEMPLATE_HISTORY } from "../../fixtures/spec/prompts.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

describe("builtin templates", () => {
  it("are synced from the code once, named by i18n key, and visible to every user", () => {
    const h = harness();
    ensureBuiltinSummaryTemplates(h.repository, 2);
    const items = h.summaryTemplates.list(LOCAL).items;
    expect(items).toEqual(
      BUILTIN_SUMMARY_TEMPLATES.map((template) => ({ id: template.id, builtin: true, name: template.nameKey, currentVersion: template.version, deleted: false })),
    );
    expect(h.summaryTemplates.list(BOB).items.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(h.summaryTemplates.versions(LOCAL, "summary.core").items).toEqual([
      { templateId: "summary.core", version: 1, prompt: BUILTIN_SUMMARY_TEMPLATES[0]?.prompt, createdAt: 1 },
    ]);
  });

  it("move to a raised version at startup and keep the earlier version's row", () => {
    const h = harness();
    const v1 = EXPECTED_SUMMARY_TEMPLATE_HISTORY.find((entry) => entry.id === "summary.detailed" && entry.version === 1);
    expect(v1).toBeDefined();
    h.repository.withTransaction((scope) =>
      scope.summaryTemplates.syncBuiltin([{ id: "summary.detailed", name: "summaryTemplate.detailed", versions: [{ version: 1, prompt: v1?.prompt as string }] }], 1),
    );
    ensureBuiltinSummaryTemplates(h.repository, 2);
    const current = BUILTIN_SUMMARY_TEMPLATES.find((template) => template.id === "summary.detailed");
    expect(current?.version).toBe(2);
    expect(h.summaryTemplates.list(LOCAL).items.find((item) => item.id === "summary.detailed")?.currentVersion).toBe(2);
    expect(h.summaryTemplates.versions(LOCAL, "summary.detailed").items.map(({ version, prompt }) => ({ version, prompt }))).toEqual([
      { version: 1, prompt: v1?.prompt },
      { version: 2, prompt: current?.prompt },
    ]);
  });

  it("cannot be changed or deleted", () => {
    const h = harness();
    expect(codeOf(() => h.summaryTemplates.patch(LOCAL, "summary.core", { name: "x" }))).toBe("forbidden");
    expect(codeOf(() => h.summaryTemplates.delete(LOCAL, "summary.terms"))).toBe("forbidden");
    expect(h.summaryTemplates.list(LOCAL).items.find((item) => item.id === "summary.core")?.currentVersion).toBe(1);
  });
});

describe("custom templates", () => {
  it("add a version only when the prompt changes and keep every old version", () => {
    const h = harness();
    const created = h.summaryTemplates.create(LOCAL, { name: "Mine", prompt: "## 要点" });
    expect(created).toMatchObject({ builtin: false, name: "Mine", currentVersion: 1, deleted: false });

    expect(h.summaryTemplates.patch(LOCAL, created.id, { name: "Renamed" })).toMatchObject({ name: "Renamed", currentVersion: 1 });
    expect(h.summaryTemplates.patch(LOCAL, created.id, { prompt: "## 要点" }).currentVersion).toBe(1);
    expect(h.summaryTemplates.patch(LOCAL, created.id, { prompt: "## 要点与例子" }).currentVersion).toBe(2);
    expect(h.summaryTemplates.versions(LOCAL, created.id).items.map(({ version, prompt }) => ({ version, prompt }))).toEqual([
      { version: 1, prompt: "## 要点" },
      { version: 2, prompt: "## 要点与例子" },
    ]);
    expect(h.repository.withTransaction((scope) => resolveTemplateRef(scope, LOCAL.userId, created.id))).toEqual({ id: created.id, version: 2 });
  });

  it("are soft-deleted: hidden, unusable and read-only, with their versions kept", () => {
    const h = harness();
    const created = h.summaryTemplates.create(LOCAL, { name: "Mine", prompt: "v1" });
    h.summaryTemplates.delete(LOCAL, created.id);
    expect(h.summaryTemplates.list(LOCAL).items.map((item) => item.id)).not.toContain(created.id);
    expect(h.summaryTemplates.versions(LOCAL, created.id).items).toHaveLength(1);
    expect(codeOf(() => h.summaryTemplates.patch(LOCAL, created.id, { prompt: "v2" }))).toBe("not_found");
    expect(codeOf(() => h.summaryTemplates.delete(LOCAL, created.id))).toBe("not_found");
    expect(codeOf(() => h.repository.withTransaction((scope) => resolveTemplateRef(scope, LOCAL.userId, created.id)))).toBe("invalid_request");
  });

  it("belong to their owner only", () => {
    const h = harness();
    const created = h.summaryTemplates.create(LOCAL, { name: "Mine", prompt: "v1" });
    expect(h.summaryTemplates.list(BOB).items.map((item) => item.id)).not.toContain(created.id);
    expect(codeOf(() => h.summaryTemplates.patch(BOB, created.id, { prompt: "v2" }))).toBe("not_found");
    expect(codeOf(() => h.summaryTemplates.delete(BOB, created.id))).toBe("not_found");
    expect(codeOf(() => h.summaryTemplates.versions(BOB, created.id))).toBe("not_found");
    expect(codeOf(() => h.repository.withTransaction((scope) => resolveTemplateRef(scope, BOB.userId, created.id)))).toBe("invalid_request");
  });

  it("resolve to the default template at its current version when none is given", () => {
    const h = harness();
    expect(h.repository.withTransaction((scope) => resolveTemplateRef(scope, LOCAL.userId, undefined))).toEqual({ id: "summary.core", version: 1 });
  });
});
