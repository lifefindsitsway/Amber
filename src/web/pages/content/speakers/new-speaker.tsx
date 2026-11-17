import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SPEAKER_NAME_MAX_GRAPHEMES } from "../../../../shared/defaults.ts";
import type { SpeakerDto } from "../../../../shared/dto/speaker.ts";
import { normalizeSpeakerName } from "../../../../shared/speakers.ts";
import { appErrorOf } from "../../../components/confirm-dialog.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Button } from "../../../ui/button.tsx";
import { Spinner } from "../../../ui/feedback.tsx";
import { speakerCreateRequest, useCreateSpeaker, usePatchSpeaker } from "./speaker-data.ts";
import { SPEAKER_POPOVER_CLASS } from "./speaker-edit-popover.tsx";

/** The text field of the speaker forms: the same look as the edit form's name field. */
const NAME_INPUT_CLASS = "h-8 w-full min-w-0 rounded-md border bg-surface px-2.5 text-sm outline-none placeholder:text-muted/70 focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Enter that finishes what was typed, not the Enter that commits an input method's
 * composition (229 is what browsers report for a key the composition consumed).
 */
export const isCommitEnter = (event: KeyboardEvent<HTMLElement>): boolean => event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229;

/**
 * The inline form of the speaker panel's 「＋ 新增」. Only Enter or 「添加」 creates; leaving the
 * field does nothing, and Esc is the panel's (it closes this form). A blank name creates an
 * unnamed speaker; a typed one is saved as confirmed. While the request runs the form takes no
 * second submission; a failure is shown under the field, which keeps what was typed.
 */
export function NewSpeakerForm(props: { contentId: string; nextOrdinal: number; onCreated: (speaker: SpeakerDto) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const create = useCreateSpeaker(props.contentId);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const tooLong = normalizeSpeakerName(draft) === "too_long";

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  const submit = (): void => {
    if (create.isPending || tooLong) return;
    create.mutate(speakerCreateRequest(draft), { onSuccess: props.onCreated });
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2.5" role="group" aria-labelledby={inputId} data-testid="speaker-panel-add-form">
      <label id={inputId} htmlFor={`${inputId}-input`} className="sr-only">
        {t("speakerEditor.panel.nameLabel")}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          ref={input}
          id={`${inputId}-input`}
          type="text"
          value={draft}
          // Read-only rather than disabled while sending: a disabled field would drop the focus.
          readOnly={create.isPending}
          placeholder={t("speakerEditor.panel.namePlaceholder")}
          aria-invalid={tooLong}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          className={`${NAME_INPUT_CLASS} flex-1 ${tooLong ? "border-danger" : "border-line"}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isCommitEnter(event)) {
              event.preventDefault();
              submit();
            }
          }}
          data-testid="speaker-panel-add-input"
        />
        <Button size="sm" variant="primary" disabled={create.isPending || tooLong} onClick={submit} data-testid="speaker-panel-add-confirm">
          {create.isPending ? <Spinner size={12} /> : null}
          {create.isPending ? t("speakerEditor.panel.creating") : t("speakerEditor.panel.create")}
        </Button>
        <Button size="sm" variant="ghost" disabled={create.isPending} onClick={props.onCancel} data-testid="speaker-panel-add-cancel">
          {t("speakerEditor.panel.cancel")}
        </Button>
      </div>
      <p id={hintId} className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`} role={tooLong ? "alert" : undefined}>
        {tooLong ? t("speakerIdentity.edit.nameTooLong", { max: SPEAKER_NAME_MAX_GRAPHEMES }) : t("speakerEditor.panel.nameHint", { ordinal: props.nextOrdinal })}
      </p>
      {create.error === null ? null : (
        <div data-testid="speaker-panel-add-error">
          <ErrorView error={appErrorOf(create.error)} />
        </div>
      )}
    </div>
  );
}

/** A speaker just created from a sentence's menu, waiting to be named beside that sentence. */
export interface NamingRequest {
  speakerId: string;
  ordinal: number;
  /** The draft key of the sentence whose speaker column the popover points at. */
  anchorKey: string;
  /** Tells one request from the next, so a new one starts with an empty form. */
  nonce: number;
}

/** The single naming popover's state: at most one request at a time, the latest one wins. */
export class NamingStore {
  private request: NamingRequest | undefined;
  private nonce = 0;
  private readonly listeners = new Set<() => void>();

  current = (): NamingRequest | undefined => this.request;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(request: Omit<NamingRequest, "nonce">): void {
    this.nonce += 1;
    this.request = { ...request, nonce: this.nonce };
    this.emit();
  }

  close(): void {
    if (this.request === undefined) return;
    this.request = undefined;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The one naming popover of the editor: opened after 「新建发言人」 created and assigned a
 * speaker and the focus is back on that sentence's speaker column, pointing at it. Enter
 * saves the name (as confirmed), Esc or 「跳过」 leaves the speaker unnamed; either way the
 * focus goes back to the column, unless the user clicked somewhere else to leave.
 */
export function NewSpeakerNaming(props: { contentId: string; store: NamingStore; anchorOf: (key: string) => HTMLElement | null }) {
  const request = useSyncExternalStore(props.store.subscribe, props.store.current);
  if (request === undefined) return null;
  return <NamingPopover key={request.nonce} contentId={props.contentId} store={props.store} request={request} anchorOf={props.anchorOf} />;
}

function NamingPopover(props: { contentId: string; store: NamingStore; request: NamingRequest; anchorOf: (key: string) => HTMLElement | null }) {
  const { t } = useTranslation();
  const { request, store, anchorOf } = props;
  const patch = usePatchSpeaker(props.contentId);
  const [draft, setDraft] = useState("");
  const leftByPointer = useRef(false);
  const inputId = useId();
  const hintId = useId();
  const tooLong = normalizeSpeakerName(draft) === "too_long";
  // The column is found again on every measurement: the row may have re-rendered meanwhile. Its
  // last position stands in should it scroll out of the DOM's reach.
  const anchor = useMemo(() => {
    let last: DOMRect | undefined;
    return {
      current: {
        getBoundingClientRect: (): DOMRect => {
          const element = anchorOf(request.anchorKey);
          if (element !== null) last = element.getBoundingClientRect();
          return last ?? new DOMRect();
        },
      },
    };
  }, [anchorOf, request.anchorKey]);

  const close = (): void => store.close();
  const save = (): void => {
    if (patch.isPending) return;
    const name = normalizeSpeakerName(draft);
    if (name === "too_long") return;
    if (name === undefined) {
      close();
      return;
    }
    patch.mutate({ speakerId: request.speakerId, patch: { name, nameConfirmed: true } }, { onSuccess: close });
  };

  return (
    <Popover.Root open onOpenChange={(open) => (open ? undefined : close())} modal={false}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className={`${SPEAKER_POPOVER_CLASS} flex w-72 max-w-[calc(100vw-16px)] flex-col gap-2 p-3`}
          aria-labelledby={inputId}
          onEscapeKeyDown={(event) => {
            // Esc that cancels an input method's composition is the input method's.
            if (event.isComposing) event.preventDefault();
          }}
          onInteractOutside={() => {
            leftByPointer.current = true;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!leftByPointer.current) anchorOf(request.anchorKey)?.focus({ preventScroll: true });
          }}
          data-testid="speaker-naming"
        >
          <label id={inputId} htmlFor={`${inputId}-input`} className="text-xs font-medium text-muted">
            {t("speakerEditor.naming.label")}
          </label>
          <input
            id={`${inputId}-input`}
            type="text"
            value={draft}
            readOnly={patch.isPending}
            placeholder={t("speakerEditor.naming.placeholder", { ordinal: request.ordinal })}
            aria-invalid={tooLong}
            aria-describedby={hintId}
            autoComplete="off"
            spellCheck={false}
            className={`${NAME_INPUT_CLASS} ${tooLong ? "border-danger" : "border-line"}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (isCommitEnter(event)) {
                event.preventDefault();
                save();
              }
            }}
            data-testid="speaker-naming-input"
          />
          <p id={hintId} className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`} role={tooLong ? "alert" : undefined}>
            {tooLong ? t("speakerIdentity.edit.nameTooLong", { max: SPEAKER_NAME_MAX_GRAPHEMES }) : t("speakerEditor.naming.hint", { ordinal: request.ordinal })}
          </p>
          {patch.error === null ? null : <ErrorView error={appErrorOf(patch.error)} />}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={close} data-testid="speaker-naming-skip">
              {t("speakerEditor.naming.skip")}
            </Button>
            <Button size="sm" variant="primary" disabled={patch.isPending || tooLong} onClick={save} data-testid="speaker-naming-save">
              {patch.isPending ? <Spinner size={12} /> : null}
              {t("speakerEditor.naming.save")}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
