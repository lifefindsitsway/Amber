/**
 * The library's selection mode, as plain set operations: rows are picked one by one or a page
 * at a time, the pick survives paging and filtering, and each bar action takes at most `max`
 * Contents, so it is refused with the reason rather than truncated.
 */

/** The ids in the order they were picked, `id` added or removed. */
export function toggleSelected(selected: readonly string[], id: string, on: boolean): string[] {
  const without = selected.filter((item) => item !== id);
  return on ? [...without, id] : without;
}

/** How much of the page is picked, for the header checkbox (`some` shows as indeterminate). */
export function pageSelection(selected: readonly string[], pageIds: readonly string[]): "none" | "some" | "all" {
  if (pageIds.length === 0) return "none";
  const picked = new Set(selected);
  const count = pageIds.filter((id) => picked.has(id)).length;
  return count === 0 ? "none" : count === pageIds.length ? "all" : "some";
}

/** The ids without `removed`, order kept: what a deletion took out of the library leaves the selection. */
export function removeSelected(selected: readonly string[], removed: readonly string[]): string[] {
  const gone = new Set(removed);
  return selected.filter((id) => !gone.has(id));
}

/** The header checkbox: a fully picked page is unpicked, otherwise every row of the page is picked. */
export function togglePage(selected: readonly string[], pageIds: readonly string[]): string[] {
  if (pageSelection(selected, pageIds) === "all") {
    const page = new Set(pageIds);
    return selected.filter((id) => !page.has(id));
  }
  const picked = new Set(selected);
  return [...selected, ...pageIds.filter((id) => !picked.has(id))];
}

/** Why a bar action (「导出所选」 up to `IMPORT_BATCH_MAX`, 「删除」 up to `CONTENT_TRASH_BATCH_MAX`) cannot start, if it cannot. */
export function exportBlock(count: number, max: number): "empty" | "tooMany" | undefined {
  if (count === 0) return "empty";
  return count > max ? "tooMany" : undefined;
}
