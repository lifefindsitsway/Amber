import { useQuery } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { contentPackImportJobDtoSchema } from "../../../shared/dto/content-pack.ts";
import { useApi } from "../../api/context.tsx";
import { Button } from "../../ui/button.tsx";
import { ExportPackDialog, type ExportRequest } from "./export-dialog.tsx";
import { ImportPackDialog } from "./import-dialog.tsx";
import { packKeys, useActivePackJobs } from "./pack-api.ts";

/**
 * The export wizard as a hook for the pages that open it: `open` takes the Contents (and the
 * page's collection), `dialog` is rendered once by the page.
 */
export function useExportPackWizard(): { open: (request: ExportRequest) => void; dialog: ReactNode } {
  const [request, setRequest] = useState<ExportRequest | undefined>(undefined);
  return {
    open: setRequest,
    dialog: <ExportPackDialog open={request !== undefined} onClose={() => setRequest(undefined)} request={request} />,
  };
}

/** 「导入内容包…」 and its dialog. */
export function ImportPackButton(props: { variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md"; testId?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={props.variant ?? "secondary"} size={props.size ?? "md"} onClick={() => setOpen(true)} data-testid={props.testId ?? "pack-import-open"}>
        <PackageOpen size={14} aria-hidden="true" />
        {t("contentPack.entry.importPack")}
      </Button>
      <ImportPackDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * A line that names the user's running pack job, export or import, with 「查看」 to open it
 * again: after a reload, or after the dialog was closed while the job went on. Nothing when
 * there is none.
 */
export function PackActiveNotice(props: { className?: string }) {
  const { t } = useTranslation();
  const client = useApi();
  const active = useActivePackJobs();
  const [opened, setOpened] = useState<"export" | "import" | undefined>(undefined);
  const importJobId = active.data?.importJobId;
  const exportJobId = active.data?.exportJobId;
  // The import's state picks the wording; the dialog polls the same query while it is open.
  const importJob = useQuery({
    queryKey: packKeys.importJob(importJobId ?? ""),
    queryFn: () => client.get(`/api/content-packs/imports/${encodeURIComponent(importJobId ?? "")}`, contentPackImportJobDtoSchema),
    enabled: importJobId !== undefined,
  });
  const kind = exportJobId !== undefined ? "export" : importJobId !== undefined ? "import" : undefined;
  const status = importJob.data?.status;
  const text =
    kind === "export"
      ? t("contentPack.active.export")
      : status === "awaiting_decisions"
        ? t("contentPack.active.review")
        : status === "receiving"
          ? t("contentPack.active.receiving")
          : t("contentPack.active.import");
  return (
    <>
      {kind === undefined || opened !== undefined ? null : (
        <div
          role="status"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm ${props.className ?? ""}`}
          data-testid="pack-active-notice"
          data-kind={kind}
        >
          <span>{text}</span>
          <button type="button" className="font-medium text-accent underline" onClick={() => setOpened(kind)} data-testid="pack-active-open">
            {t("contentPack.active.open")}
          </button>
        </div>
      )}
      <ExportPackDialog open={opened === "export"} onClose={() => setOpened(undefined)} request={undefined} resumeJobId={exportJobId} />
      <ImportPackDialog open={opened === "import"} onClose={() => setOpened(undefined)} resumeJobId={importJobId} />
    </>
  );
}
