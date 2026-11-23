import { CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TOAST_DISMISS_MS } from "../../shared/defaults.ts";
import { FOCUS_RING } from "./button.tsx";
import { TEXT_ACTION_CLASS } from "./notice.tsx";

/** Toasts on screen at once; a new one beyond this pushes out an older one, transient first. */
const TOAST_LIMIT = 3;

/**
 * Drops toasts beyond `TOAST_LIMIT`, never the newest: it is what just happened, and dropping it
 * at once would leave it unseen and unannounced. Among the older ones the oldest transient goes
 * first, sparing persistent ones (they report what cannot be undone and stay until closed); only
 * when all of them are persistent does the oldest of those go.
 */
function withinLimit(toasts: ToastEntry[]): ToastEntry[] {
  const kept = [...toasts];
  while (kept.length > TOAST_LIMIT) {
    const transient = kept.findIndex((toast, index) => index < kept.length - 1 && toast.persistent !== true);
    kept.splice(transient === -1 ? 0 : transient, 1);
  }
  return kept;
}

/**
 * A transient report that something finished. Never an error the user has to deal with: those
 * stay where they happened (a `Callout`, a `FieldError`, the dialog).
 */
export interface ToastOptions {
  tone: "success" | "info";
  message: ReactNode;
  /** One follow-up, e.g. "view" or "undo"; choosing it also closes the toast. */
  action?: { label: string; onClick: () => void };
  /** Stays until closed instead of leaving after the standard delay. */
  persistent?: boolean;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

interface ToastEntry extends ToastOptions {
  id: string;
}

interface ToastContextValue extends ToastApi {
  setOffset: (key: symbol, px: number | undefined) => void;
}

const NOOP_API: ToastApi = { show: () => "", dismiss: () => undefined };

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/**
 * Shows and dismisses toasts. Outside a `ToastProvider` both are no-ops, so a component rendered
 * on its own (in a test, in an isolated island) can call them freely.
 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  return useMemo(() => (context === undefined ? NOOP_API : { show: context.show, dismiss: context.dismiss }), [context]);
}

/**
 * Lifts the toasts by `px` while the calling component is mounted, e.g. by the height of a
 * selection action bar pinned to the bottom of a page, so the toasts never cover it. Pass
 * `undefined` (or 0) while the bar is hidden. With several callers the largest lift applies.
 */
export function useToastOffset(px: number | undefined): void {
  const context = useContext(ToastContext);
  const key = useRef(Symbol("toast-offset")).current;
  const setOffset = context?.setOffset;
  useEffect(() => {
    if (setOffset === undefined) return undefined;
    setOffset(key, px);
    return () => setOffset(key, undefined);
  }, [setOffset, key, px]);
}

let nextId = 0;

/**
 * Hosts the toasts of everything below it, in the bottom-right corner, in one polite live region
 * (it exists before any toast does, so screen readers announce each new one). Mount it inside the
 * router so a toast's action can navigate.
 */
export function ToastProvider(props: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [offsets, setOffsets] = useState<ReadonlyMap<symbol, number>>(new Map());
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback((options: ToastOptions) => {
    nextId += 1;
    const id = `toast-${nextId}`;
    setToasts((current) => withinLimit([...current, { ...options, id }]));
    return id;
  }, []);
  const setOffset = useCallback((key: symbol, px: number | undefined) => {
    setOffsets((current) => {
      const next = new Map(current);
      if (px === undefined || px <= 0) next.delete(key);
      else next.set(key, px);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ show, dismiss, setOffset }), [show, dismiss, setOffset]);
  const lift = Math.max(0, ...offsets.values());
  return (
    <ToastContext.Provider value={value}>
      {props.children}
      {/* A div rather than a section, so page structure queries do not count the host. */}
      <div
        role="region"
        aria-label={t("common.toast.region")}
        className="pointer-events-none fixed right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col items-stretch gap-2"
        style={{ bottom: `calc(1rem + ${lift}px)` }}
        data-testid="toast-region"
      >
        <ol aria-live="polite" className="flex flex-col gap-2">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </ol>
      </div>
    </ToastContext.Provider>
  );
}

/** Counts down only while neither hovered nor focused, resuming with the time that was left. */
function ToastItem(props: { toast: ToastEntry; onDismiss: (id: string) => void }) {
  const { t } = useTranslation();
  const { toast } = props;
  const dismissById = props.onDismiss;
  const onDismiss = useCallback(() => dismissById(toast.id), [dismissById, toast.id]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(TOAST_DISMISS_MS);
  const paused = hovered || focused;
  useEffect(() => {
    if (toast.persistent === true || paused) return undefined;
    const started = Date.now();
    const timer = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, toast.persistent, onDismiss]);
  const Icon = toast.tone === "success" ? CircleCheck : Info;
  return (
    <li
      className="pointer-events-auto flex items-start gap-2.5 rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink shadow-lg animate-[toast-in_140ms_ease-out] motion-reduce:animate-none"
      data-testid="toast"
      data-tone={toast.tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <span className={`flex h-5 shrink-0 items-center ${toast.tone === "success" ? "text-ok" : "text-muted"}`}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0">{toast.message}</span>
        {toast.action === undefined ? null : (
          <button
            type="button"
            className={`shrink-0 font-medium ${TEXT_ACTION_CLASS}`}
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            data-testid="toast-action"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" className={`-mr-1 shrink-0 rounded p-0.5 text-muted hover:bg-sunken hover:text-ink ${FOCUS_RING}`} aria-label={t("common.toast.dismiss")} onClick={onDismiss} data-testid="toast-dismiss">
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
