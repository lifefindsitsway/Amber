/** UI copy of paragraphs in the transcript editor: starting and merging paragraphs, and why a merge is not possible. */
export const paragraphEditor = {
  /** The action under the active sentence when it does not open a paragraph. */
  split: "从这句另起一段",
  /** The action under the active sentence when it opens a paragraph. */
  merge: "并入上一段",
  /** Shown after the action, the shortcut that does the same. */
  shortcut: "Ctrl+Enter",
  shortcutMac: "⌘+Enter",
  /** Why the action is disabled, shown next to it. */
  blocked: {
    first: "这是全文第一段",
    chapter: "这里是章节开头，章节之间总是分段",
    speaker: "这里换了发言人，不同发言人总是分段",
    hidden: "上一句被筛选隐藏了，显示全部句子后才能调整这里的分段",
  },
  /** What the undo control says it takes back. */
  undo: {
    split: "另起一段",
    merge: "合并段落",
  },
  /** Announced to assistive technology once the action is done. */
  done: {
    split: "已从这句另起一段",
    merge: "已并入上一段",
  },
  /** The split control's option to open a paragraph at the right half. */
  splitRightStarts: "后半句另起一段",
  /** Why a sentence cannot be split, in a transcript without speakers. */
  splitTooShort: "句子短于 {{ms}} 毫秒，不能拆成两半",
  /** Accessible description of a sentence that opens a paragraph. */
  startLabel: "段首",
} as const;
