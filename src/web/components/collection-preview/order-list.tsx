import { GripVertical, ListRestart } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button.tsx";
import { EmptyState } from "../../ui/feedback.tsx";
import { FieldHint, InlineNote, TextAction } from "../../ui/notice.tsx";
import { Tooltip } from "../../ui/tooltip.tsx";
import { useDragOrder } from "../../ui/use-drag-order.ts";
import { EntryCover, EntryDuration, EntryTitle } from "./entry-parts.tsx";
import { processingOrder, type PreviewSession } from "./state.ts";

/** Over the processing order, kept in view: how to rearrange it, and the way back to the platform's. */
export function OrderToolbar(props: { session: PreviewSession; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-2 pb-2" data-testid="preview-order-toolbar">
      <InlineNote>{t("shell.collectionPreview.orderHint")}</InlineNote>
      <Button size="sm" variant="ghost" disabled={props.session.order === undefined} onClick={props.onReset} data-testid="preview-order-reset">
        <ListRestart size={14} aria-hidden="true" />
        {t("shell.collectionPreview.restoreOrder")}
      </Button>
    </div>
  );
}

/**
 * The chosen entries of one collection in processing order: drag a row by its handle, or focus
 * the handle and use the arrow keys (the same gesture as reordering a collection), or send a row
 * to the front. Restoring the platform's order drops the arrangement.
 */
export function OrderList(props: { session: PreviewSession; onArrange: (order: string[]) => void; onMoveToFront: (id: string) => void }) {
  const { t } = useTranslation();
  const baseId = useId();
  const ids = processingOrder(props.session);
  const { order, dragging, rowRef, handleProps } = useDragOrder(ids, props.onArrange);
  const byId = new Map(props.session.entries.map((entry) => [entry.platformContentId, entry]));
  const handles = useRef(new Map<string, HTMLButtonElement>());
  // A row sent to the front takes the focus to its handle: its own 「移到最前」 is gone there.
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (focusId === undefined) return;
    handles.current.get(focusId)?.focus();
    setFocusId(undefined);
  }, [focusId, order]);

  if (ids.length === 0) {
    return <EmptyState title={t("shell.collectionPreview.orderEmpty")} hint={t("shell.collectionPreview.orderEmptyHint")} />;
  }
  return (
    <div className="flex flex-col gap-3 pt-1" data-testid="preview-order">
      <ol className="flex flex-col">
        {order.map((id, index) => {
          const entry = byId.get(id);
          if (entry === undefined) return null;
          const title = entry.title ?? t("shell.collectionPreview.untitled");
          return (
            <li
              key={id}
              ref={rowRef(id)}
              className={`flex min-h-15 items-center gap-3 rounded-md px-2 py-2 ${dragging === id ? "bg-accent-soft" : "hover:bg-panel"}`}
              data-testid="preview-order-row"
              data-entry-id={id}
            >
              <Tooltip content={t("shell.collectionPreview.dragTip")}>
                <button
                  type="button"
                  ref={(element) => {
                    if (element === null) handles.current.delete(id);
                    else handles.current.set(id, element);
                  }}
                  className="cursor-grab touch-none rounded p-1 text-muted outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  aria-label={t("shell.collectionPreview.dragHandle", {
                    title,
                  })}
                  data-testid="preview-order-handle"
                  {...handleProps(id)}
                >
                  <GripVertical size={14} aria-hidden="true" />
                </button>
              </Tooltip>
              <span className="w-6 shrink-0 text-right text-xs text-muted tabular-nums">{index + 1}</span>
              <EntryCover entry={entry} />
              <EntryTitle entry={entry} className="min-w-0 flex-1 text-sm" />
              <EntryDuration entry={entry} />
              {/* Kept in place on the first row, only hidden, so the columns stay put. */}
              <TextAction
                className={`shrink-0 text-note ${index === 0 ? "invisible" : ""}`}
                tabIndex={index === 0 ? -1 : undefined}
                aria-hidden={index === 0 ? true : undefined}
                onClick={() => {
                  props.onMoveToFront(id);
                  setFocusId(id);
                }}
                data-testid="preview-order-front"
              >
                {t("shell.collectionPreview.moveToFront")}
              </TextAction>
            </li>
          );
        })}
      </ol>
      <FieldHint id={`${baseId}-note`} className="mt-1" testId="preview-order-note">
        {t("shell.collectionPreview.orderNote")}
      </FieldHint>
    </div>
  );
}
