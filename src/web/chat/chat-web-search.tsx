import type { TFunction } from "i18next";
import { Check, ChevronDown, Globe } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ChatWebSearchDto, WebSourceDto } from "../../shared/dto/chat.ts";
import { WEB_SEARCH_MODES, type WebSearchMode, type WebSearchReason, type WebSearchStatus } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import { formatBeijingDate } from "../format.ts";
import { Spinner } from "../ui/feedback.tsx";

/**
 * Where one answer's web search stands: the queries while it runs, then its outcome. Built
 * from the live `search.*` events, or from the stored message once it has been read back.
 */
export type WebSearchView =
  | { phase: "searching"; queries: string[] }
  | { phase: "done"; status: WebSearchStatus; reason?: WebSearchReason | undefined; sources: WebSourceDto[]; error?: AppError | undefined };

export function storedSearchView(search: ChatWebSearchDto | undefined): WebSearchView | undefined {
  return search === undefined ? undefined : { phase: "done", status: search.status, reason: search.reason, sources: search.sources, error: search.error };
}

/**
 * The web search switch next to the model selector: off, auto (the model decides) and
 * "this message" (forced once). Without a configured search service it is greyed out and
 * offers the way to the settings instead.
 */
export function WebSearchToggle(props: { mode: WebSearchMode; available: boolean; onChange: (mode: WebSearchMode) => void }) {
  const { t } = useTranslation();
  const label = t("chat.webSearch.label");
  if (!props.available) {
    return (
      <span className="flex items-center gap-1" data-testid="chat-web-search-unavailable">
        <button
          type="button"
          disabled
          className="flex h-7 items-center rounded-md border border-line px-1.5 opacity-50"
          title={t("chat.webSearch.unconfigured")}
          aria-label={label}
          data-testid="chat-web-search"
          data-mode="off"
        >
          <Globe size={14} aria-hidden="true" />
        </button>
        <Link to="/settings/web-search" className="text-accent hover:underline" data-testid="chat-web-search-configure">
          {t("chat.webSearch.configure")}
        </Link>
      </span>
    );
  }
  const active = props.mode !== "off";
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className={`flex h-7 items-center gap-1 rounded-md border px-1.5 outline-none hover:border-accent focus-visible:border-accent ${active ? "border-accent text-accent" : "border-line"}`}
        title={`${label} · ${t(`chat.webSearch.modes.${props.mode}`)}`}
        aria-label={`${label} · ${t(`chat.webSearch.modes.${props.mode}`)}`}
        data-testid="chat-web-search"
        data-mode={props.mode}
      >
        <Globe size={14} aria-hidden="true" />
        {active ? <span className="whitespace-nowrap">{t(`chat.webSearch.modes.${props.mode}`)}</span> : null}
        <ChevronDown size={12} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={4} className="z-50 w-64 rounded-md border border-line bg-surface p-1 text-sm shadow-lg" data-testid="chat-web-search-menu">
          <DropdownMenu.RadioGroup value={props.mode} onValueChange={(value) => props.onChange(value as WebSearchMode)}>
            {WEB_SEARCH_MODES.map((mode) => (
              <DropdownMenu.RadioItem
                key={mode}
                value={mode}
                className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-sunken"
                data-testid={`chat-web-search-${mode}`}
              >
                <span className="mt-0.5 w-3.5 shrink-0">
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="flex flex-col">
                  <span>{t(`chat.webSearch.modes.${mode}`)}</span>
                  <span className="text-xs text-muted">{t(`chat.webSearch.hints.${mode}`)}</span>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The host of a source link, shown beside its title; the whole address when it does not parse. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const WEB_URL = /^https?:\/\//i;

/**
 * The status line above a web-searched answer ("searching: …", "N sources", or why no web
 * material was used; a failed search stands out), and the collapsible list of the sources
 * the model was given.
 */
export function WebSearchStatusLine(props: { view: WebSearchView }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const view = props.view;
  if (view.phase === "searching") {
    return (
      <p className="mb-1 flex items-center gap-1.5 text-xs text-muted" data-testid="chat-search-status" data-status="searching">
        <Spinner size={12} />
        {view.queries.length === 0 ? t("chat.webSearch.status.searchingPlain") : t("chat.webSearch.status.searching", { queries: view.queries.join(" · ") })}
      </p>
    );
  }
  const failed = view.status === "failed";
  const text =
    view.status === "searched"
      ? t("chat.webSearch.status.searched", { count: view.sources.length })
      : view.status === "partial"
        ? t("chat.webSearch.status.partial", { count: view.sources.length })
        : t("chat.webSearch.status.none", { reason: reasonText(t, view) });
  return (
    <div className="mb-1 text-xs" data-testid="chat-search-status" data-status={view.status}>
      <p className={`flex flex-wrap items-center gap-1.5 ${failed ? "rounded bg-danger/10 px-1.5 py-0.5 text-danger" : "text-muted"}`}>
        <Globe size={12} aria-hidden="true" />
        <span>{text}</span>
        {view.sources.length === 0 ? null : (
          <button type="button" className="text-accent hover:underline" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="chat-sources-toggle">
            {open ? t("chat.webSearch.sourcesHide") : t("chat.webSearch.sources", { count: view.sources.length })}
          </button>
        )}
      </p>
      {open ? (
        <ol className="mt-1 flex flex-col gap-0.5 rounded bg-sunken px-2 py-1" data-testid="chat-sources">
          {view.sources.map((source) => (
            <li key={source.id} className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 font-mono text-muted">[{source.index}]</span>
              {WEB_URL.test(source.url) ? (
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-accent hover:underline" title={source.url} data-testid="chat-source-link">
                  {source.title === "" ? source.url : source.title}
                </a>
              ) : (
                <span className="min-w-0 truncate">{source.title}</span>
              )}
              <span className="shrink-0 text-muted">{domainOf(source.url)}</span>
              {source.publishedAt === undefined ? null : <span className="shrink-0 text-muted">{formatBeijingDate(source.publishedAt)}</span>}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function reasonText(t: TFunction, view: Extract<WebSearchView, { phase: "done" }>): string {
  if (view.status === "failed" || view.reason === undefined) {
    if (view.error !== undefined && view.error.userMessage !== "") return view.error.userMessage;
    return t("errors.web_search_failed");
  }
  return t(`chat.webSearch.reasons.${view.reason}`);
}
