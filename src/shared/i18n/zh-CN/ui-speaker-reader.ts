/** UI copy of speakers in the reading view: turns, the 「Aa」 typography popover and copying. */
export const speakerReader = {
  typography: {
    /** The toolbar button's visible text: the conventional "type" glyph pair. */
    trigger: "Aa",
    label: "阅读排版",
    /** The trigger's accessible name starts with its visible text, so voice control can say what it sees. */
    triggerLabel: "Aa 阅读排版",
    fontSize: "字号",
    fontSizeValue: "{{px}} px",
    smaller: "减小字号",
    larger: "增大字号",
    lineHeight: "行高",
    sideMargin: "左右间距",
    sideMarginValue: "{{px}} px",
    narrower: "减小间距",
    wider: "增大间距",
    showSpeakers: "显示发言人",
    reset: "恢复默认",
  },
  turn: {
    /** Accessible name of a turn header: who speaks and when it starts. */
    label: "{{name}}，{{time}}",
  },
  copy: {
    /** The toolbar's copy menu, offered when the text has speakers. */
    menu: "复制",
    body: "复制正文",
    withSpeakers: "复制（含发言人）",
    /** The sentence menu's entry, worded like its other copy entries. */
    sentenceWithSpeaker: "复制这句（含发言人）",
    /** A speaker's name in front of a turn, for Chinese text (full-width colon) and for other languages. */
    prefixCjk: "{{name}}：",
    prefixOther: "{{name}}: ",
  },
} as const;
