import type { ModelPricing } from "../../../../shared/model-pricing.ts";
import type { AsrModelEntry, AsrProviderProfile, CapabilityFlags, CapabilityLimits, ModelCapability, ProviderProfile } from "../../../domain/provider-profile.ts";
import type { AsrProfileRepository, ProviderProfileRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface ProviderProfileRow {
  id: string;
  user_id: string;
  name: string;
  protocol: ProviderProfile["protocol"];
  base_url: string;
  credential_ref: string | null;
  created_at: number;
}

interface ModelCapabilityRow {
  model_id: string;
  flags_declared_json: string;
  flags_observed_json: string | null;
  flags_user_override_json: string | null;
  limits_declared_json: string;
  limits_observed_json: string | null;
  limits_user_override_json: string | null;
  observed_at: number | null;
  pricing_json: string | null;
}

interface AsrProfileRow {
  id: string;
  user_id: string;
  name: string;
  provider: AsrProviderProfile["provider"];
  models_json: string;
  credential_ref: string | null;
  base_url: string | null;
  provider_config_json: string | null;
  created_at: number;
}

function toCapability(row: ModelCapabilityRow): ModelCapability {
  return withoutNulls<ModelCapability>({
    modelId: row.model_id,
    flags: withoutNulls<ModelCapability["flags"]>({
      declared: parseJson<CapabilityFlags>(row.flags_declared_json),
      observed: parseJsonOrNull<Partial<CapabilityFlags>>(row.flags_observed_json),
      userOverride: parseJsonOrNull<Partial<CapabilityFlags>>(row.flags_user_override_json),
    }),
    limits: withoutNulls<ModelCapability["limits"]>({
      declared: parseJson<CapabilityLimits>(row.limits_declared_json),
      observed: parseJsonOrNull<Partial<CapabilityLimits>>(row.limits_observed_json),
      userOverride: parseJsonOrNull<Partial<CapabilityLimits>>(row.limits_user_override_json),
    }),
    observedAt: row.observed_at,
    pricing: parseJsonOrNull<ModelPricing>(row.pricing_json),
  });
}

export function sqliteProviderProfileRepository(db: SqliteConnection): ProviderProfileRepository {
  const select = db.prepare("SELECT * FROM provider_profile WHERE id = ? AND user_id = ?");
  const selectAll = db.prepare("SELECT * FROM provider_profile WHERE user_id = ? ORDER BY position, created_at, id");
  const models = db.prepare("SELECT * FROM model_capability WHERE profile_id = ? ORDER BY position, model_id");
  const selectPricing = db.prepare(
    `SELECT m.pricing_json FROM model_capability AS m JOIN provider_profile AS p ON p.id = m.profile_id
     WHERE p.id = ? AND p.user_id = ? AND m.model_id = ?`,
  );
  const insertProfile = db.prepare(
    // A new profile goes last in the user's order.
    `INSERT INTO provider_profile (id, user_id, name, protocol, base_url, credential_ref, created_at, position)
     VALUES (@id, @userId, @name, @protocol, @baseURL, @credentialRef, @createdAt,
       (SELECT coalesce(max(position) + 1, 0) FROM provider_profile WHERE user_id = @userId))`,
  );
  const updateProfile = db.prepare(
    `UPDATE provider_profile SET name = @name, base_url = @baseURL, credential_ref = @credentialRef
     WHERE id = @id AND user_id = @userId`,
  );
  const deleteModels = db.prepare("DELETE FROM model_capability WHERE profile_id = ?");
  const insertModel = db.prepare(
    `INSERT INTO model_capability (profile_id, model_id, position, flags_declared_json, flags_observed_json, flags_user_override_json,
       limits_declared_json, limits_observed_json, limits_user_override_json, observed_at, pricing_json)
     VALUES (@profileId, @modelId, @position, @flagsDeclared, @flagsObserved, @flagsUserOverride,
       @limitsDeclared, @limitsObserved, @limitsUserOverride, @observedAt, @pricing)`,
  );
  // The secret goes with it through the provider_profile_secret_delete trigger; the models cascade.
  const remove = db.prepare("DELETE FROM provider_profile WHERE id = ? AND user_id = ?");
  const setPosition = db.prepare("UPDATE provider_profile SET position = ? WHERE id = ? AND user_id = ?");
  const clearCredentials = db.prepare("UPDATE provider_profile SET credential_ref = NULL WHERE credential_ref IS NOT NULL");

  const toProfile = (row: ProviderProfileRow): ProviderProfile =>
    withoutNulls<ProviderProfile>({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      protocol: row.protocol,
      baseURL: row.base_url,
      credentialRef: row.credential_ref,
      models: (models.all(row.id) as ModelCapabilityRow[]).map(toCapability),
      createdAt: row.created_at,
    });
  const writeModels = (profile: ProviderProfile): void => {
    deleteModels.run(profile.id);
    profile.models.forEach((model, position) => {
      insertModel.run({
        profileId: profile.id,
        modelId: model.modelId,
        position,
        flagsDeclared: JSON.stringify(model.flags.declared),
        flagsObserved: jsonOrNull(model.flags.observed),
        flagsUserOverride: jsonOrNull(model.flags.userOverride),
        limitsDeclared: JSON.stringify(model.limits.declared),
        limitsObserved: jsonOrNull(model.limits.observed),
        limitsUserOverride: jsonOrNull(model.limits.userOverride),
        observedAt: nullable(model.observedAt),
        pricing: jsonOrNull(model.pricing),
      });
    });
  };
  const fields = (profile: ProviderProfile) => ({
    id: profile.id,
    userId: profile.userId,
    name: profile.name,
    baseURL: profile.baseURL,
    credentialRef: nullable(profile.credentialRef),
  });

  return {
    get(ownerUserId, profileId) {
      const row = select.get(profileId, ownerUserId) as ProviderProfileRow | undefined;
      return row === undefined ? undefined : toProfile(row);
    },
    list(ownerUserId) {
      return (selectAll.all(ownerUserId) as ProviderProfileRow[]).map(toProfile);
    },
    getModelPricing(ownerUserId, profileId, modelId) {
      const row = selectPricing.get(profileId, ownerUserId, modelId) as { pricing_json: string | null } | undefined;
      return parseJsonOrNull<ModelPricing>(row?.pricing_json ?? null) ?? undefined;
    },
    insert(profile) {
      insertProfile.run({ ...fields(profile), protocol: profile.protocol, createdAt: profile.createdAt });
      writeModels(profile);
    },
    // The protocol is fixed at creation; only name, endpoint, credential and models change.
    update(profile) {
      if (updateProfile.run(fields(profile)).changes === 0) {
        throw notFound("provider profile", profile.id);
      }
      writeModels(profile);
    },
    delete(ownerUserId, profileId) {
      return remove.run(profileId, ownerUserId).changes > 0;
    },
    reorder(ownerUserId, profileIds) {
      profileIds.forEach((profileId, position) => {
        if (setPosition.run(position, profileId, ownerUserId).changes === 0) {
          throw notFound("provider profile", profileId);
        }
      });
    },
    clearAllCredentialRefs() {
      return clearCredentials.run().changes;
    },
  };
}

export function sqliteAsrProfileRepository(db: SqliteConnection): AsrProfileRepository {
  const select = db.prepare("SELECT * FROM asr_provider_profile WHERE id = ? AND user_id = ?");
  const selectAll = db.prepare("SELECT * FROM asr_provider_profile WHERE user_id = ? ORDER BY position, created_at, id");
  const insert = db.prepare(
    `INSERT INTO asr_provider_profile (id, user_id, name, provider, models_json, credential_ref, base_url, provider_config_json, created_at, position)
     VALUES (@id, @userId, @name, @provider, @modelsJson, @credentialRef, @baseURL, @providerConfigJson, @createdAt,
       (SELECT coalesce(max(position) + 1, 0) FROM asr_provider_profile WHERE user_id = @userId))`,
  );
  const update = db.prepare(
    `UPDATE asr_provider_profile SET
       name = @name, provider = @provider, models_json = @modelsJson, credential_ref = @credentialRef,
       base_url = @baseURL, provider_config_json = @providerConfigJson
     WHERE id = @id AND user_id = @userId`,
  );
  // The secret goes with it through the asr_provider_profile_secret_delete trigger; the
  // service clears a default that named it.
  const remove = db.prepare("DELETE FROM asr_provider_profile WHERE id = ? AND user_id = ?");
  const setPosition = db.prepare("UPDATE asr_provider_profile SET position = ? WHERE id = ? AND user_id = ?");
  const clearCredentials = db.prepare("UPDATE asr_provider_profile SET credential_ref = NULL WHERE credential_ref IS NOT NULL");

  const params = (profile: AsrProviderProfile) => ({
    id: profile.id,
    userId: profile.userId,
    name: profile.name,
    provider: profile.provider,
    modelsJson: JSON.stringify(profile.models),
    credentialRef: nullable(profile.credentialRef),
    baseURL: nullable(profile.baseURL),
    providerConfigJson: jsonOrNull(profile.providerConfig),
  });

  return {
    get(ownerUserId, profileId) {
      const row = select.get(profileId, ownerUserId) as AsrProfileRow | undefined;
      return row === undefined ? undefined : toAsrProfile(row);
    },
    list(ownerUserId) {
      return (selectAll.all(ownerUserId) as AsrProfileRow[]).map(toAsrProfile);
    },
    getModelPricing(ownerUserId, profileId, modelId) {
      const row = select.get(profileId, ownerUserId) as AsrProfileRow | undefined;
      return row === undefined ? undefined : parseJson<AsrModelEntry[]>(row.models_json).find((entry) => entry.modelId === modelId)?.pricing;
    },
    insert(profile) {
      insert.run({ ...params(profile), createdAt: profile.createdAt });
    },
    update(profile) {
      return update.run(params(profile)).changes > 0;
    },
    delete(ownerUserId, profileId) {
      return remove.run(profileId, ownerUserId).changes > 0;
    },
    reorder(ownerUserId, profileIds) {
      profileIds.forEach((profileId, position) => {
        if (setPosition.run(position, profileId, ownerUserId).changes === 0) {
          throw notFound("ASR profile", profileId);
        }
      });
    },
    clearAllCredentialRefs() {
      return clearCredentials.run().changes;
    },
  };
}

function toAsrProfile(row: AsrProfileRow): AsrProviderProfile {
  return withoutNulls<AsrProviderProfile>({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    provider: row.provider,
    models: parseJson<AsrModelEntry[]>(row.models_json),
    credentialRef: row.credential_ref,
    baseURL: row.base_url,
    providerConfig: parseJsonOrNull<Record<string, unknown>>(row.provider_config_json),
    createdAt: row.created_at,
  });
}
