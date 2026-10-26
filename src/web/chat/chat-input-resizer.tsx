import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";

/** Height change of one arrow key press on the handle. */
const KEY_STEP_PX = 16;

/**
 * The input's height while its top edge is dragged: moving up makes it taller, as when
 * pulling the top edge of a window. The CSS min and max heights still bound the result.
 */
export function draggedHeight(startHeight: number, startY: number, y: number): number {
  return Math.max(0, startHeight + (startY - y));
}

/**
 * A grip along the top edge of the chat box. The input sits at the bottom of the panel, so
 * it grows upwards; the textarea's own corner handle would grow it downwards, against what
 * users expect there. A double click returns the input to its automatic height.
 */
export function ChatInputResizer(props: { target: RefObject<HTMLTextAreaElement | null> }) {
  const { t } = useTranslation();
  const drag = useRef<{ y: number; height: number } | undefined>(undefined);

  const setHeight = (height: number | undefined) => {
    const input = props.target.current;
    if (input !== null) input.style.height = height === undefined ? "" : `${height}px`;
  };
  const currentHeight = () => props.target.current?.getBoundingClientRect().height ?? 0;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (props.target.current === null || event.button !== 0) return;
    event.preventDefault();
    drag.current = { y: event.clientY, height: currentHeight() };
    // Capture keeps the drag going when the pointer leaves the thin grip; the drag works
    // without it, so a pointer the browser cannot capture never breaks it.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Not capturable (an inactive or synthetic pointer): the moves over the grip still count.
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start !== undefined) setHeight(draggedHeight(start.height, start.y, event.clientY));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setHeight(Math.max(0, currentHeight() + (event.key === "ArrowUp" ? KEY_STEP_PX : -KEY_STEP_PX)));
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("chat.resizeInput")}
      title={t("chat.resizeInput")}
      tabIndex={0}
      data-testid="chat-input-resizer"
      className="group flex h-2 shrink-0 cursor-ns-resize touch-none items-center justify-center rounded-t-lg outline-none focus-visible:bg-sunken"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => setHeight(undefined)}
      onKeyDown={onKeyDown}
    >
      <span className="h-0.5 w-8 rounded-full bg-line group-hover:bg-muted group-focus-visible:bg-muted" aria-hidden="true" />
    </div>
  );
}
