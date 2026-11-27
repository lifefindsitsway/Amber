import { z } from "zod";
import { PLATFORM_TITLE_MAX_CHARS } from "../../../../shared/defaults.ts";
import { capDescription, classifyPlatformDescription, normalizeDescription, type PlatformDescription } from "../../../domain/content-description.ts";
import { trustedImageUrl } from "../shared.ts";

/** Every media file and cover of a note is served from this domain or its subdomains. */
export const XIAOHONGSHU_MEDIA_DOMAINS: readonly string[] = ["xhscdn.com"];
/** The CDN host the untranscoded upload of a video note is read from, keyed by `originVideoKey`. */
const ORIGIN_VIDEO_HOST = "sns-video-bd.xhscdn.com";
/** `originVideoKey` is a short path of URL-safe segments; anything else never becomes a URL. */
const ORIGIN_VIDEO_KEY = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,128}$/;
const NOTE_ID = /^[0-9a-f]{24}$/;

/**
 * The script that embeds the page's server-rendered state. Requiring the `<script>` tag keeps
 * the same text inside an attribute (an `og:title` quoting a note title) from being taken for
 * it, since `<` is escaped there. The tag's attributes are bounded so that a page full of
 * unclosed `<script` cannot make the search quadratic.
 */
const STATE_SCRIPT = /<script[^>]{0,256}>\s*window\.__INITIAL_STATE__\s*=\s*/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const UNDEFINED = "undefined";

/**
 * The object literal starting at `start` as JSON text: braces and brackets are balanced
 * outside strings, and only there the bare word `undefined` (which the page's serializer
 * writes for absent values) becomes `null`. Nothing outside the literal is looked at, and no
 * part of the page is ever evaluated. `undefined` when there is no complete literal.
 */
function objectLiteralAt(text: string, start: number): string | undefined {
  if (text[start] !== "{") {
    return undefined;
  }
  const parts: string[] = [];
  let copied = start;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index] as string;
    if (inString) {
      if (char === "\\") {
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        parts.push(text.slice(copied, index + 1));
        return parts.join("");
      }
    } else if (char === "<") {
      // A literal never contains a raw `<` outside a string; the script ended early.
      return undefined;
    } else if (
      char === "u" &&
      text.startsWith(UNDEFINED, index) &&
      !IDENTIFIER_CHAR.test(text[index - 1] ?? "") &&
      !IDENTIFIER_CHAR.test(text[index + UNDEFINED.length] ?? "")
    ) {
      parts.push(text.slice(copied, index), "null");
      index += UNDEFINED.length - 1;
      copied = index + 1;
    }
  }
  return undefined;
}

/** The page's embedded state parsed as data, or `undefined` when the page has none or it is malformed. */
export function initialStateOf(html: string): unknown {
  const match = STATE_SCRIPT.exec(html);
  if (match === null) {
    return undefined;
  }
  const literal = objectLiteralAt(html, match.index + match[0].length);
  if (literal === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(literal) as unknown;
  } catch {
    return undefined;
  }
}

const optionalString = z.string().nullish();
const optionalNumber = z.number().finite().nullish();

/** One encoded stream as a note lists it; entries that do not fit are skipped one by one. */
const streamSchema = z.object({
  masterUrl: z.string().min(1),
  backupUrls: z.array(z.string()).nullish(),
  size: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: optionalNumber,
  format: optionalString,
  videoCodec: optionalString,
});

const imageSchema = z.object({
  url: optionalString,
  urlDefault: optionalString,
  infoList: z.array(z.object({ imageScene: optionalString, url: optionalString })).nullish(),
});

/** The fields of a note Amber reads; both page forms carry the same note shape. */
const noteSchema = z.object({
  noteId: z.string().regex(NOTE_ID),
  type: z.string(),
  title: optionalString,
  desc: optionalString,
  time: optionalNumber,
  user: z.object({ userId: optionalString, nickName: optionalString, nickname: optionalString }).nullish(),
  imageList: z.array(z.unknown()).nullish(),
  video: z
    .object({
      capa: z.object({ duration: optionalNumber }).nullish(),
      media: z
        .object({
          video: z.object({ duration: optionalNumber }).nullish(),
          stream: z.object({ h264: z.array(z.unknown()).nullish() }).nullish(),
        })
        .nullish(),
      consumer: z.object({ originVideoKey: optionalString }).nullish(),
    })
    .nullish(),
});

const mobileStateSchema = z.object({ noteData: z.object({ data: z.object({ noteData: z.unknown() }) }) });
const desktopStateSchema = z.object({ note: z.object({ noteDetailMap: z.record(z.string(), z.object({ note: z.unknown() }).nullish()) }) });
const loginStateSchema = z.object({ user: z.object({ loggedIn: z.boolean() }) });

/** The two forms of a note page: the mobile share page and the desktop page. */
export type NotePageForm = "mobile" | "desktop";

/** An H.264 MP4 stream of a video note, with its https URLs on the media domain (main first). */
export interface NoteStream {
  urls: string[];
  sizeBytes: number;
  width: number;
  height: number;
  durationMs?: number;
}

/** What Amber takes from a note page. */
export interface NoteDetail {
  noteId: string;
  /** `video` for video notes, `normal` for image notes; other values are kept as given. */
  type: string;
  title: string;
  description: PlatformDescription;
  durationMs?: number;
  publishedAt?: number;
  channelId?: string;
  channelTitle?: string;
  coverUrl?: string;
  /** H.264 MP4 streams only, smallest first. */
  streams: NoteStream[];
  /** The untranscoded upload, when the page names it (the mobile page does). */
  originalUrl?: string;
}

/** `http:` media URLs are read over https (same file, same ETag and length). */
function httpsUrl(url: string | null | undefined): string | undefined {
  if (typeof url !== "string" || url === "") {
    return undefined;
  }
  return trustedImageUrl(url.startsWith("//") ? `https:${url}` : url.replace(/^http:/i, "https:"), XIAOHONGSHU_MEDIA_DOMAINS);
}

/** A topic tag as the page writes it, `#name[label]#`, kept as `#name`. */
const TOPIC_TAG = /#([^#\n[\]]+)\[[^\]\n#]*\]#/g;
const TAG_ONLY_WORD = /#\S+/g;
const WHITESPACE_RUN = /\s+/g;

/** The description with topic tags written as plain `#name`. */
function tidyDescription(raw: string): string {
  return raw.replace(TOPIC_TAG, "#$1");
}

/** One line of title text: controls removed, white space collapsed, capped at a grapheme boundary. */
function titleOf(title: string | null | undefined, description: string): string {
  let text = normalizeDescription(title ?? "").replace(WHITESPACE_RUN, " ").trim();
  if (text === "") {
    // An untitled note shows the first line of its text, without the topic tags.
    const firstLine = normalizeDescription(description)
      .split("\n")
      .map((line) => line.replace(TAG_ONLY_WORD, "").replace(WHITESPACE_RUN, " ").trim())
      .find((line) => line !== "");
    text = firstLine ?? "";
  }
  return capDescription(text, PLATFORM_TITLE_MAX_CHARS).text;
}

function isH264(stream: z.infer<typeof streamSchema>): boolean {
  const codec = (stream.videoCodec ?? "h264").toLowerCase();
  const format = (stream.format ?? "mp4").toLowerCase();
  return (codec === "h264" || codec.startsWith("avc")) && format === "mp4";
}

function streamsOf(raw: readonly unknown[] | null | undefined): NoteStream[] {
  const streams: NoteStream[] = [];
  for (const entry of raw ?? []) {
    const parsed = streamSchema.safeParse(entry);
    if (!parsed.success || !isH264(parsed.data)) {
      continue;
    }
    const urls = [parsed.data.masterUrl, ...(parsed.data.backupUrls ?? [])]
      .map(httpsUrl)
      .filter((url): url is string => url !== undefined)
      .filter((url, index, all) => all.indexOf(url) === index);
    if (urls.length === 0) {
      continue;
    }
    const duration = parsed.data.duration;
    streams.push({
      urls,
      sizeBytes: parsed.data.size,
      width: parsed.data.width,
      height: parsed.data.height,
      ...(typeof duration === "number" && duration > 0 ? { durationMs: Math.round(duration) } : {}),
    });
  }
  return streams.sort((a, b) => a.sizeBytes - b.sizeBytes);
}

/** The note's first image as its cover: the default or detail rendition first, then whatever else is on the media domain. */
function coverOf(images: readonly unknown[] | null | undefined): string | undefined {
  const parsed = imageSchema.safeParse(images?.[0]);
  if (!parsed.success) {
    return undefined;
  }
  const scenes = parsed.data.infoList ?? [];
  const preferred = scenes.filter((info) => /DFT|DTL/.test(info.imageScene ?? "")).map((info) => info.url);
  const candidates = [...preferred, parsed.data.urlDefault, parsed.data.url, ...scenes.map((info) => info.url)];
  for (const candidate of candidates) {
    const url = httpsUrl(candidate);
    if (url !== undefined) {
      return url;
    }
  }
  return undefined;
}

function secondsToMs(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

/** A raw note validated and reduced to what Amber uses; `undefined` when it does not validate or names another note. */
export function noteDetailOf(raw: unknown, noteId: string): NoteDetail | undefined {
  const parsed = noteSchema.safeParse(raw);
  if (!parsed.success || parsed.data.noteId !== noteId) {
    return undefined;
  }
  const note = parsed.data;
  const desc = tidyDescription(note.desc ?? "");
  const streams = streamsOf(note.video?.media?.stream?.h264);
  const durationMs = streams.find((stream) => stream.durationMs !== undefined)?.durationMs ?? secondsToMs(note.video?.media?.video?.duration) ?? secondsToMs(note.video?.capa?.duration);
  const originKey = note.video?.consumer?.originVideoKey;
  const channelTitle = normalizeDescription(note.user?.nickName ?? note.user?.nickname ?? "").replace(WHITESPACE_RUN, " ").trim();
  const channelId = note.user?.userId;
  const coverUrl = coverOf(note.imageList);
  return {
    noteId: note.noteId,
    type: note.type,
    title: titleOf(note.title, desc),
    description: classifyPlatformDescription(typeof note.desc === "string" ? desc : undefined),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(typeof note.time === "number" && Number.isSafeInteger(note.time) && note.time > 0 ? { publishedAt: note.time } : {}),
    ...(typeof channelId === "string" && NOTE_ID.test(channelId) ? { channelId } : {}),
    ...(channelTitle === "" ? {} : { channelTitle }),
    ...(coverUrl === undefined ? {} : { coverUrl }),
    streams,
    ...(typeof originKey === "string" && ORIGIN_VIDEO_KEY.test(originKey) ? { originalUrl: `https://${ORIGIN_VIDEO_HOST}/${originKey}` } : {}),
  };
}

/**
 * The note `noteId` from a page of the given form: the mobile share page embeds it as
 * `noteData.data.noteData`, the desktop page as `note.noteDetailMap[<id>].note`. `undefined`
 * when the page has no embedded state, the state has no such note, or the note does not
 * validate.
 */
export function notePageDetail(html: string, form: NotePageForm, noteId: string): NoteDetail | undefined {
  const state = initialStateOf(html);
  if (form === "mobile") {
    const parsed = mobileStateSchema.safeParse(state);
    return parsed.success ? noteDetailOf(parsed.data.noteData.data.noteData, noteId) : undefined;
  }
  const parsed = desktopStateSchema.safeParse(state);
  return parsed.success ? noteDetailOf(parsed.data.note.noteDetailMap[noteId]?.note, noteId) : undefined;
}

/** Whether the desktop page says its viewer is logged in; `undefined` when it does not say. */
export function loggedInOf(html: string): boolean | undefined {
  const parsed = loginStateSchema.safeParse(initialStateOf(html));
  return parsed.success ? parsed.data.user.loggedIn : undefined;
}
