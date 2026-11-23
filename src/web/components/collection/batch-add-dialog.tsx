import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { importResponseSchema, type ImportRequest } from "../../../shared/dto/import.ts";
import type { AppError } from "../../../shared/errors.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useAsrProfiles, useSettings } from "../../api/queries.ts";
import { initialAsrModelRef } from "../asr-model-select.tsx";
import { appErrorOf } from "../confirm-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { TextArea } from "../../ui/text-field.tsx";
import { ContextWindowNotice } from "../../models/context-window-notice.tsx";
import { useFocusAfterSave } from "../../models/use-focus-after-save.ts";
import { useModelReadiness } from "../../models/use-model-readiness.ts";
import { ErrorView } from "../error-view.tsx";
import { linesOf, parseLinkText } from "../../links.ts";
import { LinkRecognition } from "../link-scope-hint.tsx";
import { CollectionPreviewDialog } from "../collection-preview/collection-preview-dialog.tsx";
import { choiceRequiredUrls, collectionUrls, importIntent, itemsWithChoices, outcomeUnknown, type ImportIntent } from "../collection-preview/import-intent.ts";
import type { CollectionChoice } from "../collection-preview/state.ts";
import { useCollectionPreview } from "../collection-preview/use-collection-preview.ts";
import { useLinkPasteField } from "../../shell/paste-guard.ts";

/**
 * Links (or a share text holding them) imported straight into the collection with the user's
 * default settings. Read like the new page's link box: with a supported link only the
 * supported links are sent, and the line under the box names the rest; without one, every line
 * goes as written and the server says what it cannot take. Platform collections are chosen from
 * in the collection preview first, their states judged against this collection; the preview
 * takes the place of this dialog and 「取消」 there comes back here.
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
  // Short links the server reported as collections, to be chosen from like the others.
  const [extraPreviewUrls, setExtraPreviewUrls] = useState<readonly string[]>([]);
  const intent = useRef<ImportIntent | undefined>(undefined);
  // Each link is processed up to its summary with the default model, which needs a context window.
  const defaultModel = settings.data?.defaultModelRef;
  const windowMissing = useModelReadiness(defaultModel, "context_window").status === "missing_context_window";
  const addId = useId();
  const windowSaved = useFocusAfterSave(windowMissing, () => document.getElementById(addId));
  const field = useLinkPasteField<HTMLTextAreaElement>({
    value: text,
    onValue: setText,
    multiline: true,
  });
  const parsed = useMemo(() => parseLinkText(text), [text]);
  const urls = parsed.links.length > 0 ? parsed.links.map((link) => link.url) : linesOf(text);
  const previewUrls = urls.filter((url) => collectionUrls([url]).length > 0 || extraPreviewUrls.includes(url));
  const reserved = urls.length - previewUrls.length;
  const preview = useCollectionPreview({
    compareCollectionId: props.collectionId,
    reserved,
  });
  const recognitionId = `${addId}-recognition`;

  const openPreview = (links: readonly string[] = previewUrls, startUrl?: string): void => {
    setError(undefined);
    preview.open(links, startUrl);
  };

  const submit = async (choices: readonly CollectionChoice[]): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const data = settings.data;
    const outputLanguage = data?.defaultOutputLanguage ?? data?.language;
    // The defaults stand in for the new page's pickers; without a default ASR model none is sent.
    const asrModelRef = initialAsrModelRef(asrProfiles.data?.items ?? [], data?.defaultAsrModelRef);
    const body: ImportRequest = {
      items: itemsWithChoices(urls, new Set(previewUrls), choices, (url) => ({
        url,
      })),
      settings: {
        autoProofread: true,
        ...(outputLanguage === undefined ? {} : { outputLanguage }),
        ...(data?.defaultModelRef === undefined ? {} : { modelRef: data.defaultModelRef }),
        ...(asrModelRef === undefined ? {} : { asrModelRef }),
        ...(data?.defaultSummaryTemplateId === undefined ? {} : { templateId: data.defaultSummaryTemplateId }),
      },
      collection: { id: props.collectionId },
      confirmCollections: true,
    };
    intent.current = importIntent(intent.current, body);
    try {
      await client.post("/api/contents/import", importResponseSchema, {
        body: intent.current.body,
        idempotencyKey: intent.current.key,
      });
      intent.current = undefined;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.collection(props.collectionId),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
      // The lecture counts in the sidebar and the collection list grow with the import.
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
      // Through the field, so the note of the last paste goes with the text.
      field.onChange("");
      setExtraPreviewUrls([]);
      // The dialog stays mounted with its collection page: what was imported is now in this
      // collection, so the next preview reads the links afresh rather than showing them as new.
      preview.close();
      preview.reset();
      props.onOpenChange(false);
    } catch (caught) {
      if (!outcomeUnknown(caught)) intent.current = undefined;
      const failure = appErrorOf(caught);
      if (caught instanceof ApiError && failure.code === "invalid_request.collection_choice_required") {
        const asked = choiceRequiredUrls(failure).filter((url) => urls.includes(url));
        if (asked.length > 0) {
          const extra = [...new Set([...extraPreviewUrls, ...asked])];
          setExtraPreviewUrls(extra);
          openPreview(
            urls.filter((url) => collectionUrls([url]).length > 0 || extra.includes(url)),
            asked[0],
          );
          return;
        }
      }
      if (caught instanceof ApiError && failure.code === "conflict.collection_preview_stale" && previewUrls.length > 0) {
        openPreview(previewUrls, preview.urls[preview.step]);
        preview.reread();
      }
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const onAdd = (): void => {
    if (previewUrls.length > 0) {
      openPreview();
      return;
    }
    void submit([]);
  };

  return (
    <>
      <Modal
        open={props.open && !preview.isOpen}
        onOpenChange={(open) => {
          if (!open) props.onOpenChange(false);
        }}
        title={t("library.collection.batchAddTitle")}
        description={t("library.collection.batchAddHint")}
      >
        <div className="flex flex-col gap-1.5">
          <TextArea
            className="min-h-40 w-full font-mono"
            aria-label={t("library.collection.batchAddTitle")}
            aria-describedby={recognitionId}
            ref={field.ref}
            value={text}
            onChange={(event) => field.onChange(event.target.value)}
            onPaste={field.onPaste}
          />
          <LinkRecognition parsed={parsed} pasted={field.note} id={recognitionId} onPreview={() => openPreview()} />
        </div>
        {error === undefined || preview.isOpen ? null : (
          <div className="mt-3">
            <ErrorView error={error} />
          </div>
        )}
        {windowMissing && defaultModel !== undefined ? (
          <ContextWindowNotice modelRef={defaultModel} variant="minimal" onSaved={windowSaved} className="mt-3" testId="batch-add-context-window" />
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => props.onOpenChange(false)}>{t("common.action.cancel")}</Button>
          <Button id={addId} variant="primary" loading={busy} disabled={urls.length === 0 || windowMissing} onClick={onAdd}>
            {t("library.collection.batchAddSubmit")}
          </Button>
        </div>
      </Modal>
      {props.open ? (
        <CollectionPreviewDialog
          preview={preview}
          onConfirm={(choices) => {
            // The context window is asked for in this dialog: back to it, where the notice is.
            if (windowMissing) preview.close();
            else void submit(choices);
          }}
          submitting={busy}
          error={preview.isOpen ? error : undefined}
          reserved={reserved}
        />
      ) : null}
    </>
  );
}
