import type { TFunction } from "i18next";
import { LoaderCircle, MessageSquareText, RefreshCw } from "lucide-react";
import { Popover } from "radix-ui";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useState, useSyncExternalStore, type KeyboardEvent, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ContentDanmakuSummary } from "../../shared/dto/danmaku.ts";
import { Checkbox } from "../ui/checkbox.tsx";
import { useDanmakuFetch, useDanmakuSnapshot, type DanmakuFetchOutcome } from "./danmaku-data.ts";
import { DANMAKU_PREF_RANGES, useDanmakuPrefs } from "./danmaku-prefs.ts";
import type { PlayerExtensionContext } from "./player-extensions.ts";
import { PLAYER_MENU_CONTENT_CLASS, PLAYER_MENU_ITEM_CLASS } from "./player-menus.tsx";

/** Coloured in the accent while danmaku are shown, like the subtitle button. */
const TRIGGER_CLASS = "player-button data-[state=open]:bg-white/15 data-[active=true]:text-accent";
const FIELD_CLASS = "flex items-center gap-2";
const ACTION_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded border border-white/20 px-2 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
/** Slider steps, as a share of the whole range: a tenth for density and size, a twentieth for opacity. */
const STEP = { density: 0.1, opacity: 0.05, fontScale: 0.1 } as const;

/** Where the popover opens from a narrow player, which has no button: above the picture's bottom right corner, clear of the control bar. */
const ANCHOR_INSET_PX = { right: 8, bottom: 48 } as const;

/**
 * Whether the popover is open, shared by the bar button, the settings-menu entry of a narrow
 * player and the popover itself, so it stays open while the player changes width.
 */
export interface DanmakuOpenState {
  get(): boolean;
  set(open: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createDanmakuOpenState(): DanmakuOpenState {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    get: () => open,
    set: (next) => {
      if (next === open) return;
      open = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Contents whose first opening already fetched once on this page, so a failure is not retried by reopening. */
const fetchedOnOpen = new Set<string>();

/** When the snapshot was fetched, short enough for one line: month, day and time, the year only when it is not this one. */
function fetchedAtText(epochMs: number, language: string): string {
  const sameYear = new Date(epochMs).getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(epochMs);
}

/** Percent with no fractional noise (`0.7000000001` → 70). */
const percent = (value: number): number => Math.round(value * 100);

/** Whether the system asks for reduced motion, following changes while the page is open. */
export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const list = window.matchMedia(query);
    const onChange = (): void => setReduced(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  return reduced;
}


/** Seconds left until `until`, counted down once a second while there are any. */
function useSecondsUntil(until: number | undefined): number {
  const left = (): number => (until === undefined ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    setSeconds(left());
    if (until === undefined || until <= Date.now()) return undefined;
    const timer = setInterval(() => {
      const next = left();
      setSeconds(next);
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
    // `left` reads only `until`.
  }, [until]);
  return seconds;
}

function outcomeText(outcome: DanmakuFetchOutcome, t: TFunction): string {
  switch (outcome.kind) {
    case "pending":
      return t("danmaku.updating");
    case "fetched":
      return outcome.truncated ? t("danmaku.result.truncated", { count: outcome.count }) : t("danmaku.result.fetched", { count: outcome.count });
    case "empty":
      return t("danmaku.result.empty");
    case "failed":
      if (outcome.kept) return outcome.reason === undefined ? t("danmaku.result.failedKept") : t("danmaku.result.failedKeptReason", { reason: outcome.reason });
      return outcome.reason === undefined ? t("danmaku.result.failed") : t("danmaku.result.failedReason", { reason: outcome.reason });
    case "cooldown":
      return t("danmaku.result.cooldown");
    case "error":
      return outcome.reason === undefined ? t("danmaku.result.failed") : t("danmaku.result.failedReason", { reason: outcome.reason });
  }
}

function RangeField(props: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; testId: string }) {
  const { t } = useTranslation();
  const valueText = t("danmaku.percent", { value: percent(props.value) });
  return (
    <label className={FIELD_CLASS}>
      <span className="w-14 shrink-0 text-white/70">{props.label}</span>
      <input
        type="range"
        className="min-w-0 flex-1 accent-accent"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-valuetext={valueText}
        onChange={(event) => props.onChange(Math.round(Number(event.currentTarget.value) * 100) / 100)}
        data-testid={props.testId}
      />
      <span className="w-9 shrink-0 text-right tabular-nums">{valueText}</span>
    </label>
  );
}

/**
 * The 「弹幕」 button of the local player's control bar and its compact popover: show or
 * hide danmaku, 「更新弹幕」, density, opacity and size, and one line saying how many items
 * the stored snapshot holds and when it was fetched. Opening it the first time on a Content
 * that never fetched any fetches once; after that only 「更新弹幕」 asks the platform. Each
 * outcome is said in words (a count, no danmaku, a failure that kept the last snapshot), and
 * while another request would only be refused the button is disabled with the wait beside it.
 * Non-modal and portalled into the player, so it shows in fullscreen and playback keeps its
 * pointer input; its own keys never reach the player's shortcuts.
 */
export function DanmakuMenu(props: {
  contentId: string;
  summary: ContentDanmakuSummary;
  container: HTMLElement | null;
  onOpenChange: (open: boolean) => void;
  /** Shared with the settings-menu entry; a state of its own when absent. */
  openState?: DanmakuOpenState;
  /**
   * Opens from the picture's corner instead of a bar button (a narrow player, where the entry
   * sits in the settings menu); closing then returns focus to the player.
   */
  anchor?: PlayerExtensionContext["picture"];
}) {
  const { t, i18n } = useTranslation();
  const [ownState] = useState(createDanmakuOpenState);
  const openState = props.openState ?? ownState;
  const open = useSyncExternalStore(openState.subscribe, openState.get);
  const [prefs, setPrefs] = useDanmakuPrefs();
  const snapshot = useDanmakuSnapshot(props.contentId, open || prefs.enabled);
  const { outcome, coolUntil, fetch } = useDanmakuFetch(props.contentId);
  const secondsLeft = useSecondsUntil(coolUntil);
  const reducedMotion = useReducedMotion();
  const statusId = useId();
  const stored = snapshot.data?.snapshot;
  const fetchedAt = stored?.fetchedAt ?? props.summary.fetchedAt;
  const count = stored?.count ?? props.summary.count ?? 0;
  const pending = outcome?.kind === "pending";
  const cooling = !pending && secondsLeft > 0;

  // Opening may come from outside (the settings-menu entry), so the effects of opening follow the state.
  const { onOpenChange, summary, contentId } = props;
  useEffect(() => {
    onOpenChange(open);
    if (open && summary.fetchedAt === undefined && !fetchedOnOpen.has(contentId)) {
      fetchedOnOpen.add(contentId);
      fetch();
    }
    // Only a change of `open` acts; the rest is read as it stands then.
  }, [open]);
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  // The popover is a small form: its keys (Space on a button, arrows on a slider) are its own.
  // Escape has already closed it by then (the popover listens on the document first).
  const keep = (event: KeyboardEvent<HTMLElement>): void => event.stopPropagation();
  const stop = (event: SyntheticEvent): void => event.stopPropagation();

  return (
    <Popover.Root modal={false} open={open} onOpenChange={openState.set}>
      {props.anchor === undefined ? (
        <Popover.Trigger asChild>
          <button type="button" className={TRIGGER_CLASS} aria-label={t("danmaku.button")} title={t("danmaku.button")} data-active={prefs.enabled} data-testid="player-danmaku">
            <MessageSquareText size={18} aria-hidden="true" />
          </button>
        </Popover.Trigger>
      ) : (
        <Popover.Anchor asChild>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute size-px"
            style={{ left: props.anchor.x + props.anchor.width - ANCHOR_INSET_PX.right, top: props.anchor.y + props.anchor.height - ANCHOR_INSET_PX.bottom }}
            data-testid="player-danmaku-anchor"
          />
        </Popover.Anchor>
      )}
      <Popover.Portal container={props.container ?? undefined}>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          // Kept inside the player: in a narrow player it narrows rather than leaving the picture.
          collisionBoundary={props.container}
          aria-label={t("danmaku.popoverLabel")}
          className={`${PLAYER_MENU_CONTENT_CLASS} flex max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[var(--radix-popover-content-available-width)] flex-col overflow-y-auto gap-2.5 p-3 text-xs outline-none`}
          onKeyDown={keep}
          {...(props.anchor === undefined
            ? {}
            : {
                // No trigger to go back to: the player keeps the focus, so its keys work on.
                onCloseAutoFocus: (event: Event) => {
                  event.preventDefault();
                  props.container?.focus({ preventScroll: true });
                },
              })}
          onClick={stop}
          onDoubleClick={stop}
          data-testid="player-danmaku-popover"
        >
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("danmaku.show")}</span>
            <span className="relative inline-flex shrink-0">
              {/* Drawn as a switch for the dark popover over the picture; the box itself is hidden. */}
              <Checkbox
                role="switch"
                className="peer sr-only"
                checked={prefs.enabled}
                onChange={(event) => setPrefs({ enabled: event.currentTarget.checked })}
                data-testid="player-danmaku-toggle"
              />
              <span
                aria-hidden="true"
                className="h-5 w-9 rounded-full bg-white/25 transition-colors duration-150 motion-reduce:transition-none peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-white/70"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none peer-checked:translate-x-4"
              />
            </span>
          </label>

          <div className="flex flex-col gap-1.5 border-t border-white/15 pt-2.5">
            <p className="text-white/70" data-testid="player-danmaku-summary">
              {fetchedAt === undefined ? t("danmaku.never") : t("danmaku.summary", { count, time: fetchedAtText(fetchedAt, i18n.language) })}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <button
                type="button"
                className={ACTION_CLASS}
                disabled={pending || cooling}
                aria-describedby={statusId}
                onClick={fetch}
                data-testid="player-danmaku-update"
              >
                {pending ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                {t("danmaku.update")}
              </button>
              {cooling ? (
                <span className="text-white/60 tabular-nums" data-testid="player-danmaku-cooldown">
                  {t("danmaku.cooldownWait", { seconds: secondsLeft })}
                </span>
              ) : null}
            </div>
            <p id={statusId} role="status" aria-live="polite" className="min-h-4 text-white/90" data-testid="player-danmaku-status" data-outcome={outcome?.kind ?? ""}>
              {outcome === undefined ? "" : outcomeText(outcome, t)}
            </p>
          </div>

          <div className="flex flex-col gap-2 border-t border-white/15 pt-2.5">
            <RangeField
              label={t("danmaku.density")}
              value={prefs.density}
              min={DANMAKU_PREF_RANGES.density.min}
              max={DANMAKU_PREF_RANGES.density.max}
              step={STEP.density}
              onChange={(density) => setPrefs({ density })}
              testId="player-danmaku-density"
            />
            <RangeField
              label={t("danmaku.opacity")}
              value={prefs.opacity}
              min={DANMAKU_PREF_RANGES.opacity.min}
              max={DANMAKU_PREF_RANGES.opacity.max}
              step={STEP.opacity}
              onChange={(opacity) => setPrefs({ opacity })}
              testId="player-danmaku-opacity"
            />
            <RangeField
              label={t("danmaku.fontSize")}
              value={prefs.fontScale}
              min={DANMAKU_PREF_RANGES.fontScale.min}
              max={DANMAKU_PREF_RANGES.fontScale.max}
              step={STEP.fontScale}
              onChange={(fontScale) => setPrefs({ fontScale })}
              testId="player-danmaku-font-scale"
            />
          </div>
          {reducedMotion ? (
            <p className="text-note text-white/60" data-testid="player-danmaku-reduced-motion">
              {t("danmaku.reducedMotion")}
            </p>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The settings-menu entry 「弹幕…」 of a narrow player. It opens the popover once the menu has
 * closed and handed the focus back, so that hand-back does not close the popover again.
 */
export function DanmakuSettingsItem(props: { openState: DanmakuOpenState }) {
  const { t } = useTranslation();
  const [prefs] = useDanmakuPrefs();
  return (
    <DropdownMenu.Item
      className={`${PLAYER_MENU_ITEM_CLASS} justify-between gap-4`}
      aria-haspopup="dialog"
      onSelect={() => {
        // The menu returns the focus in a task of its own after it closes; open after that one.
        setTimeout(() => setTimeout(() => props.openState.set(true)));
      }}
      data-testid="player-settings-danmaku"
    >
      <span>{t("danmaku.menuEntry")}</span>
      <span className="text-xs text-white/60">{prefs.enabled ? t("danmaku.stateOn") : t("danmaku.stateOff")}</span>
    </DropdownMenu.Item>
  );
}
