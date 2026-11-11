import { UserRound } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { speakerMonogram } from "../../../../shared/speakers.ts";
import type { SpeakerDto } from "../../../../shared/dto/speaker.ts";
import { speakerColorVars } from "./speaker-colors.ts";
import { speakerLabel } from "./speaker-data.ts";
import { useSpeakerAvatar } from "./use-speaker-avatar.ts";

/** What an avatar needs of a speaker. */
export type SpeakerAvatarSubject = Pick<SpeakerDto, "id" | "ordinal" | "colorIndex"> & Partial<Pick<SpeakerDto, "name" | "avatarVersion">>;

/** `"em"`: the reader's size, scaling with the text beside it; a number is a fixed diameter in px. */
export type SpeakerAvatarSize = number | "em";

/** `clamp(min px, em, max px)`: grows with the text beside it, within what stays legible and unobtrusive. */
const emSize = (minPx: number, em: number, maxPx: number): string => `clamp(${[`${minPx}px`, `${em}em`, `${maxPx}px`].join(", ")})`;
/** The reader's avatar diameter. */
export const AVATAR_EM_SIZE = emSize(28, 1.75, 48);
/** The muted avatar of follow-up rows, in the same scale as the reader's. */
const AVATAR_EM_SIZE_MUTED = emSize(20, 1.25, 34);
/** Share of the diameter the muted variant takes. */
const MUTED_SCALE = 0.72;
/** Strength of the hairline ring, in percent of the speaker's colour. */
const RING_PERCENT_PHOTO = 35;
const RING_PERCENT_LETTER = 24;
/** An inset hairline in `percent` of `color`, giving a pale fill an edge on any ground. */
export const ringShadow = (color: string, percent: number): string => `inset 0 0 0 1px color-mix(${["in srgb", `${color} ${percent}%`, "transparent"].join(", ")})`;
/** Letter height relative to the diameter. */
const GLYPH_RATIO = 0.42;

type Common = {
  size?: SpeakerAvatarSize;
  /** `muted`: smaller and quieter, for the rows after a turn's first. */
  variant?: "default" | "muted";
  /** When the name or label is written right beside the avatar, hide it from assistive technology instead of repeating it. */
  decorative?: boolean;
  className?: string;
  testId?: string;
};

export type SpeakerAvatarProps =
  | (Common & {
      contentId: string;
      speaker: SpeakerAvatarSubject;
      /** Shows this picture instead of the stored photo (an unsaved crop, a suggestion). */
      photoUrl?: string | undefined;
    })
  | (Common & { unassigned: true });

function diameter(size: SpeakerAvatarSize, muted: boolean): string {
  if (size === "em") return muted ? AVATAR_EM_SIZE_MUTED : AVATAR_EM_SIZE;
  return `${muted ? Math.round(size * MUTED_SCALE) : size}px`;
}

/**
 * A speaker's round avatar: the photo when there is one and it loads, else the letter (the
 * name's first character, or the ordinal of an unnamed speaker) on the speaker's colour.
 * Colour is a hint only; the accessible name is the speaker's label. The unassigned variant
 * is a neutral dashed circle.
 */
export function SpeakerAvatar(props: SpeakerAvatarProps) {
  const { t } = useTranslation();
  const muted = props.variant === "muted";
  const size = diameter(props.size ?? 32, muted);
  // The diameter lives in one custom property: the box and the letter both derive from it.
  const frame: CSSProperties = { width: "var(--speaker-size)", height: "var(--speaker-size)", "--speaker-size": size } as CSSProperties;
  const common = `relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full leading-none ${muted ? "opacity-70" : ""} ${props.className ?? ""}`;
  const a11y = (label: string) => (props.decorative === true ? ({ "aria-hidden": true } as const) : ({ role: "img", "aria-label": label } as const));

  if ("unassigned" in props) {
    return (
      <span className={`${common} border border-dashed border-muted/70 text-muted`} style={frame} data-testid={props.testId ?? "speaker-avatar"} data-kind="unassigned" {...a11y(t("speakerIdentity.unassigned"))}>
        <UserRound style={{ width: "55%", height: "55%" }} strokeWidth={1.6} aria-hidden="true" />
      </span>
    );
  }
  return <AssignedAvatar {...props} frame={frame} common={common} label={speakerLabel(t, props.speaker)} a11y={a11y} />;
}

function AssignedAvatar(
  props: Extract<SpeakerAvatarProps, { speaker: SpeakerAvatarSubject }> & {
    frame: CSSProperties;
    common: string;
    label: string;
    a11y: (label: string) => Record<string, unknown>;
  },
) {
  const { speaker } = props;
  const stored = useSpeakerAvatar(props.contentId, { id: speaker.id, avatarVersion: props.photoUrl === undefined ? speaker.avatarVersion : undefined });
  const photo = props.photoUrl ?? stored;
  // A picture the browser cannot decode falls back to the letter; a different picture gets its own chance.
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const showPhoto = photo !== undefined && failed !== photo;
  const colors = speakerColorVars(speaker.colorIndex);
  const glyph = speaker.name === undefined ? String(speaker.ordinal) : speakerMonogram(speaker.name);
  return (
    <span
      className={props.common}
      style={{ ...props.frame, backgroundColor: colors.bg, color: colors.fg }}
      data-testid={props.testId ?? "speaker-avatar"}
      data-kind={showPhoto ? "photo" : "monogram"}
      data-color-index={speaker.colorIndex}
      {...props.a11y(props.label)}
    >
      {showPhoto ? (
        <img src={photo} alt="" draggable={false} className="size-full object-cover" onError={() => setFailed(photo)} />
      ) : (
        <span aria-hidden="true" className="font-semibold" style={{ fontSize: `calc(var(--speaker-size) * ${GLYPH_RATIO})` }}>
          {glyph}
        </span>
      )}
      {/* A hairline in the speaker's colour keeps the edge crisp on any ground, photo or letter. */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full" style={{ boxShadow: ringShadow(colors.fg, showPhoto ? RING_PERCENT_PHOTO : RING_PERCENT_LETTER) }} />
    </span>
  );
}
