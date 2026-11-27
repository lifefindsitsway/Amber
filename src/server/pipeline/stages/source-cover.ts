/**
 * Keeps a local copy of a Content's cover. The source stage calls it after reading the
 * platform's metadata; the implementation lives with the application services, so the stage
 * depends on this shape only.
 */
export interface SourceCoverSaver {
  /**
   * Downloads, re-encodes and stores the cover at `coverUrl` unless the Content already has a
   * local copy. Never throws for a failed download or decode: the stage's outcome does not
   * depend on the cover, so failures are only logged.
   */
  saveIfAbsent(ownerUserId: string, contentId: string, coverUrl: string, signal: AbortSignal): Promise<void>;
}
