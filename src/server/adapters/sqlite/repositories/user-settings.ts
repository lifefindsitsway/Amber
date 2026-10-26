import { THEME_DEFAULT } from "../../../../shared/defaults.ts";
import { CHAT_WEB_SEARCH_SETTINGS } from "../../../../shared/enums.ts";
import { COOKIE_BROWSERS, THEMES } from "../../../../shared/dto/settings.ts";
import type { AsrModelRef, ModelRef } from "../../../domain/model-ref.ts";
import type { UserSettings } from "../../../domain/runtime-support.ts";
import type { UserSettingsRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";

interface UserSettingsRow {
  user_id: string;
  theme: string;
  language: string;
  default_summary_template_id: string | null;
  shortcuts_json: string;
  chat_model_ref_json: string | null;
  default_model_ref_json: string | null;
  default_asr_model_ref_json: string | null;
  default_output_language: string | null;
  platform_cookie_browser: string | null;
  chat_web_search_mode: string | null;
  updated_at: number;
}

function modelRefOf(json: string | null): ModelRef | undefined {
  if (json === null) {
    return undefined;
  }
  const { providerProfileId, modelId } = JSON.parse(json) as ModelRef;
  return { providerProfileId, modelId };
}

function asrModelRefOf(json: string | null): AsrModelRef | undefined {
  if (json === null) {
    return undefined;
  }
  const { asrProfileId, modelId } = JSON.parse(json) as AsrModelRef;
  return { asrProfileId, modelId };
}

/**
 * The columns carry no member CHECK, and a restored backup reaches them without the API
 * schemas, so unknown values are read as unset: the theme falls back to its default, the
 * cookie browser, which becomes a yt-dlp argument, is dropped, and the chat's web search
 * setting reads as off.
 */
function toSettings(row: UserSettingsRow): UserSettings {
  const theme = THEMES.find((option) => option === row.theme) ?? THEME_DEFAULT;
  const cookieBrowser = COOKIE_BROWSERS.find((option) => option === row.platform_cookie_browser);
  const chatWebSearchMode = CHAT_WEB_SEARCH_SETTINGS.find((option) => option === row.chat_web_search_mode);
  const chatModelRef = modelRefOf(row.chat_model_ref_json);
  const defaultModelRef = modelRefOf(row.default_model_ref_json);
  const defaultAsrModelRef = asrModelRefOf(row.default_asr_model_ref_json);
  return {
    userId: row.user_id,
    theme,
    language: row.language,
    ...(row.default_summary_template_id === null ? {} : { defaultSummaryTemplateId: row.default_summary_template_id }),
    shortcuts: JSON.parse(row.shortcuts_json) as UserSettings["shortcuts"],
    ...(chatModelRef === undefined ? {} : { chatModelRef }),
    ...(defaultModelRef === undefined ? {} : { defaultModelRef }),
    ...(defaultAsrModelRef === undefined ? {} : { defaultAsrModelRef }),
    ...(row.default_output_language === null ? {} : { defaultOutputLanguage: row.default_output_language }),
    ...(cookieBrowser === undefined ? {} : { platformCookieBrowser: cookieBrowser }),
    ...(chatWebSearchMode === undefined ? {} : { chatWebSearchMode }),
    updatedAt: row.updated_at,
  };
}

const modelRefJson = (ref: ModelRef | undefined): string | null =>
  ref === undefined ? null : JSON.stringify({ providerProfileId: ref.providerProfileId, modelId: ref.modelId });

const asrModelRefJson = (ref: AsrModelRef | undefined): string | null =>
  ref === undefined ? null : JSON.stringify({ asrProfileId: ref.asrProfileId, modelId: ref.modelId });

export function sqliteUserSettingsRepository(db: SqliteConnection): UserSettingsRepository {
  const select = db.prepare("SELECT * FROM user_settings WHERE user_id = ?");
  const put = db.prepare(
    `INSERT OR REPLACE INTO user_settings (
       user_id, theme, language, default_summary_template_id, shortcuts_json, chat_model_ref_json,
       default_model_ref_json, default_asr_model_ref_json, default_output_language, platform_cookie_browser, chat_web_search_mode, updated_at
     ) VALUES (
       @user_id, @theme, @language, @default_summary_template_id, @shortcuts_json, @chat_model_ref_json,
       @default_model_ref_json, @default_asr_model_ref_json, @default_output_language, @platform_cookie_browser, @chat_web_search_mode, @updated_at
     )`,
  );
  // `keep` is a JSON array of model ids that stay valid; NULL clears every reference to the Profile.
  const clearRef = (column: "chat_model_ref_json" | "default_model_ref_json") =>
    db.prepare(
      `UPDATE user_settings SET ${column} = NULL
       WHERE user_id = @owner
         AND json_extract(${column}, '$.providerProfileId') = @profile
         AND (@keep IS NULL OR json_extract(${column}, '$.modelId') NOT IN (SELECT value FROM json_each(@keep)))`,
    );
  const clearChat = clearRef("chat_model_ref_json");
  const clearDefault = clearRef("default_model_ref_json");
  const clearDefaultAsr = db.prepare(
    `UPDATE user_settings SET default_asr_model_ref_json = NULL
     WHERE user_id = @owner
       AND json_extract(default_asr_model_ref_json, '$.asrProfileId') = @profile
       AND (@keep IS NULL OR json_extract(default_asr_model_ref_json, '$.modelId') NOT IN (SELECT value FROM json_each(@keep)))`,
  );
  const clearTemplate = db.prepare(
    "UPDATE user_settings SET default_summary_template_id = NULL WHERE user_id = ? AND default_summary_template_id = ?",
  );

  return {
    get(ownerUserId) {
      const row = select.get(ownerUserId) as UserSettingsRow | undefined;
      return row === undefined ? undefined : toSettings(row);
    },
    put(settings) {
      put.run({
        user_id: settings.userId,
        theme: settings.theme,
        language: settings.language,
        default_summary_template_id: settings.defaultSummaryTemplateId ?? null,
        shortcuts_json: JSON.stringify(settings.shortcuts),
        chat_model_ref_json: modelRefJson(settings.chatModelRef),
        default_model_ref_json: modelRefJson(settings.defaultModelRef),
        default_asr_model_ref_json: asrModelRefJson(settings.defaultAsrModelRef),
        default_output_language: settings.defaultOutputLanguage ?? null,
        platform_cookie_browser: settings.platformCookieBrowser ?? null,
        chat_web_search_mode: settings.chatWebSearchMode ?? null,
        updated_at: settings.updatedAt,
      });
    },
    clearModelRefs(ownerUserId, providerProfileId, keepModelIds) {
      const params = { owner: ownerUserId, profile: providerProfileId, keep: keepModelIds === undefined ? null : JSON.stringify(keepModelIds) };
      clearChat.run(params);
      clearDefault.run(params);
    },
    clearAsrModelRefs(ownerUserId, asrProfileId, keepModelIds) {
      clearDefaultAsr.run({ owner: ownerUserId, profile: asrProfileId, keep: keepModelIds === undefined ? null : JSON.stringify(keepModelIds) });
    },
    clearDefaultTemplate(ownerUserId, templateId) {
      clearTemplate.run(ownerUserId, templateId);
    },
  };
}
