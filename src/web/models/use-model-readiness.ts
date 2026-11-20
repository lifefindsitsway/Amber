import type { ModelRefDto } from "../../shared/dto/model-ref.ts";
import type { ModelCapabilityDto, ProviderProfileDto } from "../../shared/dto/provider.ts";
import type { StageId } from "../../shared/enums.ts";
import { useProviders } from "../api/queries.ts";

/** What an entry asks of its model: features that plan against the context window need it. */
export type ModelNeeds = "context_window" | "none";

export type ModelReadinessStatus = "loading" | "no_model" | "ready" | "missing_context_window";

export interface ModelReadiness {
  status: ModelReadinessStatus;
  profile?: ProviderProfileDto;
  model?: ModelCapabilityDto;
}

/**
 * Stages that plan their requests against the model's context window; the server refuses
 * them before sending anything when the window is unknown. A summary can sometimes roll by
 * chapters without one, but every summary entry is treated as needing it so the user is never
 * sent into a refusal.
 */
export const CONTEXT_WINDOW_STAGES: ReadonlySet<StageId> = new Set(["chapter", "summary", "highlight"]);

/** The listed profile and model `modelRef` names, if the profile still lists it. */
export function findModel(profiles: readonly ProviderProfileDto[], modelRef: ModelRefDto): { profile: ProviderProfileDto; model: ModelCapabilityDto } | undefined {
  const profile = profiles.find((item) => item.id === modelRef.providerProfileId);
  const model = profile?.models.find((item) => item.modelId === modelRef.modelId);
  return profile === undefined || model === undefined ? undefined : { profile, model };
}

/** Pure form of `useModelReadiness`, for callers that already hold the profile list. */
export function modelReadiness(profiles: readonly ProviderProfileDto[] | undefined, modelRef: ModelRefDto | undefined, needs: ModelNeeds): ModelReadiness {
  if (modelRef === undefined) return { status: "no_model" };
  if (profiles === undefined) return { status: "loading" };
  const found = findModel(profiles, modelRef);
  // A model the list no longer has is the server's to report; nothing here can fill it in.
  if (found === undefined) return { status: "ready" };
  const known = found.model.effective.limits.contextWindowTokens !== undefined;
  return { status: needs === "context_window" && !known ? "missing_context_window" : "ready", ...found };
}

/**
 * Whether `modelRef` can run what the entry needs, from the effective capabilities of the
 * provider list; it follows that list, so filling the window in anywhere makes it `ready`.
 * A failed list read counts as `ready`: the server still refuses an unknown window, and an
 * entry must not stay blocked on a read error.
 */
export function useModelReadiness(modelRef: ModelRefDto | undefined, needs: ModelNeeds): ModelReadiness {
  const providers = useProviders();
  if (providers.isError && modelRef !== undefined) return { status: "ready" };
  return modelReadiness(providers.data?.items, modelRef, needs);
}
