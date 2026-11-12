import { Check, ImagePlus } from "lucide-react";
import { Popover, RadioGroup } from "radix-ui";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SPEAKER_NAME_MAX_GRAPHEMES, SPEAKER_PALETTE_SIZE } from "../../../../shared/defaults.ts";
import type { SpeakerDto, SpeakerPatchRequest } from "../../../../shared/dto/speaker.ts";
import { normalizeSpeakerName } from "../../../../shared/speakers.ts";
import { appErrorOf } from "../../../components/confirm-dialog.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Button } from "../../../ui/button.tsx";
import { Spinner } from "../../../ui/feedback.tsx";
import { loadPhoto, PHOTO_SOURCE_MAX_BYTES, PhotoError, type EncodedAvatar, type LoadedPhoto } from "./photo-crop.ts";
import { PhotoCropper } from "./photo-cropper.tsx";
import { SpeakerAvatar } from "./speaker-avatar.tsx";
import { speakerColorVars } from "./speaker-colors.ts";
import { speakerLabel, speakerNameLength, usePatchSpeaker, useSpeakerSuggestions } from "./speaker-data.ts";

/** Panel styling shared by the identity card and the edit popover. */
export const SPEAKER_POPOVER_CLASS =
  "z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-lg border border-line bg-surface text-sm text-ink shadow-xl outline-none";

/** File types offered by the photo chooser; SVG is left out on purpose. */
const PHOTO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp";
/** Pause after typing before the name is used to look up suggestions. */
const SUGGESTION_DEBOUNCE_MS = 220;
const BYTES_PER_MB = 1024 * 1024;

/** The selected swatch: a surface-coloured gap, then a ring in the swatch's own colour. */
const selectedRing = (color: string): string => ["0 0 0 2px var(--color-surface)", `0 0 0 4px ${color}`].join(", ");

type PhotoChoice = { kind: "keep" } | { kind: "remove" } | { kind: "new"; avatar: EncodedAvatar };

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * The fields of one speaker: name (with the limit shown as it is approached), colour,
 * photo (cropped here, on this machine) and the shortcut of reusing a speaker from the
 * user's other Contents. Nothing is sent until 「保存」; choosing a suggestion applies at once.
 */
export function SpeakerEditForm(props: { contentId: string; speaker: SpeakerDto; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { speaker } = props;
  const patch = usePatchSpeaker(props.contentId);
  const nameInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const counterId = useId();
  const [draft, setDraft] = useState(speaker.name ?? "");
  const [colorIndex, setColorIndex] = useState(speaker.colorIndex);
  const [photo, setPhoto] = useState<PhotoChoice>({ kind: "keep" });
  const [cropping, setCropping] = useState<LoadedPhoto | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [photoProblem, setPhotoProblem] = useState<PhotoError["reason"] | undefined>(undefined);

  useEffect(() => {
    nameInput.current?.focus({ preventScroll: true });
    nameInput.current?.select();
  }, []);

  // A decoded photo that is still open when the form goes away is freed with it.
  const open = useRef<LoadedPhoto | undefined>(undefined);
  open.current = cropping;
  useEffect(() => () => open.current?.release(), []);

  const normalized = normalizeSpeakerName(draft);
  const tooLong = normalized === "too_long";
  const name = normalized === "too_long" ? undefined : normalized;
  const count = speakerNameLength(draft);
  const nameChanged = !tooLong && name !== speaker.name;
  // A name kept as it is but never confirmed (written before confirmation existed, or by another
  // caller) is confirmed by saving it here, so saving is offered for it too.
  const confirmsName = !tooLong && name !== undefined && (nameChanged || speaker.nameConfirmed !== true);
  const hasStoredPhoto = speaker.avatarVersion !== undefined;
  const showsPhoto = photo.kind === "new" || (photo.kind === "keep" && hasStoredPhoto);
  const changed = nameChanged || confirmsName || colorIndex !== speaker.colorIndex || photo.kind !== "keep";

  const suggestionQuery = useDebounced(tooLong ? "" : (name ?? ""), SUGGESTION_DEBOUNCE_MS);
  const suggestions = useSpeakerSuggestions(suggestionQuery, props.contentId);
  const options = (suggestions.data?.items ?? []).filter((item) => !(item.contentId === props.contentId && item.speakerId === speaker.id));

  const choose = async (file: File | undefined): Promise<void> => {
    if (fileInput.current !== null) fileInput.current.value = "";
    if (file === undefined) return;
    setPhotoProblem(undefined);
    setReading(true);
    try {
      setCropping(await loadPhoto(file));
    } catch (error) {
      setPhotoProblem(error instanceof PhotoError ? error.reason : "unreadable");
    } finally {
      setReading(false);
    }
  };
  const closeCropper = (): void => {
    cropping?.release();
    setCropping(undefined);
  };

  const save = (): void => {
    if (!changed || tooLong || patch.isPending) return;
    // A name saved here is the user's own word for who this is, so it is saved as confirmed:
    // that is what lets AI requests use it (the hint under the field says so).
    const request: Exclude<SpeakerPatchRequest, { copyFrom: unknown }> = {
      ...(nameChanged || confirmsName ? { name: name ?? null, ...(name === undefined ? {} : { nameConfirmed: true }) } : {}),
      ...(colorIndex === speaker.colorIndex ? {} : { colorIndex }),
      ...(photo.kind === "remove" ? { avatar: null } : photo.kind === "new" ? { avatar: { data: photo.avatar.data, mime: photo.avatar.mime } } : {}),
    };
    patch.mutate({ speakerId: speaker.id, patch: request }, { onSuccess: props.onDone });
  };

  const previewSubject = { id: speaker.id, ordinal: speaker.ordinal, colorIndex, ...(name === undefined ? {} : { name }), ...(photo.kind === "keep" && hasStoredPhoto ? { avatarVersion: speaker.avatarVersion } : {}) };
  const label = speakerLabel(t, speaker);

  return (
    <form
      className="flex w-[21rem] max-w-full flex-col gap-4 p-4"
      aria-label={t("speakerIdentity.edit.label", { name: label })}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      data-testid="speaker-edit-form"
    >
      <div className="flex items-start gap-3">
        <SpeakerAvatar contentId={props.contentId} speaker={previewSubject} photoUrl={photo.kind === "new" ? photo.avatar.previewUrl : undefined} size={56} decorative testId="speaker-edit-preview" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={nameId} className="text-xs font-medium text-muted">
            {t("speakerIdentity.edit.name")}
          </label>
          <input
            ref={nameInput}
            id={nameId}
            type="text"
            value={draft}
            disabled={patch.isPending}
            placeholder={t("speakerIdentity.edit.namePlaceholder", { ordinal: speaker.ordinal })}
            aria-invalid={tooLong}
            aria-describedby={counterId}
            autoComplete="off"
            spellCheck={false}
            className={`h-9 w-full rounded-md border bg-surface px-2.5 text-sm outline-none placeholder:text-muted/70 focus-visible:ring-2 focus-visible:ring-accent ${tooLong ? "border-danger" : "border-line"}`}
            onChange={(event) => setDraft(event.target.value)}
            data-testid="speaker-name-input"
          />
          <p id={counterId} className={`flex justify-between gap-2 text-xs tabular-nums ${tooLong ? "text-danger" : "text-muted"}`}>
            <span role={tooLong ? "alert" : undefined}>{tooLong ? t("speakerIdentity.edit.nameTooLong", { max: SPEAKER_NAME_MAX_GRAPHEMES }) : ""}</span>
            <span data-testid="speaker-name-counter">{t("speakerIdentity.edit.nameCounter", { count, max: SPEAKER_NAME_MAX_GRAPHEMES })}</span>
          </p>
          <p className="text-xs text-muted" data-testid="speaker-name-confirm-hint">
            {t("speakerIdentity.edit.nameConfirmHint")}
          </p>
        </div>
      </div>

      {options.length === 0 ? null : (
        <section className="flex flex-col gap-1.5" aria-label={t("speakerIdentity.edit.suggestions")} data-testid="speaker-suggestions">
          <h3 className="text-xs font-medium text-muted">{t("speakerIdentity.edit.suggestions")}</h3>
          <ul className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-line">
            {options.map((item) => (
              <li key={`${item.contentId}:${item.speakerId}`} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  disabled={patch.isPending}
                  className="flex w-full min-w-0 items-center gap-2.5 px-2.5 py-1.5 text-left text-sm outline-none hover:bg-sunken focus-visible:bg-sunken focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-50"
                  onClick={() =>
                    patch.mutate(
                      { speakerId: speaker.id, patch: { copyFrom: { contentId: item.contentId, speakerId: item.speakerId }, nameConfirmed: true } },
                      { onSuccess: props.onDone },
                    )
                  }
                  data-testid="speaker-suggestion"
                >
                  <SpeakerAvatar contentId={item.contentId} speaker={{ id: item.speakerId, ordinal: 1, name: item.name, colorIndex: item.colorIndex, ...(item.avatarVersion === undefined ? {} : { avatarVersion: item.avatarVersion }) }} size={24} decorative />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.name}</span>
                    {item.contentTitle === undefined ? null : <span className="block truncate text-xs text-muted">{item.contentTitle}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t("speakerIdentity.edit.suggestionsHint")}</p>
        </section>
      )}

      <fieldset className="flex flex-col gap-2" disabled={patch.isPending}>
        <legend className="mb-1 text-xs font-medium text-muted">{t("speakerIdentity.edit.color")}</legend>
        <RadioGroup.Root
          value={String(colorIndex)}
          onValueChange={(value) => setColorIndex(Number(value))}
          aria-label={t("speakerIdentity.edit.color")}
          orientation="horizontal"
          className="flex flex-wrap gap-2.5"
          data-testid="speaker-colors"
        >
          {Array.from({ length: SPEAKER_PALETTE_SIZE }, (_, index) => {
            const colors = speakerColorVars(index);
            const selected = index === colorIndex;
            return (
              <RadioGroup.Item
                key={index}
                value={String(index)}
                aria-label={t("speakerIdentity.edit.colorOption", { name: t(`speakerIdentity.color.${index}`, { defaultValue: t("speakerIdentity.color.fallback", { ordinal: index + 1 }) }) })}
                className="relative inline-flex size-6 items-center justify-center rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
                style={{ backgroundColor: colors.fg, boxShadow: selected ? selectedRing(colors.fg) : "none" }}
                data-testid={`speaker-color-${index}`}
              >
                <RadioGroup.Indicator className="flex">
                  <Check size={13} strokeWidth={3} aria-hidden="true" style={{ color: "var(--color-surface)" }} />
                </RadioGroup.Indicator>
              </RadioGroup.Item>
            );
          })}
        </RadioGroup.Root>
      </fieldset>

      <section className="flex flex-col gap-2" aria-label={t("speakerIdentity.edit.photo")}>
        <h3 className="text-xs font-medium text-muted">{t("speakerIdentity.edit.photo")}</h3>
        {cropping === undefined ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={PHOTO_ACCEPT}
                hidden
                tabIndex={-1}
                onChange={(event) => void choose(event.target.files?.[0])}
                data-testid="speaker-photo-input"
              />
              <Button size="sm" disabled={patch.isPending || reading} onClick={() => fileInput.current?.click()} data-testid="speaker-photo-choose">
                {reading ? <Spinner size={12} /> : <ImagePlus size={14} aria-hidden="true" />}
                {showsPhoto ? t("speakerIdentity.edit.photoChange") : t("speakerIdentity.edit.photoChoose")}
              </Button>
              {showsPhoto ? (
                <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => setPhoto(hasStoredPhoto ? { kind: "remove" } : { kind: "keep" })} data-testid="speaker-photo-remove">
                  {t("speakerIdentity.edit.photoRemove")}
                </Button>
              ) : null}
            </div>
            {photo.kind === "new" ? <p className="text-xs text-muted">{t("speakerIdentity.edit.photoPending")}</p> : <p className="text-xs text-muted">{t("speakerIdentity.edit.photoHint")}</p>}
            {photoProblem === undefined ? null : (
              <p className="text-xs text-danger" role="alert">
                {photoProblem === "too_large" ? t("speakerIdentity.edit.photoTooLarge", { mb: PHOTO_SOURCE_MAX_BYTES / BYTES_PER_MB }) : t("speakerIdentity.edit.photoUnreadable")}
              </p>
            )}
          </>
        ) : (
          <PhotoCropper
            photo={cropping}
            onCancel={closeCropper}
            onConfirm={(avatar) => {
              setPhoto({ kind: "new", avatar });
              closeCropper();
            }}
          />
        )}
      </section>

      {patch.error === null ? null : <ErrorView error={appErrorOf(patch.error)} />}

      {/* Kept in view at the bottom of the panel: on a short window the panel scrolls, and the
          actions would otherwise sit below its fold. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 border-t border-line bg-surface px-4 py-3" data-testid="speaker-edit-actions">
        <Button onClick={props.onCancel} disabled={patch.isPending} data-testid="speaker-edit-cancel">
          {t("speakerIdentity.edit.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!changed || tooLong || patch.isPending || cropping !== undefined} data-testid="speaker-edit-save">
          {patch.isPending ? <Spinner size={14} /> : null}
          {patch.isPending ? t("speakerIdentity.edit.saving") : t("speakerIdentity.edit.save")}
        </Button>
      </div>
    </form>
  );
}

/**
 * A trigger that opens the edit form in a popover, for places that edit a speaker without
 * going through the identity card (the editor's speaker panel). Esc closes it and focus goes
 * back to the trigger.
 */
export function SpeakerEditPopover(props: { contentId: string; speaker: SpeakerDto; children: ReactNode; triggerClassName?: string; triggerLabel?: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <button type="button" className={props.triggerClassName} {...(props.triggerLabel === undefined ? {} : { "aria-label": props.triggerLabel })} data-testid={props.testId}>
          {props.children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={8} className={SPEAKER_POPOVER_CLASS} data-testid="speaker-edit-popover">
          <SpeakerEditForm contentId={props.contentId} speaker={props.speaker} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
