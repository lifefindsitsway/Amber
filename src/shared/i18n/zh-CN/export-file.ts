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
  /** A figure's label in a transcript exported with its figures: the image's alt text and the start of its caption line. */
  figure: "图 {{number}}",
  /** Name of a speaker nobody named: `{{ordinal}}` counts from 1 within the Content. */
  speakerDefault: "发言人 {{ordinal}}",
  /** A speaker's name in front of a line, for Chinese text (full-width colon) and for other languages. */
  speakerPrefixCjk: "{{name}}：",
  speakerPrefixOther: "{{name}}: ",
  /** The export dialog's figure options: a transcript with its figures downloads as a zip of the text and an `images/` folder. */
  dialog: {
    figures: "包含插图与备注（{{count}} 张）",
    figuresLoading: "包含插图与备注",
    figuresNone: "这条内容还没有插图",
    figuresMarkdownNote: "下载为 .zip：Markdown 文件加 images 文件夹，图片按阅读顺序编号",
    figuresTxtNote: "下载为 .zip：文稿加图片文件，文稿里用编号标出每张图的位置",
    downloadZip: "下载 .zip",
    txtZip: "TXT（.zip）",
    copyWithoutFigures: "复制的 Markdown 不含图片",
    saved: "已导出「{{filename}}」",
  },
  /** Titles of the subtitle tracks muxed into an exported video. */
  subtitleTrack: {
    bilingual: "Amber 双语",
    original: "Amber 原文",
    translation: "Amber 译文",
  },
} as const;
