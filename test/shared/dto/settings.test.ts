import { describe, expect, it } from "vitest";
import { THEMES, userSettingsDtoSchema, userSettingsPatchSchema } from "../../../src/shared/dto/settings.ts";

describe("settings DTOs", () => {
  it("read back the stored overrides and optional choices", () => {
    const dto = { theme: "light", language: "zh-CN", shortcuts: { omnibox: "Alt+K" }, defaultModelRef: { providerProfileId: "p", modelId: "m" }, asrDiarization: true, updatedAt: 1 };
    expect(userSettingsDtoSchema.parse(dto)).toEqual(dto);
    expect(userSettingsDtoSchema.safeParse({ ...dto, shortcuts: { paste: "Ctrl+V" } }).success).toBe(false);
  });

  it("accept every theme, the eye-care ones included, and nothing else", () => {
    const dto = {
      theme: "light",
      language: "zh-CN",
      defaultSummaryTemplateId: "t",
      shortcuts: { omnibox: "Alt+K" },
      chatModelRef: { providerProfileId: "p", modelId: "chat" },
      defaultModelRef: { providerProfileId: "p", modelId: "m" },
      defaultAsrModelRef: { asrProfileId: "a", modelId: "fun-asr" },
      defaultOutputLanguage: "en",
      platformCookieBrowser: "firefox",
      asrDiarization: false,
      updatedAt: 1,
    };
    expect(THEMES).toEqual(expect.arrayContaining(["bean-green", "parchment"]));
    for (const theme of THEMES) {
      expect(userSettingsPatchSchema.parse({ theme })).toEqual({ theme });
      expect(userSettingsDtoSchema.parse({ ...dto, theme })).toEqual({ ...dto, theme });
    }
    expect(userSettingsPatchSchema.safeParse({ theme: "blue" }).success).toBe(false);
    expect(userSettingsDtoSchema.safeParse({ ...dto, theme: "blue" }).success).toBe(false);
  });

  it("patch with null to clear and refuse unknown or server-owned fields", () => {
    expect(userSettingsPatchSchema.parse({ defaultModelRef: null, shortcuts: { omnibox: null } })).toEqual({ defaultModelRef: null, shortcuts: { omnibox: null } });
    expect(userSettingsPatchSchema.safeParse({ updatedAt: 1 }).success).toBe(false);
    expect(userSettingsPatchSchema.safeParse({ theme: null }).success).toBe(false);
    expect(userSettingsPatchSchema.safeParse({ platformCookieBrowser: "safari" }).success).toBe(false);
  });
});
