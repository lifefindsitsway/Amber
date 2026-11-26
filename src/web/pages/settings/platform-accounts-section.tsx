import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PLATFORM_COOKIE_BROWSER_DEFAULT } from "../../../shared/defaults.ts";
import { platformAccountDtoSchema, platformCheckDtoSchema, type PlatformAccountDto, type PlatformCheckDto } from "../../../shared/dto/platform-account.ts";
import { COOKIE_BROWSERS } from "../../../shared/dto/settings.ts";
import type { Platform, PlatformAccountStatus } from "../../../shared/enums.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, usePatchSettings, usePlatformAccounts, useSettings, useVersion } from "../../api/queries.ts";
import { clearBilibiliPlayerSession, openBilibiliLogin } from "../../desktop/bridge.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { FilePicker } from "../../ui/file-picker.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { NativeSelect } from "../../ui/native-select.tsx";
import { Callout, NOTE_TEXT_CLASS } from "../../ui/notice.tsx";
import { TextArea } from "../../ui/text-field.tsx";
import { QrLoginButton } from "./qr-login-dialog.tsx";
import { ConfirmButton, CredentialStatus, describedBy, Field, fieldHintId, RequestError, SettingsBlock } from "./settings-ui.tsx";

/**
 * `/settings/platform-accounts`: per platform the login state, an explicit
 * check, removal and a cookies.txt import; server mode adds the bilibili QR login, the
 * desktop client its isolated bilibili login window and the YouTube browser import.
 */
export function PlatformAccountsSection() {
  const { t } = useTranslation();
  const accounts = usePlatformAccounts();
  const version = useVersion();
  const desktop = useDesktop();
  if (accounts.isPending || version.isPending) {
    return <Loading />;
  }
  if (accounts.data === undefined) {
    return <RequestError error={accounts.error} />;
  }
  const server = version.data?.mode === "server";
  return (
    <div>
      <p className={`mb-4 ${NOTE_TEXT_CLASS}`}>{t("settings.platformAccounts.intro")}</p>
      {accounts.data.accounts.map((account) => (
        <AccountBlock key={account.platform} account={account} server={server} desktop={desktop} />
      ))}
    </div>
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

type AccountState = "none" | PlatformAccountStatus;

function stateOf(account: PlatformAccountDto): AccountState {
  return account.hasCredential ? (account.status ?? "unknown") : "none";
}

const STATE_TONE: Record<AccountState, string> = {
  none: "text-muted",
  valid: "text-ok",
  expired: "text-danger",
  unknown: "text-muted",
};

function AccountBlock(props: { account: PlatformAccountDto; server: boolean; desktop: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const { account, server } = props;
  const platform = account.platform;
  const label = t(`common.source.${platform}`);
  const path = `/api/platform-accounts/${platform}`;
  const [checked, setChecked] = useState<PlatformCheckDto | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.platformAccounts });
  const check = useMutation({
    mutationFn: () => client.post(`${path}/check`, platformCheckDtoSchema),
    onMutate: () => setChecked(undefined),
    onSuccess: async (result) => {
      setChecked(result);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => client.delete(path, z.undefined()),
    onSuccess: async () => {
      setChecked(undefined);
      setNotice(undefined);
      if (props.desktop && platform === "bilibili") void clearPlayerSession();
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
      if (!stored) return;
      setChecked(undefined);
      setNotice(t("settings.platformAccounts.desktopLogin.done"));
      await refresh();
    },
  });
  const state = stateOf(account);
  return (
    <SettingsBlock
      title={label}
      actions={
        <>
          {server && platform === "bilibili" ? (
            <QrLoginButton
              onConfirmed={() => {
                setChecked(undefined);
                setNotice(t("settings.platformAccounts.qr.confirmed"));
              }}
            />
          ) : null}
          {props.desktop && platform === "bilibili" ? (
            <Button size="sm" variant="primary" loading={login.isPending} onClick={() => login.mutate()} data-testid="bilibili-login">
              {t("settings.platformAccounts.desktopLogin.open")}
            </Button>
          ) : null}
          {account.hasCredential ? (
            <>
              <Button size="sm" loading={check.isPending} onClick={() => check.mutate()}>
                {t("settings.platformAccounts.check")}
              </Button>
              <ConfirmButton
                label={t("settings.platformAccounts.remove")}
                confirmLabel={t("settings.platformAccounts.remove")}
                variant="danger"
                pending={remove.isPending}
                message={t("settings.platformAccounts.removeConfirm", { platform: label })}
                onConfirm={() => remove.mutate()}
              />
            </>
          ) : null}
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm" data-testid={`account-${platform}`}>
        {account.credentialStatus === "unavailable" ? (
          <CredentialStatus status="unavailable" />
        ) : (
          <span className={STATE_TONE[state]} data-state={state}>
            {t(`settings.platformAccounts.status.${state}`)}
          </span>
        )}
        {account.checkedAt === undefined ? null : (
          <span className="text-xs text-muted">{t("settings.platformAccounts.checkedAt", { time: formatDateTime(account.checkedAt, i18n.language) })}</span>
        )}
      </div>
      {checked === undefined ? null : (
        <p className={`mb-3 text-note ${checked.status === "valid" ? "text-ok" : checked.status === "expired" ? "text-danger" : "text-muted"}`} role="status">
          {t(`settings.platformAccounts.checkResult.${checked.status}`)}
        </p>
      )}
      {notice === undefined ? null : (
        <p className="mb-3 text-note text-ok" role="status">
          {notice}
        </p>
      )}
      <RequestError error={check.error} />
      <RequestError error={remove.error} />
      <RequestError error={login.error} />
      {props.desktop && platform === "youtube" ? (
        <BrowserImport
          onImported={() => {
            setChecked(undefined);
            setNotice(t("settings.platformAccounts.browserImport.done"));
          }}
        />
      ) : null}
      <CookiesImport
        platform={platform}
        server={server}
        onImported={() => {
          setChecked(undefined);
          setNotice(t("settings.platformAccounts.imported"));
        }}
      />
    </SettingsBlock>
  );
}

type CookieBrowser = (typeof COOKIE_BROWSERS)[number];

/**
 * Desktop client: reads the YouTube login of a browser on this computer.
 * The chosen browser is remembered as the user's `platformCookieBrowser`.
 */
function BrowserImport(props: { onImported: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const [chosen, setChosen] = useState<CookieBrowser | undefined>(undefined);
  const browser: CookieBrowser = chosen ?? settings.data?.platformCookieBrowser ?? PLATFORM_COOKIE_BROWSER_DEFAULT;
  const read = useMutation({
    mutationFn: () => client.post("/api/platform-accounts/youtube/import-browser", platformAccountDtoSchema, { body: { browser } }),
    onSuccess: async () => {
      props.onImported();
      await queryClient.invalidateQueries({ queryKey: queryKeys.platformAccounts });
    },
  });
  return (
    <Field label={t("settings.platformAccounts.browserImport.label")} hint={t("settings.platformAccounts.browserImport.hint")} htmlFor="cookie-browser">
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
        <Button size="sm" variant="primary" loading={read.isPending} onClick={() => read.mutate()} data-testid="browser-import">
          {t("settings.platformAccounts.browserImport.read")}
        </Button>
      </div>
      <RequestError error={read.error} />
      <RequestError error={patchSettings.error} />
    </Field>
  );
}

/**
 * Write-only cookie entry: pasted text or a cookies.txt read in the page; the field is
 * cleared once handed over and nothing is ever read back.
 */
function CookiesImport(props: { platform: Platform; server: boolean; onImported: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const id = `cookies-${props.platform}`;
  const put = useMutation({
    mutationFn: (text: string) => client.put(`/api/platform-accounts/${props.platform}/cookies`, platformAccountDtoSchema, { body: { value: text } }),
    onSuccess: async () => {
      setValue("");
      props.onImported();
      await queryClient.invalidateQueries({ queryKey: queryKeys.platformAccounts });
    },
  });
  return (
    <Field label={t("settings.platformAccounts.importLabel")} hint={t("settings.platformAccounts.importHint")} htmlFor={id}>
      {props.server ? (
        // Must be read before pasting: the login is kept on this server, under its administrator.
        <Callout tone="info" density="compact" className="mb-2" id={`${id}-trust`} testId="cookies-trust-hint">
          {t("settings.platformAccounts.serverTrust")}
        </Callout>
      ) : null}
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
          aria-describedby={describedBy(props.server && `${id}-trust`, fieldHintId(id))}
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
          <Button type="submit" variant="primary" size="sm" loading={put.isPending} disabled={value.trim() === ""}>
            {t("settings.platformAccounts.importSubmit")}
          </Button>
        </div>
      </form>
      <RequestError error={put.error} />
    </Field>
  );
}
