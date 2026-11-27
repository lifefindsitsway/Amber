import type { Platform } from "../../domain/platform.ts";
import { videoUrl as bilibiliVideoUrl } from "./bilibili/url.ts";
import { videoUrl as douyinVideoUrl } from "./douyin/url.ts";
import { explorePageUrl } from "./xiaohongshu/url.ts";
import { watchUrl } from "./youtube/url.ts";

/**
 * The canonical link of a platform Content from its identity alone, for when a stored link
 * cannot be trusted. It carries no part number or access parameter: those exist only in a link
 * the platform gave out.
 */
export function platformContentUrl(platform: Platform, platformContentId: string): string {
  switch (platform) {
    case "bilibili":
      return bilibiliVideoUrl(platformContentId);
    case "youtube":
      return watchUrl(platformContentId);
    case "xiaohongshu":
      return explorePageUrl(platformContentId);
    case "douyin":
      return douyinVideoUrl(platformContentId);
  }
}
