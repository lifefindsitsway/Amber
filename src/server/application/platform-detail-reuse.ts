import { PLATFORM_DETAIL_REUSE_MAX, PLATFORM_DETAIL_REUSE_MS } from "../../shared/defaults.ts";
import { PLATFORM_CAPABILITIES } from "../../shared/platforms.ts";
import type { Platform } from "../domain/platform.ts";
import type { PlatformContentRef, PlatformMetadata, PlatformRelatedCollection } from "../ports/platform-source.ts";

/** What an import check read about a video, kept a moment for the steps that follow it. */
export interface ReusedPlatformDetail {
  metadata: PlatformMetadata;
  relatedCollection?: PlatformRelatedCollection;
}

interface Entry {
  detail: ReusedPlatformDetail;
  storedAt: number;
}

export interface PlatformDetailReuseOptions {
  now?: () => number;
  ttlMs?: number;
  max?: number;
}

/**
 * The key a link's detail is kept under: the whole canonical link where the platform's links
 * carry an expiring access parameter (another link to the same video may not open it), the
 * video id otherwise. `undefined` when the link that would key it is not known.
 */
export function platformDetailKey(platform: Platform, ref: Pick<PlatformContentRef, "platformContentId" | "sourceUrl">): string | undefined {
  return PLATFORM_CAPABILITIES[platform].linkMayExpire ? ref.sourceUrl : ref.platformContentId;
}

/**
 * Platform metadata an import check read, kept in process memory for `PLATFORM_DETAIL_REUSE_MS`
 * per user, platform and link so that the paste check, the import and the source stage ask the
 * platform once between them. At most `PLATFORM_DETAIL_REUSE_MAX` entries are kept, the
 * earliest stored going first. Only metadata is kept: subtitle track locators, which may embed
 * signed URLs, are dropped, and nothing of a login, session or media address ever enters it.
 */
export class PlatformDetailReuse {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(options: PlatformDetailReuseOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PLATFORM_DETAIL_REUSE_MS;
    this.max = options.max ?? PLATFORM_DETAIL_REUSE_MAX;
  }

  get size(): number {
    return this.entries.size;
  }

  remember(ownerUserId: string, platform: Platform, ref: PlatformContentRef, detail: ReusedPlatformDetail): void {
    const key = this.keyOf(ownerUserId, platform, ref);
    if (key === undefined) {
      return;
    }
    const kept: ReusedPlatformDetail = {
      metadata: structuredClone({ ...detail.metadata, subtitleTracks: [] }),
      ...(detail.relatedCollection === undefined ? {} : { relatedCollection: structuredClone(detail.relatedCollection) }),
    };
    this.entries.delete(key);
    this.entries.set(key, { detail: kept, storedAt: this.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  find(ownerUserId: string, platform: Platform, ref: PlatformContentRef): ReusedPlatformDetail | undefined {
    const key = this.keyOf(ownerUserId, platform, ref);
    const entry = key === undefined ? undefined : this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key as string);
      return undefined;
    }
    return structuredClone(entry.detail);
  }

  /** `PlatformAccess.recentMetadata` for the source stage. */
  recentMetadata(ownerUserId: string, platform: Platform, ref: PlatformContentRef): PlatformMetadata | undefined {
    return this.find(ownerUserId, platform, ref)?.metadata;
  }

  private keyOf(ownerUserId: string, platform: Platform, ref: PlatformContentRef): string | undefined {
    const key = platformDetailKey(platform, ref);
    return key === undefined ? undefined : JSON.stringify([ownerUserId, platform, key]);
  }
}
