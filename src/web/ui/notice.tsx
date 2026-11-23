import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { FOCUS_RING } from "./button.tsx";

/*
 * Three strengths of explanation, quietest first; use the quietest that will be read in time:
 * 1. quiet secondary text, no box: `FieldHint` under a control, `InlineNote` in a row or section;
 * 2. a `Callout` (or a page-wide `Banner`): only what must be read before acting, or a problem the
 *    user has to deal with;
 * 3. the result report inside a dialog.
 * Toasts (ui/toast.tsx) only report something finished; they never carry an error to handle.
 */

/** 13 px muted explanatory text on a 20 px line, at most about 70 characters wide. */
export const NOTE_TEXT_CLASS = "text-note text-muted max-w-[70ch]";

/** Links and inline text actions: the link colour, underlined on hover, the shared focus ring. */
export const TEXT_ACTION_CLASS = `rounded-sm text-link underline-offset-2 hover:underline ${FOCUS_RING}`;

/**
 * An inline text action (a button that reads like a link), e.g. "go to settings" inside a note. For
 * navigation use a router `Link` with `TEXT_ACTION_CLASS` instead.
 */
export function TextAction({ className = "", type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={`${TEXT_ACTION_CLASS} ${className}`} {...rest} />;
}

/**
 * The explanation under (or beside) a form control. Give it an `id` and put that id in the
 * control's `aria-describedby`, so screen readers read it with the control. Stack it 6 px from
 * the control (`gap-1.5` in the field's column).
 */
export function FieldHint({ id, children, className = "", testId }: { id: string; children: ReactNode; className?: string; testId?: string }) {
  return (
    <p id={id} className={`${NOTE_TEXT_CLASS} ${className}`} data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * What is wrong with a control's value, right under it. Not a live region: the control is marked
 * `aria-invalid` and names this element (its `id`) in `aria-describedby`, so the message is read
 * when the user reaches the control, and is not announced a second time as an alert.
 */
export function FieldError({ id, children, className = "", testId }: { id: string; children: ReactNode; className?: string; testId?: string }) {
  return (
    <p id={id} className={`flex max-w-[70ch] items-start gap-1.5 text-note text-danger ${className}`} data-testid={testId}>
      <CircleAlert size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * A quiet sentence in a row or under a section, optionally followed by one inline action (a
 * `TextAction`, or a `Link` with `TEXT_ACTION_CLASS`). No box, no colour beyond the muted text:
 * the lightest way to explain something.
 */
export function InlineNote({
  children,
  action,
  icon,
  className = "",
  testId,
  ...rest
}: Omit<HTMLAttributes<HTMLParagraphElement>, "children"> & {
  children: ReactNode;
  action?: ReactNode;
  /** A 14 px lucide icon before the text, rarely needed. */
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <p {...rest} className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${NOTE_TEXT_CLASS} ${className}`} data-testid={testId}>
      {icon === undefined ? null : <span className="shrink-0 self-center">{icon}</span>}
      <span className="min-w-0">{children}</span>
      {action === undefined ? null : <span className="shrink-0">{action}</span>}
    </p>
  );
}

export type NoticeTone = "info" | "warn" | "error" | "success";

/**
 * `info` is neutral on purpose: the accent marks actions and selection, not explanations.
 * Borders stay faint; the ground and the icon carry the tone, the text stays in the ink colour.
 */
const TONES: Readonly<Record<NoticeTone, { box: string; icon: string; Icon: LucideIcon }>> = {
  info: { box: "border-line bg-panel", icon: "text-muted", Icon: Info },
  warn: { box: "border-warn/25 bg-warn-soft", icon: "text-warn", Icon: TriangleAlert },
  error: { box: "border-danger/25 bg-danger-soft", icon: "text-danger", Icon: CircleAlert },
  success: { box: "border-ok/25 bg-ok-soft", icon: "text-ok", Icon: CircleCheck },
};

/**
 * `status` / `alert` make the notice a live region, so its appearance is announced; use them
 * only for a notice that appears in response to what the user just did (`alert` for a failure
 * that interrupts). A notice present from the start needs neither.
 */
export type NoticeAnnounce = "status" | "alert";

type NoticeProps = Omit<HTMLAttributes<HTMLDivElement>, "title" | "children"> & {
  tone: NoticeTone;
  /** A short bold first line. */
  title?: ReactNode;
  /** The explanation. */
  children?: ReactNode;
  /** Buttons or links that resolve the notice, after the text. */
  actions?: ReactNode;
  /** Replaces the tone's icon (16 px lucide, `aria-hidden`). */
  icon?: ReactNode;
  announce?: NoticeAnnounce;
  testId?: string;
};

/**
 * A boxed notice for what must be read before acting, or a problem to deal with: tone icon, an
 * optional title, the text and the actions. Plain-string text is capped at about 70 characters a
 * line; richer content lays itself out (cap its paragraphs with `max-w-[70ch]`). `density: "compact"` for tight rows (13 px text,
 * smaller padding). Other attributes (`role`, `aria-labelledby`, `data-*`) pass through to the
 * box; an explicit `role` wins over `announce`.
 */
export function Callout({
  tone,
  title,
  children,
  actions,
  icon,
  announce,
  testId,
  density = "regular",
  className = "",
  ...rest
}: NoticeProps & { density?: "regular" | "compact" }) {
  const look = TONES[tone];
  const compact = density === "compact";
  return (
    <div
      role={announce}
      {...rest}
      className={`flex items-start rounded-md border text-ink ${compact ? "gap-2 px-2.5 py-2 text-note" : "gap-2.5 px-3 py-2.5 text-sm"} ${look.box} ${className}`}
      data-tone={tone}
      data-testid={testId}
    >
      <span className={`flex h-5 shrink-0 items-center ${look.icon}`}>{icon ?? <look.Icon size={16} aria-hidden="true" />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title === undefined ? null : <div className="font-medium">{title}</div>}
        {children === undefined ? null : typeof children === "string" ? <p className="max-w-[70ch]">{children}</p> : <div className="min-w-0">{children}</div>}
        {actions === undefined ? null : <div className="mt-1 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * A full-width strip at the top of a page or pane for a state of the whole page (the backend is
 * unreachable, the source file is missing). Same tones and live-region rule as `Callout`; the
 * actions sit at the right end.
 */
export function Banner({ tone, title, children, actions, icon, announce, testId, className = "", ...rest }: NoticeProps) {
  const look = TONES[tone];
  return (
    <div
      role={announce}
      {...rest}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-6 py-2 text-sm text-ink ${look.box} ${className}`}
      data-tone={tone}
      data-testid={testId}
    >
      <span className={`flex shrink-0 items-center ${look.icon}`}>{icon ?? <look.Icon size={16} aria-hidden="true" />}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        {title === undefined ? null : <span className="font-medium">{title}</span>}
        {children === undefined ? null : <span className="min-w-0">{children}</span>}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
