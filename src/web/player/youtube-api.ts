/** The slice of the YouTube IFrame API the player uses. */
export interface YoutubePlayer {
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}

export interface YoutubeNamespace {
  Player: new (
    element: HTMLIFrameElement,
    options: { events?: { onReady?: () => void; onError?: (event: { data: number }) => void; onStateChange?: (event: { data: number }) => void } },
  ) => YoutubePlayer;
}

declare global {
  interface Window {
    YT?: YoutubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_URL = "https://www.youtube.com/iframe_api";
let loading: Promise<YoutubeNamespace> | undefined;

/** Loads the IFrame API script once per document; later callers share the same promise. */
export function loadYoutubeApi(doc: Document = document): Promise<YoutubeNamespace> {
  const win = doc.defaultView;
  if (win?.YT?.Player !== undefined) {
    return Promise.resolve(win.YT);
  }
  loading ??= new Promise((resolve, reject) => {
    const previous = win?.onYouTubeIframeAPIReady;
    if (win !== null && win !== undefined) {
      win.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (win.YT !== undefined) resolve(win.YT);
      };
    }
    const script = doc.createElement("script");
    script.src = API_URL;
    script.async = true;
    script.onerror = () => {
      loading = undefined;
      reject(new Error("YouTube IFrame API failed to load"));
    };
    doc.head.appendChild(script);
  });
  return loading;
}
