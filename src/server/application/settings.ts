import { THEME_DEFAULT, UI_LANGUAGE_DEFAULT } from "../../shared/defaults.ts";
import type { UserSettingsDto, UserSettingsPatch } from "../../shared/dto/settings.ts";
import { effectiveShortcuts, normalizeShortcut, SHORTCUT_ACTIONS, SHORTCUT_DEFAULTS, shortcutProblems, type ShortcutAction } from "../../shared/shortcuts.ts";
import { amberError } from "../domain/errors.ts";
import type { AsrModelRef, ModelRef } from "../domain/model-ref.ts";
import type { UserSettings } from "../domain/runtime-support.ts";
import { canonicalLanguageTag } from "../domain/subtitle-file.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import { asrModelRefProblem, modelRefProblem } from "../pipeline/requirements.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";

export interface SettingsServiceOptions {
  repository: Repository;
  now?: () => number;
}

/** What a user who never saved preferences has: the named defaults. */
export function defaultSettings(userId: string, now: number): UserSettings {
  return { userId, theme: THEME_DEFAULT, language: UI_LANGUAGE_DEFAULT, shortcuts: {}, updatedAt: now };
}

/**
 * The output language a new Task freezes when the request names none: the user's default
 * output language, else their interface language, else `UI_LANGUAGE_DEFAULT`. Reading never
 * creates the settings row.
 */
export function outputLanguageFor(scope: RepositoryScope, owner: string, requested: string | undefined): string {
  if (requested !== undefined) {
    return requested;
  }
  const settings = scope.userSettings.get(owner);
  return settings?.defaultOutputLanguage ?? settings?.language ?? UI_LANGUAGE_DEFAULT;
}

/** The user's default summary template, if they chose one. */
export function defaultSummaryTemplateIdOf(scope: RepositoryScope, owner: string): string | undefined {
  return scope.userSettings.get(owner)?.defaultSummaryTemplateId;
}

/**
 * The ASR model a submission is frozen with: the requested one, which
 * must name a model of one of the owner's profiles, else none. The user's default is never
 * applied here: like `modelRef`, it is only a picker's initial value, so "not now" chosen in
 * the UI stays not chosen.
 */
export function asrModelRefForSubmission(scope: RepositoryScope, owner: string, requested: AsrModelRef | undefined, detail = "asrModelRef"): AsrModelRef | undefined {
  if (requested === undefined) {
    return undefined;
  }
  const problem = asrModelRefProblem(scope, owner, requested);
  if (problem !== undefined) {
    invalid(detail, problem);
  }
  return { asrProfileId: requested.asrProfileId, modelId: requested.modelId };
}

/** Settings as returned; a default ASR model that no longer names one of the owner's is left out. */
function toDto(scope: RepositoryScope, settings: UserSettings): UserSettingsDto {
  const { userId: owner, shortcuts, defaultAsrModelRef, ...rest } = settings;
  const usable = defaultAsrModelRef !== undefined && asrModelRefProblem(scope, owner, defaultAsrModelRef) === undefined;
  return { ...rest, ...(usable ? { defaultAsrModelRef } : {}), shortcuts: { ...shortcuts } };
}

function invalid(detail: string, message: string): never {
  throw amberError("invalid_request", message, { params: { detail } });
}

function languageTag(value: string, detail: string): string {
  const tag = canonicalLanguageTag(value);
  return tag ?? invalid(detail, "not a BCP-47 language tag");
}

/**
 * User preferences, `GET / PATCH /api/settings`. The row is created lazily with the named
 * defaults on the first read or write; a PATCH merges field by field, `null` clears an
 * optional field and a `null` shortcut returns to its default.
 */
export class SettingsService {
  private readonly options: SettingsServiceOptions;
  private readonly now: () => number;

  constructor(options: SettingsServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get(principal: RequestPrincipal): UserSettingsDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => toDto(scope, this.ensure(scope, owner)));
  }

  patch(principal: RequestPrincipal, body: UserSettingsPatch): UserSettingsDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const next: UserSettings = { ...this.ensure(scope, owner), updatedAt: this.now() };
      if (body.theme !== undefined) {
        next.theme = body.theme;
      }
      if (body.language !== undefined) {
        next.language = languageTag(body.language, "language");
      }
      if (body.defaultOutputLanguage !== undefined) {
        assign(next, "defaultOutputLanguage", body.defaultOutputLanguage === null ? undefined : languageTag(body.defaultOutputLanguage, "defaultOutputLanguage"));
      }
      if (body.defaultSummaryTemplateId !== undefined) {
        if (body.defaultSummaryTemplateId !== null) {
          const template = scope.summaryTemplates.get(owner, body.defaultSummaryTemplateId);
          if (template === undefined || template.deletedAt !== undefined) {
            invalid("defaultSummaryTemplateId", "no usable summary template with this id");
          }
        }
        assign(next, "defaultSummaryTemplateId", body.defaultSummaryTemplateId ?? undefined);
      }
      for (const field of ["chatModelRef", "defaultModelRef"] as const) {
        const value = body[field];
        if (value === undefined) {
          continue;
        }
        if (value !== null) {
          const problem = modelRefProblem(scope, owner, value);
          if (problem !== undefined) {
            invalid(field, problem);
          }
        }
        assign(next, field, value === null ? undefined : ({ providerProfileId: value.providerProfileId, modelId: value.modelId } satisfies ModelRef));
      }
      if (body.platformCookieBrowser !== undefined) {
        assign(next, "platformCookieBrowser", body.platformCookieBrowser ?? undefined);
      }
      if (body.chatWebSearchMode !== undefined) {
        assign(next, "chatWebSearchMode", body.chatWebSearchMode ?? undefined);
      }
      if (body.shortcuts !== undefined) {
        next.shortcuts = mergeShortcuts(next.shortcuts, body.shortcuts);
      }
      if (body.defaultAsrModelRef !== undefined) {
        const value = body.defaultAsrModelRef;
        if (value !== null) {
          const problem = asrModelRefProblem(scope, owner, value);
          if (problem !== undefined) {
            invalid("defaultAsrModelRef", problem);
          }
        }
        assign(next, "defaultAsrModelRef", value === null ? undefined : ({ asrProfileId: value.asrProfileId, modelId: value.modelId } satisfies AsrModelRef));
      }
      scope.userSettings.put(next);
      return toDto(scope, next);
    });
  }

  private ensure(scope: RepositoryScope, owner: string): UserSettings {
    const existing = scope.userSettings.get(owner);
    if (existing !== undefined) {
      return existing;
    }
    const created = defaultSettings(owner, this.now());
    scope.userSettings.put(created);
    return created;
  }
}

/** Sets or removes an optional field so that `exactOptionalPropertyTypes` holds. */
function assign<K extends keyof UserSettings>(settings: UserSettings, key: K, value: UserSettings[K] | undefined): void {
  if (value === undefined) {
    delete settings[key];
  } else {
    settings[key] = value;
  }
}

/**
 * Applies shortcut changes and validates the complete effective binding: each combination
 * is well formed, not reserved by the browser, and bound to one action only. Stored
 * overrides equal to the default are dropped, so a default change later reaches the user.
 */
function mergeShortcuts(
  current: Partial<Record<ShortcutAction, string>>,
  changes: Partial<Record<ShortcutAction, string | null>>,
): Partial<Record<ShortcutAction, string>> {
  const merged: Partial<Record<ShortcutAction, string>> = { ...current };
  for (const action of SHORTCUT_ACTIONS) {
    const change = changes[action];
    if (change === undefined) {
      continue;
    }
    if (change === null) {
      delete merged[action];
      continue;
    }
    const combo = normalizeShortcut(change);
    if (combo === undefined) {
      invalid(`shortcuts.${action}`, "not a key combination");
    }
    merged[action] = combo;
  }
  const effective = effectiveShortcuts(merged);
  const problems = shortcutProblems(effective);
  const first = SHORTCUT_ACTIONS.find((action) => problems[action] !== undefined);
  if (first !== undefined) {
    invalid(`shortcuts.${first}`, `shortcut is ${problems[first]}`);
  }
  for (const action of SHORTCUT_ACTIONS) {
    if (merged[action] === SHORTCUT_DEFAULTS[action]) {
      delete merged[action];
    }
  }
  return merged;
}
