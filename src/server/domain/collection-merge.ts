/**
 * The member order of a collection after a content pack adds members to it.
 *
 * `local` is every member the collection holds now, trashed ones included, in position order
 * (ties already broken by the caller); `pack` is the pack's members of that collection, mapped
 * to local Content ids, in the pack's order, and may name Contents the collection lacks.
 *
 * The local order is the user's and is never changed: members already here keep their
 * relative order whatever the pack says, so importing a pack never reorders anything, and
 * importing the same pack again returns `local` unchanged. A new member goes right after the
 * nearest member before it in the pack that is already here; failing that, right before the
 * nearest one after it; failing both, at the end. New members sharing an anchor keep the
 * pack's order among themselves.
 *
 * The result is computed from the members as they are inside the committing transaction, so a
 * collection edited after the preview is merged against its real state.
 */
export function mergeCollectionOrder(local: readonly string[], pack: readonly string[]): string[] {
  assertUnique(local, "local");
  assertUnique(pack, "pack");
  const present = new Set(local);
  const after = new Map<string, string[]>();
  const before = new Map<string, string[]>();
  const tail: string[] = [];
  let anchor: string | undefined;
  for (let index = 0; index < pack.length; index += 1) {
    const id = pack[index] as string;
    if (present.has(id)) {
      anchor = id;
      continue;
    }
    if (anchor !== undefined) {
      push(after, anchor, id);
      continue;
    }
    const next = pack.slice(index + 1).find((candidate) => present.has(candidate));
    if (next !== undefined) push(before, next, id);
    else tail.push(id);
  }
  const merged: string[] = [];
  for (const id of local) {
    merged.push(...(before.get(id) ?? []), id, ...(after.get(id) ?? []));
  }
  merged.push(...tail);
  return merged;
}

function push(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [id]);
  else list.push(id);
}

function assertUnique(ids: readonly string[], name: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`mergeCollectionOrder: duplicate id in ${name}`);
}
