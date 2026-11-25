import { Check, Copy, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatMessageDto } from "../../shared/dto/chat.ts";
import { useProviders } from "../api/queries.ts";
import { formatBeijingDateTime, formatBeijingDateTimeSeconds } from "../format.ts";
import { LlmModelMark } from "../models/model-mark.tsx";
import { FOCUS_RING } from "../ui/button.tsx";
import { useCopyFeedback } from "../ui/copy-feedback.tsx";
import { Tooltip } from "../ui/tooltip.tsx";

const ICON_BUTTON = `flex size-6 items-center justify-center rounded text-muted transition-colors duration-150 motion-reduce:transition-none hover:bg-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`;

/**
 * The row under an answer: copy · retry (last turn only) · delete the turn · the model's mark,
 * Profile name · model id (hover: the protocol it was called through) · when it finished. The
 * mark goes by the model name, else by the service of the Profile while it still exists. Times are Beijing
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
  const { copied, copy } = useCopyFeedback();
  const model = props.answer.modelRef;
  // The list the panel's model picker reads, shared through the query cache.
  const providers = useProviders();
  const presetId = model === undefined ? undefined : providers.data?.items.find((item) => item.id === model.providerProfileId)?.presetId;
  const finished = props.answer.finishedAt;
  const time = finished ?? props.askedAt;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted" data-testid="chat-turn-footer">
      <Tooltip content={copied ? t("chat.turn.copied") : t("chat.turn.copy")}>
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={!props.copyable}
          aria-label={t("chat.turn.copy")}
          data-testid="chat-turn-copy"
          data-copied={copied ? "true" : undefined}
          onClick={() => void copy(props.copy())}
        >
          {copied ? <Check size={13} className="text-ok" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      </Tooltip>
      {props.onRetry === undefined ? null : (
        <Tooltip content={t("chat.turn.retry")}>
          <button type="button" className={ICON_BUTTON} disabled={props.busy} aria-label={t("chat.turn.retry")} data-testid="chat-turn-retry" onClick={props.onRetry}>
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <Tooltip content={t("chat.turn.delete")}>
        <button type="button" className={ICON_BUTTON} disabled={props.busy} aria-label={t("chat.turn.delete")} data-testid="chat-turn-delete" onClick={props.onDelete}>
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </Tooltip>
      {model === undefined ? null : (
        <span className="ml-1 flex min-w-0 items-center gap-1">
          <LlmModelMark modelId={model.modelId} presetId={presetId} size={14} />
          <span
            className="min-w-0 truncate"
            title={model.protocolSnapshot === undefined ? undefined : t(`chat.protocol.${model.protocolSnapshot}`)}
            data-testid="chat-turn-model"
          >
            {model.providerNameSnapshot} · {model.modelId}
          </span>
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
