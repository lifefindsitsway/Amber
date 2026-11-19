/**
 * Below this control-bar width the bar has no room for the 「弹幕」 and 「截图」 buttons: they
 * give way to entries in the settings menu, and the danmaku popover opens from the picture's
 * corner. Measured with the busiest bar (quality menu, capture and danmaku buttons): from this
 * width the clock keeps room for a position past one hour.
 */
export const DANMAKU_NARROW_PICTURE_PX = 440;

/**
 * Whether the control bar is too narrow for the feature buttons. The bar spans the video box,
 * not the picture: the picture is centred in the box, so the box is the picture's width plus
 * its offset on both sides. A portrait video in a wide player keeps its buttons. A width of 0
 * is a picture not measured yet, which counts as wide so the buttons do not flicker.
 */
export function isNarrowPlayer(picture: { x: number; width: number }): boolean {
  const bar = picture.width + 2 * Math.max(0, picture.x);
  return picture.width > 0 && bar < DANMAKU_NARROW_PICTURE_PX;
}
