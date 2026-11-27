import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { IMPORT_CHECK_DEBOUNCE_MS, IMPORT_CHECK_QUIET_MS } from "../../shared/defaults.ts";
import { inspectResponseSchema, type InspectResponse, type RelatedCollection } from "../../shared/dto/import.ts";
import { platformAccountListDtoSchema } from "../../shared/dto/platform-account.ts";
import type { Platform } from "../../shared/enums.ts";
import { platformCapabilities } from "../../shared/platforms.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys } from "../api/queries.ts";
import { formatDuration } from "../format.ts";
import type { ParsedLinkText } from "../links.ts";
import { TEXT_ACTION_CLASS, TextAction } from "../ui/notice.tsx";

/**
 * The link a box is checked for before import: only when it holds exactly one link, of a
 * platform that checks single links, and not a collection (a collection is previewed instead).
 */
export function checkableLink(parsed: ParsedLinkText): string | undefined {
  const link = parsed.links[0];
  if (parsed.all.length !== 1 || link === undefined || link.kind === "collection") return undefined;
  return platformCapabilities(link.platform).importCheck ? link.url : undefined;
}

/** Where the check of the box's link stands; `undefined` when the box holds no checkable link. */
export type ImportCheckView =
  | { url: string; phase: "waiting" | "checking" | "quiet" }
  | { url: string; phase: "done"; answer: InspectResponse };

/** What a check ended in: its answer, or nothing worth showing (no answer in time, or a failure). */
type Settled = { answer: InspectResponse } | { quiet: true };

/**
 * Checks the box's single link once typing has paused for `IMPORT_CHECK_DEBOUNCE_MS`. A new edit
 * restarts the pause; a different link (or none) stops a check under way. Each link is checked at
 * most once on the page and its result reused. A check that has not answered within
 * `IMPORT_CHECK_QUIET_MS`, or fails, is given up quietly: it is only a hint, the import checks
 * again, and nothing here ever holds the submit back.
 */
export function useImportCheck(url: string | undefined, text: string): ImportCheckView | undefined {
  const api = useApi();
  const settled = useRef(new Map<string, Settled>());
  const running = useRef<{ url: string; controller: AbortController; quiet: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const [checking, setChecking] = useState<string | undefined>(undefined);
  const [, setSettledCount] = useState(0);

  useEffect(() => {
    if (url !== undefined && (settled.current.has(url) || running.current?.url === url)) return undefined;
    const previous = running.current;
    if (previous !== undefined) {
      clearTimeout(previous.quiet);
      previous.controller.abort();
      running.current = undefined;
      setChecking(undefined);
    }
    if (url === undefined) return undefined;
    const settle = (controller: AbortController, result: Settled): void => {
      const current = running.current;
      if (current === undefined || current.controller !== controller) return;
      clearTimeout(current.quiet);
      running.current = undefined;
      settled.current.set(url, result);
      setChecking(undefined);
      setSettledCount((count) => count + 1);
    };
    const pause = setTimeout(() => {
      const controller = new AbortController();
      const quiet = setTimeout(() => {
        settle(controller, { quiet: true });
        controller.abort();
      }, IMPORT_CHECK_QUIET_MS);
      running.current = { url, controller, quiet };
      setChecking(url);
      api.post("/api/contents/inspect", inspectResponseSchema, { body: { url }, signal: controller.signal }).then(
        (answer) => settle(controller, { answer }),
        () => settle(controller, { quiet: true }),
      );
    }, IMPORT_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(pause);
  }, [api, url, text]);

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
  const result = settled.current.get(url);
  if (result !== undefined) return "answer" in result ? { url, phase: "done", answer: result.answer } : { url, phase: "quiet" };
  return { url, phase: checking === url ? "checking" : "waiting" };
}

/**
 * Whether the check has anything to say: while it is under way, and for an answer naming a
 * Content in the library, a video, or a rejected link. Nothing while waiting for the pause, when
 * given up, when the check could not tell, or for any other answer.
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
 * library (with 「打开」), a video's title and length, the collection the video belongs to (with
 * 「选择合集中的视频」), an image post or an incomplete or expired link (as a field error). Render
 * it only when `importCheckShown`.
 */
export function ImportCheckNote(props: { check: ImportCheckView | undefined; onChooseFromCollection: (related: RelatedCollection, answer: InspectResponse) => void }) {
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
  const related = answer.relatedCollection;
  if (related !== undefined) {
    return (
      <span data-testid="import-check-collection">
        {t("shell.newPage.check.relatedCollection", { title: related.title })}
        {related.itemCount === undefined ? null : (
          <>
            <Separator />
            {t("shell.newPage.check.episodes", { count: related.itemCount })}
          </>
        )}
        <Separator />
        <TextAction onClick={() => props.onChooseFromCollection(related, answer)} data-testid="import-check-choose">
          {t("shell.newPage.check.chooseFromCollection")}
        </TextAction>
      </span>
    );
  }
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
