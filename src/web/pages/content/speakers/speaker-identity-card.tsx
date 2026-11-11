import { Pencil } from "lucide-react";
import type { TFunction } from "i18next";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerDto } from "../../../../shared/dto/speaker.ts";
import { Button } from "../../../ui/button.tsx";
import { SpeakerAvatar } from "./speaker-avatar.tsx";
import { speakerColorVars } from "./speaker-colors.ts";
import { speakerLabel } from "./speaker-data.ts";
import { SPEAKER_POPOVER_CLASS, SpeakerEditForm } from "./speaker-edit-popover.tsx";

/** The share line of the card: sentence count and the share of the Content's speaking time. */
export function shareLine(t: TFunction, sentences: number | undefined, durationShare: number | undefined): string {
  const parts: string[] = [];
  if (sentences !== undefined) parts.push(t("speakerIdentity.card.shareSentences", { count: sentences }));
  if (durationShare !== undefined) {
    const percent = Math.round(durationShare * 100);
    parts.push(durationShare > 0 && percent < 1 ? t("speakerIdentity.card.shareDurationLow") : t("speakerIdentity.card.shareDuration", { percent }));
  }
  return parts.join(" · ");
}

/**
 * Wraps whatever shows a speaker (an avatar, a name, both) in a button that opens a light
 * identity card: large avatar, name, how much they speak, and 「编辑」, which turns the same
 * popover into the edit form. Enter or Space on the trigger opens it; Esc closes it and
 * focus returns to the trigger.
 */
export function SpeakerIdentityCard(props: {
  contentId: string;
  speaker: SpeakerDto;
  /** Number of sentences the speaker has in the text being read. */
  sentences?: number;
  /** Share of the speaking time, 0 to 1. */
  durationShare?: number;
  children: ReactNode;
  triggerClassName?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const { speaker } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const footer = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  // Leaving the form removes the focused control; the card's own button takes focus back.
  useEffect(() => {
    if (wasEditing.current && !editing) footer.current?.querySelector("button")?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);
  const label = speakerLabel(t, speaker);
  const colors = speakerColorVars(speaker.colorIndex);
  const share = shareLine(t, props.sentences, props.durationShare);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing always returns to the card, so the next opening starts there.
        if (!next) setEditing(false);
      }}
      modal={false}
    >
      <Popover.Trigger asChild>
        <button type="button" className={props.triggerClassName} data-testid={props.testId ?? "speaker-trigger"} data-speaker-id={speaker.id}>
          {props.children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={SPEAKER_POPOVER_CLASS}
          aria-label={t(editing ? "speakerIdentity.edit.label" : "speakerIdentity.card.label", { name: label })}
          data-testid="speaker-popover"
        >
          {editing ? (
            <SpeakerEditForm
              contentId={props.contentId}
              speaker={speaker}
              onDone={() => setEditing(false)}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="w-64 max-w-full" data-testid="speaker-card">
              <div className="flex items-center gap-3 rounded-t-lg px-4 py-4" style={{ backgroundColor: colors.bg }}>
                <SpeakerAvatar contentId={props.contentId} speaker={speaker} size={56} decorative />
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold" style={{ color: colors.fg }} title={label} data-testid="speaker-card-name">
                    {label}
                  </p>
                  {share === "" ? null : (
                    <p className="mt-0.5 text-xs text-ink/75" data-testid="speaker-card-share">
                      {share}
                    </p>
                  )}
                </div>
              </div>
              <div ref={footer} className="flex justify-end px-3 py-2.5">
                <Button size="sm" onClick={() => setEditing(true)} data-testid="speaker-card-edit">
                  <Pencil size={13} aria-hidden="true" />
                  {t("speakerIdentity.card.edit")}
                </Button>
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
