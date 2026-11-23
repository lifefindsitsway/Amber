import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ContentDetailDto, MediaAssetDto } from "../../../shared/dto/content.ts";
import type { RelinkRequest } from "../../../shared/dto/local-media.ts";
import { mediaAssetDtoSchema } from "../../../shared/dto/content.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { pickRelinkFile } from "../../desktop/bridge.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { Button } from "../../ui/button.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { Callout } from "../../ui/notice.tsx";

/** The local original whose file is gone, if any: Amber never deletes an `external_local` file and marks the asset `missing` when it is gone. */
export function missingOriginal(content: Pick<ContentDetailDto, "media">): MediaAssetDto | undefined {
  return content.media.find((item) => item.kind === "external_local" && item.availability === "missing");
}

/**
 * Desktop client: when a local Content's original file is missing, the user picks its new
 * location and it is relinked at once; the backend checks the fingerprint and answers
 * `media_changed` without touching anything when the picked file is a different one.
 */
export function RelinkBanner(props: { content: ContentDetailDto }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const missing = missingOriginal(props.content);
  const relink = useMutation({
    mutationFn: async (assetId: string) => {
      const picked = await pickRelinkFile();
      if (picked === null) return;
      const body: RelinkRequest = { path: picked.path, grant: picked.grant };
      await client.put(`/api/media/${encodeURIComponent(assetId)}/relink`, mediaAssetDtoSchema, { body });
      await queryClient.invalidateQueries({ queryKey: queryKeys.content(props.content.id) });
    },
  });
  if (missing === undefined) return null;
  return (
    // A problem the user has to deal with before playing from the original: a boxed notice
    // holding the fix. Present from the start, so not a live region.
    <Callout
      tone="error"
      density="compact"
      testId="relink-banner"
      actions={
        <Button size="sm" loading={relink.isPending} onClick={() => relink.mutate(missing.id)} data-testid="relink-pick">
          {t("contentView.relink.action")}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="max-w-[70ch]">{t("contentView.relink.missing", { name: missing.displayName ?? t("contentView.relink.unnamed") })}</p>
        {relink.error === null ? null : <ErrorView error={appErrorOf(relink.error)} />}
      </div>
    </Callout>
  );
}
