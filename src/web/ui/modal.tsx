import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { keepOpenForContextMenu } from "./context-menu.tsx";

/**
 * Centered dialog with a title; content and footer are the caller's. Focus returns on close to
 * the element that had it when the dialog opened: these dialogs are controlled without a
 * Radix trigger, so Radix itself has nothing to return focus to and would leave it on the
 * page body, losing the keyboard user's place.
 */
export function Modal(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className={`fixed top-[12vh] left-1/2 z-50 max-h-[76vh] w-[92vw] -translate-x-1/2 overflow-auto rounded-lg border border-line bg-surface p-5 shadow-xl ${props.wide === true ? "max-w-3xl" : "max-w-lg"}`}
          aria-describedby={props.description === undefined ? undefined : "modal-description"}
          onPointerDownOutside={keepOpenForContextMenu}
          onOpenAutoFocus={() => {
            // Runs before focus moves into the dialog, so this is still the opener.
            opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            opener.current = null;
            if (target !== null && target.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">{props.title}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-muted hover:bg-sunken" aria-label={t("common.action.close")}>
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
      </Dialog.Portal>
    </Dialog.Root>
  );
}
