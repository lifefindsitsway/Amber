import type { OtherModelKind } from "../../shared/dto/other-model.ts";
import type { AsrProviderId, CredentialStatus, LlmProtocol, PlatformAccountStatus, Tri } from "../../shared/enums.ts";
import type { ModelPricing } from "../../shared/model-pricing.ts";
import type { Platform } from "./platform.ts";

export interface CapabilityFlags {
  stream: Tri;
  tools: Tri;
  structuredOutput: Tri;
  vision: Tri;
  audioInput: Tri;
  reasoning: Tri;
}

/** Numeric limits are not tri-state, hence separate from flags. */
export interface CapabilityLimits {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

/**
 * Three layers per field: declared by preset, observed by probing, overridden by the
 * user. Relays do not reliably forward official capabilities, so all three are kept.
 */
export interface ModelCapability {
  modelId: string;
  flags: { declared: CapabilityFlags; observed?: Partial<CapabilityFlags>; userOverride?: Partial<CapabilityFlags> };
  limits: { declared: CapabilityLimits; observed?: Partial<CapabilityLimits>; userOverride?: Partial<CapabilityLimits> };
  observedAt?: number;
  /** The user's own price: display only, never a capability, never used to compute cost. */
  pricing?: ModelPricing;
}

export interface EffectiveCapability {
  flags: CapabilityFlags;
  limits: CapabilityLimits;
}

/**
 * Field-wise merge `userOverride[f] ?? observed[f] ?? declared[f]`, never a whole-object
 * pick. This is the only source of capability decisions: behavior must not branch on
 * model names.
 */
export function effectiveCapability(capability: ModelCapability): EffectiveCapability {
  const { flags, limits } = capability;
  const effectiveFlags = { ...flags.declared };
  for (const key of Object.keys(effectiveFlags) as Array<keyof CapabilityFlags>) {
    effectiveFlags[key] = flags.userOverride?.[key] ?? flags.observed?.[key] ?? flags.declared[key];
  }
  const effectiveLimits: CapabilityLimits = {};
  for (const key of ["contextWindowTokens", "maxOutputTokens"] as const) {
    const value = limits.userOverride?.[key] ?? limits.observed?.[key] ?? limits.declared[key];
    if (value !== undefined) {
      effectiveLimits[key] = value;
    }
  }
  return { flags: effectiveFlags, limits: effectiveLimits };
}

/**
 * An LLM endpoint configuration. Holds a SecretStore reference, never the key itself.
 * `credentialRef` is an exclusive reference: one Secret belongs to exactly one profile or
 * account, and re-entering a credential replaces the ciphertext under the same reference.
 */
export interface ProviderProfile {
  id: string;
  userId: string;
  name: string;
  protocol: LlmProtocol;
  baseURL: string;
  /** The preset chosen at creation; display only, never consulted for requests or policy. */
  presetId?: string;
  credentialRef?: string;
  models: ModelCapability[];
  createdAt: number;
}

/** What DTOs expose about a stored credential; `hasCredential` is derived. */
export interface CredentialView {
  credentialStatus: CredentialStatus;
  hasCredential: boolean;
}

/** Outward shape of a ProviderProfile: the reference is replaced by its status. */
export type ProviderProfileView = Omit<ProviderProfile, "credentialRef"> & CredentialView;

/**
 * One of a user's ASR profiles: one service account (endpoint and key)
 * with its models in the user's order; a user may keep several, in their own order. While
 * an unfinished Task is bound to one of its models, that model, the endpoint and (while a
 * submitted job awaits its result) the key stay as they are, so a job is always queried
 * where and how it was submitted.
 */
export interface AsrProviderProfile {
  id: string;
  userId: string;
  name: string;
  /** Adding a provider means a new adapter plus a new member of `ASR_PROVIDERS`. */
  provider: AsrProviderId;
  /** Non-empty, without repeated `modelId`; may still hold a model whose family no longer resolves. */
  models: AsrModelEntry[];
  credentialRef?: string;
  baseURL?: string;
  providerConfig?: Record<string, unknown>;
  createdAt: number;
}

/**
 * One model of an ASR profile. Any id may be added: `family` names the
 * request family it follows and is absent only where the provider knows the model by id
 * (rows from before families). A kept entry's family never changes.
 */
export interface AsrModelEntry {
  modelId: string;
  family?: string;
  pricing?: ModelPricing;
  /** When "test connection" last succeeded for this model. */
  testedAt?: number;
}

/**
 * One entry of the user's register of models Amber does not call: name, note
 * and models with their kind and the user's price. Holds no key and no address.
 */
export interface OtherModelProfile {
  id: string;
  userId: string;
  name: string;
  note?: string;
  models: OtherModelEntry[];
  createdAt: number;
}

export interface OtherModelEntry {
  modelId: string;
  kind: OtherModelKind;
  pricing?: ModelPricing;
}

export interface PlatformAccount {
  id: string;
  userId: string;
  platform: Platform;
  /** The cookie itself lives in SecretStore. */
  credentialRef: string;
  status: PlatformAccountStatus;
  checkedAt?: number;
}

/** What a preset knows about any model: nothing; capabilities come from probing and overrides. */
export const UNKNOWN_CAPABILITY_FLAGS: CapabilityFlags = {
  stream: "unknown",
  tools: "unknown",
  structuredOutput: "unknown",
  vision: "unknown",
  audioInput: "unknown",
  reasoning: "unknown",
};

/**
 * The limits a user states for one model. Omitted keeps what is stored (a new model has
 * nothing), a number replaces it, `null` clears it.
 */
export interface UserLimitsInput {
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}

/**
 * A model as the user adds it: every declared flag `unknown`, and the limits the user
 * states (both optional: probing cannot measure them) recorded as the user's own override,
 * never as a measured value. Without any, the model has no override layer.
 */
export function newModelCapability(modelId: string, limits: UserLimitsInput = {}): ModelCapability {
  const userOverride = applyUserLimits(undefined, limits);
  return {
    modelId,
    flags: { declared: { ...UNKNOWN_CAPABILITY_FLAGS } },
    limits: { declared: {}, ...(userOverride === undefined ? {} : { userOverride }) },
  };
}

/**
 * A model kept in a new model list, with the limits the request stated applied to its user
 * override (see `UserLimitsInput`); its other layers stay as they were. An override left
 * empty is removed so lower layers show through.
 */
export function withUserLimits(capability: ModelCapability, limits: UserLimitsInput): ModelCapability {
  const { userOverride: _previous, ...layers } = capability.limits;
  const userOverride = applyUserLimits(capability.limits.userOverride, limits);
  return { ...capability, limits: { ...layers, ...(userOverride === undefined ? {} : { userOverride }) } };
}

/**
 * A model as measurements made against another endpoint or key leave it: no observed flags
 * or limits and no time of measurement; declared values and the user's overrides stay.
 */
export function withoutObserved(capability: ModelCapability): ModelCapability {
  const { observedAt: _at, ...model } = capability;
  const { observed: _flags, ...flags } = capability.flags;
  const { observed: _limits, ...limits } = capability.limits;
  return { ...model, flags, limits };
}

function applyUserLimits(current: Partial<CapabilityLimits> | undefined, limits: UserLimitsInput): Partial<CapabilityLimits> | undefined {
  const next: Partial<CapabilityLimits> = { ...current };
  for (const key of ["contextWindowTokens", "maxOutputTokens"] as const) {
    const value = limits[key];
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return Object.keys(next).length === 0 ? undefined : next;
}
