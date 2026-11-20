import type { ProviderProfileDto } from "../../../src/shared/dto/provider.ts";
import type { RecordedCall } from "./render.tsx";
import { provider } from "./shell-data.ts";

// Provider lists where some models have no context window, and the override route that fills
// one in, for the "needs a context window" entries; values are synthetic.

/** `provider()` with the listed models (default: all) stripped of their context window. */
export function providerWithoutWindow(id: string, name: string, modelIds: readonly string[], missing: readonly string[] = modelIds): ProviderProfileDto {
  const base = provider(id, name, modelIds);
  return {
    ...base,
    models: base.models.map((model) => (missing.includes(model.modelId) ? { ...model, limits: { declared: {} }, effective: { ...model.effective, limits: {} } } : model)),
  };
}

/**
 * `GET /api/providers` over a mutable list, plus `PUT …/override` for each listed model that
 * writes the window into it, as the server would; `overrides` records the bodies sent.
 */
export function windowRoutes(profiles: ProviderProfileDto[]) {
  const overrides: RecordedCall[] = [];
  const routes: Record<string, (call: RecordedCall) => { status?: number; body?: unknown }> = {
    "GET /api/providers": () => ({ body: { items: profiles } }),
  };
  for (const profile of profiles) {
    for (const model of profile.models) {
      routes[`PUT /api/providers/${profile.id}/models/${model.modelId}/override`] = (call) => {
        overrides.push(call);
        const limits = (call.body as { limits: { contextWindowTokens: number | null; maxOutputTokens: number | null } }).limits;
        const index = profiles.findIndex((item) => item.id === profile.id);
        const current = profiles[index] as ProviderProfileDto;
        const updated: ProviderProfileDto = {
          ...current,
          models: current.models.map((item) =>
            item.modelId !== model.modelId
              ? item
              : {
                  ...item,
                  limits: {
                    ...item.limits,
                    userOverride: {
                      ...(limits.contextWindowTokens === null ? {} : { contextWindowTokens: limits.contextWindowTokens }),
                      ...(limits.maxOutputTokens === null ? {} : { maxOutputTokens: limits.maxOutputTokens }),
                    },
                  },
                  effective: {
                    ...item.effective,
                    limits: { ...item.effective.limits, ...(limits.contextWindowTokens === null ? {} : { contextWindowTokens: limits.contextWindowTokens }) },
                  },
                },
          ),
        };
        profiles[index] = updated;
        return { body: updated };
      };
    }
  }
  return { routes, overrides };
}
