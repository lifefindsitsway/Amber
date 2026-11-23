import { ChevronDown, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatThreadDto } from "../../shared/dto/chat.ts";
import { formatBeijingDateTime } from "../format.ts";
import { FOCUS_RING } from "../ui/button.tsx";
import { InlineNote } from "../ui/notice.tsx";
import { Tooltip } from "../ui/tooltip.tsx";

/**
 * A thread row's icon buttons. Delete is drawn like its neighbours: in a menu every entry has the
 * same colour, and the danger colour is kept for the confirmation that follows.
 */
const ROW_ICON = `rounded p-1 text-muted transition-colors duration-150 motion-reduce:transition-none hover:bg-line hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`;

/** A thread's title as listed: the user's own name, else the first line of its first question, else 「新对话」. */
export function useThreadTitle(): (thread: ChatThreadDto | undefined) => string {
  const { t } = useTranslation();
  return (thread) => (thread?.title === undefined || thread.title === "" ? t("chat.threads.untitled") : thread.title);
}

/**
 * The thread menu of the dialogue's top row: the open thread's title (a label for the history
 * when there is no thread or it has no title), and a list of every thread of the Content
 * (title · time of its last message · rename · pin · delete), in the server's order. Threads with an answer still streaming in this page are marked; switching to
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
  // Without a title the trigger names what it opens (the history) instead of claiming a new thread.
  const currentTitle = props.current?.title === undefined || props.current.title === "" ? t("chat.threads.currentUntitled") : props.current.title;
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium hover:bg-sunken ${FOCUS_RING}`}
          aria-label={t("chat.threads.menu")}
          title={currentTitle}
          data-testid="chat-thread-menu"
        >
          {props.current?.pinnedAt === undefined ? null : (
            <Pin size={12} className="shrink-0 text-accent" aria-label={t("chat.threads.pinned")} data-testid="chat-thread-title-pinned" />
          )}
          <span className="min-w-0 truncate" data-testid="chat-thread-title">
            {currentTitle}
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
          {props.threads.length === 0 ? <InlineNote className="px-2 py-1.5">{t("chat.threads.empty")}</InlineNote> : null}
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
                    className="flex min-w-0 flex-1 flex-col items-start rounded px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
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
                  <Tooltip content={t("chat.threads.rename")}>
                    <button
                      type="button"
                      className={ROW_ICON}
                      aria-label={t("chat.threads.renameNamed", { title })}
                      onClick={() => {
                        setOpen(false);
                        props.onRename(thread);
                      }}
                      data-testid="chat-thread-rename"
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip content={t(pinned ? "chat.threads.unpin" : "chat.threads.pin")}>
                    <button
                      type="button"
                      className={ROW_ICON}
                      aria-label={t(pinned ? "chat.threads.unpinNamed" : "chat.threads.pinNamed", { title })}
                      onClick={() => {
                        // The menu stays open, so the thread is seen moving to its new place.
                        props.onPin(thread, !pinned);
                      }}
                      data-testid="chat-thread-pin"
                      data-pinned={pinned ? "true" : "false"}
                    >
                      {pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
                    </button>
                  </Tooltip>
                  <Tooltip content={t("chat.threads.delete")}>
                    <button
                      type="button"
                      className={`mr-1 ${ROW_ICON}`}
                      aria-label={t("chat.threads.deleteNamed", { title })}
                      disabled={props.running.has(thread.id)}
                      onClick={() => {
                        setOpen(false);
                        props.onDelete(thread);
                      }}
                      data-testid="chat-thread-delete"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
