import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ModelRefDto } from "../../shared/dto/model-ref.ts";
import { useProviders, useSetContextWindow } from "../api/queries.ts";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import { Button, FOCUS_RING } from "../ui/button.tsx";
import { Callout, FieldError, InlineNote, TEXT_ACTION_CLASS, TextAction } from "../ui/notice.tsx";
import { SuggestionInput } from "../ui/suggestion-input.tsx";
import { CONTEXT_WINDOW_SUGGESTION_LABELS, CONTEXT_WINDOW_SUGGESTIONS, parseTokenCount } from "./context-window.ts";
import { findModel } from "./use-model-readiness.ts";

/**
 * The full notices on screen, by model: a deferring notice for the same model (the chat beside
 * a summary tab) only points to one of them, so a page never asks the same thing twice.
 */
const shown = new Map<string, Set<() => void>>();
const listeners = new Set<() => void>();
let shownVersion = 0;

function modelKey(ref: ModelRefDto): string {
  return JSON.stringify([ref.providerProfileId, ref.modelId]);
}

function changed(): void {
  shownVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Focuses the field of a full notice for `ref` on screen, if there is one. */
function fullNoticeFor(ref: ModelRefDto): (() => void) | undefined {
  return shown.get(modelKey(ref))?.values().next().value;
}

/**
 * Where a feature needs the chosen model's context window and it has none: one sentence, a
 * number field and 「保存」, written through the model's capability override. Saving re-reads
 * the provider list, so every entry waiting on that model becomes usable on its own and drops
 * its notice. Never a `<form>`: it sits inside other forms, and Enter in its field saves only here.
 */
export function ContextWindowNotice(props: {
  modelRef: ModelRefDto;
  /** `compact` for tight rows (a stage's actions, the chat box); `regular` in page forms. */
  density?: "regular" | "compact";
  /**
   * `full` offers the common sizes as buttons and a way to the model settings; `minimal` (a
   * stage's re-run row, a dialog) keeps to the field and 「保存」, the sizes as input suggestions.
   */
  variant?: "full" | "minimal";
  /** Only points to a full notice for the same model when one is on screen. */
  defer?: boolean;
  /** Runs after a save from this notice, even once the notice itself has gone. */
  onSaved?: () => void;
  className?: string;
  testId?: string;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const providers = useProviders();
  const save = useSetContextWindow();
  const [text, setText] = useState("");
  // Counts the refused attempts since the last edit (0: none), so every refusal moves focus anew.
  const [invalid, setInvalid] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const found = findModel(providers.data?.items ?? [], props.modelRef);
  const testId = props.testId ?? "context-window-notice";
  const compact = props.density === "compact";
  const minimal = props.variant === "minimal";
  const defer = props.defer === true;
  const key = modelKey(props.modelRef);
  const modelLabel = found === undefined ? props.modelRef.modelId : `${found.profile.name} · ${found.model.modelId}`;
  const failure = save.error === null ? undefined : appErrorOf(save.error);
  const fillable = found !== undefined;

  useEffect(() => {
    if (defer || !fillable) return undefined;
    const focus = (): void => {
      inputRef.current?.scrollIntoView?.({ block: "nearest" });
      inputRef.current?.focus();
    };
    const entries = shown.get(key) ?? new Set();
    entries.add(focus);
    shown.set(key, entries);
    changed();
    return () => {
      entries.delete(focus);
      if (entries.size === 0) shown.delete(key);
      changed();
    };
  }, [defer, fillable, key]);
  useSyncExternalStore(subscribe, () => shownVersion);
  // A refused value or save is reported under the field, which is not a live region, while focus
  // may still be on 「保存」: moving focus back to the field (by then marked invalid and described
  // by the error) is what makes a screen reader say why nothing was saved.
  useEffect(() => {
    if (save.error !== null || invalid !== 0) inputRef.current?.focus();
  }, [save.error, invalid]);
  const elsewhere = defer ? fullNoticeFor(props.modelRef) : undefined;

  const submit = (): void => {
    if (found === undefined || save.isPending) return;
    const tokens = parseTokenCount(text);
    if (tokens === undefined) {
      setInvalid((count) => count + 1);
      return;
    }
    setInvalid(0);
    const onSaved = props.onSaved;
    // Awaited rather than a per-call callback: those do not run once this notice has unmounted,
    // which a successful save usually causes before it answers.
    save
      .mutateAsync({
        profileId: found.profile.id,
        model: found.model,
        contextWindowTokens: tokens,
      })
      .then(
        () => onSaved?.(),
        () => undefined,
      );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    // The surrounding form, if any, must not submit: the entry is still unusable here.
    event.preventDefault();
    submit();
  };
  const problem = invalid !== 0 ? t("modelReadiness.invalid") : failure === undefined ? undefined : failure.userMessage !== "" ? failure.userMessage : t(`errors.${failure.class}`);
  if (elsewhere !== undefined) {
    // Only a pointer to the notice beside it: the quietest form, a sentence and a text action.
    return (
      <InlineNote
        testId={testId}
        data-variant="pointer"
        {...(props.className === undefined ? {} : { className: props.className })}
        icon={<Info size={14} className="text-warn" aria-hidden="true" />}
        action={
          <TextAction className="font-medium" onClick={elsewhere} data-testid={`${testId}-goto`}>
            {t("modelReadiness.gotoFill")}
          </TextAction>
        }
      >
        {t("modelReadiness.elsewhere", { model: modelLabel })}
      </InlineNote>
    );
  }

  // Must be dealt with before the feature can run, so a boxed caution rather than a quiet note.
  return (
    <Callout
      tone="warn"
      density={compact ? "compact" : "regular"}
      role="group"
      aria-labelledby={`${id}-text`}
      testId={testId}
      data-variant={minimal ? "minimal" : "full"}
      {...(props.className === undefined ? {} : { className: props.className })}
    >
      <div className="flex flex-col gap-2">
        <p id={`${id}-text`} className="max-w-[70ch]">
          {t("modelReadiness.notice", { model: modelLabel })}
        </p>
        {found === undefined ? null : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <label htmlFor={`${id}-input`} className="sr-only">
              {t("modelReadiness.inputLabel")}
            </label>
            <span
              className={`inline-flex h-7 items-center rounded-md border bg-surface transition duration-150 focus-within:ring-1 motion-reduce:transition-none ${
                problem === undefined ? "border-line focus-within:border-accent focus-within:ring-accent/40" : "border-danger focus-within:ring-danger/40"
              }`}
            >
              <SuggestionInput
                ref={inputRef}
                id={`${id}-input`}
                suggestions={minimal ? CONTEXT_WINDOW_SUGGESTION_LABELS : []}
                listLabel={t("modelReadiness.suggestions")}
                toggle={false}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={text}
                placeholder={t("modelReadiness.placeholder")}
                aria-invalid={problem === undefined ? undefined : true}
                aria-describedby={problem === undefined ? undefined : `${id}-problem`}
                data-testid={`${testId}-input`}
                wrapperClassName="h-full"
                className="h-full w-28 min-w-0 bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted"
                onValueChange={(value) => {
                  setText(value);
                  setInvalid(0);
                  if (save.isError) save.reset();
                }}
                onKeyDown={onKeyDown}
              />
              <span className="pr-2 text-xs text-muted" aria-hidden="true">
                {t("modelReadiness.unit")}
              </span>
            </span>
            <Button size="sm" variant="primary" disabled={save.isPending || text.trim() === ""} onClick={submit} data-testid={`${testId}-save`}>
              {save.isPending ? t("modelReadiness.saving") : t("modelReadiness.save")}
            </Button>
            {minimal ? null : (
              <span role="group" aria-label={t("modelReadiness.suggestions")} className="flex flex-wrap items-center gap-0.5">
                {CONTEXT_WINDOW_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    aria-label={t("modelReadiness.suggestionFill", {
                      label: suggestion.label,
                      value: suggestion.tokens.toLocaleString(i18n.language),
                    })}
                    className={`h-6 rounded px-1.5 text-xs text-muted transition hover:bg-surface hover:text-ink focus-visible:bg-surface focus-visible:text-ink ${FOCUS_RING}`}
                    onClick={() => {
                      setText(suggestion.label);
                      setInvalid(0);
                      if (save.isError) save.reset();
                    }}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </span>
            )}
            {minimal ? null : (
              <Link to="/settings/models" className={`ml-auto text-note ${TEXT_ACTION_CLASS}`} data-testid={`${testId}-settings`}>
                {t("modelReadiness.settings")}
              </Link>
            )}
          </div>
        )}
        {found === undefined ? (
          <Link to="/settings/models" className={`self-start text-note ${TEXT_ACTION_CLASS}`} data-testid={`${testId}-settings`}>
            {t("modelReadiness.settings")}
          </Link>
        ) : null}
        {problem === undefined ? null : (
          <FieldError id={`${id}-problem`} testId={`${testId}-error`}>
            {problem}
          </FieldError>
        )}
      </div>
    </Callout>
  );
}
