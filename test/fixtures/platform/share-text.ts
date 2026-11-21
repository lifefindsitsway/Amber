/**
 * Share texts as the platforms' "share" buttons copy them, with made-up titles, ids and
 * tracking values: no real account, video or person is named.
 */

export const BV = "BV1xx411c7mD";
export const BV_2 = "BV1Ab4y1c7Xy";
export const VIDEO = `https://www.bilibili.com/video/${BV}/`;
export const VIDEO_2 = `https://www.bilibili.com/video/${BV_2}/`;
export const SHORT = "https://b23.tv/Ab3dE5f";
export const YT_ID = "UF8uR6Z6KLc";
export const YT_VIDEO = `https://www.youtube.com/watch?v=${YT_ID}`;
export const YT_LIST = "https://www.youtube.com/playlist?list=PLabcdefghij0123456789";
export const UNSUPPORTED = "https://example.com/notes/lecture-1";

/** The web page's share: a title in full-width brackets, then the link with tracking parameters. */
export const WEB_SHARE = `【示例课程 第 1 讲：绪论】 https://www.bilibili.com/video/${BV}/?share_source=copy_web&vd_source=0000placeholder0000`;
export const WEB_SHARE_LINK = `https://www.bilibili.com/video/${BV}/?share_source=copy_web&vd_source=0000placeholder0000`;

/** The app's share: title with the site name, then a short link. */
export const APP_SHARE = `【示例课程 第 2 讲-哔哩哔哩】 ${SHORT}`;

/** A part link with the title after it: a URL parser would take the title into the query. */
export const PART_THEN_TITLE = `https://www.bilibili.com/video/${BV}?p=2 【示例课程 第 2 P】`;

/** A long share message spanning several lines, mixing platforms, an unsupported link and chatter. */
export const LONG_SHARE = [
  "这周的资料都在这里，按顺序看：",
  "",
  `1. ${WEB_SHARE}`,
  `2. 【示例课程 第 2 讲】${VIDEO_2}?p=3。`,
  `3. YouTube 上的对照讲解（${YT_VIDEO}）`,
  `4. 讲义见 ${UNSUPPORTED}，课后再看。`,
  `5. 整个播放列表：${YT_LIST}`,
  "有问题群里说。",
].join("\n");
