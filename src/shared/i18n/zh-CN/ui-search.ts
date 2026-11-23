/** UI copy of search (Omnibox groups, library / collection search, in-page locating); keys are dot paths under `search`. */
export const search = {
  group: {
    contents: "内容",
    segments: "字幕命中",
    summaries: "总结命中",
    collections: "合集",
    figures: "插图备注",
  },
  kind: {
    title: "标题",
    reference: "参考资料",
    summary: "总结",
    /** Tells several figures of one Content apart: its place among them, or the frame's time for a capture. */
    figure: "图 {{n}}",
    figureCapture: "截图 {{time}}",
  },
  failed: "搜索失败，请稍后重试",
  empty: "没有找到相关内容",
  emptyHint: "试试更短的关键词，或换个说法",
  emptyAction: "粘贴视频链接，新建总结",
  libraryPlaceholder: "搜索标题、字幕与总结",
  collectionPlaceholder: "在本合集中搜索",
  untitled: "未命名内容",
} as const;
