import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FOCUS_RING } from "./button.tsx";
import { keepOpenForContextMenu } from "./context-menu.tsx";

/** Dialog width: `md` for confirmations and short forms, `wide` for lists and editors, `xl` for side-by-side views. */
export type ModalSize = "md" | "wide" | "xl";

const WIDTH: Readonly<Record<ModalSize, string>> = {
  md: "max-w-lg",
  wide: "max-w-3xl",
  xl: "max-w-5xl",
};

const CLOSE_CLASS = "rounded p-1 text-muted hover:bg-sunken";

/**
 * Centered dialog with a title. Focus returns on close to the element that had it when the
 * dialog opened: these dialogs are controlled without a Radix trigger, so Radix itself has
 * nothing to return focus to and would leave it on the page body, losing the keyboard user's place.
 *
 * Without `footer` the content and its buttons are the caller's and the whole dialog scrolls.
 * With `footer` the dialog is three stacked parts: the title (and description) stays at the top,
 * the body scrolls on its own, and the footer stays visible at the bottom, so the buttons are in
 * reach however long the body or however small the window (narrow, or zoomed to 200%). Put the
 * footer's buttons in reading order, cancel first; they are aligned to the right.
 */
/**
 * A dialog opened from a menu item gets that item as its opener, but the menu closes as the
 * dialog opens, so the item is gone by the time focus should come back. Climb to the button
 * that opened the menu (Radix names the menu in its trigger's `aria-controls`), through any
 * submenus, so closing the dialog returns focus to the control the user started from.
 */
function menuOpener(element: HTMLElement): HTMLElement {
  let current = element;
  for (let menu = current.closest<HTMLElement>("[role=menu]"); menu !== null && menu.id !== ""; menu = current.closest<HTMLElement>("[role=menu]")) {
    const trigger = document.querySelector<HTMLElement>(`[aria-controls="${menu.id.replace(/["\\]/gu, "\\$&")}"]`);
    if (trigger === null) break;
    current = trigger;
  }
  return current;
}

export function Modal(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Buttons that stay in view below a scrolling body. */
  footer?: ReactNode;
  /** A decorative mark before the title of a sectioned dialog, e.g. the platform a list comes from. */
  titleIcon?: ReactNode;
  /** Same as `size: "wide"`; kept for existing callers. */
  wide?: boolean;
  size?: ModalSize;
  testId?: string;
}) {
  const { t } = useTranslation();
  const opener = useRef<HTMLElement | null>(null);
  const descriptionId = useId();
  const size: ModalSize = props.size ?? (props.wide === true ? "wide" : "md");
  const sectioned = props.footer !== undefined;
  const contentProps = {
    onPointerDownOutside: keepOpenForContextMenu,
    onOpenAutoFocus: () => {
      // Runs before focus moves into the dialog, so this is still the opener.
      opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? menuOpener(document.activeElement) : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const target = opener.current;
      opener.current = null;
      if (target !== null && target.isConnected) {
        event.preventDefault();
        target.focus({ preventScroll: true });
      }
    },
    ...(props.testId === undefined ? {} : { "data-testid": props.testId }),
  };
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        {sectioned ? (
          <Dialog.Content
            // Anchored at the top so a body that grows (an error appears) extends downwards
            // instead of moving the title; the height cap keeps the footer on screen.
            className={`fixed top-[min(12dvh,6rem)] left-1/2 z-50 flex max-h-[calc(100dvh_-_min(12dvh,6rem)_-_1rem)] w-[92vw] -translate-x-1/2 flex-col rounded-lg border border-line bg-surface shadow-xl ${WIDTH[size]}`}
            aria-describedby={props.description === undefined ? undefined : descriptionId}
            data-sectioned=""
            {...contentProps}
          >
            <div className="flex shrink-0 flex-col gap-1.5 px-6 pt-6 pb-4">
              <div className="flex items-start justify-between gap-4">
                <Dialog.Title className="flex min-w-0 items-center gap-2 text-base font-semibold">
                  {props.titleIcon === undefined ? null : (
                    <span className="flex shrink-0 items-center" aria-hidden="true">
                      {props.titleIcon}
                    </span>
                  )}
                  <span className="min-w-0">{props.title}</span>
                </Dialog.Title>
                <Dialog.Close className={`-mt-1 -mr-2 ${CLOSE_CLASS} ${FOCUS_RING}`} aria-label={t("common.action.close")}>
                  <X size={16} />
                </Dialog.Close>
              </div>
              {props.description === undefined ? null : (
                <Dialog.Description id={descriptionId} className="max-w-[70ch] text-sm text-muted">
                  {props.description}
                </Dialog.Description>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-6 pb-4 empty:hidden" data-modal-body="">
              {props.children}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-4" data-modal-footer="">
              {props.footer}
            </div>
          </Dialog.Content>
        ) : (
          <Dialog.Content
            className={`fixed top-[12vh] left-1/2 z-50 max-h-[76vh] w-[92vw] -translate-x-1/2 overflow-auto rounded-lg border border-line bg-surface p-5 shadow-xl ${WIDTH[size]}`}
            aria-describedby={props.description === undefined ? undefined : "modal-description"}
            {...contentProps}
          >
            <div className="mb-3 flex items-start justify-between gap-4">
              <Dialog.Title className="text-base font-semibold">{props.title}</Dialog.Title>
              <Dialog.Close className={CLOSE_CLASS} aria-label={t("common.action.close")}>
                <X size={16} />
              </Dialog.Close>
            </div>
            {props.description === undefined ? null : (
              <Dialog.Description id="modal-description" className="mb-3 text-sm text-muted">
                {props.description}
              </Dialog.Description>
            )}
            {props.children}
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}
