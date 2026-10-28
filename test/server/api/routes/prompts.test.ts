import { afterEach, describe, expect, it } from "vitest";
import { CHAPTER_AI_PROMPT, PROOFREAD_AUDIO_PROMPT, PROOFREAD_TEXT_PROMPT } from "../../../../src/server/domain/prompts.ts";
import { PROMPT_CUSTOM_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import { EXPECTED_CUSTOMIZABLE_PROMPTS, EXPECTED_PROMPTS } from "../../../fixtures/spec/prompts.ts";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const { app } = await h.app();
  return { h, app };
}

interface PromptItem {
  id: string;
  nameKey: string;
  slots: string[];
  protocol: string[];
  builtin: { version: number; text: string };
  current?: { version: number; text: string; createdAt: number };
  customized: boolean;
}

const CHAPTER = CHAPTER_AI_PROMPT.text;
const custom = (suffix: string) => `${CHAPTER}\n${suffix}`;

describe("/api/prompts", () => {
  it("lists the thirteen customizable prompts with their builtin text, slots and protocol fragments", async () => {
    const { app } = await setup();
    const listed = await app.inject({ method: "GET", url: "/api/prompts", headers: auth });
    expect(listed.statusCode).toBe(200);
    const items = listed.json().items as PromptItem[];
    expect(items.map((item) => ({ id: item.id, protocol: item.protocol }))).toEqual(EXPECTED_CUSTOMIZABLE_PROMPTS);
    for (const item of items) {
      const expected = EXPECTED_PROMPTS.find((prompt) => prompt.id === item.id);
      expect(item.builtin, item.id).toEqual({ version: expected?.version, text: expected?.text });
      expect(item.customized).toBe(false);
      expect(item).not.toHaveProperty("current");
    }
    const audio = items.find((item) => item.id === "proofread.audio");
    expect(audio?.builtin.version).toBe(6);
    expect(audio?.slots).toEqual(["{{proofread_text}}"]);
    expect(items.find((item) => item.id === "chapter.ai")?.slots).toEqual(["{{window_note}}", "{{output_language}}", "{{transcript_with_aliases}}"]);
  });

  it("refuses a text missing or adding a slot, missing a protocol fragment, empty or too long", async () => {
    const { app } = await setup();
    const put = (id: string, text: string) => app.inject({ method: "PUT", url: `/api/prompts/${id}`, headers: auth, payload: { text } });
    const cases: Array<[string, string, { missing: string[]; unknown: string[] }]> = [
      ["chapter.ai", CHAPTER.replace("{{transcript_with_aliases}}", ""), { missing: ["{{transcript_with_aliases}}"], unknown: [] }],
      ["chapter.ai", custom("{{tone}}"), { missing: [], unknown: ["{{tone}}"] }],
      ["chapter.ai", CHAPTER.replace('"startAlias"', '"start"'), { missing: ['"startAlias"'], unknown: [] }],
      ["chapter.ai", custom("字".repeat(PROMPT_CUSTOM_MAX_CHARS)), { missing: [], unknown: [] }],
      ["proofread.audio", "请对照音频校对。", { missing: ["{{proofread_text}}"], unknown: [] }],
      ["proofread.text", PROOFREAD_TEXT_PROMPT.text.replaceAll("¶", "§"), { missing: ["¶"], unknown: [] }],
    ];
    for (const [id, text, details] of cases) {
      const refused = await put(id, text);
      expect(refused.statusCode, text.slice(-30)).toBe(400);
      expect(refused.json().error).toMatchObject({ class: "invalid_request", code: "invalid_request.prompt_protocol", details });
    }
    const empty = await put("chapter.ai", "  ");
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("invalid_request.prompt_protocol");
    expect(empty.json().error.details.missing).toContain("只输出 JSON");
    const listed = (await app.inject({ method: "GET", url: "/api/prompts", headers: auth })).json().items as PromptItem[];
    expect(listed.every((item) => !item.customized)).toBe(true);
  });

  it("saves a version that becomes current, adds none for the same text, restores the builtin keeping the versions", async () => {
    const { app } = await setup();
    const put = (text: string) => app.inject({ method: "PUT", url: "/api/prompts/chapter.ai", headers: auth, payload: { text } });
    const saved = await put(custom("标题尽量短。"));
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ id: "chapter.ai", customized: true, current: { version: 1, text: custom("标题尽量短。") } });
    expect((await put(custom("标题尽量短。"))).json().current.version).toBe(1);
    expect((await put(custom("标题不超过 10 字。"))).json().current).toMatchObject({ version: 2, text: custom("标题不超过 10 字。") });

    const restored = await app.inject({ method: "DELETE", url: "/api/prompts/chapter.ai", headers: auth });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ customized: false, builtin: { version: 2, text: CHAPTER } });
    expect(restored.json()).not.toHaveProperty("current");
    // Restoring twice is harmless.
    expect((await app.inject({ method: "DELETE", url: "/api/prompts/chapter.ai", headers: auth })).statusCode).toBe(200);

    const versions = await app.inject({ method: "GET", url: "/api/prompts/chapter.ai/versions", headers: auth });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().items.map((item: { version: number; text: string; current: boolean }) => [item.version, item.text, item.current])).toEqual([
      [1, custom("标题尽量短。"), false],
      [2, custom("标题不超过 10 字。"), false],
    ]);
    // Saving again after a restore continues the numbering, even with an earlier text.
    expect((await put(custom("标题尽量短。"))).json().current.version).toBe(3);
    const after = (await app.inject({ method: "GET", url: "/api/prompts/chapter.ai/versions", headers: auth })).json().items;
    expect(after.map((item: { version: number; current: boolean }) => [item.version, item.current])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it("composes nothing on save: the audio preamble keeps only its own slot", async () => {
    const { app } = await setup();
    const preamble = PROOFREAD_AUDIO_PROMPT.text.replace("以音频为准。", "以音频为准，专有名词尤其如此。");
    const saved = await app.inject({ method: "PUT", url: "/api/prompts/proofread.audio", headers: auth, payload: { text: preamble } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().current.text).toBe(preamble);
  });

  it("answers not_found for an unknown or non-customizable id and keeps each user's prompts to themselves", async () => {
    const { app } = await setup();
    for (const id of ["nope", "citation.repair", "chat.search.plan"]) {
      expect((await app.inject({ method: "GET", url: `/api/prompts/${id}/versions`, headers: auth })).json().error.class).toBe("not_found");
      expect((await app.inject({ method: "PUT", url: `/api/prompts/${id}`, headers: auth, payload: { text: "x" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/prompts/${id}`, headers: auth })).statusCode).toBe(404);
    }
    await app.inject({ method: "PUT", url: "/api/prompts/chapter.ai", headers: auth, payload: { text: custom("本人的。") } });
    const bobs = (await app.inject({ method: "GET", url: "/api/prompts", headers: bob })).json().items as PromptItem[];
    expect(bobs.find((item) => item.id === "chapter.ai")).toMatchObject({ customized: false });
    expect((await app.inject({ method: "GET", url: "/api/prompts/chapter.ai/versions", headers: bob })).json().items).toEqual([]);
    // Bob restoring his builtin leaves the local user's version in effect.
    await app.inject({ method: "DELETE", url: "/api/prompts/chapter.ai", headers: bob });
    const mine = (await app.inject({ method: "GET", url: "/api/prompts", headers: auth })).json().items as PromptItem[];
    expect(mine.find((item) => item.id === "chapter.ai")?.current?.text).toBe(custom("本人的。"));
    expect((await app.inject({ method: "GET", url: "/api/prompts" })).statusCode).toBe(401);
  });
});
