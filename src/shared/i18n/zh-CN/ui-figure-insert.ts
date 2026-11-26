/** UI copy of inserting figures (the capture button, the insert menu, upload, paste, recently deleted); keys are dot paths under `figureInsert`. */
export const figureInsert = {
  capture: {
    /** The player's control-bar button (its name and tooltip) and its settings-menu entry in a narrow player. */
    buttonTitle: "截取当前画面，插入原文细读",
    menuItem: "截取当前画面",
    done: "已截图，插入原文细读",
  },
  menu: {
    trigger: "插入图片",
    capture: "截取当前画面",
    upload: "上传图片",
    uploadFormats: "PNG、JPEG、WebP，不超过 {{size}} MB",
    recent: "最近删除（{{count}}）",
    /** Said under 「最近删除（0）」, which is off then. */
    recentEmpty: "没有最近删除的插图",
    recentHint: "删除后保留 {{days}} 天，可在此恢复",
    pasteHint: "也可以直接粘贴图片（{{keys}}）",
    pasteKeysCtrl: "Ctrl+V",
    pasteKeysMeta: "⌘V",
    /** Why the whole entry is off, said beside it and read with it. */
    noTranscript: "有字幕稿后才能插图",
    loading: "正在加载原文…",
    loadFailed: "原文加载失败，暂时不能插图",
    noParagraphs: "这一版原文没有段落，无法插图",
    /** Why 「截取当前画面」 is off. */
    captureNeedsVideo: "本地播放视频时才能截取画面",
    captureNoPicture: "当前播放的文件没有画面，不能截图",
    atLimit: "插图已达 {{limit}} 张上限（最近删除的也计在内）",
  },
  recent: {
    /** One recently deleted figure: what it is, then when it was deleted. */
    capture: "截图 · {{time}}",
    upload: "图片",
    deletedAt: "删除于 {{time}}",
    restore: "恢复",
    restoreLabel: "恢复插图：{{name}}",
  },
  status: {
    capture: "正在截取画面…",
    upload: "正在上传图片…",
    paste: "正在插入粘贴的图片…",
    restore: "正在恢复插图…",
    captureDone: "已插入截图",
    uploadDone: "已插入图片",
    pasteDone: "已插入粘贴的图片",
    restoreDone: "已恢复插图",
    cancelled: "已取消上传",
    cancel: "取消",
    cancelLabel: "取消上传图片",
    dismiss: "关闭",
  },
  error: {
    image: {
      unsupported: "只支持 PNG、JPEG、WebP 图片",
      corrupt: "图片已损坏，无法读取",
      too_large: "图片超过 {{size}} MB，无法插入",
      too_many_pixels: "图片尺寸过大，请缩小后再试",
    },
    frame: {
      no_video: "这个文件没有画面，无法截图",
      past_end: "已到片尾，没有可截取的画面，往前一点再试",
      failed: "截取画面失败，请重试",
    },
    limit: "插图已达 {{limit}} 张上限（最近删除的也计在内）",
    anchor: "插图位置所依据的字幕已变化，请重试",
    purged: "这张插图已超过保留期，无法恢复",
    mediaMissing: "找不到视频文件，无法截图",
    unknown: "操作失败，请重试",
  },
} as const;
