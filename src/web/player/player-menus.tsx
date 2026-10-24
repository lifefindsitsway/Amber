import type { TFunction } from "i18next";
import { Settings } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { LoopCollectionChoice } from "./list-loop.ts";
import { END_BEHAVIORS, type PlayerSettings } from "./player-settings.ts";

/** Playback rates the local player offers, in menu order: fastest on top, as in the bilibili player. */
export const PLAYBACK_RATES = [2, 1.5, 1.25, 1, 0.75, 0.5] as const;

/** A rate as the menu writes it: whole rates keep one decimal (`1.0x`, `2.0x`), others as they are. */
export function rateText(rate: number): string {
  return Number.isInteger(rate) ? rate.toFixed(1) : String(rate);
}

/** A text-coloured control on the dark bar over the picture. */
const BAR_BUTTON_CLASS =
  "flex h-8 shrink-0 items-center justify-center rounded px-2 text-sm whitespace-nowrap text-white outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70 data-[state=open]:bg-white/15";
/**
 * The control-bar menus sit over the picture, so unlike the app's context menus they are dark
 * like the volume popover, as wide as their content, and mark the chosen item by colouring it
 * in the accent (the volume bar's colour) rather than with a check; the radio / checkbox roles
 * still carry the state for assistive technology.
 */
export const PLAYER_MENU_CONTENT_CLASS = "z-50 rounded-md bg-black/80 p-1 text-sm text-white shadow-lg";
export const PLAYER_MENU_ITEM_CLASS =
  "flex cursor-pointer items-center rounded px-4 py-1.5 outline-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[highlighted]:bg-white/15 data-[state=checked]:text-accent";
const LABEL_CLASS = "px-4 pt-1.5 pb-1 text-xs text-white/60";
const SEPARATOR_CLASS = "my-1 h-px bg-white/15";

interface MenuShellProps {
  container: HTMLElement | null;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

/**
 * Non-modal so the player keeps receiving pointer and key input while a menu is open; the
 * popup is portalled into the player so it stays visible in fullscreen.
 */
function rootProps(props: MenuShellProps) {
  return { modal: false, ...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange }) };
}

/** The speed menu of the local player's control bar; its popup renders inside `container`. */
export function PlaybackRateMenu(props: { rate: number; onRate: (rate: number) => void; container: HTMLElement | null; onOpenChange?: (open: boolean) => void }) {
  const { t } = useTranslation();
  const valueOf = (rate: number): string => t("contentView.player.settings.rateValue", { rate: rateText(rate) });
  return (
    <DropdownMenu.Root {...rootProps(props)}>
      <DropdownMenu.Trigger className={BAR_BUTTON_CLASS} aria-label={t("contentView.player.settings.rate")} data-testid="player-rate">
        {props.rate === 1 ? t("contentView.player.settings.rate") : valueOf(props.rate)}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={props.container ?? undefined}>
        <DropdownMenu.Content side="top" align="center" sideOffset={6} className={PLAYER_MENU_CONTENT_CLASS} data-testid="player-rate-menu">
          <DropdownMenu.RadioGroup
            value={String(props.rate)}
            onValueChange={(value) => {
              const next = PLAYBACK_RATES.find((rate) => String(rate) === value);
              if (next !== undefined) props.onRate(next);
            }}
          >
            {PLAYBACK_RATES.map((rate) => (
              <DropdownMenu.RadioItem key={rate} value={String(rate)} className={`${PLAYER_MENU_ITEM_CLASS} justify-center`} data-testid={`player-rate-${rate}`}>
                {valueOf(rate)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One file the local player can switch to, as the quality menu names it. */
export interface QualitySource {
  assetId: string;
  label: string;
}

/**
 * The quality menu of the local player's control bar: the button names the file actually
 * loaded, the popup lists every source in the given order with the loaded one marked, and
 * picking another one asks the page to switch. Its popup renders inside `container`.
 */
export function QualityMenu(props: {
  sources: readonly QualitySource[];
  activeId: string | undefined;
  onSelect: (assetId: string) => void;
  container: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const active = props.sources.find((source) => source.assetId === props.activeId);
  return (
    <DropdownMenu.Root {...rootProps(props)}>
      <DropdownMenu.Trigger className={BAR_BUTTON_CLASS} aria-label={t("contentView.player.quality.title")} title={t("contentView.player.quality.title")} data-testid="player-quality">
        {active?.label ?? t("contentView.player.quality.title")}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={props.container ?? undefined}>
        <DropdownMenu.Content side="top" align="center" sideOffset={6} className={PLAYER_MENU_CONTENT_CLASS} data-testid="player-quality-menu">
          <DropdownMenu.RadioGroup
            value={props.activeId ?? ""}
            aria-label={t("contentView.player.quality.title")}
            onValueChange={(value) => {
              if (value !== props.activeId && props.sources.some((source) => source.assetId === value)) props.onSelect(value);
            }}
          >
            {props.sources.map((source) => (
              <DropdownMenu.RadioItem
                key={source.assetId}
                value={source.assetId}
                className={`${PLAYER_MENU_ITEM_CLASS} justify-center`}
                data-testid={`player-quality-item-${source.assetId}`}
              >
                {source.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * One group of the settings menu; new options are added as further sections. Choosing
 * `keepOpenOn` leaves the menu open, for an option that reveals a follow-up section. A
 * `hideLabel` group shows no heading, its label only names the group for assistive technology.
 */
type SettingsSection =
  | {
      kind: "choice";
      id: string;
      label: string;
      value: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      onChange: (value: string) => void;
      keepOpenOn?: string;
      hideLabel?: boolean;
    }
  | { kind: "toggle"; id: string; label: string; checked: boolean; onChange: (checked: boolean) => void };

function settingsSections(settings: PlayerSettings, loopCollection: LoopCollectionChoice | undefined, t: TFunction): SettingsSection[] {
  const sections: SettingsSection[] = [
    {
      kind: "choice",
      id: "endBehavior",
      label: t("contentView.player.settings.endBehavior"),
      // The play modes explain themselves; a heading above them would only add noise.
      hideLabel: true,
      value: settings.endBehavior,
      options: END_BEHAVIORS.map((value) => ({ value, label: t(`contentView.player.settings.endBehaviorValue.${value}`) })),
      onChange: (value) => {
        const next = END_BEHAVIORS.find((option) => option === value);
        if (next !== undefined) settings.setEndBehavior(next);
      },
      ...(loopCollection === undefined ? {} : { keepOpenOn: "loop_list" }),
    },
  ];
  // A Content in several collections loops through the one the user picks.
  if (settings.endBehavior === "loop_list" && loopCollection !== undefined) {
    sections.push({
      kind: "choice",
      id: "loopCollection",
      label: t("contentView.player.settings.loopCollection"),
      value: loopCollection.value,
      options: loopCollection.options.map((option) => ({ value: option.id, label: option.name })),
      onChange: loopCollection.choose,
    });
  }
  sections.push({ kind: "toggle", id: "autoplay", label: t("contentView.player.settings.autoplay"), checked: settings.autoplay, onChange: settings.setAutoplay });
  return sections;
}

/**
 * The settings menu of the local player's control bar; its popup renders inside `container`.
 * `loopCollection` is the collection choice of a Content in several collections.
 */
export function PlayerSettingsMenu(props: {
  settings: PlayerSettings;
  container: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
  loopCollection?: LoopCollectionChoice | undefined;
}) {
  const { t } = useTranslation();
  const sections = settingsSections(props.settings, props.loopCollection, t);
  return (
    <DropdownMenu.Root {...rootProps(props)}>
      <DropdownMenu.Trigger className={BAR_BUTTON_CLASS} aria-label={t("contentView.player.settings.title")} title={t("contentView.player.settings.title")} data-testid="player-settings">
        <Settings size={18} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={props.container ?? undefined}>
        <DropdownMenu.Content side="top" align="end" sideOffset={6} className={PLAYER_MENU_CONTENT_CLASS} data-testid="player-settings-menu">
          {sections.map((section, index) => (
            <Fragment key={section.id}>
              {index > 0 ? <DropdownMenu.Separator className={SEPARATOR_CLASS} /> : null}
              {section.kind === "choice" ? (
                <>
                  {section.hideLabel === true ? null : <DropdownMenu.Label className={LABEL_CLASS}>{section.label}</DropdownMenu.Label>}
                  <DropdownMenu.RadioGroup
                    value={section.value}
                    onValueChange={section.onChange}
                    {...(section.hideLabel === true ? { "aria-label": section.label } : {})}
                  >
                    {section.options.map((option) => (
                      <DropdownMenu.RadioItem
                        key={option.value}
                        value={option.value}
                        className={PLAYER_MENU_ITEM_CLASS}
                        data-testid={`player-settings-${section.id}-${option.value}`}
                        onSelect={(event) => {
                          if (option.value === section.keepOpenOn) event.preventDefault();
                        }}
                      >
                        <span className="max-w-48 truncate" title={option.label}>
                          {option.label}
                        </span>
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </>
              ) : (
                <DropdownMenu.CheckboxItem
                  checked={section.checked}
                  onCheckedChange={(checked) => section.onChange(checked === true)}
                  className={PLAYER_MENU_ITEM_CLASS}
                  data-testid={`player-settings-${section.id}`}
                >
                  {section.label}
                </DropdownMenu.CheckboxItem>
              )}
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
