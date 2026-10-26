import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DISPLAY_NAME_MAX_CHARS } from "../../shared/defaults.ts";
import type { ChatThreadDto } from "../../shared/dto/chat.ts";
import { ApiError } from "../api/client.ts";
import { ErrorView } from "../components/error-view.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";
import { usePatchChatThread } from "./chat-data.ts";

/**
 * The user's own name for one chat thread. Saving it blank drops that name, so the thread is
 * called after its first question again. Allowed while an answer of the thread streams.
 */
export function ChatThreadRenameDialog(props: { contentId: string; thread: ChatThreadDto | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={props.thread !== undefined} onOpenChange={props.onOpenChange} title={t("chat.threads.renameTitle")}>
      {props.thread === undefined ? null : <RenameForm key={props.thread.id} contentId={props.contentId} thread={props.thread} onDone={() => props.onOpenChange(false)} />}
    </Modal>
  );
}

function RenameForm(props: { contentId: string; thread: ChatThreadDto; onDone: () => void }) {
  const { t } = useTranslation();
  const patch = usePatchChatThread(props.contentId);
  const { thread } = props;
  const [title, setTitle] = useState(thread.title ?? "");
  const trimmed = title.trim();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    // Unchanged, or blank with no own name to drop: nothing to send.
    if (trimmed === "" ? thread.customTitle === undefined : trimmed === thread.title) return props.onDone();
    patch.mutate({ threadId: thread.id, patch: { title: trimmed === "" ? null : trimmed } }, { onSuccess: props.onDone });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="chat-thread-rename-form">
      <label className="flex flex-col gap-1 text-sm">
        {t("chat.threads.renameLabel")}
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          autoFocus
          className="h-9 rounded-md border border-line bg-surface px-2"
          data-testid="chat-thread-rename-input"
        />
        <span className="text-xs text-muted">{t("chat.threads.renameHint")}</span>
      </label>
      {patch.error instanceof ApiError ? <ErrorView error={patch.error.error} /> : null}
      <div className="flex items-center justify-end gap-2">
        <Button onClick={props.onDone}>{t("common.action.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={patch.isPending} data-testid="chat-thread-rename-save">
          {t("common.action.save")}
        </Button>
      </div>
    </form>
  );
}
