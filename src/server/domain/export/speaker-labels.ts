import { normalizeSpeakerName, type SpeakerLabelMode } from "../../../shared/speakers.ts";
import { exportFile } from "../../../shared/i18n/zh-CN/export-file.ts";
import type { ContentSpeaker } from "../speaker.ts";
import { fillText } from "./markdown.ts";

/**
 * The name each speaker carries in an export: its own name, or the default naming its
 * ordinal. Names are stored normalized; they go through `normalizeSpeakerName` again so a
 * control or bidirectional character can never reach an exported file, and one that does
 * not survive it falls back to the default.
 */
export function speakerLabels(speakers: readonly Pick<ContentSpeaker, "id" | "ordinal" | "name">[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const speaker of speakers) {
    const name = speaker.name === undefined ? undefined : normalizeSpeakerName(speaker.name);
    labels.set(speaker.id, name === undefined || name === "too_long" ? fillText(exportFile.speakerDefault, { ordinal: String(speaker.ordinal) }) : name);
  }
  return labels;
}

// Primary subtags of Chinese written in Han characters: the macrolanguage and the varieties
// a recognizer may name on their own.
const CHINESE_LANGUAGES: ReadonlySet<string> = new Set(["zh", "cmn", "yue", "wuu", "nan", "hak", "gan", "hsn"]);

/** Whether text in `language` (a BCP-47 tag) is Chinese and so takes a full-width colon. */
export function isChinese(language: string): boolean {
  return CHINESE_LANGUAGES.has(language.split(/[-_]/u)[0]?.toLowerCase() ?? "");
}

/** `名字：` in front of a line; a replacer function keeps `$` sequences in a name literal. */
export function speakerPrefix(name: string, chinese: boolean): string {
  const template = chinese ? exportFile.speakerPrefixCjk : exportFile.speakerPrefixOther;
  return template.replace("{{name}}", () => oneLineName(name));
}

/** A name on one physical line, since every labelled format is line-based. */
export function oneLineName(name: string): string {
  return name.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Decides which cues or paragraphs of a stream carry the name. Feed speakers in order:
 * `turn` labels the first one of each run of the same speaker, `every` labels all; an
 * unassigned one is never labelled and ends the run, so the same speaker resuming after it
 * is a new turn. `restart` forgets the run, for a boundary such as a chapter heading.
 */
export class SpeakerLabeler {
  private previous: string | undefined;
  private readonly mode: SpeakerLabelMode;

  constructor(mode: SpeakerLabelMode) {
    this.mode = mode;
  }

  /** Whether the item of `speakerId` is labelled. */
  next(speakerId: string | undefined): boolean {
    const first = speakerId !== this.previous;
    this.previous = speakerId;
    return speakerId !== undefined && (this.mode === "every" || first);
  }

  restart(): void {
    this.previous = undefined;
  }
}
