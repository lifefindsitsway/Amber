import { randomBytes } from "node:crypto";
import { COLLECTION_PREVIEW_CACHE_MAX, COLLECTION_PREVIEW_PER_USER_MAX, COLLECTION_PREVIEW_TTL_MS } from "../../shared/defaults.ts";
import type { Platform } from "../domain/platform.ts";
import type { PlatformCollectionEntry, PlatformCollectionItem } from "../ports/platform-source.ts";

/** What a cached preview was listed for; a preview only serves a request that matches all of it. */
export interface CollectionPreviewBinding {
  ownerUserId: string;
  platform: Platform;
  platformCollectionId: string;
  /** Whether the listing was made with the user's platform login: a login can see entries a guest cannot. */
  withLogin: boolean;
}

/** A listed platform collection with the entries resolved so far. */
export interface CollectionPreview extends CollectionPreviewBinding {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly PlatformCollectionEntry[];
  readonly totalCount?: number;
  readonly truncated: boolean;
  /** Entries resolved so far, by platform content id; later pages and imports add to it. */
  readonly resolved: Map<string, PlatformCollectionItem>;
  readonly storedAt: number;
}

export interface CollectionPreviewCacheOptions {
  now?: () => number;
  /** Must not be guessable: the id is all a later request shows to reach a cached listing. */
  newId?: () => string;
}

/**
 * Collection listings kept in memory between a preview's pages and the import that follows.
 * Each lives `COLLECTION_PREVIEW_TTL_MS` from when it was stored; a restart forgets them all.
 * Storing never fails: past `COLLECTION_PREVIEW_PER_USER_MAX` the user's oldest goes, then
 * past `COLLECTION_PREVIEW_CACHE_MAX` the oldest of anyone's. Only listings that succeeded
 * are stored, by the caller.
 */
export class CollectionPreviewCache {
  // A Map iterates in insertion order, which is storage order: the first entry is the oldest.
  private readonly previews = new Map<string, CollectionPreview>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: CollectionPreviewCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(18).toString("base64url"));
  }

  get size(): number {
    this.sweep();
    return this.previews.size;
  }

  store(preview: Omit<CollectionPreview, "id" | "storedAt">): CollectionPreview {
    this.sweep();
    const own = [...this.previews.values()].filter((cached) => cached.ownerUserId === preview.ownerUserId);
    for (const oldest of own.slice(0, Math.max(0, own.length - COLLECTION_PREVIEW_PER_USER_MAX + 1))) {
      this.previews.delete(oldest.id);
    }
    for (const oldest of [...this.previews.keys()].slice(0, Math.max(0, this.previews.size - COLLECTION_PREVIEW_CACHE_MAX + 1))) {
      this.previews.delete(oldest);
    }
    const stored: CollectionPreview = { ...preview, id: this.newId(), storedAt: this.now() };
    this.previews.set(stored.id, stored);
    return stored;
  }

  /**
   * The preview `previewId` names when it is still alive and matches `binding` in full;
   * another user's preview is never returned, as if it did not exist.
   */
  find(previewId: string, binding: CollectionPreviewBinding): CollectionPreview | undefined {
    this.sweep();
    const preview = this.previews.get(previewId);
    if (
      preview === undefined ||
      preview.ownerUserId !== binding.ownerUserId ||
      preview.platform !== binding.platform ||
      preview.platformCollectionId !== binding.platformCollectionId ||
      preview.withLogin !== binding.withLogin
    ) {
      return undefined;
    }
    return preview;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, preview] of this.previews) {
      if (now - preview.storedAt >= COLLECTION_PREVIEW_TTL_MS) {
        this.previews.delete(id);
      }
    }
  }
}
