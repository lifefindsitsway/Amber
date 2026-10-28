/**
 * Fixed text inside exported files. `{{name}}` slots are filled
 * by the exporter; revision labels reuse `contentView.revisionKind`.
 */
export const exportFile = {
  source: "来源：{{source}}",
  duration: "时长 {{duration}}",
  exportedAt: "导出于 {{date}}",
  app: "Amber {{version}}",
  summary: "总结（{{template}}）",
  chapters: "章节",
  transcript: "原文细读（{{revision}}）",
  subtitles: "字幕",
  unresolvedCitation: "引用无法定位",
  collectionSummary: "合集归纳",
  lectures: "各项内容",
  noCoreSummary: "（尚无核心总结）",
  collectionSummaryHidden: "合集归纳暂不可用：有内容在回收站中",
  untitled: "未命名",
  /** Titles of the subtitle tracks muxed into an exported video. */
  subtitleTrack: {
    bilingual: "Amber 双语",
    original: "Amber 原文",
    translation: "Amber 译文",
  },
} as const;
