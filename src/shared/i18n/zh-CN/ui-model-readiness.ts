/** The "this model still needs its context window" notice shown where a feature needs it. */
export const modelReadiness = {
  notice: "「{{model}}」还没有填写上下文窗口，总结、章节、高光与 AI 对话需要它。可在厂商的模型说明里查到。",
  inputLabel: "上下文窗口",
  unit: "tokens",
  placeholder: "如 128000",
  suggestions: "常用值",
  suggestionFill: "填入 {{label}}（{{value}} tokens）",
  save: "保存",
  saving: "保存中…",
  settings: "去设置",
  invalid: "请填写正整数，例如 128000 或 128K",
  elsewhere: "「{{model}}」还没有填写上下文窗口，在旁边的提示里填好即可使用。",
  gotoFill: "去填写",
  blockedHint: "先为所选模型填写上下文窗口",
} as const;
