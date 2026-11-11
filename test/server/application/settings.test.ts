import { afterEach, describe, expect, it } from "vitest";
import { ASR_DIARIZATION_DEFAULT, THEME_DEFAULT, UI_LANGUAGE_DEFAULT } from "../../../src/shared/defaults.ts";
import { ProviderService } from "../../../src/server/application/providers.ts";
import { defaultSummaryTemplateIdOf, outputLanguageFor } from "../../../src/server/application/settings.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { BOB, configureLlm, createHarness, createLocalContent, LOCAL, taskOf, type Harness } from "../../fixtures/pipeline/harness.ts";
import { seedTranscripts } from "../../fixtures/pipeline/summary-data.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

/** The error code and, for `invalid_request`, the offending field named in the user message. */
function errorOf(work: () => unknown): { code: string; detail?: string } | undefined {
  try {
    work();
  } catch (error) {
    if (isAmberError(error)) {
      const detail = /(shortcuts\.\w+|defaultSummaryTemplateId|defaultOutputLanguage|defaultModelRef|defaultAsrModelRef|chatModelRef|language)/.exec(error.appError.userMessage)?.[1];
      return { code: error.appError.code, ...(detail === undefined ? {} : { detail }) };
    }
    throw error;
  }
  return undefined;
}

const rowCount = (h: Harness) => (h.db.prepare("SELECT count(*) AS n FROM user_settings").get() as { n: number }).n;

describe("reading settings", () => {
  it("creates the row lazily with the named defaults, per user", () => {
    const h = harness();
    expect(rowCount(h)).toBe(0);
    const settings = h.userSettings.get(LOCAL);
    expect(settings).toMatchObject({ theme: THEME_DEFAULT, language: UI_LANGUAGE_DEFAULT, shortcuts: {} });
    expect(Object.keys(settings)).not.toContain("defaultModelRef");
    expect(rowCount(h)).toBe(1);
    h.userSettings.patch(LOCAL, { theme: "dark" });
    expect(h.userSettings.get(BOB).theme).toBe(THEME_DEFAULT);
    expect(rowCount(h)).toBe(2);
  });
});

describe("patching settings", () => {
  it("merges field by field and clears an optional field with null", () => {
    const h = harness();
    h.userSettings.patch(LOCAL, { theme: "dark", defaultOutputLanguage: "en-us", platformCookieBrowser: "chrome" });
    const merged = h.userSettings.patch(LOCAL, { language: "zh-cn" });
    expect(merged).toMatchObject({ theme: "dark", language: "zh-CN", defaultOutputLanguage: "en-US", platformCookieBrowser: "chrome" });
    const cleared = h.userSettings.patch(LOCAL, { defaultOutputLanguage: null, platformCookieBrowser: null });
    expect(Object.keys(cleared)).not.toContain("defaultOutputLanguage");
    expect(Object.keys(cleared)).not.toContain("platformCookieBrowser");
    expect(h.userSettings.get(LOCAL)).toEqual(cleared);
  });

  it("refuses a malformed language tag", () => {
    const h = harness();
    expect(errorOf(() => h.userSettings.patch(LOCAL, { language: "not a tag" }))).toEqual({ code: "invalid_request", detail: "language" });
    expect(errorOf(() => h.userSettings.patch(LOCAL, { defaultOutputLanguage: "??" }))).toEqual({ code: "invalid_request", detail: "defaultOutputLanguage" });
  });

  it("normalizes shortcuts, drops overrides equal to the default and refuses reserved, malformed or shared keys", () => {
    const h = harness();
    expect(h.userSettings.patch(LOCAL, { shortcuts: { omnibox: "alt+k" } }).shortcuts).toEqual({ omnibox: "Alt+K" });
    expect(h.userSettings.patch(LOCAL, { shortcuts: { newSummary: "Ctrl+Shift+O" } }).shortcuts).toEqual({ omnibox: "Alt+K" });
    expect(h.userSettings.patch(LOCAL, { shortcuts: { omnibox: null } }).shortcuts).toEqual({});

    expect(errorOf(() => h.userSettings.patch(LOCAL, { shortcuts: { omnibox: "Ctrl+T" } }))).toEqual({ code: "invalid_request", detail: "shortcuts.omnibox" });
    expect(errorOf(() => h.userSettings.patch(LOCAL, { shortcuts: { omnibox: "Ctrl+Alt+K" } }))).toEqual({ code: "invalid_request", detail: "shortcuts.omnibox" });
    expect(errorOf(() => h.userSettings.patch(LOCAL, { shortcuts: { shortcutHelp: "K" } }))).toEqual({ code: "invalid_request", detail: "shortcuts.shortcutHelp" });
    expect(errorOf(() => h.userSettings.patch(LOCAL, { shortcuts: { newSummary: "Ctrl+K" } }))).toMatchObject({ code: "invalid_request" });
    expect(h.userSettings.get(LOCAL).shortcuts).toEqual({});
  });

  it("accepts only usable templates and the user's own models", () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const custom = h.summaryTemplates.create(LOCAL, { name: "Mine", prompt: "# mine" });
    expect(h.userSettings.patch(LOCAL, { defaultSummaryTemplateId: custom.id, defaultModelRef: modelRef, chatModelRef: modelRef })).toMatchObject({
      defaultSummaryTemplateId: custom.id,
      defaultModelRef: modelRef,
      chatModelRef: modelRef,
    });
    expect(errorOf(() => h.userSettings.patch(BOB, { defaultSummaryTemplateId: custom.id }))).toEqual({ code: "invalid_request", detail: "defaultSummaryTemplateId" });
    expect(errorOf(() => h.userSettings.patch(BOB, { defaultModelRef: modelRef }))).toEqual({ code: "invalid_request", detail: "defaultModelRef" });
    expect(errorOf(() => h.userSettings.patch(LOCAL, { chatModelRef: { ...modelRef, modelId: "missing" } }))).toEqual({ code: "invalid_request", detail: "chatModelRef" });
    expect(h.userSettings.patch(LOCAL, { defaultSummaryTemplateId: "summary.terms" }).defaultSummaryTemplateId).toBe("summary.terms");
  });
});

describe("the speaker identification setting", () => {
  it("starts at the named default, is changed by a patch and round-trips through reads", () => {
    const h = harness();
    expect(h.userSettings.get(LOCAL).asrDiarization).toBe(ASR_DIARIZATION_DEFAULT);
    const off = h.userSettings.patch(LOCAL, { asrDiarization: !ASR_DIARIZATION_DEFAULT });
    expect(off.asrDiarization).toBe(!ASR_DIARIZATION_DEFAULT);
    expect(h.userSettings.get(LOCAL).asrDiarization).toBe(!ASR_DIARIZATION_DEFAULT);
    // Other fields leave it alone, and a patch is per user.
    h.userSettings.patch(LOCAL, { theme: "dark" });
    expect(h.userSettings.get(LOCAL).asrDiarization).toBe(!ASR_DIARIZATION_DEFAULT);
    expect(h.userSettings.get(BOB).asrDiarization).toBe(ASR_DIARIZATION_DEFAULT);
    expect(h.userSettings.patch(LOCAL, { asrDiarization: ASR_DIARIZATION_DEFAULT }).asrDiarization).toBe(ASR_DIARIZATION_DEFAULT);
  });
});

describe("the default ASR model", () => {
  const asrProfile = (h: Harness, userId: string, id: string): void =>
    h.repository.withTransaction((scope) =>
      scope.asrProfiles.insert({ id, userId, name: id, provider: "dashscope", models: [{ modelId: "fun-asr" }, { modelId: "qwen-audio-3.1-asr-flash-filetrans" }], createdAt: 1 }),
    );

  it("starts unset, accepts only a listed model of the user's own profile, clears with null, and is never set by creating a profile", () => {
    const h = harness();
    asrProfile(h, LOCAL.userId, "mine");
    asrProfile(h, BOB.userId, "bobs");
    const mine = { asrProfileId: "mine", modelId: "fun-asr" };
    expect(Object.keys(h.userSettings.get(LOCAL))).not.toContain("defaultAsrModelRef");
    expect(h.userSettings.patch(LOCAL, { defaultAsrModelRef: mine }).defaultAsrModelRef).toEqual(mine);
    expect(errorOf(() => h.userSettings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: "bobs", modelId: "fun-asr" } }))).toEqual({ code: "invalid_request", detail: "defaultAsrModelRef" });
    expect(errorOf(() => h.userSettings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: "missing", modelId: "fun-asr" } }))).toEqual({ code: "invalid_request", detail: "defaultAsrModelRef" });
    expect(errorOf(() => h.userSettings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: "mine", modelId: "scribe_v2" } }))).toEqual({ code: "invalid_request", detail: "defaultAsrModelRef" });
    expect(h.userSettings.get(LOCAL).defaultAsrModelRef).toEqual(mine);
    expect(Object.keys(h.userSettings.patch(LOCAL, { defaultAsrModelRef: null }))).not.toContain("defaultAsrModelRef");
  });

  it("is not shown when the stored reference no longer names a listed model of one of the user's profiles", () => {
    const h = harness();
    asrProfile(h, BOB.userId, "bobs");
    asrProfile(h, LOCAL.userId, "mine");
    h.userSettings.get(LOCAL);
    // Written behind the service's back: the read side still refuses another user's profile.
    const write = (ref: unknown) => h.db.prepare("UPDATE user_settings SET default_asr_model_ref_json = ? WHERE user_id = ?").run(JSON.stringify(ref), LOCAL.userId);
    write({ asrProfileId: "bobs", modelId: "fun-asr" });
    expect(Object.keys(h.userSettings.get(LOCAL))).not.toContain("defaultAsrModelRef");
    write({ asrProfileId: "mine", modelId: "scribe_v2" });
    expect(Object.keys(h.userSettings.get(LOCAL))).not.toContain("defaultAsrModelRef");
  });
});

describe("references cleared with their target", () => {
  it("soft-deleting the default template clears it in the same transaction", () => {
    const h = harness();
    const custom = h.summaryTemplates.create(LOCAL, { name: "Mine", prompt: "# mine" });
    h.userSettings.patch(LOCAL, { defaultSummaryTemplateId: custom.id });
    h.summaryTemplates.delete(LOCAL, custom.id);
    expect(Object.keys(h.userSettings.get(LOCAL))).not.toContain("defaultSummaryTemplateId");
  });

  it("removing a model clears choices naming it, deleting the Profile clears every choice naming it", () => {
    const h = harness();
    const providers = new ProviderService({
      repository: h.repository,
      secrets: h.secrets,
      prober: { probe: async () => Promise.reject(new Error("not probed here")) },
      newId: h.newId,
    });
    const profile = providers.create(LOCAL, {
      name: "relay",
      protocol: "openai_compatible",
      baseURL: "https://llm.invalid/v1",
      models: [{ modelId: "a", contextWindowTokens: 1000 }, { modelId: "b", contextWindowTokens: 1000 }],
    });
    const a = { providerProfileId: profile.id, modelId: "a" };
    const b = { providerProfileId: profile.id, modelId: "b" };
    h.userSettings.patch(LOCAL, { chatModelRef: a, defaultModelRef: b });

    providers.update(LOCAL, profile.id, { models: [{ modelId: "b", contextWindowTokens: 1000 }] });
    const afterUpdate = h.userSettings.get(LOCAL);
    expect(Object.keys(afterUpdate)).not.toContain("chatModelRef");
    expect(afterUpdate.defaultModelRef).toEqual(b);

    providers.delete(LOCAL, profile.id);
    expect(Object.keys(h.userSettings.get(LOCAL))).not.toContain("defaultModelRef");
  });
});

describe("default chains", () => {
  it("resolve the output language from the request, the default output language, the interface language, then UI_LANGUAGE_DEFAULT", () => {
    const h = harness();
    const read = (requested?: string) => h.repository.withTransaction((scope) => outputLanguageFor(scope, LOCAL.userId, requested));
    expect(read()).toBe(UI_LANGUAGE_DEFAULT);
    expect(rowCount(h)).toBe(0);
    h.userSettings.patch(LOCAL, { language: "en" });
    expect(read()).toBe("en");
    h.userSettings.patch(LOCAL, { defaultOutputLanguage: "ja" });
    expect(read()).toBe("ja");
    expect(read("fr")).toBe("fr");
    expect(h.repository.withTransaction((scope) => defaultSummaryTemplateIdOf(scope, LOCAL.userId))).toBeUndefined();
  });

  it("are frozen by summaries and chapter regeneration", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const contentId = createLocalContent(h);
    seedTranscripts(h, contentId);
    h.userSettings.patch(LOCAL, { defaultOutputLanguage: "en" });

    // The API names the template explicitly; only the language comes from the chain.
    const summary = await h.summaries.create(LOCAL, contentId, { templateId: "summary.core", modelRef });
    expect(JSON.parse(taskOf(h, summary.body.taskId).requestJson)).toMatchObject({ outputLanguage: "en", templateRef: { id: "summary.core", version: 1 } });
    await h.tasks.cancel(LOCAL, summary.body.taskId);

    const chapters = await h.derivedTasks.regenerateChapters(LOCAL, contentId, { modelRef });
    expect(JSON.parse(taskOf(h, chapters.body.taskId).requestJson)).toMatchObject({ outputLanguage: "en" });
  });
});
