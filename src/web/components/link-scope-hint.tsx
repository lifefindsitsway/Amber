import { Info } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParsedLinkText } from "../links.ts";

/** Links left out are listed up to this many; the rest are counted. */
const SCOPE_LIST_MAX = 20;

/**
 * Beside a link field's submit: how many links will be processed when the field holds more than
 * supported links, and, on request, the links left out. Calm body text with a small info mark:
 * nothing here blocks the submit. `id` names the sentence, for the button's description.
 */
export function LinkScopeHint(props: {
  parsed: ParsedLinkText;
  id: string;
  className?: string | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { parsed } = props;
  const count = parsed.links.length;
  const excluded = parsed.unsupported.length;
  const detailsId = `${props.id}-details`;
  const sentence =
    excluded > 0
      ? t("shell.newPage.scopeExcluded", { count, excluded })
      : parsed.ignoredLines > 0
        ? t("shell.newPage.scopeIgnoredLines", {
            count,
            lines: parsed.ignoredLines,
          })
        : t("shell.newPage.scopeTextLeft", { count });
  return (
    <div
      className={`text-sm text-ink ${props.className ?? ""}`}
      data-testid="link-scope"
    >
      {/* The mark keeps its own column, so a wrapped line lines up under the text. */}
      <p className="flex min-h-9 items-center gap-1.5">
        <Info size={14} aria-hidden="true" className="shrink-0 text-muted" />
        <span>
          <span id={props.id}>{sentence}</span>
          {excluded === 0 ? null : (
            <>
              <span aria-hidden="true" className="mx-1.5 text-muted">
                ·
              </span>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => setOpen(!open)}
                className="rounded-sm font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/40"
                data-testid="link-scope-toggle"
              >
                {open
                  ? t("shell.newPage.scopeHide")
                  : t("shell.newPage.scopeShow")}
              </button>
            </>
          )}
        </span>
      </p>
      {open && excluded > 0 ? (
        <div
          id={detailsId}
          className="mt-1 flex flex-col gap-1 pl-5"
          data-testid="link-scope-details"
        >
          <p>{t("shell.newPage.scopeUnsupportedTitle")}</p>
          <ul className="flex flex-col gap-0.5 font-mono text-xs break-all">
            {parsed.unsupported.slice(0, SCOPE_LIST_MAX).map((url) => (
              <li key={url}>{url}</li>
            ))}
          </ul>
          {excluded > SCOPE_LIST_MAX ? (
            <p>
              {t("shell.newPage.scopeMore", {
                count: excluded - SCOPE_LIST_MAX,
              })}
            </p>
          ) : null}
          {parsed.ignoredLines > 0 ? (
            <p>
              {t("shell.newPage.scopeIgnoredLinesDetail", {
                count: parsed.ignoredLines,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
