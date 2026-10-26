import { z } from "zod";
import { CHAT_WEB_SEARCH_SETTINGS } from "../enums.ts";
import { SHORTCUT_ACTIONS } from "../shortcuts.ts";
import { asrModelRefSchema, modelRefSchema } from "./model-ref.ts";

/** Order is the menu order and the cycle of the "toggle theme" command. */
export const THEMES = ["light", "dark", "bean-green", "parchment"] as const;
export type Theme = (typeof THEMES)[number];
export const COOKIE_BROWSERS = ["firefox", "chrome", "edge"] as const;

const shortcutOverridesSchema = z.partialRecord(z.enum(SHORTCUT_ACTIONS), z.string().min(1));

/**
 * `GET /api/settings`. `shortcuts` holds only the stored overrides;
 * the effective binding is `effectiveShortcuts(shortcuts)`.
 */
export const userSettingsDtoSchema = z.object({
  theme: z.enum(THEMES),
  language: z.string().min(1),
  defaultSummaryTemplateId: z.string().min(1).exactOptional(),
  shortcuts: shortcutOverridesSchema,
  chatModelRef: modelRefSchema.exactOptional(),
  defaultModelRef: modelRefSchema.exactOptional(),
  /** Absent = not set; pickers then start with nothing chosen. */
  defaultAsrModelRef: asrModelRefSchema.exactOptional(),
  defaultOutputLanguage: z.string().min(1).exactOptional(),
  platformCookieBrowser: z.enum(COOKIE_BROWSERS).exactOptional(),
  /** The chat's remembered web search setting; absent = off. */
  chatWebSearchMode: z.enum(CHAT_WEB_SEARCH_SETTINGS).exactOptional(),
  updatedAt: z.number().int().nonnegative(),
});
export type UserSettingsDto = z.infer<typeof userSettingsDtoSchema>;

/**
 * `PATCH /api/settings`: merged field by field; `null` clears an optional field, and a
 * `null` shortcut returns that action to its default.
 */
export const userSettingsPatchSchema = z
  .object({
    theme: z.enum(THEMES).exactOptional(),
    language: z.string().min(1).exactOptional(),
    defaultSummaryTemplateId: z.string().min(1).nullable().exactOptional(),
    shortcuts: z.partialRecord(z.enum(SHORTCUT_ACTIONS), z.string().min(1).nullable()).exactOptional(),
    chatModelRef: modelRefSchema.nullable().exactOptional(),
    defaultModelRef: modelRefSchema.nullable().exactOptional(),
    defaultAsrModelRef: asrModelRefSchema.nullable().exactOptional(),
    defaultOutputLanguage: z.string().min(1).nullable().exactOptional(),
    platformCookieBrowser: z.enum(COOKIE_BROWSERS).nullable().exactOptional(),
    chatWebSearchMode: z.enum(CHAT_WEB_SEARCH_SETTINGS).nullable().exactOptional(),
  })
  .strict();
export type UserSettingsPatch = z.infer<typeof userSettingsPatchSchema>;
