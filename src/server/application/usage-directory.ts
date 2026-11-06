import { encodeModelKey, encodeProfileKey, type UsageModality } from "../../shared/dto/usage-analytics.ts";
import type { UsageModelDims, UsageProfileName } from "../domain/usage-analytics.ts";

/** `modality` and `profileId` as one map key. */
function profileSlot(modality: UsageModality, profileId: string): string {
  return JSON.stringify([modality, profileId]);
}

/** The key a model is filtered and charted by: profiles and modalities never share one. */
export function modelKeyOf(dims: Pick<UsageModelDims, "modality" | "profileId" | "modelId">): string {
  return encodeModelKey([dims.modality, dims.profileId, dims.modelId]);
}

export function profileKeyOf(dims: Pick<UsageModelDims, "modality" | "profileId">): string {
  return encodeProfileKey([dims.modality, dims.profileId]);
}

/**
 * The owner's profiles as they are now. A profile's current name wins over the name recorded
 * with its calls; once the profile is gone the recorded name is all there is. A call that
 * never recorded its profile (empty id) has neither a name nor a profile that could be deleted.
 */
export class ProfileDirectory {
  private readonly current = new Map<string, string>();
  private readonly recorded = new Map<string, string>();

  constructor(current: readonly UsageProfileName[], recorded: readonly UsageProfileName[] = []) {
    for (const profile of current) {
      this.current.set(profileSlot(profile.modality, profile.profileId), profile.name);
    }
    for (const profile of recorded) {
      this.recorded.set(profileSlot(profile.modality, profile.profileId), profile.name);
    }
  }

  /** The profiles among `used` that no longer exist, whose recorded names are worth looking up. */
  missing(used: Iterable<{ modality: UsageModality; profileId: string }>): Array<{ modality: UsageModality; profileId: string }> {
    const seen = new Map<string, { modality: UsageModality; profileId: string }>();
    for (const { modality, profileId } of used) {
      if (this.isDeleted(modality, profileId)) {
        seen.set(profileSlot(modality, profileId), { modality, profileId });
      }
    }
    return [...seen.values()];
  }

  nameOf(modality: UsageModality, profileId: string): string | null {
    if (profileId === "") {
      return null;
    }
    const slot = profileSlot(modality, profileId);
    return this.current.get(slot) ?? this.recorded.get(slot) ?? null;
  }

  isDeleted(modality: UsageModality, profileId: string): boolean {
    return profileId !== "" && !this.current.has(profileSlot(modality, profileId));
  }
}
