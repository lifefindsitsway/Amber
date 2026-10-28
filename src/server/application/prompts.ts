import type { PromptDto, PromptListDto, PromptUpdateRequest, PromptVersionListDto } from "../../shared/dto/prompt.ts";
import { amberError } from "../domain/errors.ts";
import { CUSTOMIZABLE_PROMPTS, customizablePrompt, validatePromptText, type CustomizablePrompt } from "../domain/prompts.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";

export { freezePromptRefs, type PromptRefMap } from "../pipeline/prompts.ts";

export interface PromptServiceOptions {
  repository: Repository;
  now?: () => number;
}

function entryOf(promptId: string): CustomizablePrompt {
  const entry = customizablePrompt(promptId);
  if (entry === undefined) {
    throw amberError("not_found", `prompt ${promptId}`);
  }
  return entry;
}

function promptDto(scope: RepositoryScope, owner: string, entry: CustomizablePrompt): PromptDto {
  const currentVersion = scope.promptOverrides.get(owner, entry.id)?.currentVersion;
  const current = currentVersion === undefined ? undefined : scope.promptOverrides.getVersion(owner, entry.id, currentVersion);
  return {
    id: entry.id,
    nameKey: entry.nameKey,
    descriptionKey: entry.descriptionKey,
    slots: [...entry.slots],
    protocol: [...entry.protocol],
    builtin: { version: entry.builtin.ref.version, text: entry.builtin.text },
    ...(current === undefined ? {} : { current: { version: current.version, text: current.text, createdAt: current.createdAt } }),
    customized: current !== undefined,
  };
}

/**
 * The user's own versions of the customizable system prompts. Saving a text appends a
 * version and makes it current (the same text as the current one adds none); restoring the
 * builtin only clears the current version, so every version stays readable and every frozen
 * `custom:` ref resolvable. A change reaches new Tasks, re-run stages and new answers only.
 */
export class PromptService {
  private readonly options: PromptServiceOptions;
  private readonly now: () => number;

  constructor(options: PromptServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  list(principal: RequestPrincipal): PromptListDto {
    return this.options.repository.withTransaction((scope) => ({
      items: CUSTOMIZABLE_PROMPTS.map((entry) => promptDto(scope, principal.userId, entry)),
    }));
  }

  /**
   * The check only makes sure the model still receives what the parsers rely on; a text that
   * passes may still produce poor results or failures.
   */
  update(principal: RequestPrincipal, promptId: string, body: PromptUpdateRequest): PromptDto {
    const entry = entryOf(promptId);
    const problems = validatePromptText(entry, body.text);
    if (problems !== undefined) {
      throw amberError("invalid_request", "the prompt text does not keep its placeholders and protocol", {
        code: "invalid_request.prompt_protocol",
        details: problems,
      });
    }
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const currentVersion = scope.promptOverrides.get(owner, entry.id)?.currentVersion;
      const current = currentVersion === undefined ? undefined : scope.promptOverrides.getVersion(owner, entry.id, currentVersion);
      if (current?.text !== body.text) {
        const latest = scope.promptOverrides.listVersions(owner, entry.id).at(-1)?.version ?? 0;
        scope.promptOverrides.addVersion({ userId: owner, promptId: entry.id, version: latest + 1, text: body.text, createdAt: this.now() });
      }
      return promptDto(scope, owner, entry);
    });
  }

  /** Back to the builtin text; the user's versions stay. */
  restore(principal: RequestPrincipal, promptId: string): PromptDto {
    const entry = entryOf(promptId);
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      if (scope.promptOverrides.get(owner, entry.id)?.currentVersion !== undefined) {
        scope.promptOverrides.clearCurrent(owner, entry.id, this.now());
      }
      return promptDto(scope, owner, entry);
    });
  }

  versions(principal: RequestPrincipal, promptId: string): PromptVersionListDto {
    const entry = entryOf(promptId);
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const currentVersion = scope.promptOverrides.get(owner, entry.id)?.currentVersion;
      return {
        items: scope.promptOverrides
          .listVersions(owner, entry.id)
          .map((version) => ({ version: version.version, text: version.text, createdAt: version.createdAt, current: version.version === currentVersion })),
      };
    });
  }
}
