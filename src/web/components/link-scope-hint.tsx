import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParsedLinkText } from "../links.ts";
import { NOTE_TEXT_CLASS, TextAction } from "../ui/notice.tsx";

/** Links left out are listed up to this many; the rest are counted. */
const SCOPE_LIST_MAX = 20;

/** What the line under a link box says; `undefined` parts are not shown. */
export interface RecognitionSummary {
  /** The first half: what was recognized. */
  lead?: { key: "pasted" | "collections" | "batch" | "links"; count: number };
  /** The second half: what will not be sent. */
  rest?: { key: "unsupported" | "lines" | "text"; count: number };
  collections: number;
}

/**
 * What a link box holds, read for its one line: the first half is the most specific of "just
 * tidied from a share text", "holds collections" and "several links"; the second half names what
 * will not be sent. A single plain link (or nothing) says nothing.
 */
export function recognitionSummary(parsed: ParsedLinkText, pasted: number | undefined): RecognitionSummary {
  const count = parsed.links.length;
  const collections = parsed.links.filter((link) => link.kind === "collection").length;
  const rest: RecognitionSummary["rest"] =
    count === 0
      ? undefined
      : parsed.unsupported.length > 0
        ? { key: "unsupported", count: parsed.unsupported.length }
        : parsed.ignoredLines > 0
          ? { key: "lines", count: parsed.ignoredLines }
          : parsed.otherText
            ? { key: "text", count: 0 }
            : undefined;
  const lead: RecognitionSummary["lead"] =
    pasted !== undefined
      ? { key: "pasted", count: pasted }
      : collections > 0
        ? { key: "collections", count: collections }
        : count > 1
          ? { key: "batch", count }
          : count === 1 && rest !== undefined
            ? { key: "links", count }
            : undefined;
  return {
    ...(lead === undefined ? {} : { lead }),
    ...(rest === undefined ? {} : { rest }),
    collections,
  };
}

/**
 * The one quiet line under a link box saying what it holds, always read from its current text:
 * how many links (or collections) were recognized, what will not be sent with 「查看」 to list
 * the links left out in place, and 「预览合集」 when collections are present. `id` names the
 * line, for the box's `aria-describedby`.
 */
export function LinkRecognition(props: {
  parsed: ParsedLinkText;
  /** How many links the last paste took out of a share text; cleared by the next edit. */
  pasted: number | undefined;
  id: string;
  /** Opens the collection preview; without it the action is not offered. */
  onPreview?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { parsed } = props;
  const summary = recognitionSummary(parsed, props.pasted);
  if (summary.lead === undefined && summary.rest === undefined) return null;
  const listed = parsed.unsupported.length > 0;
  const detailsId = `${props.id}-details`;
  const lead =
    summary.lead === undefined
      ? undefined
      : t(`shell.newPage.recognized.${summary.lead.key}`, {
          count: summary.lead.count,
        });
  const rest =
    summary.rest === undefined
      ? undefined
      : t(`shell.newPage.recognized.${summary.rest.key}`, {
          count: summary.rest.count,
        });
  const sentence = [lead, rest].filter((part) => part !== undefined).join(t("shell.newPage.recognized.separator"));
  const preview = summary.collections > 0 && props.onPreview !== undefined;
  return (
    <div className={`flex flex-col gap-1.5 ${props.className ?? ""}`} data-testid="link-recognition">
      {/* Inline flow, not flex: the actions follow the sentence on its last line instead of wrapping onto a line of their own. */}
      <p className={NOTE_TEXT_CLASS} aria-live="polite">
        <span id={props.id} data-testid="link-recognition-text">
          {sentence}
        </span>
        {listed ? (
          <>
            <span aria-hidden="true" className="mx-1.5">·</span>
            <TextAction aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)} data-testid="link-recognition-toggle">
              {open ? t("shell.newPage.recognized.hide") : t("shell.newPage.recognized.show")}
            </TextAction>
          </>
        ) : null}
        {preview ? (
          <>
            <span aria-hidden="true" className="mx-1.5">·</span>
            <TextAction onClick={props.onPreview} data-testid="link-recognition-preview">
              {t("shell.newPage.recognized.preview")}
            </TextAction>
          </>
        ) : null}
      </p>
      {open && listed ? (
        <div id={detailsId} className={`flex flex-col gap-1 ${NOTE_TEXT_CLASS}`} data-testid="link-recognition-details">
          <p>{t("shell.newPage.recognized.unsupportedTitle")}</p>
          <ul className="flex flex-col gap-0.5 font-mono text-xs break-all">
            {parsed.unsupported.slice(0, SCOPE_LIST_MAX).map((url) => (
              <li key={url}>{url}</li>
            ))}
          </ul>
          {parsed.unsupported.length > SCOPE_LIST_MAX ? (
            <p>
              {t("shell.newPage.recognized.more", {
                count: parsed.unsupported.length - SCOPE_LIST_MAX,
              })}
            </p>
          ) : null}
          {parsed.ignoredLines > 0 ? (
            <p>
              {t("shell.newPage.recognized.linesDetail", {
                count: parsed.ignoredLines,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
