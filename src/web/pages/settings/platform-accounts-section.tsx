import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { PLATFORM_COOKIE_BROWSER_DEFAULT, PLATFORM_LOGIN_RECHECK_MS } from "../../../shared/defaults.ts";
import { platformAccountDtoSchema, platformCheckDtoSchema, type PlatformAccountDto } from "../../../shared/dto/platform-account.ts";
import { COOKIE_BROWSERS } from "../../../shared/dto/settings.ts";
import { PLATFORMS, type Platform, type PlatformAccountStatus } from "../../../shared/enums.ts";
import type { zhCN } from "../../../shared/i18n/zh-CN/index.ts";
import { PLATFORM_CAPABILITIES } from "../../../shared/platforms.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, usePatchSettings, usePlatformAccounts, useSettings, useVersion } from "../../api/queries.ts";
import { clearBilibiliPlayerSession, openBilibiliLogin } from "../../desktop/bridge.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { formatDateTime } from "../../format.ts";
import { Button, buttonClass } from "../../ui/button.tsx";
import { Skeleton } from "../../ui/feedback.tsx";
import { FilePicker } from "../../ui/file-picker.tsx";
import { NativeSelect } from "../../ui/native-select.tsx";
import { Callout, FieldHint, TEXT_ACTION_CLASS } from "../../ui/notice.tsx";
import { PlatformIcon } from "../../ui/platform-icons/platform-icon.tsx";
import { TextArea } from "../../ui/text-field.tsx";
import { QrLoginButton } from "./qr-login-dialog.tsx";
import { ConfirmButton, describedBy, fieldHintId, RequestError } from "./settings-ui.tsx";

/** Rows in the order of what a login gains: subtitles first, then verification, then fallbacks. */
const ROW_ORDER: readonly Platform[] = ["bilibili", "youtube", "xiaohongshu", "douyin"];

/** The platforms a login can be stored for, as the copy names them. */
type LoginPlatform = keyof (typeof zhCN)["settings"]["platformAccounts"]["impact"]["valid"];

function isLoginPlatform(platform: Platform): platform is LoginPlatform {
  return PLATFORM_CAPABILITIES[platform].loginSupported;
}

/** The `?focus=` value when it names a platform a login can be stored for; anything else is ignored. */
function focusedPlatform(value: string | null): LoginPlatform | undefined {
  const platform = PLATFORMS.find((item) => item === value);
  return platform !== undefined && isLoginPlatform(platform) ? platform : undefined;
}

/**
 * How strongly each platform asks for a login when it has none, following what the login gains:
 * a bilibili login is what makes its subtitles readable, so its entry is the page's one main
 * button; YouTube's is a plain button; Xiaohongshu's, only a fallback, is a text action.
 */
const PROMINENCE: Readonly<Record<LoginPlatform, "main" | "secondary" | "text">> = {
  bilibili: "main",
  youtube: "secondary",
  xiaohongshu: "text",
};

/** Said above a platform's import form when a logged-in visit carries a risk to the account. */
const IMPORT_RISK: Readonly<Partial<Record<LoginPlatform, "xiaohongshuRisk">>> = {
  xiaohongshu: "xiaohongshuRisk",
};

/** Matches the `duration-150` of the panel's height transition. */
const PANEL_TRANSITION_MS = 150;

/** What can take focus in a panel: enabled form controls and links. */
const FOCUSABLE = [...["button", "select", "textarea", "input"].map((tag) => `${tag}:not([disabled])`), "a[href]"].join(",");

/** A row: icon and text, then (from 480 px of list width) the status and actions on the same line, else below the text. */
const ROW_MAIN = "flex min-h-21 flex-col justify-center gap-2 px-4 py-3 @min-[480px]:flex-row @min-[480px]:items-center @min-[480px]:gap-4";
/** Below the text column: 36 px icon plus 12 px gap; the panel and errors line up with the text too. */
const ROW_ASIDE = "flex flex-wrap items-center gap-x-3 gap-y-2 pl-12 @min-[480px]:shrink-0 @min-[480px]:justify-end @min-[480px]:pl-0";
const TEXT_COLUMN_INSET = "ml-16 mr-4";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * `/settings/platform-accounts`: one list, a row per platform with what its login state means for
 * processing, and the ways to log in opened in place under the row, one row at a time.
 */
export function PlatformAccountsSection() {
  const { t } = useTranslation();
  const accounts = usePlatformAccounts();
  const version = useVersion();
  const desktop = useDesktop();
  const [params] = useSearchParams();
  const focus = focusedPlatform(params.get("focus"));
  const [expanded, setExpanded] = useState<LoginPlatform | undefined>(undefined);
  useEffect(() => {
    if (focus !== undefined) setExpanded(focus);
  }, [focus]);
  if (accounts.isPending || version.isPending) {
    return (
      <div>
        <p className="mb-4 text-note text-muted">{t("settings.platformAccounts.lead")}</p>
        <RowsSkeleton />
      </div>
    );
  }
  if (accounts.data === undefined) {
    return <RequestError error={accounts.error} />;
  }
  const server = version.data?.mode === "server";
  const list = accounts.data.accounts;
  return (
    <div>
      <p className="mb-4 text-note text-muted">{t("settings.platformAccounts.lead")}</p>
      <ul className="@container divide-y divide-line rounded-lg border border-line bg-surface" aria-label={t("settings.platformAccounts.listLabel")} data-testid="platform-account-list">
        {ROW_ORDER.map((platform) =>
          isLoginPlatform(platform) ? (
            <LoginRow
              key={platform}
              platform={platform}
              account={list.find((item) => item.platform === platform) ?? { platform, credentialStatus: "missing", hasCredential: false }}
              server={server}
              desktop={desktop}
              expanded={expanded === platform}
              onExpandedChange={(open) => setExpanded(open ? platform : undefined)}
            />
          ) : (
            <FixedRow key={platform} platform={platform} />
          ),
        )}
      </ul>
    </div>
  );
}

/** Four rows of the real rows' height, so nothing moves when the list arrives. */
function RowsSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="@container divide-y divide-line rounded-lg border border-line bg-surface" data-testid="platform-accounts-skeleton">
      <span className="sr-only">{t("common.state.loading")}</span>
      {ROW_ORDER.map((platform) => (
        <div key={platform} className={ROW_MAIN} data-skeleton-row="">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Skeleton width={36} height={36} className="shrink-0 rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton width="5rem" height={14} />
              <Skeleton width="70%" height={12} />
            </div>
          </div>
          <div className={ROW_ASIDE}>
            <Skeleton width="8rem" height={28} />
          </div>
        </div>
      ))}
    </div>
  );
}

type DotLook = "solid-ok" | "hollow-muted" | "solid-danger" | "solid-muted";

const DOT_CLASS: Record<DotLook, string> = {
  "solid-ok": "bg-ok",
  "hollow-muted": "border-[1.5px] border-muted",
  "solid-danger": "bg-danger",
  "solid-muted": "bg-muted",
};

const DOT_TEXT: Record<DotLook, string> = {
  "solid-ok": "text-ok",
  "hollow-muted": "text-muted",
  "solid-danger": "text-danger",
  "solid-muted": "text-muted",
};

/** A coloured dot and the state in words; the colour is never the only signal. */
function StatusMark(props: { dot: DotLook; text: string; testId: string; state: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${DOT_TEXT[props.dot]}`} data-testid={props.testId} data-state={props.state}>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT_CLASS[props.dot]}`} data-dot={props.dot} />
      {props.text}
    </span>
  );
}

/** Icon tile, platform name and the line saying what the state means. */
function RowText(props: { platform: Platform; nameId: string; detail: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sunken">
        <PlatformIcon platform={props.platform} size={20} />
      </span>
      <div className="min-w-0">
        <p id={props.nameId} className="text-sm font-medium">
          {t(`common.source.${props.platform}`)}
        </p>
        <p className="text-note text-muted" data-testid={`account-detail-${props.platform}`}>
          {props.detail}
        </p>
      </div>
    </div>
  );
}

/** A platform that needs no login: its row says so and offers nothing to do. */
function FixedRow(props: { platform: Platform }) {
  const { t } = useTranslation();
  return (
    <li data-testid={`account-row-${props.platform}`}>
      <div className={ROW_MAIN}>
        <RowText platform={props.platform} nameId={`account-name-${props.platform}`} detail={t(`settings.platformAccounts.impact.none.${props.platform}`)} />
        <div className={ROW_ASIDE}>
          <StatusMark dot="solid-muted" text={t("settings.platformAccounts.state.notRequired")} testId={`account-${props.platform}`} state="not_required" />
        </div>
      </div>
    </li>
  );
}

/**
 * Drops the bilibili login the shell gave the player iframe. Best effort:
 * the shell logs a failure, and the account itself is already settled by then.
 */
async function clearPlayerSession(): Promise<void> {
  try {
    await clearBilibiliPlayerSession();
  } catch {
    return;
  }
}

type LoginState = "none" | "unavailable" | PlatformAccountStatus;

function stateOf(account: PlatformAccountDto): LoginState {
  if (account.credentialStatus === "unavailable") return "unavailable";
  return account.hasCredential ? (account.status ?? "unknown") : "none";
}

/**
 * Whether opening the page should confirm this login: one saved but never confirmed, or one last
 * confirmed longer ago than the recheck interval. Logins that cannot be read are left alone.
 */
function needsCheck(account: PlatformAccountDto, now: number): boolean {
  if (account.credentialStatus !== "configured") return false;
  if ((account.status ?? "unknown") === "unknown" || account.checkedAt === undefined) return true;
  return now - account.checkedAt > PLATFORM_LOGIN_RECHECK_MS;
}

/** The panel's height transition: content stays mounted while it closes, and is dropped afterwards. */
function useCollapse(expanded: boolean): { rendered: boolean; open: boolean } {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const previous = useRef(expanded);
  useEffect(() => {
    const was = previous.current;
    previous.current = expanded;
    if (expanded) {
      setClosing(false);
      if (prefersReducedMotion()) {
        setOpen(true);
        return undefined;
      }
      // One frame at zero height first, so the browser has a start for the transition.
      const frame = window.requestAnimationFrame(() => setOpen(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setOpen(false);
    if (!was || prefersReducedMotion()) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => setClosing(false), PANEL_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [expanded]);
  return { rendered: expanded || closing, open: expanded && open };
}

/** Text that a live region reads once it changes, never on first render. */
function useAnnouncement(text: string): string {
  const [live, setLive] = useState("");
  const previous = useRef(text);
  useEffect(() => {
    if (previous.current !== text) {
      previous.current = text;
      setLive(text);
    }
  }, [text]);
  return live;
}

function LoginRow(props: {
  platform: LoginPlatform;
  account: PlatformAccountDto;
  server: boolean;
  desktop: boolean;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const { account, platform, server, desktop, expanded, onExpandedChange } = props;
  const label = t(`common.source.${platform}`);
  const path = `/api/platform-accounts/${platform}`;
  const toggleId = `account-toggle-${platform}`;
  const panelId = `account-panel-${platform}`;
  const nameId = `account-name-${platform}`;
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const [lastCheck, setLastCheck] = useState<PlatformAccountStatus | undefined>(undefined);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.platformAccounts });
  const collapse = () => {
    restoreFocus.current = true;
    onExpandedChange(false);
  };

  const check = useMutation({
    mutationFn: () => client.post(`${path}/check`, platformCheckDtoSchema),
    onMutate: () => setLastCheck(undefined),
    onSuccess: async (result) => {
      setLastCheck(result.status);
      await refresh();
    },
  });
  /** A login was just stored: show it, then confirm it as the unconfirmed state promises. */
  const saved = async () => {
    if (expanded) collapse();
    await refresh();
    check.mutate();
  };
  const remove = useMutation({
    mutationFn: () => client.delete(path, z.undefined()),
    onSuccess: async () => {
      setLastCheck(undefined);
      if (desktop && platform === "bilibili") void clearPlayerSession();
      collapse();
      await refresh();
    },
  });
  // The login window hands its cookies straight to the backend; they are never kept here.
  // The shell has already given the player iframe that login, so a login the backend did
  // not store is taken back from the iframe too.
  const login = useMutation({
    mutationFn: async (): Promise<boolean> => {
      const result = await openBilibiliLogin();
      if (result === null) return false;
      try {
        await client.put(`${path}/cookies`, platformAccountDtoSchema, { body: { value: result.cookies } });
      } catch (caught) {
        await clearPlayerSession();
        throw caught;
      }
      return true;
    },
    onSuccess: async (stored) => {
      if (stored) await saved();
    },
  });

  // Opening the page confirms a stale or unconfirmed login once; later renders never repeat it.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current) return;
    autoChecked.current = true;
    if (needsCheck(account, Date.now())) check.mutate();
  }, [account, check]);

  // Focus follows the panel: into its first action when it opens, back to the toggle when it closes.
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (expanded && !wasExpanded.current) {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
    if (!expanded && restoreFocus.current) {
      restoreFocus.current = false;
      document.getElementById(toggleId)?.focus();
    }
    wasExpanded.current = expanded;
  });

  const state = stateOf(account);
  const checking = check.isPending;
  const loggedIn = state === "valid" || state === "unknown";
  const bilibiliLogin = platform === "bilibili" ? (server ? "qr" : desktop ? "window" : undefined) : undefined;
  const hasOtherMethod = bilibiliLogin !== undefined || (platform === "youtube" && desktop);
  const time = account.checkedAt === undefined ? undefined : formatDateTime(account.checkedAt, i18n.language);
  const detail =
    state === "none"
      ? t(`settings.platformAccounts.impact.none.${platform}`)
      : state === "valid" && time !== undefined
        ? t(`settings.platformAccounts.impact.valid.${platform}`, { time })
        : state === "expired"
          ? t(`settings.platformAccounts.impact.expired.${platform}`)
          : state === "unavailable"
            ? t("settings.common.credential.unavailable")
            : !checking && lastCheck === "unknown"
              ? t("settings.platformAccounts.checkResult.unknown")
              : t("settings.platformAccounts.unconfirmed");
  const stateText = t(`settings.platformAccounts.state.${checking ? "checking" : state}`);
  const dot: DotLook = checking ? "hollow-muted" : state === "valid" ? "solid-ok" : state === "expired" || state === "unavailable" ? "solid-danger" : "hollow-muted";
  const announcement = useAnnouncement(t("settings.platformAccounts.announce", { platform: label, state: stateText, detail }));
  const { rendered, open } = useCollapse(expanded);

  const loginButton = (variant: "primary" | "secondary", text: string) =>
    bilibiliLogin === "qr" ? (
      <QrLoginButton
        variant={variant}
        label={text}
        onConfirmed={() => {
          setLastCheck(undefined);
          if (expanded) collapse();
        }}
      />
    ) : bilibiliLogin === "window" ? (
      <Button size="sm" variant={variant} loading={login.isPending} onClick={() => login.mutate()} data-testid="bilibili-login">
        {text}
      </Button>
    ) : null;

  const look = loggedIn ? "secondary" : PROMINENCE[platform] === "main" ? "icon" : PROMINENCE[platform];
  const toggleText = loggedIn
    ? t("settings.platformAccounts.manage")
    : state !== "none"
      ? t("settings.platformAccounts.reimport")
      : platform === "youtube" && desktop
        ? t("settings.platformAccounts.browserImport.read")
        : t("settings.platformAccounts.importLogin");
  // One element whatever the state, so focus stays on it when the row's state changes.
  const toggle = (
    <button
      type="button"
      id={toggleId}
      data-testid={toggleId}
      aria-expanded={expanded}
      aria-controls={panelId}
      aria-label={look === "icon" ? t("settings.platformAccounts.moreWays") : undefined}
      className={
        look === "text"
          ? `inline-flex items-center gap-1 text-xs font-medium ${TEXT_ACTION_CLASS}`
          : `${buttonClass(look === "icon" ? "ghost" : "secondary", "sm")} ${look === "icon" ? "w-7 px-0!" : ""}`
      }
      onClick={() => onExpandedChange(!expanded)}
    >
      {look === "icon" ? null : toggleText}
      <ChevronDown size={look === "icon" ? 14 : 12} aria-hidden="true" className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
    </button>
  );

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    // Only keys pressed in this row's own DOM: a dialog opened from the panel lives in a portal
    // and closes itself on Escape.
    if (event.key !== "Escape" || !expanded || !(event.currentTarget as Node).contains(event.target as Node)) return;
    event.preventDefault();
    collapse();
  };

  const loginInPanel = loggedIn;
  const rowErrors = (
    <>
      {expanded ? null : <RequestError error={check.error} />}
      {loginInPanel ? null : <RequestError error={login.error} />}
    </>
  );
  const hasRowErrors = (!expanded && check.error !== null) || (!loginInPanel && login.error !== null);

  return (
    <li data-testid={`account-row-${platform}`} onKeyDown={onKeyDown}>
      <div className={ROW_MAIN}>
        <RowText platform={platform} nameId={nameId} detail={detail} />
        <div className={ROW_ASIDE}>
          <StatusMark dot={dot} text={stateText} testId={`account-${platform}`} state={checking ? "checking" : state} />
          {loggedIn ? null : loginButton("primary", state === "none" ? t(bilibiliLogin === "qr" ? "settings.platformAccounts.qr.open" : "settings.platformAccounts.desktopLogin.open") : t("settings.platformAccounts.relogin"))}
          {toggle}
        </div>
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid={`account-live-${platform}`}>
        {announcement}
      </span>
      {hasRowErrors ? <div className={`${TEXT_COLUMN_INSET} -mt-1 mb-3`}>{rowErrors}</div> : null}
      <div
        id={panelId}
        role="region"
        aria-labelledby={nameId}
        hidden={!rendered}
        inert={!expanded}
        className={`grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
        data-testid={panelId}
      >
        <div className="min-h-0 overflow-hidden">
          {rendered ? (
            <div ref={panelRef} className={`${TEXT_COLUMN_INSET} mb-3 flex flex-col gap-4 rounded-md bg-panel p-3`}>
              {server ? (
                // Read before handing over a login: it is kept on this server, under its administrator.
                <Callout tone="info" density="compact" id={`account-trust-${platform}`} testId="cookies-trust-hint">
                  {t("settings.platformAccounts.serverTrust")}
                </Callout>
              ) : null}
              {account.hasCredential ? (
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" loading={checking} onClick={() => check.mutate()} data-testid={`account-recheck-${platform}`}>
                      {t("settings.platformAccounts.recheck")}
                    </Button>
                    {loginInPanel ? loginButton("secondary", t("settings.platformAccounts.relogin")) : null}
                    <ConfirmButton
                      label={t("settings.platformAccounts.remove")}
                      confirmLabel={t("settings.platformAccounts.remove")}
                      destructive
                      pending={remove.isPending}
                      message={t("settings.platformAccounts.removeConfirm", { platform: label })}
                      onConfirm={() => remove.mutate()}
                      testId={`account-remove-${platform}`}
                    />
                  </div>
                  <RequestError error={check.error} />
                  <RequestError error={remove.error} />
                  {loginInPanel ? <RequestError error={login.error} /> : null}
                </div>
              ) : null}
              {platform === "youtube" && desktop ? <BrowserImport onImported={saved} /> : null}
              {hasOtherMethod ? (
                <OtherWays>
                  <CookiesImport platform={platform} trustId={server ? `account-trust-${platform}` : undefined} onImported={saved} />
                </OtherWays>
              ) : (
                <CookiesImport platform={platform} trustId={server ? `account-trust-${platform}` : undefined} onImported={saved} />
              )}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** The less common ways in (a cookies.txt import), grouped under their own small heading. */
function OtherWays(props: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("settings.platformAccounts.otherWays")} data-testid="account-other-ways">
      <p className="mb-2 text-xs font-medium text-muted" aria-hidden="true">
        {t("settings.platformAccounts.otherWays")}
      </p>
      {props.children}
    </div>
  );
}

/** A label, its control and the hint under it, without the outer spacing of a settings form. */
function PanelField(props: { label: string; htmlFor: string; hint: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      <FieldHint id={fieldHintId(props.htmlFor)} className="mt-1.5">
        {props.hint}
      </FieldHint>
    </div>
  );
}

type CookieBrowser = (typeof COOKIE_BROWSERS)[number];

/**
 * Desktop client: reads the YouTube login of a browser on this computer.
 * The chosen browser is remembered as the user's `platformCookieBrowser`.
 */
function BrowserImport(props: { onImported: () => Promise<void> }) {
  const { t } = useTranslation();
  const client = useApi();
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const [chosen, setChosen] = useState<CookieBrowser | undefined>(undefined);
  const browser: CookieBrowser = chosen ?? settings.data?.platformCookieBrowser ?? PLATFORM_COOKIE_BROWSER_DEFAULT;
  const read = useMutation({
    mutationFn: () => client.post("/api/platform-accounts/youtube/import-browser", platformAccountDtoSchema, { body: { browser } }),
    onSuccess: () => props.onImported(),
  });
  return (
    <PanelField label={t("settings.platformAccounts.browserImport.label")} hint={t("settings.platformAccounts.browserImport.hint")} htmlFor="cookie-browser">
      {/* Read before reading a browser: it exports every site's cookies for a moment. */}
      <Callout tone="info" density="compact" className="mb-2" id="cookie-browser-notice" testId="browser-import-notice">
        {t("settings.platformAccounts.browserImport.notice")}
      </Callout>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          id="cookie-browser"
          className="w-40"
          aria-describedby={describedBy("cookie-browser-notice", fieldHintId("cookie-browser"))}
          value={browser}
          onChange={(event) => {
            const next = event.target.value as CookieBrowser;
            setChosen(next);
            patchSettings.mutate({ platformCookieBrowser: next });
          }}
        >
          {COOKIE_BROWSERS.map((item) => (
            <option key={item} value={item}>
              {t(`settings.platformAccounts.browserImport.browser.${item}`)}
            </option>
          ))}
        </NativeSelect>
        <Button size="sm" loading={read.isPending} onClick={() => read.mutate()} data-testid="browser-import">
          {t("settings.platformAccounts.browserImportSubmit")}
        </Button>
      </div>
      <RequestError error={read.error} />
      <RequestError error={patchSettings.error} />
    </PanelField>
  );
}

/**
 * Write-only cookie entry: pasted text or a cookies.txt read in the page; the field is
 * cleared once handed over and nothing is ever read back.
 */
function CookiesImport(props: { platform: LoginPlatform; trustId: string | undefined; onImported: () => Promise<void> }) {
  const { t } = useTranslation();
  const client = useApi();
  const [value, setValue] = useState("");
  const id = `cookies-${props.platform}`;
  const risk = IMPORT_RISK[props.platform];
  const riskId = `${id}-risk`;
  const put = useMutation({
    mutationFn: (text: string) => client.put(`/api/platform-accounts/${props.platform}/cookies`, platformAccountDtoSchema, { body: { value: text } }),
    onSuccess: () => {
      setValue("");
      return props.onImported();
    },
  });
  // The risk is said above the whole form, label included, so the label stays next to its field.
  return (
    <>
      {risk === undefined ? null : (
        <Callout tone="warn" density="compact" className="mb-2" id={riskId} testId={`${props.platform}-import-risk`}>
          {t(`settings.platformAccounts.${risk}`)}
        </Callout>
      )}
      <PanelField label={t("settings.platformAccounts.importLabel")} hint={t("settings.platformAccounts.importHint")} htmlFor={id}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim() !== "") {
              put.mutate(value);
            }
          }}
        >
          <TextArea
            id={id}
            rows={4}
            size="sm"
            autoComplete="off"
            spellCheck={false}
            className="w-full font-mono"
            aria-describedby={describedBy(risk !== undefined && riskId, props.trustId, fieldHintId(id))}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <FilePicker
              accept=".txt,text/plain"
              fileName={undefined}
              size="sm"
              hideName
              buttonLabel={t("settings.platformAccounts.importFile")}
              onFile={(file) => {
                if (file !== undefined) void file.text().then(setValue);
              }}
            />
            {/* Outlined like every other entry on this page: the page's one brand-coloured button is the bilibili login. */}
            <Button type="submit" size="sm" loading={put.isPending} disabled={value.trim() === ""}>
              {t("settings.platformAccounts.importSubmit")}
            </Button>
          </div>
        </form>
        <RequestError error={put.error} />
      </PanelField>
    </>
  );
}
