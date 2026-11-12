/** UI copy of the font group of the reading-view typography popover. */
export const readerFont = {
  label: "字体",
  /** The five choices, in display order. */
  choice: {
    default: "默认",
    sans: "黑体",
    serif: "宋体",
    kai: "楷体",
    custom: "自选",
  },
  /** Accessible name of a bundled choice while its font is being read. */
  loading: "{{name}}（加载中）",
  loadFailed: "字体加载失败",
  customLabel: "本机字体名",
  customPlaceholder: "输入本机已安装的字体名",
  customInvalid: "字体名最多 {{max}} 个字符，不能含引号、反斜杠、分号、花括号、逗号或控制字符",
  /** The detection is a measurement heuristic: a hint, never a refusal. */
  customFound: "已找到",
  customMissing: "未检测到，仍可使用；本机没有这个字体时显示默认字体",
} as const;
