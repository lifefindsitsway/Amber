/** UI copy of figures in the reading view (figure rows, caption editing, width, moving, deleting); keys are dot paths under `figures`. */
export const figures = {
  block: {
    /** The figure's accessible name: what it is and its caption, if any. */
    label: "插图",
    labelWithCaption: "插图：{{caption}}",
    /** The image's text alternative when the figure has no caption. */
    alt: "插图图片",
    loading: "图片加载中",
    loadFailed: "图片加载失败",
    retry: "重试",
  },
  time: {
    /** The capture time under a frame: what clicking it does, for assistive technology and the tooltip. */
    seek: "跳到截图时刻 {{time}}",
  },
  zoom: {
    open: "放大查看",
    title: "插图",
    close: "关闭",
  },
  caption: {
    label: "插图备注",
    add: "添加备注",
    edit: "编辑备注",
    /** The caption as a control: activating it starts editing. */
    editLabel: "编辑备注：{{caption}}",
    placeholder: "写点备注…",
    hintCtrl: "回车换行 · Ctrl+Enter 保存 · Esc 取消",
    hintMeta: "回车换行 · ⌘+Enter 保存 · Esc 取消",
    count: "{{count}}/{{max}}",
    tooLong: "备注最多 {{max}} 字",
    saving: "保存中…",
    saved: "已保存",
    failed: "保存失败",
    retry: "重试",
  },
  width: {
    group: "插图宽度",
    small: "小",
    medium: "中",
    large: "大",
    smallLabel: "小图",
    mediumLabel: "中图",
    largeLabel: "大图",
    /** Shown beside the handle while it is dragged. */
    percent: "{{percent}}%",
    handle: "拖动调整宽度",
    failed: "调整宽度失败",
  },
  move: {
    /** The move handle: dragged with the pointer, or moved with the arrow keys once focused. */
    handle: "移动插图（拖动，或按 ↑ ↓ 键）",
    up: "上移一段",
    down: "下移一段",
    toPlayback: "移到当前播放位置",
    toCapture: "回到截图时刻",
    atTop: "已在最前",
    atBottom: "已在最后",
    noPlayback: "播放视频后才能移到播放位置",
    filtered: "显示完整原文后才能移动插图",
    /** Read out after a move: where the figure is now, so two moves never read the same. */
    movedAfter: "插图已移到第 {{paragraph}} 段之后",
    movedTop: "插图已移到最前",
    failed: "移动失败",
  },
  menu: {
    more: "插图操作",
    delete: "删除插图",
  },
  deleted: {
    text: "已删除插图",
    undo: "撤销",
    undoLabel: "撤销删除插图",
    failed: "删除失败",
    undoFailed: "撤销失败",
  },
  conflict: "这张插图已在别处修改，已显示最新内容",
  locate: {
    missing: "要查看的插图已删除或不存在",
  },
  loadFailed: "插图加载失败",
} as const;
