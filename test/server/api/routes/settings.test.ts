import { afterEach, describe, expect, it } from "vitest";
import { THEME_DEFAULT, UI_LANGUAGE_DEFAULT } from "../../../../src/shared/defaults.ts";
import { userSettingsDtoSchema } from "../../../../src/shared/dto/settings.ts";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const { app } = await h.app();
  return { h, app };
}

describe("/api/settings", () => {
  it("reads the caller's defaults, merges a patch and keeps users apart", async () => {
    const { app } = await setup();
    const read = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(read.statusCode).toBe(200);
    expect(userSettingsDtoSchema.parse(read.json())).toMatchObject({ theme: THEME_DEFAULT, language: UI_LANGUAGE_DEFAULT, shortcuts: {} });

    const patched = await app.inject({ method: "PATCH", url: "/api/settings", headers: auth, payload: { theme: "dark", shortcuts: { omnibox: "Alt+K" } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ theme: "dark", shortcuts: { omnibox: "Alt+K" } });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json()).toMatchObject({ theme: "dark" });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: bob })).json()).toMatchObject({ theme: THEME_DEFAULT });
  });

  it("stores an eye-care theme", async () => {
    const { app } = await setup();
    const patched = await app.inject({ method: "PATCH", url: "/api/settings", headers: auth, payload: { theme: "parchment" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ theme: "parchment" });
    const read = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(userSettingsDtoSchema.parse(read.json())).toMatchObject({ theme: "parchment" });
  });

  it("remembers the chat's web search setting until it is cleared; a one-off search is not a setting", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json()).not.toHaveProperty("chatWebSearchMode");
    const patched = await app.inject({ method: "PATCH", url: "/api/settings", headers: auth, payload: { chatWebSearchMode: "auto" } });
    expect(patched.json()).toMatchObject({ chatWebSearchMode: "auto" });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json()).toMatchObject({ chatWebSearchMode: "auto" });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: bob })).json()).not.toHaveProperty("chatWebSearchMode");
    expect((await app.inject({ method: "PATCH", url: "/api/settings", headers: auth, payload: { chatWebSearchMode: "force" } })).statusCode).toBe(400);
    await app.inject({ method: "PATCH", url: "/api/settings", headers: auth, payload: { chatWebSearchMode: null } });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json()).not.toHaveProperty("chatWebSearchMode");
  });

  it("rejects unknown fields, bad values and reserved shortcuts with 400", async () => {
    const { app } = await setup();
    for (const payload of [{ updatedAt: 1 }, { theme: "blue" }, { shortcuts: { paste: "Ctrl+V" } }, { shortcuts: { omnibox: "Ctrl+W" } }, { language: "!!" }]) {
      const response = await app.inject({ method: "PATCH", url: "/api/settings", headers: auth, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.class).toBe("invalid_request");
    }
  });

  it("requires authentication", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
  });
});
