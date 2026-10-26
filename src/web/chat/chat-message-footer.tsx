import { Check, Copy, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatMessageDto } from "../../shared/dto/chat.ts";
import { formatBeijingDateTime, formatBeijingDateTimeSeconds } from "../format.ts";
import { copyText } from "../ui/clipboard.ts";
import { useAutoDismiss } from "../use-auto-dismiss.ts";

const ICON_BUTTON = "flex size-6 items-center justify-center rounded text-muted hover:bg-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The row under an answer: copy · retry (last turn only) · delete the turn · Profile name ·
 * model id (hover: the protocol it was called through) · when it finished. Times are Beijing
 * time; answers stored before finish times were kept show the question's time instead, and
 * say so on hover.
 */
export function ChatMessageFooter(props: {
  answer: ChatMessageDto;
  askedAt: number | undefined;
  /** The answer as plain text, built when copied so it reflects what is shown. */
  copy: () => string;
  copyable: boolean;
  /** Absent: retry is not offered on this turn. */
  onRetry?: (() => void) | undefined;
  onDelete: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<number | undefined>(undefined);
  useAutoDismiss(copied, () => setCopied(undefined));
  const model = props.answer.modelRef;
  const finished = props.answer.finishedAt;
  const time = finished ?? props.askedAt;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted" data-testid="chat-turn-footer">
      <button
        type="button"
        className={ICON_BUTTON}
        disabled={!props.copyable}
        title={copied === undefined ? t("chat.turn.copy") : t("chat.turn.copied")}
        aria-label={t("chat.turn.copy")}
        data-testid="chat-turn-copy"
        onClick={() => {
          void copyText(props.copy()).then((ok) => {
            if (ok) setCopied(Date.now());
          });
        }}
      >
        {copied === undefined ? <Copy size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
      </button>
      {props.onRetry === undefined ? null : (
        <button type="button" className={ICON_BUTTON} disabled={props.busy} title={t("chat.turn.retry")} aria-label={t("chat.turn.retry")} data-testid="chat-turn-retry" onClick={props.onRetry}>
          <RotateCcw size={13} aria-hidden="true" />
        </button>
      )}
      <button type="button" className={ICON_BUTTON} disabled={props.busy} title={t("chat.turn.delete")} aria-label={t("chat.turn.delete")} data-testid="chat-turn-delete" onClick={props.onDelete}>
        <Trash2 size={13} aria-hidden="true" />
      </button>
      {model === undefined ? null : (
        <span
          className="ml-1 min-w-0 truncate"
          title={model.protocolSnapshot === undefined ? undefined : t(`chat.protocol.${model.protocolSnapshot}`)}
          data-testid="chat-turn-model"
        >
          {model.providerNameSnapshot} · {model.modelId}
        </span>
      )}
      {time === undefined ? null : (
        <time
          className="ml-1 whitespace-nowrap"
          dateTime={new Date(time).toISOString()}
          title={t(finished === undefined ? "chat.turn.askedAtHint" : "chat.turn.finishedAtHint", { time: formatBeijingDateTimeSeconds(time) })}
          data-testid="chat-turn-time"
          data-fallback={finished === undefined ? "asked" : undefined}
        >
          {formatBeijingDateTime(time)}
        </time>
      )}
    </div>
  );
}
