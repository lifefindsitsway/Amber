import type { Content } from "../../domain/content.ts";
import { isAmberError } from "../../domain/errors.ts";
import { isPlatform, type Platform } from "../../domain/platform.ts";
import type { PlatformContentRef, PlatformCredential, PlatformMetadata, PlatformSourceAdapter } from "../../ports/platform-source.ts";
import type { Repository } from "../../ports/repository.ts";
import type { StageExecutionContext } from "../executor.ts";

/**
 * What the platform stages need: the adapter for a Content's source kind and the user's
 * login for it. Composed from the platform registry and the account service.
 */
export interface PlatformAccess {
  adapterFor(kind: Platform): PlatformSourceAdapter;
  credentialFor(ownerUserId: string, platform: Platform): PlatformCredential | undefined;
  /** Records that the platform turned the user's login away. */
  markExpired(ownerUserId: string, platform: Platform): void;
  /**
   * Metadata an import check read for this user and link a moment ago, so the source stage
   * need not ask the platform again; `undefined` when there is none or it has gone stale.
   * Only platforms that check links before import ever have any.
   */
  recentMetadata?(ownerUserId: string, platform: Platform, ref: PlatformContentRef): PlatformMetadata | undefined;
}

/**
 * The adapter as callers holding the user's login should use it: when the platform
 * answers `auth_required` to such a call, `onRefused` records the login as expired so
 * the settings and detail pages ask for a new one. Wrapping happens only
 * when a login is sent; guest calls and other refusals (`paid_content`,
 * `platform_blocked`) never touch the account. Caught here rather than where a stage
 * handles the failure, because some stages deliberately carry on after one.
 */
export function expiringOnRefusal(adapter: PlatformSourceAdapter, onRefused: () => void): PlatformSourceAdapter {
  const noteRefusal = (error: unknown): never => {
    if (isAmberError(error) && error.appError.class === "auth_required") {
      onRefused();
    }
    throw error;
  };
  return new Proxy(adapter, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => {
        const result: unknown = value.apply(target, args);
        return result instanceof Promise ? result.catch(noteRefusal) : result;
      };
    },
  });
}

export interface PlatformTarget {
  adapter: PlatformSourceAdapter;
  auth: PlatformCredential | undefined;
  ref: PlatformContentRef;
}

/** The adapter, login and reference of a platform Content; `undefined` for local sources. */
export function platformTarget(access: PlatformAccess, content: Content): PlatformTarget | undefined {
  const { source } = content;
  if (!isPlatform(source.kind) || source.platformContentId === undefined) {
    return undefined;
  }
  const adapter = access.adapterFor(source.kind);
  const auth = access.credentialFor(content.userId, source.kind);
  const platform = source.kind;
  return {
    adapter: auth === undefined ? adapter : expiringOnRefusal(adapter, () => access.markExpired(content.userId, platform)),
    auth,
    ref: {
      platformContentId: source.platformContentId,
      ...(source.platformPartId === undefined ? {} : { platformPartId: source.platformPartId }),
      ...(source.platformCollectionId === undefined ? {} : { platformCollectionId: source.platformCollectionId }),
      ...(source.sourceUrl === undefined ? {} : { sourceUrl: source.sourceUrl }),
    },
  };
}

/** The Content a stage works on, as it is now. */
export function taskContent(repository: Repository, context: StageExecutionContext): Content {
  const { task } = context;
  const content = task.contentId === undefined ? undefined : repository.withTransaction((scope) => scope.contents.getIncludingTrashed(task.userId, task.contentId as string));
  if (content === undefined) {
    throw new TypeError("the stage needs a Content target");
  }
  return content;
}
