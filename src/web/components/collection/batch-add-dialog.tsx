import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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

/** One link per line, imported straight into the collection with the user's default settings. */
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
  const urls = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
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
      setText("");
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
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error === undefined ? null : (
        <div className="mt-2">
          <ErrorView error={error} />
        </div>
      )}
      {windowMissing && defaultModel !== undefined ? <ContextWindowNotice modelRef={defaultModel} variant="minimal" onSaved={windowSaved} className="mt-2" testId="batch-add-context-window" /> : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={() => props.onOpenChange(false)}>{t("common.action.cancel")}</Button>
        <Button id={addId} variant="primary" disabled={busy || urls.length === 0 || windowMissing} onClick={() => void submit()}>
          {t("library.collection.batchAddSubmit")}
        </Button>
      </div>
    </Modal>
  );
}
