/** UI copy of notices about the speakers an AI result was generated with, the speaker filter and speakers in search. */
export const speakerContext = {
  /** One line on a summary, chapters or highlights whose speaker basis no longer holds; keyed by the derived state. */
  notice: {
    attribution_changed: "生成后有 {{count}} 句改了发言人，其中的人物观点可能不再准确",
    evidence_removed: "引用的 {{count}} 句原话已被删除，相关结论失去依据",
    unknown: "无法确认发言人依据是否仍然一致",
    names_changed: "生成时为{{was}}，现为{{now}}",
    unconfirmed: "当前字幕稿的发言人未核对",
  },
  /** The same notices when the server gave no count or names to quote. */
  noticePlain: {
    attribution_changed: "生成后有句子改了发言人，其中的人物观点可能不再准确",
    evidence_removed: "引用的原话已被删除，相关结论失去依据",
    names_changed: "生成后有发言人改了名字",
  },
  /** Between several 「生成时为甲，现为乙」. */
  renamedSeparator: "；",
  /** A result made without speakers, while the current transcript's speakers are reviewed. */
  canInclude: "重新生成可带上发言人",
  /** Beside a generation entry while the transcript it would read has unreviewed speakers. */
  notRead: "发言人未核对，本次不读取",
  /** Beside the collection summary's button. */
  collectionChanged: "{{count}} 个成员的总结发言人依据已变化，建议先重新生成",
  filter: {
    /** The reading toolbar's icon button. */
    trigger: "只看某些发言人",
    triggerActive: "只看某些发言人，已选 {{count}} 人",
    /** The popover's heading. */
    title: "只看",
    sentences: "{{count}} 句",
    /** The line under the toolbar while the filter is on. */
    active: "只看 {{names}} · {{turns}} 轮",
    nameSeparator: "、",
    clear: "清除",
    /** A bar between two shown turns that were not next to each other. */
    gap: "略过 {{duration}}",
    gapLabel: "略过 {{duration}}，回到完整原文的这个位置",
    empty: "这份字幕稿里没有所选发言人的句子",
    clearFilter: "清除筛选",
    noSpeakers: "这份字幕稿没有标注发言人",
  },
  /** A skipped stretch of time, coarsest unit first. */
  duration: {
    hours: "{{hours}} 小时 {{minutes}} 分",
    minutes: "{{minutes}} 分 {{seconds}} 秒",
    seconds: "{{seconds}} 秒",
  },
  search: {
    /** Muted after the name of a speaker whose transcript is not reviewed. */
    unconfirmed: "未核对",
    basisChanged: "人物依据已变化",
    /** The group of speakers whose name matches; a name match only, never one person across Contents. */
    group: "发言人（姓名匹配）",
    hitDetail: "{{title}} · {{count}} 句",
  },
  citation: {
    /** The hover card of a citation badge. */
    card: "引用的原句",
    play: "播放这句",
    /** For a player that cannot be started by the page: it only seeks. */
    jump: "跳到这句",
  },
} as const;
