import type { TFunction } from "i18next";
import { Check, CircleQuestionMark, Plus, UserRoundX } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { memo, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto } from "../../../shared/dto/speaker.ts";
import { speakerMonogram } from "../../../shared/speakers.ts";
import { hasCommandModifier } from "../../shortcut-registry.tsx";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../../ui/context-menu.tsx";
import { ringShadow, SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerColorVars } from "./speakers/speaker-colors.ts";
import { speakerLabel } from "./speakers/speaker-data.ts";
import { useSpeakerEditingContext, type LeadScope } from "./use-speaker-editing.tsx";

/** The avatar size of a sentence's speaker column. */
const LEAD_AVATAR_PX = 24;
/**
 * The follow-up avatar's diameter. Smaller than the lead's so the first sentence of a stretch
 * stands out, yet large enough for its letter to be read rather than seen as a dot.
 */
const FOLLOW_UP_PX = 20;
/** Letter height relative to the follow-up's diameter: larger than the full avatar's, as the circle is small. */
const FOLLOW_UP_GLYPH_RATIO = 0.5;
/** Strength of the hairline ring, in percent of the speaker's colour: it gives the pale fill an edge on the page. */
const FOLLOW_UP_RING_PERCENT = 40;

const isDigit = (key: string): boolean => key.length === 1 && key >= "0" && key <= "9";

/**
 * The muted avatar of the sentences after a stretch's first. A draft has thousands of rows
 * and most are follow-ups, so this is drawn without the photo lookup and hooks of the full
 * avatar: the speaker's colour and letter, quiet enough that a photo would not be seen at
 * this size anyway.
 */
function FollowUpAvatar(props: { speaker: SpeakerDto | undefined }) {
  const diameter = FOLLOW_UP_PX;
  const { speaker } = props;
  if (speaker === undefined) {
    return <span className="inline-block rounded-full border border-dashed border-muted/60" style={{ width: diameter, height: diameter }} aria-hidden="true" />;
  }
  const colors = speakerColorVars(speaker.colorIndex);
  const glyph = speaker.name === undefined ? String(speaker.ordinal) : speakerMonogram(speaker.name);
  return (
    <span
      className="inline-flex select-none items-center justify-center rounded-full font-semibold leading-none opacity-80"
      style={{
        width: diameter,
        height: diameter,
        backgroundColor: colors.bg,
        color: colors.fg,
        fontSize: diameter * FOLLOW_UP_GLYPH_RATIO,
        boxShadow: ringShadow(colors.fg, FOLLOW_UP_RING_PERCENT),
      }}
      data-testid="speaker-follow-up-avatar"
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}

/**
 * The speaker column of one sentence: its speaker (avatar and name for the first sentence of
 * a stretch of one speaker, a muted small avatar after it) and the menu that changes it.
 * Clicking opens the menu; with focus on the column `1`–`9` give the numbered speaker, `0`
 * unassigns, Shift+arrows extend the selection and Shift+click selects a range. These keys
 * work only here, never globally.
 *
 * The menu machinery is mounted on first use: every sentence has a column, and a menu per
 * row would make opening a long draft slow for the sake of the few rows ever used.
 */
export const SpeakerLead = memo(function SpeakerLead(props: { index: number }) {
  const editing = useSpeakerEditingContext();
  // The translator comes from the editor rather than a hook per row: thousands of rows each
  // subscribing to language changes is a cost nobody gets anything for.
  const { t } = editing;
  const { actions } = editing;
  const view = useSyncExternalStore(editing.store.subscribe, () => editing.store.at(props.index));
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  /** `run` once the user asked the menu for the whole turn; the default is the sentence (or the selection). */
  const [mode, setMode] = useState<"run" | undefined>(undefined);
  if (view === undefined) return null;

  const speaker = view.speakerId === null ? undefined : editing.speakers.get(view.speakerId);
  const known = view.speakerId === null || speaker !== undefined;
  const name = speaker === undefined ? t("speakerIdentity.unassigned") : speakerLabel(t, speaker);
  const colors = speaker === undefined ? undefined : speakerColorVars(speaker.colorIndex);

  // The menu opens as soon as it exists and takes the focus; closing it hands the focus back to the column.
  const arm = (): void => {
    setArmed(true);
    setOpen(true);
  };

  /**
   * A digit gives the numbered speaker (0 = nobody) to the selection, else to this sentence.
   * Only the open menu, which writes its scope out, may also be on a whole turn.
   */
  const choose = (digit: string, scopeMode: "run" | undefined): void => {
    const scope = actions.scope(props.index, scopeMode);
    if (digit === "0") {
      actions.assign(scope, null);
      return;
    }
    const target = editing.current[Number(digit) - 1];
    if (target !== undefined) actions.assign(scope, target.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.nativeEvent.isComposing || hasCommandModifier(event.nativeEvent)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      if (event.shiftKey) actions.extend(props.index, delta);
      else actions.moveFocus(props.index, delta);
    } else if (event.key === "Escape" && actions.hasSelection()) {
      event.preventDefault();
      actions.clearSelection();
    } else if (!event.shiftKey && isDigit(event.key)) {
      event.preventDefault();
      choose(event.key, undefined);
    } else if (!armed && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      arm();
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    actions.pointer(props.index, event.shiftKey);
    // Shift+click selects; it must not also open the menu.
    if (event.shiftKey) event.preventDefault();
    else if (!armed) {
      event.preventDefault();
      arm();
    }
  };

  const state = [view.review === "needs_review" ? t("speakerEditor.lead.needsReview") : undefined, view.selected ? t("speakerEditor.lead.selected") : undefined].filter((part) => part !== undefined);
  const label = [t("speakerEditor.lead.label", { name }), ...state].join(" · ");

  const face = (
    <button
      type="button"
      tabIndex={view.tabbable ? 0 : -1}
      aria-label={label}
      aria-keyshortcuts="0 1 2 3 4 5 6 7 8 9"
      aria-haspopup="menu"
      title={t("speakerEditor.lead.hint")}
      className={`flex h-8 w-28 items-center gap-1.5 rounded-md px-1 text-left outline-none transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-sunken @max-[520px]:w-auto ${view.selected ? "bg-accent-soft ring-1 ring-accent/50" : ""}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      data-speaker-lead=""
      data-selected={view.selected ? "true" : undefined}
      data-review={view.review}
      data-testid="speaker-lead"
    >
      <span className="flex shrink-0 justify-center" style={{ width: LEAD_AVATAR_PX }}>
        {!known ? (
          <span className="inline-block rounded-full bg-sunken" style={{ width: LEAD_AVATAR_PX, height: LEAD_AVATAR_PX }} aria-hidden="true" />
        ) : !view.showName ? (
          <FollowUpAvatar speaker={speaker} />
        ) : speaker === undefined ? (
          <SpeakerAvatar unassigned size={LEAD_AVATAR_PX} decorative />
        ) : (
          <SpeakerAvatar contentId={editing.contentId} speaker={speaker} size={LEAD_AVATAR_PX} decorative />
        )}
      </span>
      {view.showName ? (
        <span className={`min-w-0 flex-1 truncate text-xs font-medium @max-[520px]:hidden ${speaker === undefined ? "text-muted" : ""}`} style={colors === undefined ? undefined : { color: colors.fg }} data-testid="speaker-lead-name">
          {known ? name : ""}
        </span>
      ) : null}
      {view.review === "needs_review" ? <CircleQuestionMark size={13} className="shrink-0 text-accent" aria-hidden="true" data-testid="speaker-lead-review" /> : null}
    </button>
  );
  if (!armed) return face;

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setMode(undefined);
      }}
    >
      <DropdownMenu.Trigger asChild>{face}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className={`${MENU_CONTENT_CLASS} w-64`}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || hasCommandModifier(event.nativeEvent) || event.shiftKey || !isDigit(event.key)) return;
            // Radix would take a digit as type-ahead; here it picks the numbered speaker and closes the menu.
            event.preventDefault();
            choose(event.key, mode);
            setOpen(false);
            setMode(undefined);
          }}
          data-testid="speaker-menu"
        >
          <LeadMenu index={props.index} mode={mode} setMode={setMode} speakerId={view.speakerId} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
});

function scopeLabel(t: TFunction, scope: LeadScope): string {
  if (scope.kind === "selection") return t("speakerEditor.scope.selection", { count: scope.keys.length });
  if (scope.kind === "run") return t("speakerEditor.scope.run", { count: scope.keys.length });
  return t("speakerEditor.scope.sentence");
}

/** The menu's entries; rendered only while it is open, so it reads the scope at that moment. */
function LeadMenu(props: { index: number; mode: "run" | undefined; setMode: (mode: "run" | undefined) => void; speakerId: string | null }) {
  const { t } = useTranslation();
  const editing = useSpeakerEditingContext();
  const { actions } = editing;
  const scope = actions.scope(props.index, props.mode);
  const run = actions.scope(props.index, "run");
  const canToggle = scope.kind !== "selection" && run.keys.length > 1;

  const item = (speaker: SpeakerDto, digit: number | undefined) => (
    <DropdownMenu.Item key={speaker.id} className={MENU_ITEM_CLASS} onSelect={() => actions.assign(scope, speaker.id)} data-testid={`speaker-menu-item-${speaker.id}`}>
      <SpeakerAvatar contentId={editing.contentId} speaker={speaker} size={20} decorative />
      <span className="min-w-0 flex-1 truncate">{speakerLabel(t, speaker)}</span>
      {scope.common === speaker.id ? <Check size={14} className="shrink-0 text-accent" aria-label={t("speakerEditor.menu.currentSpeaker")} /> : null}
      {digit === undefined ? null : <kbd className="shrink-0 rounded border border-line px-1 font-mono text-[11px] text-muted">{digit}</kbd>}
    </DropdownMenu.Item>
  );

  return (
    <>
      <DropdownMenu.Label className="px-2 pt-1 pb-1.5 text-xs text-muted" data-testid="speaker-menu-scope">
        {scopeLabel(t, scope)}
      </DropdownMenu.Label>
      {canToggle ? (
        <DropdownMenu.Item
          className={`${MENU_ITEM_CLASS} text-xs text-accent`}
          onSelect={(event) => {
            event.preventDefault();
            props.setMode(scope.kind === "run" ? undefined : "run");
          }}
          data-testid="speaker-menu-scope-toggle"
        >
          {scope.kind === "run" ? t("speakerEditor.scope.onlySentence") : t("speakerEditor.scope.wholeRun", { count: run.keys.length })}
        </DropdownMenu.Item>
      ) : null}
      <DropdownMenu.Separator className="my-1 h-px bg-line" />
      {editing.current.map((speaker, position) => item(speaker, position < 9 ? position + 1 : undefined))}
      {editing.others.length === 0 ? null : (
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS} data-testid="speaker-menu-others">
            <span className="flex-1">{t("speakerEditor.menu.others")}</span>
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent className={`${MENU_CONTENT_CLASS} max-h-72 w-56 overflow-y-auto`} sideOffset={4} collisionPadding={8}>
              {editing.others.map((speaker) => item(speaker, undefined))}
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      )}
      <DropdownMenu.Separator className="my-1 h-px bg-line" />
      <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => actions.createAndAssign(scope)} data-testid="speaker-menu-new">
        <Plus size={16} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="flex-1">{t("speakerEditor.menu.create")}</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => actions.assign(scope, null)} data-testid="speaker-menu-unassign">
        <UserRoundX size={16} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="flex-1">{t("speakerEditor.menu.unassign")}</span>
        {scope.common === null ? <Check size={14} className="shrink-0 text-accent" aria-label={t("speakerEditor.menu.currentSpeaker")} /> : null}
        <kbd className="shrink-0 rounded border border-line px-1 font-mono text-[11px] text-muted">0</kbd>
      </DropdownMenu.Item>
    </>
  );
}
