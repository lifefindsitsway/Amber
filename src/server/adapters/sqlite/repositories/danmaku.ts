import { DANMAKU_MODES, type DanmakuItem } from "../../../../shared/dto/danmaku.ts";
import type { DanmakuRepository, DanmakuSnapshotRecord } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { parseJson } from "./rows.ts";

/** One stored item: `[timeMs, mode, color, weight, text]`, mode as its index in `DANMAKU_MODES` (0 scroll, 1 top, 2 bottom). */
type StoredItem = [number, number, number, number, string];

interface SnapshotRow {
  content_id: string;
  platform_part_id: string;
  fetched_at: number;
  items_json: string;
}

function encode(items: readonly DanmakuItem[]): string {
  return JSON.stringify(items.map((item): StoredItem => [item.timeMs, DANMAKU_MODES.indexOf(item.mode), item.color, item.weight, item.text]));
}

function decode(json: string): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  for (const [timeMs, mode, color, weight, text] of parseJson<StoredItem[]>(json)) {
    const name = DANMAKU_MODES[mode];
    // Only rows this repository wrote exist; an unknown mode index is skipped rather than shown wrong.
    if (name !== undefined) {
      items.push({ timeMs, mode: name, color, weight, text });
    }
  }
  return items;
}

export function sqliteDanmakuRepository(db: SqliteConnection): DanmakuRepository {
  const select = db.prepare("SELECT content_id, platform_part_id, fetched_at, items_json FROM content_danmaku WHERE content_id = ? AND user_id = ?");
  const summary = db.prepare("SELECT platform_part_id, fetched_at, item_count FROM content_danmaku WHERE content_id = ? AND user_id = ?");
  // The row is replaced in place, never merged: a snapshot is always one fetch's answer whole.
  const upsert = db.prepare(
    `INSERT INTO content_danmaku (content_id, user_id, platform_part_id, fetched_at, item_count, items_json)
     VALUES (@contentId, @userId, @platformPartId, @fetchedAt, @itemCount, @itemsJson)
     ON CONFLICT (content_id) DO UPDATE SET
       platform_part_id = excluded.platform_part_id, fetched_at = excluded.fetched_at,
       item_count = excluded.item_count, items_json = excluded.items_json
     WHERE content_danmaku.user_id = excluded.user_id`,
  );

  return {
    get(ownerUserId, contentId) {
      const row = select.get(contentId, ownerUserId) as SnapshotRow | undefined;
      return row === undefined
        ? undefined
        : { contentId: row.content_id, platformPartId: row.platform_part_id, fetchedAt: row.fetched_at, items: decode(row.items_json) };
    },
    summary(ownerUserId, contentId) {
      const row = summary.get(contentId, ownerUserId) as { platform_part_id: string; fetched_at: number; item_count: number } | undefined;
      return row === undefined ? undefined : { platformPartId: row.platform_part_id, fetchedAt: row.fetched_at, count: row.item_count };
    },
    put(ownerUserId, snapshot: DanmakuSnapshotRecord) {
      upsert.run({
        contentId: snapshot.contentId,
        userId: ownerUserId,
        platformPartId: snapshot.platformPartId,
        fetchedAt: snapshot.fetchedAt,
        itemCount: snapshot.items.length,
        itemsJson: encode(snapshot.items),
      });
    },
  };
}
