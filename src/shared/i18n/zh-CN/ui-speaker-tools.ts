/** UI copy of speakers outside the reader and editor: the subtitle list, transcription options and settings, version info and export. */
export const speakerTools = {
  /** What identification will do for a model and a content length; shared by the re-transcribe options and the new page. */
  note: {
    willIdentify: "将识别发言人",
    unsupported: "此模型不识别发言人",
    overRecommended: "时长超过建议上限，不识别发言人",
  },
  /** The options next to the re-transcribe button. */
  retranscribe: {
    diarization: "识别发言人",
    countAuto: "自动",
    /** A reference value: the provider tries to output that many speakers. */
    countReference: "参考人数 {{min}}–{{max}}",
    countReferenceLabel: "参考人数（{{min}}–{{max}}）",
    /** An upper bound, written around the input: 「最多 [  ] 人」. */
    countMaximumBefore: "最多",
    countMaximumAfter: "人",
    countMaximumLabel: "最多人数（{{min}}–{{max}}）",
    countInvalid: "人数需为 {{min}}–{{max}} 之间的整数",
    unavailable: {
      title: "无法按要求识别发言人：",
      unsupported: "所选模型不支持识别发言人。",
      over_recommended: "内容时长超过该模型建议识别发言人的上限。",
      speaker_count: "人数超出了所选模型允许的范围。",
      speaker_count_range: "人数需为 {{min}}–{{max}} 之间的整数。",
      other: "所选模型或内容暂时无法识别发言人。",
      continueWithout: "不识别发言人，继续转录",
    },
  },
  /** The switch in the transcription settings. */
  settings: {
    diarization: "识别发言人",
    diarizationHint: "新的转录会区分发言人。只对支持该功能的官方模型生效，其他模型照常转录；也可以在重新转录时单独开关。",
  },
  /** Version info of a revision. */
  revisionInfo: {
    diarization: "发言人识别：{{status}}",
    status: {
      applied: "已识别发言人",
      no_speakers: "未识别出发言人",
      off: "未开启识别",
      unsupported: "模型不支持",
      over_recommended: "时长超过建议上限",
    },
    acceptedSuggestions: "{{count}} 句按建议归属，未逐句核对",
  },
  /** The export dialog. */
  export: {
    includeSpeakers: "包含发言人",
    labels: "标注方式",
    labelsHint: "只作用于 SRT 与 TXT。",
    /** Under the subtitles tab's download menu, which has no options of its own. */
    quickHint: "导出的字幕会标出发言人，SRT 和 TXT 只在换人时标一次。要每句都标或不带发言人，请到「总结」页点「导出」。",
    label: {
      turn: "每轮首条",
      every: "每条",
    },
  },
} as const;
