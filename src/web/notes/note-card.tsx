import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { NOTE_COMMENT_MAX_CHARS } from "../../shared/defaults.ts";
import type { NoteDto } from "../../shared/dto/note.ts";
import { NOTE_COLORS, NOTE_MARKS, type NoteColor, type NoteMark } from "../../shared/enums.ts";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import { formatDateTime, formatDuration } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Callout, InlineNote, TEXT_ACTION_CLASS, TextAction } from "../ui/notice.tsx";
import { TextArea } from "../ui/text-field.tsx";
import { rememberColor, swatchClass } from "./note-colors.ts";
import { useOptionalNotesUi, type CommentDraft } from "./note-ui-context.tsx";
import { useDeleteNote, usePatchNote } from "./queries.ts";

/** The deep link that opens a note's own revision at its first sentence. */
export function noteLocation(note: NoteDto): string {
  const query = new URLSearchParams({ tab: "transcript", revision: note.transcriptRevisionId, segment: note.startSegmentId });
  return `/contents/${encodeURIComponent(note.contentId)}?${query.toString()}`;
}

/** The message of a failed note request: the server's explanation, else a generic line. */
export function noteErrorText(error: unknown, fallback: string): string {
  const message = appErrorOf(error).userMessage;
  return message === "" ? fallback : message;
}

/** Mark switch and five-colour palette; disabled while a request on the note is in flight. */
export function MarkAndColor(props: { mark: NoteMark; color: NoteColor; disabled?: boolean; onMark: (mark: NoteMark) => void; onColor: (color: NoteColor) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label={t("notes.popover.markGroup")} className="inline-flex overflow-hidden rounded-md border border-line">
        {NOTE_MARKS.map((mark) => (
          <button
            key={mark}
            type="button"
            aria-pressed={props.mark === mark}
            disabled={props.disabled}
            className={`h-6 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${mark === "background" ? "border-l border-line" : ""} ${props.mark === mark ? "bg-accent-glow text-accent-ink" : "hover:bg-sunken"}`}
            onClick={() => props.onMark(mark)}
            data-testid={`note-mark-${mark}`}
          >
            {t(`notes.mark.${mark}`)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {NOTE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-pressed={props.color === color}
            aria-label={t(`notes.color.${color}`)}
            title={t(`notes.color.${color}`)}
            disabled={props.disabled}
            className={`h-4 w-4 rounded-full disabled:cursor-not-allowed disabled:opacity-50 ${swatchClass(color)} ${props.color === color ? "ring-2 ring-ink ring-offset-1 ring-offset-surface" : ""}`}
            onClick={() => props.onColor(color)}
            data-testid={`note-color-${color}`}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One note with its controls: comment, two-step delete and creation
 * time. `popover` adds mark and colour; `page` adds the excerpt, start time and a link to the
 * text, and keeps the comment action on that link's row; `popover`
 * keeps its comment draft in the page-level notes UI, so the draft outlives the popover, and
 * says when the note is shown approximately on another revision. Every control is disabled
 * while a request on this note is in flight.
 */
export function NoteCard(props: { note: NoteDto; variant: "popover" | "page"; onOpenAnchor?: (note: NoteDto) => void }) {
  const { t, i18n } = useTranslation();
  const { note } = props;
  const ui = useOptionalNotesUi();
  const shared = props.variant === "popover" ? ui : undefined;
  const [localDraft, setLocalDraft] = useState<CommentDraft | undefined>(undefined);
  const draft = shared === undefined ? localDraft : shared.commentDrafts.get(note.id);
  const setDraft = (next: CommentDraft | undefined): void => (shared === undefined ? setLocalDraft(next) : shared.setCommentDraft(note.id, next));
  const [confirming, setConfirming] = useState(false);
  const patch = usePatchNote();
  const remove = useDeleteNote();
  const busy = patch.isPending || remove.isPending;
  const original = note.comment ?? "";

  const saveComment = (): void => {
    if (draft === undefined) return;
    const text = draft.text.trim();
    if (text === original) {
      setDraft(undefined);
      return;
    }
    if (text === "" && note.comment === undefined) {
      setDraft(undefined);
      return;
    }
    patch.mutate({ noteId: note.id, patch: { comment: text === "" ? null : text } }, { onSuccess: () => setDraft(undefined) });
  };

  const commentButton = (
    <TextAction
      className="shrink-0 text-xs disabled:opacity-50"
      disabled={busy}
      onClick={() => {
        patch.reset();
        setDraft({ text: original, original });
      }}
      data-testid="note-comment-edit"
    >
      {note.comment === undefined ? t("notes.popover.addComment") : t("notes.popover.editComment")}
    </TextAction>
  );
  // The notes page lists what the user wrote; mark and colour change in the transcript's popover,
  // one 「定位原文」 away, and the comment action joins that link on the card's foot.
  const page = props.variant === "page";

  return (
    <article className="flex flex-col gap-2 text-sm" data-testid="note-card" data-note-id={note.id}>
      {page ? (
        <div className="flex items-start gap-2">
          <span className="shrink-0 font-mono text-xs text-link tabular-nums">{formatDuration(note.startMs)}</span>
          <blockquote className="line-clamp-3 min-w-0 flex-1 border-l-2 border-line pl-2 text-muted" title={note.quote}>
            {note.quote}
          </blockquote>
        </div>
      ) : null}
      {page ? null : (
        <MarkAndColor
          mark={note.mark}
          color={note.color}
          disabled={busy}
          onMark={(mark) => {
            if (mark !== note.mark) patch.mutate({ noteId: note.id, patch: { mark } });
          }}
          onColor={(color) => {
            rememberColor(note.mark, color);
            if (color !== note.color) patch.mutate({ noteId: note.id, patch: { color } });
          }}
        />
      )}
      {props.variant === "popover" && note.view?.exact === false ? (
        <InlineNote
          testId="note-approximate"
          action={
            <TextAction className="disabled:opacity-50" disabled={busy} onClick={() => props.onOpenAnchor?.(note)} data-testid="note-open-anchor">
              {t("notes.popover.openAnchor")}
            </TextAction>
          }
        >
          {t("notes.popover.approximate")}
        </InlineNote>
      ) : null}
      {draft === undefined ? (
        page && note.comment === undefined ? null : (
          <div className="flex items-start gap-2">
            {note.comment === undefined ? null : (
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words" data-testid="note-comment">
                {note.comment}
              </p>
            )}
            {page ? null : commentButton}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-1">
          <TextArea
            size="md"
            className="min-h-16 w-full resize-y"
            value={draft.text}
            maxLength={NOTE_COMMENT_MAX_CHARS}
            placeholder={t("notes.popover.commentPlaceholder")}
            aria-label={t("notes.popover.editComment")}
            disabled={busy}
            onChange={(event) => {
              if (patch.isError) patch.reset();
              setDraft({ text: event.target.value, original: draft.original });
            }}
            data-testid="note-comment-input"
          />
          {patch.isError ? (
            <Callout tone="error" density="compact" announce="alert">
              {noteErrorText(patch.error, t("notes.popover.saveFailed"))}
            </Callout>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                patch.reset();
                setDraft(undefined);
              }}
              data-testid="note-comment-cancel"
            >
              {t("notes.popover.cancel")}
            </Button>
            {patch.isError ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={saveComment} data-testid="note-comment-retry">
                {t("notes.popover.retry")}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={saveComment} data-testid="note-comment-save">
                {t("notes.popover.save")}
              </Button>
            )}
          </div>
        </div>
      )}
      {patch.isError && draft === undefined ? (
        <Callout tone="error" density="compact" announce="alert">
          {noteErrorText(patch.error, t("notes.popover.saveFailed"))}
        </Callout>
      ) : null}
      {remove.isError ? (
        <Callout tone="error" density="compact" announce="alert">
          {noteErrorText(remove.error, t("notes.popover.deleteFailed"))}
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span data-testid="note-created">{t("notes.popover.createdAt", { time: formatDateTime(note.createdAt, i18n.language) })}</span>
        {page ? (
          <Link className={TEXT_ACTION_CLASS} to={noteLocation(note)} data-testid="note-locate">
            {t("notes.page.locate")}
          </Link>
        ) : null}
        {page && draft === undefined ? commentButton : null}
        <span className="ml-auto flex items-center gap-1">
          {confirming ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                {t("notes.popover.cancel")}
              </Button>
              <Button size="sm" variant="danger-solid" disabled={busy} onClick={() => remove.mutate(note.id)} data-testid="note-delete-confirm">
                {t("notes.popover.confirmDelete")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)} data-testid="note-delete">
              {t("notes.popover.delete")}
            </Button>
          )}
        </span>
      </div>
    </article>
  );
}
