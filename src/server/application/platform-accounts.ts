import { monotonicFactory } from "ulid";
import { PLATFORM_COOKIE_BROWSER_DEFAULT } from "../../shared/defaults.ts";
import type { PlatformAccountDto, PlatformAccountListDto, PlatformCheckDto } from "../../shared/dto/platform-account.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import { canonicalPlatformCookies } from "../domain/platform-cookie.ts";
import type { Platform } from "../domain/platform.ts";
import { LOGIN_PLATFORMS } from "../../shared/platforms.ts";
import type { PlatformAccount } from "../domain/provider-profile.ts";
import type { CookieBrowser } from "../domain/runtime-support.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { PlatformCredential } from "../ports/platform-source.ts";
import type { Repository } from "../ports/repository.ts";
import type { SecretStore } from "../ports/secret-store.ts";
import type { PlatformRegistry } from "./platforms.ts";

export interface PlatformAccountServiceOptions {
  repository: Repository;
  secrets: SecretStore;
  platforms: PlatformRegistry;
  now?: () => number;
  newId?: () => string;
}

/**
 * The user's platform logins. A cookie is stored only as a
 * Secret envelope in its canonical Netscape form, filtered to the platform's domains;
 * each `(userId, platform)` has one account and a new cookie replaces the old Secret
 * atomically. Nothing here ever returns or logs the cookie.
 */
export class PlatformAccountService {
  private readonly options: PlatformAccountServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: PlatformAccountServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  list(principal: RequestPrincipal): PlatformAccountListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => ({
      accounts: LOGIN_PLATFORMS.map((platform) => this.dto(owner, platform, scope.platformAccounts.get(owner, platform))),
    }));
  }

  /** `PUT cookies`: stored with status `unknown`; checking is a separate, explicit action. */
  putCookies(principal: RequestPrincipal, platform: Platform, value: string): PlatformAccountDto {
    const owner = principal.userId;
    const cookies = canonicalPlatformCookies(value, this.cookieDomainsOf(platform), this.now());
    return this.storeUnchecked(owner, platform, cookies);
  }

  /** Stores canonical cookies with status `unknown`, replacing any previous Secret atomically. */
  private storeUnchecked(owner: string, platform: Platform, cookies: string): PlatformAccountDto {
    return this.options.repository.withTransaction((scope) => {
      const existing = scope.platformAccounts.get(owner, platform);
      if (existing === undefined) {
        const credentialRef = this.options.secrets.store(owner, cookies);
        scope.platformAccounts.insert({ id: this.newId(), userId: owner, platform, credentialRef, status: "unknown" });
      } else {
        this.options.secrets.replace(owner, existing.credentialRef, cookies);
        scope.platformAccounts.setStatus(owner, platform, "unknown", undefined);
      }
      return this.dto(owner, platform, scope.platformAccounts.get(owner, platform));
    });
  }

  /**
   * A login handed over by a confirmed QR code: stored like `PUT cookies` but known to work
   * right now, so the account is `valid` as of this moment.
   */
  saveConfirmedLogin(ownerUserId: string, platform: Platform, cookies: string): void {
    const canonical = canonicalPlatformCookies(cookies, this.cookieDomainsOf(platform), this.now());
    this.options.repository.withTransaction((scope) => {
      const existing = scope.platformAccounts.get(ownerUserId, platform);
      const checkedAt = this.now();
      if (existing === undefined) {
        const credentialRef = this.options.secrets.store(ownerUserId, canonical);
        scope.platformAccounts.insert({ id: this.newId(), userId: ownerUserId, platform, credentialRef, status: "valid", checkedAt });
      } else {
        this.options.secrets.replace(ownerUserId, existing.credentialRef, canonical);
        scope.platformAccounts.setStatus(ownerUserId, platform, "valid", checkedAt);
      }
    });
  }

  /**
   * The platform refused a request made with this login as not logged in (`auth_required`):
   * the account is `expired` until the user logs in again. Nothing happens without an account.
   */
  markExpired(ownerUserId: string, platform: Platform): void {
    const checkedAt = this.now();
    this.options.repository.withTransaction((scope) => {
      if (scope.platformAccounts.get(ownerUserId, platform) !== undefined) {
        scope.platformAccounts.setStatus(ownerUserId, platform, "expired", checkedAt);
      }
    });
  }

  /**
   * `POST check`: `valid` / `expired` are recorded; `unknown` (network or transient
   * platform trouble) leaves the stored status alone so nobody is told to log in again
   * for a hiccup.
   */
  async check(principal: RequestPrincipal, platform: Platform, signal: AbortSignal): Promise<PlatformCheckDto> {
    const owner = principal.userId;
    const credential = this.credentialFor(owner, platform);
    if (credential === undefined) {
      throw amberError("not_found", "no account for this platform");
    }
    const adapter = this.options.platforms.adapterFor(platform);
    if (adapter.checkCredential === undefined) {
      throw amberError("not_found", "this platform has no login");
    }
    const status = await adapter.checkCredential(credential, signal);
    if (status !== "unknown") {
      const checkedAt = this.now();
      this.options.repository.withTransaction((scope) => {
        if (scope.platformAccounts.get(owner, platform) !== undefined) {
          scope.platformAccounts.setStatus(owner, platform, status, checkedAt);
        }
      });
    }
    return { status };
  }

  /**
   * `POST /api/platform-accounts/:platform/import-browser` [client]:
   * the browser named, else the user's `platformCookieBrowser`, else
   * `PLATFORM_COOKIE_BROWSER_DEFAULT`; the adapter's export is filtered to `cookieDomains`
   * and stored like `PUT cookies`. Fails with `browser_cookies_unavailable`.
   */
  async importFromBrowser(principal: RequestPrincipal, platform: Platform, browser: CookieBrowser | undefined, signal: AbortSignal): Promise<PlatformAccountDto> {
    const owner = principal.userId;
    const adapter = this.options.platforms.adapterFor(platform);
    if (adapter.importBrowserCookies === undefined) {
      throw amberError("not_found", "this platform cannot read its login from a browser");
    }
    const chosen =
      browser ??
      this.options.repository.withTransaction((scope) => scope.userSettings.get(owner))?.platformCookieBrowser ??
      PLATFORM_COOKIE_BROWSER_DEFAULT;
    // The export holds every site's cookies of that browser profile; only the platform's
    // own domains are kept, and the unfiltered text goes nowhere else.
    const exported = await adapter.importBrowserCookies(chosen, signal);
    let cookies: string;
    try {
      cookies = canonicalPlatformCookies(exported, this.cookieDomainsOf(platform), this.now());
    } catch (error) {
      // Nothing of the platform in the profile means the user is not logged in there: to
      // the user that is the same "could not read the login" as an unreadable profile.
      if (error instanceof AmberError && error.appError.class === "invalid_request") {
        throw amberError("browser_cookies_unavailable", "the browser profile holds no usable login for this platform");
      }
      throw error;
    }
    return this.storeUnchecked(owner, platform, cookies);
  }

  /** Removes the account and, through the schema trigger, its Secret. */
  delete(principal: RequestPrincipal, platform: Platform): void {
    const owner = principal.userId;
    const deleted = this.options.repository.withTransaction((scope) => scope.platformAccounts.delete(owner, platform));
    if (!deleted) {
      throw amberError("not_found", "no account for this platform");
    }
  }

  /**
   * The login handed to adapters: the Secret is decrypted only when an adapter actually
   * asks for the cookies, and the plaintext lives only in that call.
   */
  credentialFor(ownerUserId: string, platform: Platform): PlatformCredential | undefined {
    const account = this.options.repository.withTransaction((scope) => scope.platformAccounts.get(ownerUserId, platform));
    if (account === undefined) {
      return undefined;
    }
    const secrets = this.options.secrets;
    return {
      platform,
      cookies: async () => secrets.reveal(ownerUserId, account.credentialRef),
    };
  }

  /** The platform's cookie domains; a platform without login support has no account at all. */
  private cookieDomainsOf(platform: Platform): readonly string[] {
    const domains = this.options.platforms.adapterFor(platform).cookieDomains;
    if (domains === undefined) {
      throw amberError("not_found", "this platform has no login");
    }
    return domains;
  }

  private dto(owner: string, platform: Platform, account: PlatformAccount | undefined): PlatformAccountDto {
    const credentialStatus = this.options.secrets.status(owner, account?.credentialRef);
    return {
      platform,
      credentialStatus,
      hasCredential: credentialStatus !== "missing",
      ...(account === undefined ? {} : { status: account.status }),
      ...(account?.checkedAt === undefined ? {} : { checkedAt: account.checkedAt }),
    };
  }
}
