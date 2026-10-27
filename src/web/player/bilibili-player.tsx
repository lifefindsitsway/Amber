import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../ui/feedback.tsx";
import { bilibiliEmbedUrl, CAPABILITIES, type PlayerSource } from "./capabilities.ts";
import { usePlayerController } from "./player-controller.tsx";

/**
 * Bilibili's embedded player only takes URL parameters: seeking reloads the
 * iframe with `t=` and autoplay, showing a loading state; it cannot report its time.
 * Every seek remounts the iframe: `t=` has whole-second precision, so seeking to the
 * same second again leaves the URL unchanged and a mere `src` update would never load,
 * keeping the loading state up and the video where it was.
 */
export function BilibiliPlayer(props: { source: Extract<PlayerSource, { kind: "bilibili" }> }) {
  const { t } = useTranslation();
  const controller = usePlayerController();
  const [frame, setFrame] = useState(() => ({ src: bilibiliEmbedUrl(props.source, undefined), load: 0 }));
  const [loading, setLoading] = useState(true);
  const { source } = props;

  useEffect(
    () =>
      controller.attach({
        capabilities: CAPABILITIES.bilibili,
        seek: (ms) => {
          setLoading(true);
          setFrame((previous) => ({ src: bilibiliEmbedUrl(source, ms), load: previous.load + 1 }));
        },
      }),
    [controller, source],
  );

  return (
    <div className="relative">
      <iframe
        key={frame.load}
        data-testid="player-bilibili"
        title="Bilibili"
        src={frame.src}
        className="aspect-video w-full rounded-md border-0 bg-black"
        allow="autoplay; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setLoading(false)}
      />
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-md bg-black/40 text-sm text-white" data-testid="player-loading">
          <Spinner />
          {t("contentView.player.loading")}
        </div>
      ) : null}
    </div>
  );
}
