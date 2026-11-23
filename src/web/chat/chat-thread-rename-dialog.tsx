import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DISPLAY_NAME_MAX_CHARS } from "../../shared/defaults.ts";
import type { ChatThreadDto } from "../../shared/dto/chat.ts";
import { ApiError } from "../api/client.ts";
import { ErrorView } from "../components/error-view.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";
import { FieldHint } from "../ui/notice.tsx";
import { TextInput } from "../ui/text-field.tsx";
import { usePatchChatThread } from "./chat-data.ts";

/**
 * The user's own name for one chat thread. Saving it blank drops that name, so the thread is
 * called after its first question again (a blank name is a choice here, not an error). Allowed
 * while an answer of the thread streams.
 */
export function ChatThreadRenameDialog(props: { contentId: string; thread: ChatThreadDto | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const formId = useId();
  const patch = usePatchChatThread(props.contentId);
  const close = (): void => props.onOpenChange(false);
  // A refusal belongs to the attempt that got it: the next opening starts clean.
  const onOpenChange = (open: boolean): void => {
    if (!open) patch.reset();
    props.onOpenChange(open);
  };
  return (
    <Modal
      open={props.thread !== undefined}
      onOpenChange={onOpenChange}
      title={t("chat.threads.renameTitle")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.action.cancel")}</Button>
          <Button type="submit" form={formId} variant="primary" loading={patch.isPending} data-testid="chat-thread-rename-save">
            {t("common.action.save")}
          </Button>
        </>
      }
    >
      {props.thread === undefined ? null : <RenameForm key={props.thread.id} formId={formId} thread={props.thread} patch={patch} onDone={close} />}
    </Modal>
  );
}

function RenameForm(props: { formId: string; thread: ChatThreadDto; patch: ReturnType<typeof usePatchChatThread>; onDone: () => void }) {
  const { t } = useTranslation();
  const hintId = useId();
  const { thread, patch } = props;
  const [title, setTitle] = useState(thread.title ?? "");
  const trimmed = title.trim();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    // Unchanged, or blank with no own name to drop: nothing to send.
    if (trimmed === "" ? thread.customTitle === undefined : trimmed === thread.title) return props.onDone();
    patch.mutate({ threadId: thread.id, patch: { title: trimmed === "" ? null : trimmed } }, { onSuccess: props.onDone });
  };
  return (
    <form id={props.formId} onSubmit={submit} className="flex flex-col gap-5" data-testid="chat-thread-rename-form">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${hintId}-input`} className="text-sm font-medium">
          {t("chat.threads.renameLabel")}
        </label>
        <TextInput
          id={`${hintId}-input`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          autoFocus
          aria-describedby={hintId}
          data-testid="chat-thread-rename-input"
        />
        <FieldHint id={hintId}>{t("chat.threads.renameHint")}</FieldHint>
      </div>
      {patch.error instanceof ApiError ? <ErrorView error={patch.error.error} /> : null}
    </form>
  );
}
