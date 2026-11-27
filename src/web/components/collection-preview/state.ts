import type { InspectResponse } from "../../../shared/dto/import.ts";
import type { AppError } from "../../../shared/errors.ts";

/** One entry of a collection preview page, as the server lists it. */
export type PreviewEntry = NonNullable<InspectResponse["items"]>[number];

/**
 * What the user chose for one collection link: the entries in the order their Tasks are queued,
 * and the preview they were chosen from.
 */
export interface CollectionChoice {
  url: string;
  entries: string[];
  previewId?: string;
}

/**
 * One collection link under preview. `selected` and `order` survive closing the dialog and
 * reading the collection again; they only ever hold entries the user (or the first page's
 * defaults) chose.
 */
export interface PreviewSession {
  url: string;
  /** `idle`: not read yet, or the read was stopped by closing the dialog. */
  phase: "idle" | "loading" | "ready" | "failed";
  /** Why the first page could not be read. */
  error?: AppError;
  title?: string;
  canonicalUrl?: string;
  previewId?: string;
  /** Entries listed for this collection (at most the listing cap). */
  itemCount: number;
  /** What the platform reports in total; absent when it does not say. */
  totalCount?: number;
  truncated: boolean;
  nextOffset?: number;
  /** Every entry read so far, in the platform's order. */
  entries: PreviewEntry[];
  /** A later page is being read. */
  paging: boolean;
  /** Why the last later page could not be read. */
  pageError?: AppError;
  /** "Load all" is running; clearing it stops after the page in flight. */
  loadingAll: boolean;
  localCollection?: { id: string; name: string };
  selected: ReadonlySet<string>;
  /** The processing order the user arranged; undefined while it is the platform's. */
  order?: string[];
  /** The defaults were applied once; a later read never adds to the user's choice again. */
  chosen: boolean;
}

export function emptySession(url: string): PreviewSession {
  return {
    url,
    phase: "idle",
    itemCount: 0,
    truncated: false,
    entries: [],
    paging: false,
    loadingAll: false,
    selected: new Set(),
    chosen: false,
  };
}

/** Trashed and unavailable entries cannot be chosen. */
export function selectable(entry: PreviewEntry): boolean {
  return entry.state !== "trashed" && entry.state !== "unavailable";
}

/**
 * Entries not yet in the compared collection (new ones, ones already in the library, ones being
 * processed): what the defaults and 「只选还不在此合集里的」 pick.
 */
export function notInCollection(entry: PreviewEntry): boolean {
  return entry.state === undefined || entry.state === "new" || entry.state === "in_library" || entry.state === "processing";
}

type Page = Pick<InspectResponse, "title" | "canonicalUrl" | "previewId" | "itemCount" | "totalCount" | "truncated" | "nextOffset" | "items" | "localCollection">;

function pageMeta(session: PreviewSession, page: Page): PreviewSession {
  const { nextOffset: _next, totalCount: _total, localCollection: _local, title: _title, previewId: _preview, ...rest } = session;
  return {
    ...rest,
    canonicalUrl: page.canonicalUrl,
    itemCount: page.itemCount ?? 0,
    truncated: page.truncated === true,
    ...(page.title === undefined ? {} : { title: page.title }),
    ...(page.previewId === undefined ? {} : { previewId: page.previewId }),
    ...(page.totalCount === undefined ? {} : { totalCount: page.totalCount }),
    ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    ...(page.localCollection === undefined ? {} : { localCollection: page.localCollection }),
  };
}

/**
 * The first page read (again), in place of the entries read before. The user's choice is kept as
 * it is (`pruneChoice` drops what is gone once the chosen entries had a chance to be found).
 */
export function withFirstPage(session: PreviewSession, page: Page): PreviewSession {
  return { ...pageMeta(session, page), entries: page.items ?? [] };
}

/**
 * The default choice, given once: the entries read so far that are not imported yet, as many as
 * `budget` allows. A session chosen before is left as it is.
 */
export function withDefaults(session: PreviewSession, budget: number): PreviewSession {
  if (session.chosen) return session;
  const picked = session.entries.filter((entry) => selectable(entry) && notInCollection(entry)).slice(0, Math.max(0, budget));
  const { order: _order, ...rest } = session;
  return {
    ...rest,
    selected: new Set(picked.map((entry) => entry.platformContentId)),
    chosen: true,
  };
}

/**
 * The one entry a preview opened from a single video starts with chosen: that video, found by
 * its canonical link. `index` (0-based, when the platform tells the episode number) only says
 * how far to page on to find it; it never picks an entry by position.
 */
export interface EntryPreselect {
  canonicalUrl: string;
  index?: number;
}

function preselected(session: PreviewSession, preselect: EntryPreselect): PreviewEntry | undefined {
  return session.entries.find((entry) => entry.canonicalUrl === preselect.canonicalUrl);
}

/**
 * Whether the next page should be read before the defaults are given: the preselected entry is
 * not among those read, and by its episode number it is still ahead. Without a number nothing
 * more is read: the first page decides.
 */
export function preselectAhead(session: PreviewSession, preselect: EntryPreselect | undefined): boolean {
  if (preselect === undefined || session.chosen || preselected(session, preselect) !== undefined) return false;
  return preselect.index !== undefined && session.entries.length <= preselect.index;
}

/**
 * The defaults of a preview opened from a single video: that entry alone when it can be chosen,
 * else nothing; given once, like `withDefaults`.
 */
export function withPreselect(session: PreviewSession, preselect: EntryPreselect): PreviewSession {
  if (session.chosen) return session;
  const entry = preselected(session, preselect);
  const { order: _order, ...rest } = session;
  return {
    ...rest,
    selected: new Set(entry !== undefined && selectable(entry) ? [entry.platformContentId] : []),
    chosen: true,
  };
}

/** A later page appended; an entry already read is not listed twice. */
export function withPage(session: PreviewSession, page: Page): PreviewSession {
  const known = new Set(session.entries.map((entry) => entry.platformContentId));
  const added = (page.items ?? []).filter((entry) => !known.has(entry.platformContentId));
  const next = pageMeta(session, page);
  return { ...next, entries: [...session.entries, ...added] };
}

/** Chosen entries the pages read so far do not hold yet. */
export function missingChoice(session: PreviewSession): boolean {
  const ids = new Set(session.entries.map((entry) => entry.platformContentId));
  return [...session.selected].some((id) => !ids.has(id));
}

/** Drops chosen entries that are gone from the collection or can no longer be chosen. */
export function pruneChoice(session: PreviewSession): PreviewSession {
  const keep = new Set(session.entries.filter(selectable).map((entry) => entry.platformContentId));
  const selected = new Set([...session.selected].filter((id) => keep.has(id)));
  const { order, ...rest } = session;
  return {
    ...rest,
    selected,
    ...(order === undefined ? {} : { order: order.filter((id) => selected.has(id)) }),
  };
}

/** The chosen entries in processing order: the user's arrangement, else the platform's. */
export function processingOrder(session: PreviewSession): string[] {
  const byPlatform = session.entries.filter((entry) => session.selected.has(entry.platformContentId)).map((entry) => entry.platformContentId);
  if (session.order === undefined) return byPlatform;
  const arranged = session.order.filter((id) => session.selected.has(id));
  const placed = new Set(arranged);
  return [...arranged, ...byPlatform.filter((id) => !placed.has(id))];
}

/**
 * Sets the given entries chosen or not. Unselectable entries are left alone. Once the user has
 * arranged the order, newly chosen entries join at its end.
 */
export function setChosen(session: PreviewSession, ids: readonly string[], on: boolean): PreviewSession {
  const allowed = new Set(session.entries.filter(selectable).map((entry) => entry.platformContentId));
  const selected = new Set(session.selected);
  for (const id of ids) {
    if (!allowed.has(id)) continue;
    if (on) selected.add(id);
    else selected.delete(id);
  }
  if (session.order === undefined) return { ...session, selected };
  const order = session.order.filter((id) => selected.has(id));
  const placed = new Set(order);
  for (const id of ids) {
    if (selected.has(id) && !placed.has(id)) {
      order.push(id);
      placed.add(id);
    }
  }
  return { ...session, selected, order };
}

/** The user's arrangement of the chosen entries. */
export function withOrder(session: PreviewSession, order: readonly string[]): PreviewSession {
  return { ...session, order: order.filter((id) => session.selected.has(id)) };
}

export function movedToFront(session: PreviewSession, id: string): PreviewSession {
  const current = processingOrder(session);
  if (!current.includes(id)) return session;
  return {
    ...session,
    order: [id, ...current.filter((other) => other !== id)],
  };
}

export function platformOrder(session: PreviewSession): PreviewSession {
  const { order: _order, ...rest } = session;
  return rest;
}

/** Total duration of the chosen entries; `complete` is false when some of them have none. */
export function chosenDuration(session: PreviewSession): { totalMs: number; complete: boolean } | undefined {
  const chosen = session.entries.filter((entry) => session.selected.has(entry.platformContentId));
  const timed = chosen.filter((entry) => entry.durationMs !== undefined);
  if (timed.length === 0) return undefined;
  return {
    totalMs: timed.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
    complete: timed.length === chosen.length,
  };
}

/** Hours and minutes of a duration, rounded to the minute. */
export function hoursAndMinutes(ms: number): {
  hours: number;
  minutes: number;
} {
  const minutes = Math.round(ms / 60_000);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * Indices `from`..`to` (either order) of a list, for a range picked with Shift; undefined when
 * either end is not in it.
 */
export function rangeBetween(ids: readonly string[], from: string, to: string): string[] | undefined {
  const a = ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a === -1 || b === -1) return undefined;
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}
