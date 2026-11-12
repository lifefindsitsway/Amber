/** UI copy of speaker labels on player subtitles and in exported video. */
export const subtitleSpeaker = {
  editor: {
    title: "发言人",
    hint: "姓名显示在该条字幕上方，沿用字幕的字体、颜色与描边",
    value: { off: "不显示", change: "换人时", every: "每条" },
  },
  burn: {
    summary: "发言人：{{mode}}",
    mp4Unsupported: "MP4 字幕轨不保留位置与底框，无法显示发言人姓名；请改用 MKV 或硬字幕，或在字幕样式中关闭发言人",
    unreviewed: "所选字幕稿的发言人尚未核对，视频中的姓名按当前归属写入",
  },
} as const;
