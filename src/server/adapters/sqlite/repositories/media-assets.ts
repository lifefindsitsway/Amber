import type { MediaAsset } from "../../../domain/media-asset.ts";
import type { MediaAssetRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface MediaAssetRow {
  id: string;
  user_id: string;
  content_id: string;
  kind: MediaAsset["kind"];
  task_id: string | null;
  storage_ref: string;
  display_name: string | null;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  quality: string | null;
  quality_verified: number;
  fingerprint: string | null;
  acquisition: NonNullable<MediaAsset["acquisition"]> | null;
  availability: MediaAsset["availability"];
  retention_policy: MediaAsset["retentionPolicy"];
  created_at: number;
}

function toMediaAsset(row: MediaAssetRow): MediaAsset {
  return withoutNulls<MediaAsset>({
    id: row.id,
    userId: row.user_id,
    contentId: row.content_id,
    kind: row.kind,
    taskId: row.task_id,
    storageRef: row.storage_ref,
    displayName: row.display_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    durationMs: row.duration_ms,
    quality: row.quality,
    // Absent rather than false: only a verified quality is worth carrying around.
    qualityVerified: row.quality_verified === 1 ? true : null,
    fingerprint: row.fingerprint,
    acquisition: row.acquisition,
    availability: row.availability,
    retentionPolicy: row.retention_policy,
    createdAt: row.created_at,
  });
}

export function sqliteMediaAssetRepository(db: SqliteConnection): MediaAssetRepository {
  const select = db.prepare("SELECT * FROM media_asset WHERE id = ? AND user_id = ?");
  const byContent = db.prepare("SELECT * FROM media_asset WHERE content_id = ? AND user_id = ? ORDER BY created_at, id");
  const byTask = db.prepare("SELECT * FROM media_asset WHERE task_id = ? AND user_id = ? ORDER BY created_at, id");
  const byFingerprint = db.prepare("SELECT * FROM media_asset WHERE user_id = ? AND fingerprint = ? ORDER BY created_at, id");
  const availableCaches = db.prepare(
    "SELECT * FROM media_asset WHERE user_id = ? AND kind = 'platform_cache' AND availability = 'available' ORDER BY created_at, id",
  );
  const allAvailableCaches = db.prepare("SELECT * FROM media_asset WHERE kind = 'platform_cache' AND availability = 'available' ORDER BY created_at, id");
  const cachesByRef = db.prepare("SELECT * FROM media_asset WHERE kind = 'platform_cache' AND storage_ref = ? ORDER BY created_at, id");
  const cachesOfUser = db.prepare("SELECT * FROM media_asset WHERE user_id = ? AND kind = 'platform_cache' ORDER BY created_at, id");
  const burnOutputs = db.prepare(
    `SELECT media_asset.* FROM media_asset JOIN task ON task.id = media_asset.task_id AND task.user_id = media_asset.user_id
     WHERE media_asset.user_id = ? AND media_asset.kind = 'temporary' AND media_asset.availability = 'available' AND task.kind = 'burn'
     ORDER BY media_asset.created_at, media_asset.id`,
  );
  const update = db.prepare(
    `UPDATE media_asset SET storage_ref = @storageRef, mime_type = @mimeType, size_bytes = @sizeBytes, duration_ms = @durationMs,
       quality = @quality, quality_verified = @qualityVerified, fingerprint = @fingerprint, availability = @availability
     WHERE id = @id AND user_id = @userId`,
  );
  const remove = db.prepare("DELETE FROM media_asset WHERE id = ? AND user_id = ?");
  // The composite key (content_id, user_id) rejects an asset whose owner differs from its Content's.
  const insert = db.prepare(
    `INSERT INTO media_asset (
       id, user_id, content_id, kind, task_id, storage_ref, display_name, mime_type, size_bytes, duration_ms,
       quality, quality_verified, fingerprint, acquisition, availability, retention_policy, created_at
     ) VALUES (
       @id, @userId, @contentId, @kind, @taskId, @storageRef, @displayName, @mimeType, @sizeBytes, @durationMs,
       @quality, @qualityVerified, @fingerprint, @acquisition, @availability, @retentionPolicy, @createdAt
     )`,
  );

  return {
    get(ownerUserId, assetId) {
      const row = select.get(assetId, ownerUserId) as MediaAssetRow | undefined;
      return row === undefined ? undefined : toMediaAsset(row);
    },
    listByContent(ownerUserId, contentId) {
      return (byContent.all(contentId, ownerUserId) as MediaAssetRow[]).map(toMediaAsset);
    },
    listByTask(ownerUserId, taskId) {
      return (byTask.all(taskId, ownerUserId) as MediaAssetRow[]).map(toMediaAsset);
    },
    findByFingerprint(ownerUserId, fingerprint) {
      return (byFingerprint.all(ownerUserId, fingerprint) as MediaAssetRow[]).map(toMediaAsset);
    },
    listAvailableCaches(ownerUserId) {
      return (availableCaches.all(ownerUserId) as MediaAssetRow[]).map(toMediaAsset);
    },
    listAvailableCachesUnscoped() {
      return (allAvailableCaches.all() as MediaAssetRow[]).map(toMediaAsset);
    },
    listCachesByStorageRefUnscoped(storageRef) {
      return (cachesByRef.all(storageRef) as MediaAssetRow[]).map(toMediaAsset);
    },
    listCachesOfUser(ownerUserId) {
      return (cachesOfUser.all(ownerUserId) as MediaAssetRow[]).map(toMediaAsset);
    },
    listBurnOutputs(ownerUserId) {
      return (burnOutputs.all(ownerUserId) as MediaAssetRow[]).map(toMediaAsset);
    },
    insert(asset) {
      insert.run({
        id: asset.id,
        userId: asset.userId,
        contentId: asset.contentId,
        kind: asset.kind,
        taskId: nullable(asset.taskId),
        storageRef: asset.storageRef,
        displayName: nullable(asset.displayName),
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        durationMs: nullable(asset.durationMs),
        quality: nullable(asset.quality),
        qualityVerified: asset.qualityVerified === true ? 1 : 0,
        fingerprint: nullable(asset.fingerprint),
        acquisition: nullable(asset.acquisition),
        availability: asset.availability,
        retentionPolicy: asset.retentionPolicy,
        createdAt: asset.createdAt,
      });
    },
    update(ownerUserId, asset) {
      const changes = update.run({
        id: asset.id,
        userId: ownerUserId,
        storageRef: asset.storageRef,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        durationMs: nullable(asset.durationMs),
        quality: nullable(asset.quality),
        qualityVerified: asset.qualityVerified === true ? 1 : 0,
        fingerprint: nullable(asset.fingerprint),
        availability: asset.availability,
      }).changes;
      if (changes === 0) {
        throw notFound("media asset", asset.id);
      }
    },
    delete(ownerUserId, assetId) {
      return remove.run(assetId, ownerUserId).changes > 0;
    },
  };
}
