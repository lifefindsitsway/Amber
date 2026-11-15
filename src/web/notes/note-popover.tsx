import { Popover } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { NOTE_COMMENT_MAX_CHARS } from "../../shared/defaults.ts";
import type { NoteCreateRequest, NoteDto } from "../../shared/dto/note.ts";
import { Button } from "../ui/button.tsx";
import { useContentPage } from "../pages/content/content-context.tsx";
import { newestFirst } from "./note-anchor.ts";
import { MarkAndColor, NoteCard, noteErrorText } from "./note-card.tsx";
import { rememberColor, rememberedColor } from "./note-colors.ts";
import { useNotesUi, type NoteComposeTarget, type NoteTarget, type NotesUi } from "./note-ui-context.tsx";
import { newNoteIntent, useContentNotes, useCreateNote, type NoteCreateIntent } from "./queries.ts";

/** Room kept between a detached popover and the corner of the reading view. */
const DETACHED_INSET_PX = 16;

const cssId = (value: string): string => (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/gu, "\\$&"));

/**
 * The element a target hangs on: the run with its note, or an anchored sentence of a draft. A
 * draft's selection may run across more screens than a windowed list keeps mounted, so it hangs
 * on its first sentence or, with that one out of the document, on its last: the end the user
 * let go at is the one in view.
 */
function anchorElement(target: NoteTarget): HTMLElement | null {
  if (target.kind === "compose") {
    const sentence = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-notes] [data-segment-id="${cssId(id)}"]`);
    return sentence(target.anchor.startSegmentId) ?? sentence(target.anchor.endSegmentId);
  }
  for (const id of target.noteIds) {
    const run = document.querySelector<HTMLElement>(`[data-segment-id="${cssId(target.segmentId)}"] [data-note-ids~="${cssId(id)}"]`);
    if (run !== null) return run;
  }
  return null;
}

function readingRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-notes]");
}

/**
 * Whether the target's element and the reading view are in the document, re-read on every
 * DOM change while a target is open: windowed rows mount and unmount as the reader scrolls.
 */
function usePresence(target: NoteTarget | undefined): { anchored: boolean; reading: boolean } {
  const open = target !== undefined;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!open) return () => undefined;
      const observer = new MutationObserver(notify);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-note-ids", "data-revision-id"] });
      return () => observer.disconnect();
    },
    [open],
  );
  const snapshot = (): string => (target === undefined ? "" : `${anchorElement(target) !== null ? 1 : 0}${readingRoot() !== null ? 1 : 0}`);
  const value = useSyncExternalStore(subscribe, snapshot);
  return { anchored: value[0] === "1", reading: value[1] === "1" };
}

/**
 * The single note popover of the Content page: non-modal and following the
 * run it was opened from as the reader scrolls. With unsaved comment text it refuses Esc and
 * outside presses, and when its run leaves the document (scrolled out of a windowed list,
 * another tab or revision) it stays as a detached panel in the reading view's corner rather
 * than dropping the text; without unsaved text it simply closes.
 */
export function NotePopover() {
  const { t } = useTranslation();
  const ui = useNotesUi();
  const { target } = ui;
  const presence = usePresence(target);
  const latest = useRef<{ target: NoteTarget | undefined; last: NoteTarget | undefined }>({ target: undefined, last: undefined });
  latest.current.target = target;
  if (target !== undefined) latest.current.last = target;
  const closedOutside = useRef(false);
  // One stable measurable that reads the live position, so the popover follows the run.
  const virtualRef = useRef({
    getBoundingClientRect: (): DOMRect => {
      const last = latest.current.last;
      if (last === undefined) return DOMRect.fromRect();
      if (last.kind === "compose") {
        // DOMRect.fromRect takes x / y, not top / left: passing the frozen rect as is pins it to 0,0.
        const { left, top, width, height } = last.rect;
        return DOMRect.fromRect({ x: left, y: top, width, height });
      }
      return anchorElement(last)?.getBoundingClientRect() ?? DOMRect.fromRect();
    },
  });

  const gone = target !== undefined && !presence.anchored && !ui.dirty;
  useEffect(() => {
    if (gone) ui.close();
  }, [gone, ui]);

  if (target === undefined || gone) return null;
  const body = target.kind === "compose" ? <ComposeBody target={target} /> : <ViewBody noteIds={target.noteIds} revisionId={target.revisionId} />;

  if (!presence.anchored) {
    if (!presence.reading) return null;
    return <Detached target={target}>{body}</Detached>;
  }

  const refuse = (event: Event): void => {
    if (ui.dirty) {
      event.preventDefault();
      ui.warn();
    }
  };
  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) ui.close();
      }}
    >
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        {/* No Popover.Arrow: it measures itself with ResizeObserver and the popover needs no pointer. */}
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          updatePositionStrategy="always"
          aria-label={t("notes.popover.title")}
          className="z-40 flex max-h-[min(70vh,32rem)] w-80 flex-col gap-3 overflow-auto rounded-md border border-line bg-surface p-3 shadow-lg"
          data-testid="note-popover"
          onOpenAutoFocus={(event) => {
            closedOutside.current = false;
            if (target.kind === "compose") {
              event.preventDefault();
              document.querySelector<HTMLTextAreaElement>("[data-testid='note-compose-input']")?.focus();
            }
          }}
          onEscapeKeyDown={refuse}
          onInteractOutside={(event) => {
            refuse(event);
            if (!event.defaultPrevented) closedOutside.current = true;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Unmounted to go detached, or closed by a press elsewhere: focus stays where it went.
            if (latest.current.target !== undefined || closedOutside.current) return;
            const last = latest.current.last;
            const run = last?.kind === "view" ? anchorElement(last) : null;
            (run ?? document.querySelector<HTMLElement>("[data-testid='transcript-notes-link']"))?.focus();
          }}
        >
          {body}
          <Footer ui={ui} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Unsaved-work hints shown under the popover's body. */
function Footer(props: { ui: NotesUi }) {
  const { t } = useTranslation();
  if (!props.ui.dirty) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {props.ui.warned ? (
        <p className="text-danger" role="status" data-testid="note-dirty">
          {t("notes.popover.dirty")}
        </p>
      ) : null}
      <p className="text-muted">{t("notes.popover.leaveWarning")}</p>
    </div>
  );
}

/** The popover pinned to the reading view's corner while its run is out of the document. */
function Detached(props: { target: NoteTarget; children: ReactNode }) {
  const { t } = useTranslation();
  const ui = useNotesUi();
  const root = readingRoot()?.getBoundingClientRect();
  const excerpt = useTargetExcerpt(props.target);
  const style =
    root === undefined
      ? { right: DETACHED_INSET_PX, bottom: DETACHED_INSET_PX }
      : { right: Math.max(0, window.innerWidth - root.right) + DETACHED_INSET_PX, bottom: Math.max(0, window.innerHeight - root.bottom) + DETACHED_INSET_PX };
  const locate = (): void => {
    const { target } = props;
    if (target.kind === "compose") ui.locate(target.anchor.transcriptRevisionId, target.anchor.startSegmentId);
    else ui.locate(target.revisionId, target.segmentId);
  };
  return (
    <div
      role="dialog"
      aria-label={t("notes.popover.title")}
      className="fixed z-40 flex max-h-[min(60vh,28rem)] w-80 flex-col gap-3 overflow-auto rounded-md border border-line bg-surface p-3 shadow-lg"
      style={style}
      data-testid="note-popover-detached"
    >
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="min-w-0 flex-1">{t("notes.popover.detached")}</span>
        <button type="button" className="shrink-0 text-accent hover:underline" onClick={locate} data-testid="note-locate-anchor">
          {t("notes.popover.locate")}
        </button>
      </div>
      {excerpt === "" ? null : <blockquote className="line-clamp-3 border-l-2 border-line pl-2 text-sm text-muted">{excerpt}</blockquote>}
      {props.children}
      <Footer ui={ui} />
    </div>
  );
}

function useTargetExcerpt(target: NoteTarget): string {
  const page = useContentPage();
  const notes = useContentNotes(page.content.id, target.kind === "view" ? target.revisionId : undefined, target.kind === "view");
  if (target.kind === "compose") return target.excerpt;
  const first = notes.data?.items.find((note) => target.noteIds.includes(note.id));
  return first?.quote ?? "";
}

/** The notes covering a run, newest first; the popover closes once the last one is deleted. */
function ViewBody(props: { noteIds: readonly string[]; revisionId: string }) {
  const ui = useNotesUi();
  const page = useContentPage();
  const [params, setParams] = useSearchParams();
  const notes = useContentNotes(page.content.id, props.revisionId);
  const shown = useMemo(
    () => (notes.data?.items ?? []).filter((note) => props.noteIds.includes(note.id)).sort(newestFirst),
    [notes.data, props.noteIds],
  );
  const empty = notes.data !== undefined && shown.length === 0;
  useEffect(() => {
    if (empty) ui.close();
  }, [empty, ui]);
  // Reads the note in the revision it was made on, at its first sentence, without seeking.
  const openAnchor = (note: NoteDto): void => {
    page.select({ revisionId: note.transcriptRevisionId, segmentId: note.startSegmentId });
    const next = new URLSearchParams(params);
    next.set("tab", "transcript");
    next.set("revision", note.transcriptRevisionId);
    next.set("segment", note.startSegmentId);
    setParams(next, { replace: true });
  };
  return (
    <div className="flex flex-col gap-3 divide-y divide-line">
      {shown.map((note) => (
        <div key={note.id} className="pt-3 first:pt-0">
          <NoteCard note={note} variant="popover" onOpenAnchor={openAnchor} />
        </div>
      ))}
    </div>
  );
}

function sameBody(a: NoteCreateRequest, b: NoteCreateRequest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A comment note not yet saved: excerpt, mark and colour, text. 保存 freezes the request into
 * one creation intent and posts it once; after a failure the input stays and saving the same
 * text again resends that intent with its key. 取消 writes nothing.
 */
function ComposeBody(props: { target: NoteComposeTarget }) {
  const { t } = useTranslation();
  const ui = useNotesUi();
  const page = useContentPage();
  const create = useCreateNote();
  const { anchor, draft, excerpt } = props.target;
  const comment = draft.comment.trim();
  const save = (): void => {
    if (comment === "") return;
    const body: NoteCreateRequest = { ...anchor, mark: draft.mark, color: draft.color, comment };
    const intent: NoteCreateIntent = draft.intent !== undefined && sameBody(draft.intent.body, body) ? draft.intent : newNoteIntent(page.content.id, body);
    ui.updateCompose({ intent });
    rememberColor(draft.mark, draft.color);
    create.mutate(intent, { onSuccess: () => ui.close() });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="note-compose">
      <blockquote className="line-clamp-3 border-l-2 border-line pl-2 text-sm text-muted" title={excerpt}>
        {excerpt}
      </blockquote>
      <MarkAndColor
        mark={draft.mark}
        color={draft.color}
        disabled={create.isPending}
        onMark={(mark) => ui.updateCompose({ mark, color: mark === draft.mark ? draft.color : rememberedColor(mark) })}
        onColor={(color) => ui.updateCompose({ color })}
      />
      <textarea
        className="min-h-20 w-full resize-y rounded border border-line bg-surface p-1.5 text-sm"
        value={draft.comment}
        maxLength={NOTE_COMMENT_MAX_CHARS}
        placeholder={t("notes.popover.commentPlaceholder")}
        aria-label={t("notes.selection.comment")}
        disabled={create.isPending}
        onChange={(event) => ui.updateCompose({ comment: event.target.value })}
        data-testid="note-compose-input"
      />
      {create.isError ? (
        <p className="text-xs text-danger" role="alert">
          {noteErrorText(create.error, t("notes.popover.saveFailed"))}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={create.isPending} onClick={() => ui.close()} data-testid="note-compose-cancel">
          {t("notes.popover.cancel")}
        </Button>
        <Button size="sm" variant="primary" disabled={create.isPending || comment === ""} onClick={save} data-testid="note-compose-save">
          {create.isError ? t("notes.popover.retry") : t("notes.popover.save")}
        </Button>
      </div>
    </div>
  );
}
