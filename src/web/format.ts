/** `h:mm:ss` for an hour or more, else `m:ss`; media time is integer milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Local date and time for list columns; the UI language picks the format. */
export function formatDateTime(epochMs: number, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(epochMs);
}

/**
 * Publish dates show in Beijing time (UTC+8) in a fixed `YYYY-MM-DD` / `YYYY-MM-DD HH:mm`
 * form, so a video's date reads the same whatever the machine's time zone or UI language.
 */
const PUBLISHED_TIME_ZONE = "Asia/Shanghai";
const publishedParts = new Intl.DateTimeFormat("en-US", {
  timeZone: PUBLISHED_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function publishedFields(epochMs: number): Record<"year" | "month" | "day" | "hour" | "minute", string> {
  const fields = { year: "", month: "", day: "", hour: "", minute: "" };
  for (const part of publishedParts.formatToParts(epochMs)) {
    if (part.type in fields) {
      fields[part.type as keyof typeof fields] = part.value;
    }
  }
  return fields;
}

/** `YYYY-MM-DD` of a publish moment in Beijing time. */
export function formatPublishedDate(epochMs: number): string {
  const { year, month, day } = publishedFields(epochMs);
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD HH:mm` of a publish moment in Beijing time. */
export function formatPublishedDateTime(epochMs: number): string {
  const { hour, minute } = publishedFields(epochMs);
  return `${formatPublishedDate(epochMs)} ${hour}:${minute}`;
}

/** Local time of day only, for a moment on the same date as one shown just before it. */
export function formatTime(epochMs: number, language: string): string {
  return new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(epochMs);
}

/** Whether two moments fall on the same local date. */
export function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
