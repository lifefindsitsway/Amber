import { PLATFORMS, type Platform } from "./enums.ts";

/**
 * What each platform supports, the one table server and web consult instead of branching on
 * platform literals. A new platform fails to compile until every capability is decided, and a
 * test keeps each adapter consistent with its row.
 */
export interface PlatformCapabilities {
  /** The user can store a platform login (QR code, login window, cookies). Without it, every platform account route answers `not_found`. */
  readonly loginSupported: boolean;
  /** The platform offers an embeddable player; without one a Content plays only from a local cache. */
  readonly onlinePlayer: boolean;
  /** The canonical source link carries an access parameter that expires, so a copied link may stop opening. */
  readonly linkMayExpire: boolean;
  /** A single link is checked against the platform before import (video, not a video, cannot tell). */
  readonly importCheck: boolean;
  /** A pasted single video link can reveal the platform collection the video belongs to. */
  readonly relatedCollection: boolean;
}

export const PLATFORM_CAPABILITIES: Readonly<Record<Platform, PlatformCapabilities>> = {
  bilibili: { loginSupported: true, onlinePlayer: true, linkMayExpire: false, importCheck: false, relatedCollection: true },
  youtube: { loginSupported: true, onlinePlayer: true, linkMayExpire: false, importCheck: false, relatedCollection: false },
  xiaohongshu: { loginSupported: true, onlinePlayer: false, linkMayExpire: true, importCheck: true, relatedCollection: false },
  douyin: { loginSupported: false, onlinePlayer: false, linkMayExpire: false, importCheck: true, relatedCollection: true },
};

export function platformCapabilities(platform: Platform): PlatformCapabilities {
  return PLATFORM_CAPABILITIES[platform];
}

/** Platforms a login can be stored for, in enumeration order. */
export const LOGIN_PLATFORMS: readonly Platform[] = PLATFORMS.filter((platform) => PLATFORM_CAPABILITIES[platform].loginSupported);
