import { rm, rmdir } from "node:fs/promises";
import { z } from "zod";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { Logger } from "../ports/logger.ts";
import { matchesIdentity } from "../pipeline/cache-swap.ts";

/**
 * The journal of one content pack import, `<data dir>/tmp/content-packs/journal/<jobId>.json`.
 * It is written, synced and renamed into place before the first file is staged, and again
 * whenever a Content's files were placed or its commit settled. It names every file the job
 * may create — the staged file and the final place — with the size and SHA-256 the pack
 * declares, so a crash anywhere can be settled from it and the database alone.
 */

export const JOURNAL_CONTENT_PHASES = ["pending", "placed", "committed", "failed"] as const;

const journalFileSchema = z
  .object({
    entry: z.string().min(1),
    contentKey: z.string().min(1),
    assetId: z.string().min(1),
    targetKind: z.enum(["external_local", "managed_upload", "platform_cache"]),
    /** The file goes back to a registered asset whose file was missing. */
    fills: z.boolean(),
    finalPath: z.string().min(1),
    tempPath: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    cacheRef: z.string().min(1).exactOptional(),
  })
  .strict();
export type JournalFile = z.infer<typeof journalFileSchema>;

export const journalSchema = z
  .object({
    v: z.literal(1),
    jobId: z.string().min(1),
    owner: z.string().min(1),
    createdAt: z.number().int(),
    /** The originals directory of a local-mode import, and whether this job created it. */
    originalsDir: z.object({ path: z.string().min(1), created: z.boolean() }).strict().exactOptional(),
    files: z.array(journalFileSchema),
    contents: z.record(z.string(), z.enum(JOURNAL_CONTENT_PHASES)),
  })
  .strict();
export type ImportJournal = z.infer<typeof journalSchema>;

export interface SettleDeps {
  /** The asset row as committed now, if any. */
  assetOf(owner: string, assetId: string): MediaAsset | undefined;
  logger?: Logger | undefined;
}

export interface SettleOutcome {
  kept: number;
  removed: number;
}

/**
 * Settles an interrupted import from its journal; safe to run any number of times.
 *
 * | file                               | committed (its asset row exists)  | not committed                                  |
 * |------------------------------------|-----------------------------------|------------------------------------------------|
 * | new original or managed upload     | kept                               | removed, only while size and SHA-256 match     |
 * | filled-in file of a registered asset | kept                             | kept: it is the file the row already expects, and at a place the user owns |
 * | platform cache                     | settled by the cache replacement recovery, which runs first |                         |
 *
 * A filled-in file counts as committed once its row is available again. Every staged file
 * (the job's own temporary names) goes either way, and the originals directory the job
 * created goes once it is empty. A file the user put there meanwhile is never touched.
 */
export async function settleJournal(journal: ImportJournal, deps: SettleDeps): Promise<SettleOutcome> {
  const outcome: SettleOutcome = { kept: 0, removed: 0 };
  for (const file of journal.files) {
    if (file.targetKind === "platform_cache") {
      continue;
    }
    await rm(file.tempPath, { force: true });
    const row = deps.assetOf(journal.owner, file.assetId);
    const committed = file.fills ? row?.availability === "available" : row !== undefined;
    if (committed || file.fills) {
      outcome.kept += 1;
      continue;
    }
    if ((await matchesIdentity(file.finalPath, { sizeBytes: file.sizeBytes, digest: `sha256:${file.sha256}` })) === true) {
      await rm(file.finalPath, { force: true });
      outcome.removed += 1;
    } else {
      deps.logger?.info("content_pack_journal_file_absent", { jobId: journal.jobId, assetId: file.assetId });
    }
  }
  if (journal.originalsDir?.created === true) {
    try {
      await rmdir(journal.originalsDir.path);
    } catch (error) {
      // Still holding committed originals, or already gone.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
    }
  }
  return outcome;
}
