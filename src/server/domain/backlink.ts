import type { ContentSource } from "./content.ts";

/**
 * A link that opens the source at `ms`, or `undefined` for local files, which have no URL,
 * and for platforms whose web pages cannot be opened at a time (Xiaohongshu, Douyin). The `t` query parameter is set or replaced with a URL parser
 * on the canonical source URL, so parameters already there (`p=` of a bilibili part)
 * survive: bilibili reads whole seconds, YouTube seconds with an `s` suffix.
 */
export function backlinkUrl(source: ContentSource, ms: number): string | undefined {
  if (source.sourceUrl === undefined) {
    return undefined;
  }
  const seconds = Math.max(0, Math.floor(ms / 1000));
  let value: string;
  switch (source.kind) {
    case "bilibili":
      value = String(seconds);
      break;
    case "youtube":
      value = `${seconds}s`;
      break;
    case "xiaohongshu":
    case "douyin":
    case "local":
      return undefined;
  }
  const url = new URL(source.sourceUrl);
  url.searchParams.set("t", value);
  return url.toString();
}
