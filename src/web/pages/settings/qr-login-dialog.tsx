import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { QR_POLL_INTERVAL_MS } from "../../../shared/defaults.ts";
import { platformQrAttemptDtoSchema, platformQrStatusDtoSchema, type PlatformQrAttemptDto } from "../../../shared/dto/platform-account.ts";
import type { PlatformQrStatus } from "../../../shared/enums.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { RequestError } from "./settings-ui.tsx";

const QR_PATH = "/api/platform-accounts/bilibili/qr";

/**
 * The server-mode bilibili QR login: a button that asks the server for a
 * code and a dialog that polls it until the login is confirmed or the code lapses. The
 * attempt starts from the click, not from a mount effect, so a remount never creates a
 * second one.
 */
export function QrLoginButton(props: { onConfirmed: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const [open, setOpen] = useState(false);
  const start = useMutation({ mutationFn: () => client.post(QR_PATH, platformQrAttemptDtoSchema) });
  const begin = () => {
    start.reset();
    start.mutate();
  };
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpen(true);
          begin();
        }}
      >
        {t("settings.platformAccounts.qr.open")}
      </Button>
      <Modal open={open} onOpenChange={setOpen} title={t("settings.platformAccounts.qr.title")}>
        {start.data === undefined ? (
          start.isError ? <RequestError error={start.error} /> : <Loading />
        ) : (
          <QrAttempt
            key={start.data.attemptId}
            attempt={start.data}
            refreshing={start.isPending}
            onRefresh={begin}
            onConfirmed={() => {
              setOpen(false);
              props.onConfirmed();
            }}
          />
        )}
      </Modal>
    </>
  );
}

/** One attempt: its code and its status, polled while the dialog shows it. */
function QrAttempt(props: { attempt: PlatformQrAttemptDto; refreshing: boolean; onRefresh: () => void; onConfirmed: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const { attempt, onConfirmed } = props;
  const image = useQrImage(attempt.qrUrl);
  const [status, setStatus] = useState<PlatformQrStatus>("pending");
  const [pollError, setPollError] = useState<unknown>(undefined);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (status === "confirmed" || status === "expired") {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (Date.now() >= attempt.expiresAt) {
        setStatus("expired");
        return;
      }
      client
        .get(`${QR_PATH}/${encodeURIComponent(attempt.attemptId)}`, platformQrStatusDtoSchema)
        .then((next) => {
          if (cancelled) return;
          setPollError(undefined);
          setStatus(next.status);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          // The server forgets an attempt that was replaced or outlived a restart.
          if (error instanceof ApiError && error.status === 404) {
            setStatus("expired");
          } else {
            setPollError(error);
          }
        })
        .finally(() => {
          if (!cancelled) setRound((value) => value + 1);
        });
    }, QR_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, attempt, status, round]);

  useEffect(() => {
    if (status === "confirmed") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.platformAccounts });
      onConfirmed();
    }
  }, [status, queryClient, onConfirmed]);

  const expired = status === "expired";
  return (
    <div className="flex flex-col items-center gap-3">
      <div className={`relative rounded-md border border-line bg-white p-2 ${expired ? "opacity-30" : ""}`}>
        {image === undefined ? (
          <div className="size-48" />
        ) : (
          <img src={image} alt={t("settings.platformAccounts.qr.image")} className="size-48" data-testid="qr-image" />
        )}
      </div>
      <p className={`text-sm ${status === "scanned" ? "text-accent" : expired ? "text-danger" : "text-muted"}`} role="status">
        {t(`settings.platformAccounts.qr.${status}`)}
      </p>
      {expired ? (
        <Button size="sm" variant="primary" loading={props.refreshing} onClick={props.onRefresh}>
          {t("settings.platformAccounts.qr.refresh")}
        </Button>
      ) : null}
      <RequestError error={pollError} />
    </div>
  );
}

/** The code as a data URL, drawn locally; the login URL it encodes never leaves the page. */
function useQrImage(text: string): string | undefined {
  const [image, setImage] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    // SVG needs no canvas, so the same code path runs in every WebView and in tests.
    QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1 })
      .then((svg) => {
        if (!cancelled) setImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setImage(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return image;
}
