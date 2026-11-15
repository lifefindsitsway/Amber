import { Highlighter, MessageSquarePlus, Underline } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NOTE_SPAN_MAX_SEGMENTS } from "../../shared/defaults.ts";
import type { NoteMark } from "../../shared/enums.ts";
import type { SelectionRect } from "../chat/selection-toolbar.tsx";
import { useContentPage } from "../pages/content/content-context.tsx";
import { useSegments } from "../pages/content/content-data.ts";
import type { SelectionBounds } from "../ui/dom-selection.ts";
import { anchorFromBounds } from "./note-anchor.ts";
import { noteErrorText } from "./note-card.tsx";
import { rememberedColor } from "./note-colors.ts";
import { useNotesUi } from "./note-ui-context.tsx";
import { newNoteIntent, useCreateNote, type NoteCreateIntent } from "./queries.ts";

const BUTTON = "flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 下划线 · 高亮 · 评论 on a frozen reading-view selection. The first two
 * create the note at once in the colour last used for that mark; each press is one creation
 * intent with a fixed key, so 重试 after a failure resends exactly that request. 评论 opens a
 * draft in the note popover instead and writes nothing until it is saved. A selection longer
 * than NOTE_SPAN_MAX_SEGMENTS sentences, whose sentences are not loaded, or that `crossesGap`
 * (spans text the view does not show) offers them disabled with the reason; the hidden text is
 * named first, as showing it is the remedy.
 */
export function NoteSelectionActions(props: { bounds: SelectionBounds; rect: SelectionRect; crossesGap?: boolean; close: () => void }) {
  const { t } = useTranslation();
  const page = useContentPage();
  const ui = useNotesUi();
  const segments = useSegments(props.bounds.revisionId);
  const create = useCreateNote();
  const [intent, setIntent] = useState<NoteCreateIntent | undefined>(undefined);
  const result = anchorFromBounds(props.bounds, segments.data);
  const crossesGap = props.crossesGap === true;
  const reason = crossesGap
    ? t("notes.selection.crossesGap")
    : result.ok
      ? undefined
      : result.reason === "tooLong"
        ? t("notes.selection.tooLong", { limit: NOTE_SPAN_MAX_SEGMENTS })
        : t("notes.selection.unavailable");
  const disabled = crossesGap || !result.ok || create.isPending;

  const send = (next: NoteCreateIntent): void => {
    setIntent(next);
    create.mutate(next, {
      onSuccess: () => {
        setIntent(undefined);
        window.getSelection()?.removeAllRanges();
        props.close();
      },
    });
  };
  const mark = (kind: NoteMark): void => {
    if (crossesGap || !result.ok) return;
    send(newNoteIntent(page.content.id, { ...result.anchor, mark: kind, color: rememberedColor(kind) }));
  };

  return (
    <>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
      <button type="button" className={BUTTON} disabled={disabled} title={reason} onClick={() => mark("underline")} data-testid="selection-note-underline">
        <Underline size={14} />
        {t("notes.selection.underline")}
      </button>
      <button type="button" className={BUTTON} disabled={disabled} title={reason} onClick={() => mark("background")} data-testid="selection-note-background">
        <Highlighter size={14} />
        {t("notes.selection.background")}
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={disabled}
        title={reason}
        onClick={() => {
          if (crossesGap || !result.ok) return;
          if (ui.openCompose({ anchor: result.anchor, rect: props.rect, excerpt: result.excerpt })) props.close();
        }}
        data-testid="selection-note-comment"
      >
        <MessageSquarePlus size={14} />
        {t("notes.selection.comment")}
      </button>
      {create.isError && intent !== undefined ? (
        <span className="flex basis-full items-center gap-2 px-2 pb-1 text-xs">
          <span className="min-w-0 flex-1 text-danger" role="alert">
            {noteErrorText(create.error, t("notes.selection.failed"))}
          </span>
          <button type="button" className={BUTTON} disabled={create.isPending} onClick={() => send(intent)} data-testid="selection-note-retry">
            {t("notes.selection.retry")}
          </button>
        </span>
      ) : null}
    </>
  );
}
