import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CircleAlert, ListVideo } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { IMPORT_CHECK_CACHE_MS, IMPORT_CHECK_DEBOUNCE_MS, IMPORT_CHECK_QUIET_MS } from "../../shared/defaults.ts";
import { inspectResponseSchema, type InspectRequest, type InspectResponse, type RelatedCollection } from "../../shared/dto/import.ts";
import { platformAccountListDtoSchema } from "../../shared/dto/platform-account.ts";
import type { Platform } from "../../shared/enums.ts";
import { platformCapabilities } from "../../shared/platforms.ts";
import type { ContentEventBus } from "../api/content-events.ts";
import { useApi, useContentEvents } from "../api/context.tsx";
import { queryKeys, useMe } from "../api/queries.ts";
import { formatDuration } from "../format.ts";
import type { ParsedLinkText } from "../links.ts";
import { NOTE_TEXT_CLASS, TEXT_ACTION_CLASS, TextAction } from "../ui/notice.tsx";

/**
 * The link a box is checked for before import: only when it holds exactly one link, of a
 * platform that checks single links or can name the collection a video belongs to, and not a
 * collection (a collection is previewed instead).
 */
export function checkableLink(parsed: ParsedLinkText): string | undefined {
  const link = parsed.links[0];
  if (parsed.all.length !== 1 || link === undefined || link.kind === "collection") return undefined;
  const capabilities = platformCapabilities(link.platform);
  return capabilities.importCheck || capabilities.relatedCollection ? link.url : undefined;
}

/** Where the check of the box's link stands; `undefined` when the box holds no checkable link. */
export type ImportCheckView =
  | { url: string; phase: "waiting" | "checking" | "quiet" }
  | { url: string; phase: "done"; answer: InspectResponse };

/**
 * Successful checks are kept in the query cache, under the signed-in user and the link, so they
 * outlive the page for `IMPORT_CHECK_CACHE_MS` and go with everything else the session cached
 * when the user signs out.
 */
const IMPORT_CHECK_KEY = ["importCheck"] as const;

function checkKey(userId: string, url: string): readonly unknown[] {
  return [...IMPORT_CHECK_KEY, userId, url];
}

function keptCheck(queryClient: QueryClient, userId: string, url: string): InspectResponse | undefined {
  const state = queryClient.getQueryState<InspectResponse>(checkKey(userId, url));
  if (state?.data === undefined || Date.now() - state.dataUpdatedAt >= IMPORT_CHECK_CACHE_MS) return undefined;
  return state.data;
}

/** Forgets every kept check: the library changed, so "already in the library" may no longer hold. */
export function forgetImportChecks(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: IMPORT_CHECK_KEY });
}

/**
 * Content moving into or out of the trash changes what a check would say. The kept checks
 * outlive the page, so they are forgotten whenever it happens, whatever page is open: the
 * first check subscribes once for the app's event bus.
 */
const watchedBuses = new WeakSet<ContentEventBus>();
function forgetOnContentEvents(bus: ContentEventBus, queryClient: QueryClient): void {
  if (watchedBuses.has(bus)) return;
  watchedBuses.add(bus);
  bus.subscribe((event) => {
    if (event.type === "trashed" || event.type === "restored" || event.type === "purged") forgetImportChecks(queryClient);
  });
}

/** Whether the answer names a Content in the library whose collection was not asked for yet. */
function collectionPending(answer: InspectResponse): boolean {
  return answer.collectionCheck === "available" && answer.relatedCollection === undefined;
}

/**
 * Checks the box's single link once typing has paused for `IMPORT_CHECK_DEBOUNCE_MS`. A new edit
 * restarts the pause; a different link (or none) stops a check under way. A successful answer is
 * kept for the signed-in user and the link for `IMPORT_CHECK_CACHE_MS` (forgotten earlier once an
 * import succeeds, Content is trashed or restored, or the user signs out). An answer naming a
 * Content in the library that says its collection can be asked for is shown at once and asked
 * again, right away, with `discoverCollection`. A check that has not answered within
 * `IMPORT_CHECK_QUIET_MS`, or fails, is given up quietly and not kept: the link is checked again
 * once the box holds another link and then this one. It is only a hint, the import checks
 * again, and nothing here ever holds the submit back.
 */
export function useImportCheck(url: string | undefined, text: string): ImportCheckView | undefined {
  const api = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  const userId = useMe().data?.userId ?? "";
  const running = useRef<{ url: string; discover: boolean; controller: AbortController; quiet: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const [checking, setChecking] = useState<string | undefined>(undefined);
  // The link whose last check (or collection question) ended without an answer.
  const [failed, setFailed] = useState<{ url: string; discover: boolean } | undefined>(undefined);
  // Bumped whenever a kept check is stored or forgotten, so the view and the effect read it again.
  const [kept, setKept] = useState(0);

  useEffect(() => forgetOnContentEvents(contentEvents, queryClient), [contentEvents, queryClient]);
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] === IMPORT_CHECK_KEY[0] && (event.type === "added" || event.type === "removed" || event.type === "updated")) setKept((count) => count + 1);
      }),
    [queryClient],
  );
  useEffect(() => {
    if (failed !== undefined && failed.url !== url) setFailed(undefined);
  }, [failed, url]);

  useEffect(() => {
    const stop = (): void => {
      const previous = running.current;
      if (previous === undefined) return;
      clearTimeout(previous.quiet);
      previous.controller.abort();
      running.current = undefined;
      setChecking(undefined);
    };
    if (url === undefined) {
      stop();
      return undefined;
    }
    const answer = keptCheck(queryClient, userId, url);
    const discover = answer !== undefined && collectionPending(answer);
    const givenUp = failed?.url === url && (answer === undefined || failed.discover);
    if ((answer !== undefined && !discover) || givenUp) {
      if (running.current?.url !== url) stop();
      return undefined;
    }
    if (running.current?.url === url && running.current.discover === discover) return undefined;
    stop();
    const start = (): void => {
      const controller = new AbortController();
      const settle = (result: InspectResponse | undefined): void => {
        const current = running.current;
        if (current === undefined || current.controller !== controller) return;
        clearTimeout(current.quiet);
        running.current = undefined;
        setChecking(undefined);
        if (result === undefined) setFailed({ url, discover });
        else queryClient.setQueryData(checkKey(userId, url), result);
      };
      const quiet = setTimeout(() => {
        settle(undefined);
        controller.abort();
      }, IMPORT_CHECK_QUIET_MS);
      running.current = { url, discover, controller, quiet };
      // Asking for the collection keeps the library state on the line; only a first check shows progress.
      if (!discover) setChecking(url);
      const body: InspectRequest = discover ? { url, discoverCollection: true } : { url };
      api.post("/api/contents/inspect", inspectResponseSchema, { body, signal: controller.signal }).then(
        (result) => settle(result),
        () => settle(undefined),
      );
    };
    if (discover) {
      start();
      return undefined;
    }
    const pause = setTimeout(start, IMPORT_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(pause);
  }, [api, queryClient, url, text, userId, failed, kept]);

  useEffect(
    () => () => {
      const current = running.current;
      if (current === undefined) return;
      clearTimeout(current.quiet);
      current.controller.abort();
      running.current = undefined;
    },
    [],
  );

  if (url === undefined) return undefined;
  const answer = keptCheck(queryClient, userId, url);
  if (answer !== undefined) return { url, phase: "done", answer };
  if (failed?.url === url) return { url, phase: "quiet" };
  return { url, phase: checking === url ? "checking" : "waiting" };
}

/**
 * Whether the check has anything to say on the recognition line: while it is under way, and for
 * an answer naming a Content in the library, a video, or a rejected link. Nothing while waiting
 * for the pause, when given up, when the check could not tell, or for any other answer.
 */
export function importCheckShown(check: ImportCheckView | undefined): boolean {
  if (check === undefined) return false;
  if (check.phase === "checking") return true;
  if (check.phase !== "done") return false;
  const result = check.answer.check?.result;
  return check.answer.contentId !== undefined || result === "video" || result === "rejected";
}

/**
 * The check's part of the recognition line, per what it found: checking, already in the
 * library (with 「打开」), a video's title and length, or an image post or an incomplete or
 * expired link (as a field error). Render it only when `importCheckShown`. The collection the
 * video belongs to is a block of its own, `RelatedCollectionNote`.
 */
export function ImportCheckNote(props: { check: ImportCheckView | undefined }) {
  const { t } = useTranslation();
  const { check } = props;
  if (check === undefined || !importCheckShown(check)) return null;
  if (check.phase === "checking") {
    return <span data-testid="import-check-checking">{t("shell.newPage.check.checking")}</span>;
  }
  if (check.phase !== "done") return null;
  const { answer } = check;
  if (answer.contentId !== undefined) {
    return (
      <span data-testid="import-check-in-library">
        {t("shell.newPage.check.inLibrary")}
        <Separator />
        <Link to={`/contents/${encodeURIComponent(answer.contentId)}`} className={TEXT_ACTION_CLASS} data-testid="import-check-open">
          {t("shell.newPage.check.open")}
        </Link>
      </span>
    );
  }
  const found = answer.check;
  if (found?.result === "rejected") {
    return (
      <span className="text-danger" data-testid="import-check-rejected" data-reason={found.reason}>
        <CircleAlert size={14} className="mr-1 inline-block align-[-2px]" aria-hidden="true" />
        {t(`shell.newPage.check.${found.reason}`)}
      </span>
    );
  }
  if (found?.result !== "video") return null;
  return (
    // The title stays on the one line; a long one is cut, its length always shown.
    <span className="inline-flex max-w-full min-w-0 align-bottom" data-testid="import-check-video">
      {found.title === "" ? null : (
        <>
          <span className="min-w-0 truncate" title={found.title}>
            {found.title}
          </span>
          <Separator />
        </>
      )}
      <span className="shrink-0 tabular-nums">{formatDuration(found.durationMs)}</span>
    </span>
  );
}

/**
 * The video id a canonical video link names, as a collection's entries carry it: the last
 * segment of its path. `undefined` for a link that is not one.
 */
export function videoIdOf(canonicalUrl: string): string | undefined {
  try {
    const segment = new URL(canonicalUrl).pathname.split("/").filter((part) => part !== "").at(-1);
    return segment === undefined || segment === "" ? undefined : segment;
  } catch {
    return undefined;
  }
}

/** The collection the checked video belongs to, when the check named one. */
export function relatedCollectionOf(check: ImportCheckView | undefined): RelatedCollection | undefined {
  return check?.phase === "done" ? check.answer.relatedCollection : undefined;
}

/**
 * The collection block under the recognition line: the collection the box's video belongs to,
 * its size when the platform says, and 「选择合集中的视频」. Quiet on purpose, a hint beside the
 * line rather than part of it; nothing when the video belongs to no collection.
 */
export function RelatedCollectionNote(props: { id: string; related: RelatedCollection | undefined; onChoose: (related: RelatedCollection) => void }) {
  const { t } = useTranslation();
  const { related } = props;
  if (related === undefined) return null;
  return (
    <p className={`flex items-baseline gap-1.5 ${NOTE_TEXT_CLASS}`} data-testid="import-check-collection">
      <ListVideo size={14} className="shrink-0 self-center" aria-hidden="true" />
      <span id={props.id} className="min-w-0">
        <span className="break-words">{t("shell.newPage.check.relatedCollection", { title: related.title })}</span>
        {related.itemCount === undefined ? null : (
          <>
            <Separator />
            {t("shell.newPage.check.episodes", { count: related.itemCount })}
          </>
        )}
        <Separator />
        <TextAction onClick={() => props.onChoose(related)} data-testid="import-check-choose">
          {t("shell.newPage.check.chooseFromCollection")}
        </TextAction>
      </span>
    </p>
  );
}

function Separator() {
  return (
    <span aria-hidden="true" className="mx-1.5">
      ·
    </span>
  );
}

/**
 * The platform whose login decides whether a pasted link gets its platform subtitles: bilibili
 * serves them to logged-in users only, so without a valid login the subtitles come from
 * speech recognition. No other platform is pointed at: they are read as visitors first.
 */
const SUBTITLE_LOGIN_PLATFORM: Platform = "bilibili";

/**
 * Whether the box holds a bilibili link while bilibili has no valid login: `none` without a
 * stored login, `expired` once it was found expired. A login saved but not confirmed yet, a
 * valid one, or an account list that cannot be read say nothing. The list is read only once a
 * bilibili link is in the box.
 */
export function useSubtitleLoginHint(parsed: ParsedLinkText, enabled: boolean): "none" | "expired" | undefined {
  const api = useApi();
  const wanted = enabled && parsed.links.some((link) => link.platform === SUBTITLE_LOGIN_PLATFORM);
  const accounts = useQuery({
    queryKey: queryKeys.platformAccounts,
    queryFn: () => api.get("/api/platform-accounts", platformAccountListDtoSchema),
    enabled: wanted,
  });
  if (!wanted || accounts.data === undefined) return undefined;
  const account = accounts.data.accounts.find((candidate) => candidate.platform === SUBTITLE_LOGIN_PLATFORM);
  if (account === undefined) return undefined;
  if (!account.hasCredential) return "none";
  return account.status === "expired" ? "expired" : undefined;
}

/** The login hint's part of the recognition line, linking to the platform's row of the accounts page. */
export function SubtitleLoginNote(props: { state: "none" | "expired" | undefined }) {
  const { t } = useTranslation();
  if (props.state === undefined) return null;
  return (
    <span data-testid="bilibili-login-hint" data-state={props.state}>
      {t(`shell.newPage.bilibiliLogin.${props.state}`)}
      <Separator />
      <Link to={`/settings/platform-accounts?focus=${SUBTITLE_LOGIN_PLATFORM}`} className={TEXT_ACTION_CLASS} data-testid="bilibili-login-link">
        {props.state === "none" ? t("shell.newPage.bilibiliLogin.login") : t("shell.newPage.bilibiliLogin.relogin")}
      </Link>
    </span>
  );
}
