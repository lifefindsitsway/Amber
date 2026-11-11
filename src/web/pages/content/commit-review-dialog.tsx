import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerReviewResolution } from "../../../shared/speakers.ts";
import { Button } from "../../ui/button.tsx";

/**
 * Asked when 「完成」 is pressed while sentences still wait for their speaker to be
 * confirmed. The safe way out, 「继续核对」, has the focus: committing is a choice made on
 * purpose, never by pressing Enter through the dialog.
 */
export function CommitReviewDialog(props: {
  open: boolean;
  /** Sentences still marked for review. */
  remaining: number;
  /** Of those, the ones that have a suggested speaker. */
  suggested: number;
  busy: boolean;
  onContinue: () => void;
  onCommit: (resolution: SpeakerReviewResolution) => void;
}) {
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => (open ? undefined : props.onContinue())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          ref={content}
          className="fixed top-[12vh] left-1/2 z-50 max-h-[76vh] w-[92vw] max-w-lg -translate-x-1/2 overflow-auto rounded-lg border border-line bg-surface p-5 shadow-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
          }}
          data-testid="commit-review-dialog"
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">{t("speakerEditor.commit.title")}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-muted hover:bg-sunken" aria-label={t("common.action.close")}>
              <X size={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm" data-testid="commit-review-remaining">
            {t("speakerEditor.commit.message", { count: props.remaining })}
          </Dialog.Description>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Button data-initial-focus="" variant="primary" className="self-start" onClick={props.onContinue} data-testid="commit-review-continue">
                {t("speakerEditor.commit.continue")}
              </Button>
              <p className="text-xs text-muted">{t("speakerEditor.commit.continueHint")}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Button className="self-start" disabled={props.busy} onClick={() => props.onCommit("unassign")} data-testid="commit-review-unassign">
                {t("speakerEditor.commit.unassign")}
              </Button>
              <p className="text-xs text-muted">{t("speakerEditor.commit.unassignHint", { count: props.remaining })}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Button className="self-start" disabled={props.busy} onClick={() => props.onCommit("accept_suggestions")} data-testid="commit-review-accept">
                {t("speakerEditor.commit.accept")}
              </Button>
              <p className="text-xs text-muted">{t("speakerEditor.commit.acceptHint", { count: props.suggested })}</p>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
