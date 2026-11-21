import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { importResponseSchema } from "../../../shared/dto/import.ts";
import type { AppError } from "../../../shared/errors.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useAsrProfiles, useSettings } from "../../api/queries.ts";
import { initialAsrModelRef } from "../asr-model-select.tsx";
import { appErrorOf } from "../confirm-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ContextWindowNotice } from "../../models/context-window-notice.tsx";
import { useFocusAfterSave } from "../../models/use-focus-after-save.ts";
import { useModelReadiness } from "../../models/use-model-readiness.ts";
import { ErrorView } from "../error-view.tsx";
import { linesOf, parseLinkText } from "../../links.ts";
import { LinkScopeHint } from "../link-scope-hint.tsx";
import { useLinkPasteField } from "../../shell/paste-guard.ts";

/**
 * Links (or a share text holding them) imported straight into the collection with the user's
 * default settings. Read like the new page's link box: with a supported link only the
 * supported links are sent, and the rest is named beside the action; without one, every line
 * goes as written and the server says what it cannot take.
 */
export function BatchAddDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; collectionId: string }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const asrProfiles = useAsrProfiles();
  const [text, setText] = useState("");
  const [error, setError] = useState<AppError | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Each link is processed up to its summary with the default model, which needs a context window.
  const defaultModel = settings.data?.defaultModelRef;
  const windowMissing = useModelReadiness(defaultModel, "context_window").status === "missing_context_window";
  const addId = useId();
  const windowSaved = useFocusAfterSave(windowMissing, () => document.getElementById(addId));
  const field = useLinkPasteField<HTMLTextAreaElement>({ value: text, onValue: setText, multiline: true });
  const parsed = useMemo(() => parseLinkText(text), [text]);
  const urls = parsed.links.length > 0 ? parsed.links.map((link) => link.url) : linesOf(text);
  const scopeShown = parsed.links.length > 0 && (parsed.unsupported.length > 0 || parsed.ignoredLines > 0 || parsed.otherText);
  const scopeId = `${addId}-scope`;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const data = settings.data;
    const outputLanguage = data?.defaultOutputLanguage ?? data?.language;
    // The defaults stand in for the new page's pickers; without a default ASR model none is sent.
    const asrModelRef = initialAsrModelRef(asrProfiles.data?.items ?? [], data?.defaultAsrModelRef);
    try {
      await client.post("/api/contents/import", importResponseSchema, {
        body: {
          items: urls.map((url) => ({ url })),
          settings: {
            autoProofread: true,
            ...(outputLanguage === undefined ? {} : { outputLanguage }),
            ...(data?.defaultModelRef === undefined ? {} : { modelRef: data.defaultModelRef }),
            ...(asrModelRef === undefined ? {} : { asrModelRef }),
            ...(data?.defaultSummaryTemplateId === undefined ? {} : { templateId: data.defaultSummaryTemplateId }),
          },
          collection: { id: props.collectionId },
        },
        idempotent: true,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.collection(props.collectionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      // The lecture counts in the sidebar and the collection list grow with the import.
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
      // Through the field, so the note of the last paste goes with the text.
      field.onChange("");
      props.onOpenChange(false);
    } catch (caught) {
      setError(appErrorOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("library.collection.batchAddTitle")} description={t("library.collection.batchAddHint")}>
      <textarea
        className="min-h-40 w-full rounded-md border border-line bg-surface p-2 font-mono text-sm"
        aria-label={t("library.collection.batchAddTitle")}
        ref={field.ref}
        value={text}
        onChange={(event) => field.onChange(event.target.value)}
        onPaste={field.onPaste}
      />
      {field.note === undefined ? null : (
        <p className="mt-1 text-xs text-muted" role="status" data-testid="batch-add-paste-note">
          {t("shell.newPage.pasteNote", { count: field.note })}
        </p>
      )}
      {error === undefined ? null : (
        <div className="mt-2">
          <ErrorView error={error} />
        </div>
      )}
      {windowMissing && defaultModel !== undefined ? <ContextWindowNotice modelRef={defaultModel} variant="minimal" onSaved={windowSaved} className="mt-2" testId="batch-add-context-window" /> : null}
      {scopeShown ? <LinkScopeHint parsed={parsed} id={scopeId} className="mt-2" /> : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={() => props.onOpenChange(false)}>{t("common.action.cancel")}</Button>
        <Button
          id={addId}
          variant="primary"
          aria-describedby={scopeShown ? scopeId : undefined}
          disabled={busy || urls.length === 0 || windowMissing}
          onClick={() => void submit()}
        >
          {t("library.collection.batchAddSubmit")}
        </Button>
      </div>
    </Modal>
  );
}
