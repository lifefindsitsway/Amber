import { Captions, ChevronRight, Lock } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { PLAYER_MENU_CONTENT_CLASS, PLAYER_MENU_ITEM_CLASS } from "./player-menus.tsx";
import type { SubtitleTrackModel } from "./subtitle-overlay.tsx";
import { SUBTITLE_DISPLAY_MODES, type SubtitleDisplayMode } from "./subtitle-prefs.ts";

/** Coloured in the accent while subtitles are on, like the chosen item of a player menu. */
const TRIGGER_CLASS = "player-button data-[state=open]:bg-white/15 data-[active=true]:text-accent";
const LABEL_CLASS = "px-4 pt-1.5 pb-1 text-xs text-white/60";
const SEPARATOR_CLASS = "my-1 h-px bg-white/15";
const NOTE_CLASS = "max-w-56 px-4 py-1 text-xs text-white/60";

/**
 * The 「字幕」 menu of the local player's control bar: display mode, original
 * revision, translation (or 「去翻译」 without one) and 「样式与位置…」, which enters the
 * editor. A translation is chosen by language (following its current version) or, under
 * 「历史版本」, by locking one version. Non-modal and portalled into the player like the other control-bar menus.
 */
export function SubtitleMenu(props: { model: SubtitleTrackModel; container: HTMLElement | null; onOpenChange?: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { model } = props;
  const noTranslation = model.translations.length === 0;
  const needsTranslation = (mode: SubtitleDisplayMode): boolean => mode === "translation" || mode === "bilingual";
  return (
    <DropdownMenu.Root modal={false} {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}>
      <DropdownMenu.Trigger
        className={TRIGGER_CLASS}
        aria-label={t("contentView.player.subtitles.button")}
        title={t("contentView.player.subtitles.button")}
        data-active={model.mode !== "off"}
        data-testid="player-subtitles"
      >
        <Captions size={18} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={props.container ?? undefined}>
        <DropdownMenu.Content side="top" align="end" sideOffset={6} className={`${PLAYER_MENU_CONTENT_CLASS} max-h-80 overflow-y-auto`} data-testid="player-subtitles-menu">
          <DropdownMenu.Label className={LABEL_CLASS}>{t("contentView.player.subtitles.display")}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={model.mode}
            onValueChange={(value) => {
              const next = SUBTITLE_DISPLAY_MODES.find((mode) => mode === value);
              if (next !== undefined) model.setMode(next);
            }}
          >
            {SUBTITLE_DISPLAY_MODES.map((mode) => (
              <DropdownMenu.RadioItem
                key={mode}
                value={mode}
                disabled={noTranslation && needsTranslation(mode)}
                className={PLAYER_MENU_ITEM_CLASS}
                data-testid={`player-subtitles-mode-${mode}`}
              >
                {t(`contentView.player.subtitles.mode.${mode}`)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {model.originals.length === 0 ? null : (
            <>
              <DropdownMenu.Separator className={SEPARATOR_CLASS} />
              <DropdownMenu.Label className={LABEL_CLASS}>{t("contentView.player.subtitles.originalRevision")}</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={model.originalId ?? ""} onValueChange={model.setOriginal}>
                {model.originals.map((option) => (
                  <DropdownMenu.RadioItem key={option.id} value={option.id} className={PLAYER_MENU_ITEM_CLASS} data-testid={`player-subtitles-original-${option.id}`}>
                    <span className="max-w-56 truncate" title={option.label}>
                      {option.label}
                    </span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </>
          )}
          <DropdownMenu.Separator className={SEPARATOR_CLASS} />
          <DropdownMenu.Label className={LABEL_CLASS}>{t("contentView.player.subtitles.translation")}</DropdownMenu.Label>
          {noTranslation ? (
            <>
              <p className={NOTE_CLASS}>{t("contentView.player.subtitles.noTranslation")}</p>
              <DropdownMenu.Item className={PLAYER_MENU_ITEM_CLASS} onSelect={model.goTranslate} data-testid="player-subtitles-go-translate">
                {t("contentView.player.subtitles.goTranslate")}
              </DropdownMenu.Item>
            </>
          ) : (
            <TranslationChoices model={model} />
          )}
          <DropdownMenu.Separator className={SEPARATOR_CLASS} />
          <DropdownMenu.Item className={PLAYER_MENU_ITEM_CLASS} onSelect={model.startEditing} data-testid="player-subtitles-edit">
            {t("contentView.player.subtitles.editStyle")}
          </DropdownMenu.Item>
          {model.fontFallback ? <p className={NOTE_CLASS}>{t("contentView.player.subtitles.fontFallback")}</p> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const FOLLOW = "follow:";
const LOCK = "lock:";

/**
 * The translation radio items: one 「<language>（当前）」 per language, which follows it, and
 * a 「历史版本」 toggle that lists the language's other versions inline to lock one. Inline
 * rather than a submenu, so the list stays inside the portalled menu and arrow keys reach it.
 * A language whose history holds the locked version starts expanded.
 */
function TranslationChoices(props: { model: SubtitleTrackModel }) {
  const { t } = useTranslation();
  const { model } = props;
  const lockedId = model.translationLocked ? model.translationId : undefined;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(model.translations.filter((entry) => entry.history.some((option) => option.id === lockedId)).map((entry) => entry.language)),
  );
  const following = lockedId === undefined ? model.translations.find((entry) => entry.currentId === model.translationId)?.language : undefined;
  const value = lockedId !== undefined ? `${LOCK}${lockedId}` : following === undefined ? "" : `${FOLLOW}${following}`;
  const toggle = (language: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(language)) next.add(language);
      return next;
    });
  return (
    <DropdownMenu.RadioGroup
      value={value}
      onValueChange={(next) => {
        if (next.startsWith(FOLLOW)) model.followTranslation(next.slice(FOLLOW.length));
        else if (next.startsWith(LOCK)) model.lockTranslation(next.slice(LOCK.length));
      }}
    >
      {model.translations.map((entry) => {
        const open = expanded.has(entry.language);
        const historyId = `player-subtitles-history-list-${entry.language}`;
        return (
          <Fragment key={entry.language}>
            <DropdownMenu.RadioItem value={`${FOLLOW}${entry.language}`} className={PLAYER_MENU_ITEM_CLASS} data-testid={`player-subtitles-follow-${entry.language}`}>
              <span className="max-w-56 truncate">{t("contentView.player.subtitles.followLanguage", { language: entry.label })}</span>
            </DropdownMenu.RadioItem>
            {entry.history.length === 0 ? null : (
              <DropdownMenu.Item
                className={`${PLAYER_MENU_ITEM_CLASS} gap-1 pl-6 text-xs text-white/70`}
                aria-expanded={open}
                aria-controls={open ? historyId : undefined}
                aria-label={t("contentView.player.subtitles.historyOf", { language: entry.label })}
                // Keeps the menu open: the toggle only shows or hides the versions below.
                onSelect={(event) => {
                  event.preventDefault();
                  toggle(entry.language);
                }}
                data-testid={`player-subtitles-history-${entry.language}`}
              >
                <ChevronRight size={14} aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
                {t("contentView.player.subtitles.history", { count: entry.history.length })}
              </DropdownMenu.Item>
            )}
            {open ? (
              <div id={historyId} role="group" aria-label={t("contentView.player.subtitles.historyOf", { language: entry.label })}>
                {entry.history.map((option) => {
                  const locked = option.id === lockedId;
                  return (
                    <DropdownMenu.RadioItem
                      key={option.id}
                      value={`${LOCK}${option.id}`}
                      className={`${PLAYER_MENU_ITEM_CLASS} gap-1.5 pl-10 text-xs`}
                      data-testid={`player-subtitles-translation-${option.id}`}
                    >
                      <span className="max-w-56 truncate" title={option.label}>
                        {option.label}
                      </span>
                      {locked ? (
                        <span className="inline-flex shrink-0 items-center gap-0.5" data-testid="player-subtitles-locked">
                          <Lock size={12} aria-hidden="true" />
                          <span className="sr-only">{t("contentView.player.subtitles.locked")}</span>
                        </span>
                      ) : null}
                    </DropdownMenu.RadioItem>
                  );
                })}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </DropdownMenu.RadioGroup>
  );
}
