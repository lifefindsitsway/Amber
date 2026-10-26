import { ChevronDown, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatThreadDto } from "../../shared/dto/chat.ts";
import { formatBeijingDateTime } from "../format.ts";

/** A thread's title as listed: the user's own name, else the first line of its first question, else 「新对话」. */
export function useThreadTitle(): (thread: ChatThreadDto | undefined) => string {
  const { t } = useTranslation();
  return (thread) => (thread?.title === undefined || thread.title === "" ? t("chat.threads.untitled") : thread.title);
}

/**
 * The thread menu of the dialogue's top row: the open thread's title, and a list of every
 * thread of the Content (title · time of its last message · rename · pin · delete), in the
 * server's order. Threads with an answer still streaming in this page are marked; switching to
 * another thread never stops it, and such a thread can be renamed or pinned but not deleted.
 */
export function ChatThreadMenu(props: {
  threads: readonly ChatThreadDto[];
  current: ChatThreadDto | undefined;
  running: ReadonlySet<string>;
  onSelect: (threadId: string) => void;
  onRename: (thread: ChatThreadDto) => void;
  onPin: (thread: ChatThreadDto, pinned: boolean) => void;
  onDelete: (thread: ChatThreadDto) => void;
}) {
  const { t } = useTranslation();
  const titleOf = useThreadTitle();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium hover:bg-sunken"
          aria-label={t("chat.threads.menu")}
          title={titleOf(props.current)}
          data-testid="chat-thread-menu"
        >
          {props.current?.pinnedAt === undefined ? null : (
            <Pin size={12} className="shrink-0 text-accent" aria-label={t("chat.threads.pinned")} data-testid="chat-thread-title-pinned" />
          )}
          <span className="min-w-0 truncate" data-testid="chat-thread-title">
            {titleOf(props.current)}
          </span>
          <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 flex max-h-[60vh] w-80 flex-col overflow-auto rounded-md border border-line bg-surface p-1 text-sm shadow-lg"
          data-testid="chat-thread-list"
        >
          {props.threads.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted">{t("chat.threads.empty")}</p> : null}
          <ul>
            {props.threads.map((thread) => {
              const title = titleOf(thread);
              const time = thread.lastMessageAt ?? thread.createdAt;
              const current = thread.id === props.current?.id;
              const pinned = thread.pinnedAt !== undefined;
              return (
                <li key={thread.id} className={`group flex items-center gap-1 rounded ${current ? "bg-accent-soft" : "hover:bg-sunken"}`} data-testid="chat-thread-item" data-thread-id={thread.id}>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start px-2 py-1.5 text-left focus-visible:outline-none"
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      setOpen(false);
                      props.onSelect(thread.id);
                    }}
                  >
                    <span className="flex w-full min-w-0 items-center gap-1">
                      {pinned ? <Pin size={12} className="shrink-0 text-accent" aria-label={t("chat.threads.pinned")} data-testid="chat-thread-pinned" /> : null}
                      <span className="min-w-0 truncate">{title}</span>
                    </span>
                    <span className="text-xs text-muted">
                      {formatBeijingDateTime(time)}
                      {props.running.has(thread.id) ? ` · ${t("chat.threads.running")}` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-muted hover:bg-line hover:text-ink"
                    aria-label={t("chat.threads.renameNamed", { title })}
                    title={t("chat.threads.rename")}
                    onClick={() => {
                      setOpen(false);
                      props.onRename(thread);
                    }}
                    data-testid="chat-thread-rename"
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-muted hover:bg-line hover:text-ink"
                    aria-label={t(pinned ? "chat.threads.unpinNamed" : "chat.threads.pinNamed", { title })}
                    title={t(pinned ? "chat.threads.unpin" : "chat.threads.pin")}
                    onClick={() => {
                      // The menu stays open, so the thread is seen moving to its new place.
                      props.onPin(thread, !pinned);
                    }}
                    data-testid="chat-thread-pin"
                    data-pinned={pinned ? "true" : "false"}
                  >
                    {pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="mr-1 rounded p-1 text-muted hover:bg-line hover:text-danger disabled:opacity-40"
                    aria-label={t("chat.threads.deleteNamed", { title })}
                    title={t("chat.threads.delete")}
                    disabled={props.running.has(thread.id)}
                    onClick={() => {
                      setOpen(false);
                      props.onDelete(thread);
                    }}
                    data-testid="chat-thread-delete"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
