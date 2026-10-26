import { Copy, CornerDownRight, Quote } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChatQuote, WebSourceDto } from "../../shared/dto/chat.ts";
import type { ChatMessageStatus } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import { ErrorView } from "../components/error-view.tsx";
import { answerPlainText } from "../components/plain-text.ts";
import { RichText } from "../components/rich-text.tsx";
import { useContentPage } from "../pages/content/content-context.tsx";
import { useSegments } from "../pages/content/content-data.ts";
import { copyText } from "../ui/clipboard.ts";
import { useContextMenuTarget, type MenuAction } from "../ui/context-menu.tsx";
import { Spinner } from "../ui/feedback.tsx";
import { ChatMessageFooter } from "./chat-message-footer.tsx";
import { WebSearchStatusLine, type WebSearchView } from "./chat-web-search.tsx";

export function UserMessage(props: { text: string; quote: ChatQuote | undefined; quoteText?: string | undefined }) {
  const { t } = useTranslation();
  const segments = useSegments(props.quoteText === undefined ? props.quote?.transcriptRevisionId : undefined);
  const quoted = props.quoteText ?? segments.data?.find((segment) => segment.id === props.quote?.segmentId)?.text;
  const text = props.text;
  const menuTarget = useContextMenuTarget<HTMLDivElement>(() => ({
    kind: "text",
    entries: [{ id: "copy", label: t("common.action.copy"), icon: <Copy size={14} aria-hidden="true" />, onSelect: () => void copyText(text) }],
  }));
  return (
    <div ref={menuTarget} className="my-2 flex flex-col items-end gap-1" data-testid="chat-message" data-role="user">
      {props.quote === undefined ? null : (
        <p className="flex max-w-[85%] items-start gap-1 rounded bg-sunken px-2 py-1 text-xs text-muted">
          <Quote size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2">{quoted ?? ""}</span>
        </p>
      )}
      <p className="max-w-[85%] rounded-md bg-accent-soft px-3 py-1.5 text-sm whitespace-pre-wrap">{props.text}</p>
    </div>
  );
}

/** The footer of a stored answer; the copy text is filled in by the answer itself. */
export interface AnswerFooter {
  answer: Parameters<typeof ChatMessageFooter>[0]["answer"];
  askedAt: number | undefined;
  onRetry?: (() => void) | undefined;
  onDelete: () => void;
  busy: boolean;
}

export function AssistantMessage(props: {
  text: string;
  status: ChatMessageStatus;
  revisionId: string | undefined;
  citations: ReadonlyArray<{ transcriptRevisionId: string; segmentId: string }>;
  knownTimes?: ReadonlyMap<string, { startMs: number }>;
  /** The sources this answer was given; its `[[web:…]]` markers resolve only against these. */
  webSources: readonly WebSourceDto[];
  search?: WebSearchView | undefined;
  suggestions: string[] | undefined;
  error?: AppError | undefined;
  /** A later attempt that failed while this answer stays in force: its reason and time. */
  failedAttempt?: { reason: string; time: string } | undefined;
  /** Answered before the Content had a transcript (metadata mode): always labelled as such. */
  ungrounded: boolean;
  footer?: AnswerFooter | undefined;
  onSuggestion: (text: string) => void;
}) {
  const { t } = useTranslation();
  const page = useContentPage();
  const segments = useSegments(props.revisionId);
  const times = useMemo(() => {
    const map = new Map((segments.data ?? []).map((segment) => [segment.id as string, segment.startMs]));
    for (const [segmentId, known] of props.knownTimes ?? []) map.set(segmentId, known.startMs);
    return map;
  }, [segments.data, props.knownTimes]);
  const sources = useMemo(() => new Map(props.webSources.map((source) => [source.id, source])), [props.webSources]);
  // A citation opens exactly the revision the answer relied on.
  const onCitation = (segmentId: string): void => {
    const revisionId = props.citations.find((citation) => citation.segmentId === segmentId)?.transcriptRevisionId ?? props.revisionId;
    if (revisionId === undefined) return;
    page.select({ revisionId, segmentId }, times.get(segmentId));
    page.openTab("transcript");
  };
  const copyable = props.status !== "streaming" && props.text !== "";
  const plain = (): string => answerPlainText(props.text, (segmentId) => times.get(segmentId), props.webSources, t("chat.turn.sourcesHeading"));
  const menuTarget = useContextMenuTarget<HTMLDivElement>((hit) => {
    // Snapshot of the answer as shown now; a streaming or empty answer has nothing to copy yet.
    const answer = plain();
    const cited = hit.target.closest<HTMLElement>("[data-citation]")?.dataset["citation"];
    const entries: MenuAction[] = [
      { id: "copy-answer", label: t("common.menu.copyAnswer"), icon: <Copy size={14} aria-hidden="true" />, disabled: !copyable, onSelect: () => void copyText(answer) },
    ];
    // An unresolved citation names no sentence, so there is nothing to jump to.
    if (cited !== undefined && cited !== "unresolved") {
      entries.push({ id: "jump-to-source", label: t("common.menu.jumpToSource"), icon: <CornerDownRight size={14} aria-hidden="true" />, onSelect: () => onCitation(cited) });
    }
    return { kind: "text", entries };
  });
  return (
    <div ref={menuTarget} className="my-2" data-testid="chat-message" data-role="assistant" data-status={props.status}>
      {props.ungrounded ? (
        <span className="mb-1 inline-block rounded bg-sunken px-1.5 py-0.5 text-xs text-muted" data-testid="chat-ungrounded">
          {t("chat.ungrounded")}
        </span>
      ) : null}
      {props.search === undefined ? null : <WebSearchStatusLine view={props.search} />}
      {props.text === "" && props.status === "streaming" ? (
        props.search?.phase === "searching" ? null : (
          <span className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={12} />
            {t("chat.status.streaming")}
          </span>
        )
      ) : (
        <RichText source={props.text} timeOf={(segmentId) => times.get(segmentId)} onCitation={onCitation} webSourceOf={(sourceId) => sources.get(sourceId)} />
      )}
      {props.status === "interrupted" || props.status === "failed" ? (
        <p className="mt-1 text-xs text-danger" data-testid="chat-message-status">
          {t(`chat.status.${props.status}`)}
        </p>
      ) : null}
      {props.error === undefined ? null : <ErrorView error={props.error} />}
      {props.failedAttempt === undefined ? null : (
        <p className="mt-1 text-xs text-danger" data-testid="chat-retry-failed">
          {t("chat.turn.retryFailed", props.failedAttempt)}
        </p>
      )}
      {props.footer === undefined ? null : <ChatMessageFooter {...props.footer} copy={plain} copyable={copyable} />}
      {props.suggestions === undefined || props.suggestions.length === 0 ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t("chat.suggestions")}>
          {props.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="rounded-full border border-line px-2 py-0.5 text-xs hover:border-accent hover:text-accent"
              data-testid="chat-suggestion"
              onClick={() => props.onSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
