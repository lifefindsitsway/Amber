import { useEffect, useRef, useState } from "react";
import { CAPABILITIES, youtubeEmbedUrl } from "./capabilities.ts";
import { usePlayerController } from "./player-controller.tsx";
import { loadYoutubeApi, type YoutubePlayer as YtPlayer } from "./youtube-api.ts";

const TIME_POLL_MS = 250;

/** `onStateChange` codes of the IFrame API. */
const STATE_ENDED = 0;
const STATE_PLAYING = 1;
const STATE_PAUSED = 2;

/**
 * YouTube iframe driven through the IFrame API: direct seeking, play and pause, and polled
 * current time. The iframe is ours so its Referer policy is set before the first request.
 * The position remembered from an earlier visit is not applied here: only the local player takes it.
 */
export function YoutubePlayer(props: { videoId: string; onFailure: () => void }) {
  const controller = usePlayerController();
  const frame = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => youtubeEmbedUrl(props.videoId, window.location.origin));
  const { onFailure } = props;

  useEffect(() => {
    const element = frame.current;
    if (element === null) {
      return;
    }
    let player: YtPlayer | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    let pendingSeek: number | undefined;
    const reportDuration = (target: YtPlayer): void => {
      const seconds = target.getDuration();
      if (Number.isFinite(seconds) && seconds > 0) controller.reportDuration(Math.round(seconds * 1000));
    };
    const detach = controller.attach({
      capabilities: CAPABILITIES.youtube,
      seek: (ms) => {
        if (player === undefined) {
          pendingSeek = ms;
        } else {
          player.seekTo(ms / 1000, true);
        }
      },
      play: () => player?.playVideo(),
      pause: () => player?.pauseVideo(),
    });
    loadYoutubeApi()
      .then((YT) => {
        if (cancelled) return;
        const created = new YT.Player(element, {
          events: {
            onReady: () => {
              player = created;
              reportDuration(created);
              if (pendingSeek !== undefined) {
                created.seekTo(pendingSeek / 1000, true);
                pendingSeek = undefined;
              }
              poll = setInterval(() => controller.reportTime(Math.round(created.getCurrentTime() * 1000)), TIME_POLL_MS);
            },
            onStateChange: (event) => {
              if (event.data === STATE_PLAYING) {
                // The length is often still unknown at onReady.
                if (player !== undefined) reportDuration(player);
                controller.reportPlayback("play");
              } else if (event.data === STATE_PAUSED) {
                controller.reportPlayback("pause");
              } else if (event.data === STATE_ENDED) {
                controller.reportPlayback("ended");
              }
            },
            onError: () => onFailure(),
          },
        });
      })
      .catch(() => {
        if (!cancelled) onFailure();
      });
    return () => {
      cancelled = true;
      if (poll !== undefined) clearInterval(poll);
      detach();
    };
  }, [controller, onFailure]);

  return (
    <iframe
      ref={frame}
      data-testid="player-youtube"
      title="YouTube"
      src={src}
      className="aspect-video w-full rounded-md border-0 bg-black"
      allow="autoplay; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}
