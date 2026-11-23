import type { ImportItem, ImportRequest } from "../../../shared/dto/import.ts";
import type { AppError } from "../../../shared/errors.ts";
import { ApiError } from "../../api/client.ts";
import { recognizeLink } from "../../links.ts";
import type { CollectionChoice } from "./state.ts";

/**
 * One confirmed import: the request body frozen when the user acted and its Idempotency-Key.
 * A retry after a network failure resends both unchanged; any other body is a new intent.
 */
export interface ImportIntent {
  key: string;
  body: ImportRequest;
}

/**
 * The intent for `body`: the held one while its body is the same (a retry), else a new key.
 * Bodies are built in a fixed key order, so comparing their JSON is comparing their content.
 */
export function importIntent(held: ImportIntent | undefined, body: ImportRequest): ImportIntent {
  return held !== undefined && JSON.stringify(held.body) === JSON.stringify(body) ? held : { key: crypto.randomUUID(), body };
}

/**
 * Whether a failed import may have reached the server: only then is the intent kept for a retry.
 * An answer from the server (any error) means nothing was created, so the next try is new.
 */
export function outcomeUnknown(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 0;
}

/** The links of a list that name a platform collection, as far as the client can tell. */
export function collectionUrls(urls: readonly string[]): string[] {
  return urls.filter((url) => recognizeLink(url)?.kind === "collection");
}

/** The links the server wants chosen from first (a short link that turned out to be a collection). */
export function choiceRequiredUrls(error: AppError): string[] {
  const urls = error.details?.["urls"];
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
}

/**
 * The import items of a link list: a previewed collection link carries its chosen entries (and
 * is left out when nothing was chosen from it); every other link goes as `plain` makes it.
 */
export function itemsWithChoices(urls: readonly string[], previewed: ReadonlySet<string>, choices: readonly CollectionChoice[], plain: (url: string) => ImportItem): ImportItem[] {
  return urls.flatMap((url): ImportItem[] => {
    const choice = choices.find((candidate) => candidate.url === url);
    if (choice !== undefined)
      return [
        {
          url,
          entries: choice.entries,
          ...(choice.previewId === undefined ? {} : { previewId: choice.previewId }),
        },
      ];
    return previewed.has(url) ? [] : [plain(url)];
  });
}
