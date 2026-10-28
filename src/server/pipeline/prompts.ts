import type { TaskKind } from "../../shared/enums.ts";
import type { PromptRef } from "../domain/model-ref.ts";
import {
  builtinPromptOf,
  customizablePrompt,
  customPromptIdOf,
  customPromptRef,
  promptIdsOf,
  type CustomizablePromptId,
  type ResolvedPrompt,
} from "../domain/prompts.ts";
import type { RepositoryScope } from "../ports/repository.ts";

/** Prompt versions by prompt id, as frozen on a Task request or a stage input. */
export type PromptRefMap = Record<string, PromptRef>;

function entryOf(id: CustomizablePromptId) {
  const entry = customizablePrompt(id);
  if (entry === undefined) {
    throw new TypeError(`${id} is not a customizable prompt`);
  }
  return entry;
}

/** The version of `id` in effect for `owner` now: their own current version, else the builtin one. */
export function effectivePromptRef(scope: RepositoryScope, owner: string, id: CustomizablePromptId): PromptRef {
  const current = scope.promptOverrides.get(owner, id)?.currentVersion;
  return current === undefined ? entryOf(id).builtin.ref : customPromptRef(id, current);
}

/**
 * The versions of every prompt a Task of `kind` uses, as in effect for `owner` now: what a
 * new Task freezes into `requestJson.promptRefs`, and what a re-run failed stage freezes
 * into its new attempt's input. Empty for kinds that send no customizable prompt.
 */
export function freezePromptRefs(scope: RepositoryScope, owner: string, kind: TaskKind): PromptRefMap {
  return Object.fromEntries(promptIdsOf(kind).map((id) => [id, effectivePromptRef(scope, owner, id)]));
}

/**
 * The text of a prompt version: the owner's own version for a `custom:` ref, else the
 * builtin one, current or historical. `undefined` when it cannot be found.
 */
export function promptTextOf(scope: RepositoryScope, owner: string, ref: PromptRef): string | undefined {
  const customId = customPromptIdOf(ref);
  if (customId !== undefined) {
    return scope.promptOverrides.getVersion(owner, customId, ref.version)?.text;
  }
  return builtinPromptOf(ref)?.text;
}

/**
 * `id` as a stage or an answer uses it: the `frozen` version when there is one, else the
 * version in effect now. A frozen version that no longer resolves falls back to the current
 * builtin text, reported through `onUnresolved`, so the Task is never blocked by it.
 */
export function resolvePrompt(
  scope: RepositoryScope,
  owner: string,
  id: CustomizablePromptId,
  frozen: PromptRef | undefined,
  onUnresolved?: (ref: PromptRef) => void,
): ResolvedPrompt {
  const ref = frozen ?? effectivePromptRef(scope, owner, id);
  const text = promptTextOf(scope, owner, ref);
  if (text !== undefined) {
    return { ref, text };
  }
  onUnresolved?.(ref);
  const builtin = entryOf(id).builtin;
  return { ref: builtin.ref, text: builtin.text };
}
