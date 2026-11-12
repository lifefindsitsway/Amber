import { Play, SkipForward } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SPEAKER_REVIEW_SAMPLES_PER_SPEAKER } from "../../../../../shared/defaults.ts";
import type { SpeakerDto } from "../../../../../shared/dto/speaker.ts";
import { formatDuration } from "../../../../format.ts";
import { usePlayRange } from "../../../../player/player-controller.tsx";
import { SpeakerAvatar } from "../speaker-avatar.tsx";
import { speakerLabel } from "../speaker-data.ts";
import { reviewSamples, type SampleSentence } from "./review-samples.ts";

/** A sentence with its text, to show what a clip says. */
export type SampleListSentence = SampleSentence & { text: string };

/**
 * Listening to sampled clips of each speaker, one 「播放」 per clip: plays that sentence and
 * pauses at its end (「播放一段」). With a player that can only jump the entries read 「跳到」
 * and a line says playback goes on; without a player there is nothing to listen with.
 */
export function ReviewSampleList(props: { contentId: string; sentences: readonly SampleListSentence[]; speakers: ReadonlyMap<string, SpeakerDto> }) {
  const { t } = useTranslation();
  const { mode, playing, playRange } = usePlayRange();
  const samples = useMemo(() => reviewSamples(props.sentences), [props.sentences]);
  const texts = useMemo(() => new Map(props.sentences.map((sentence) => [sentence.id, sentence.text])), [props.sentences]);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="speaker-review-samples-title" data-testid="speaker-review-samples">
      <div>
        <h4 id="speaker-review-samples-title" className="text-xs font-medium">
          {t("speakerReview.samples.title")}
        </h4>
        <p className="text-xs text-muted">{t("speakerReview.samples.hint", { count: SPEAKER_REVIEW_SAMPLES_PER_SPEAKER })}</p>
      </div>
      {mode === "unsupported" ? (
        <p className="text-xs text-muted" data-testid="speaker-review-samples-no-player">
          {t("speakerReview.samples.noPlayer")}
        </p>
      ) : mode === "jump" ? (
        <p className="text-xs text-muted" data-testid="speaker-review-samples-jump-only">
          {t("speakerReview.samples.jumpOnly")}
        </p>
      ) : null}
      {samples.map((entry) => {
        const speaker = props.speakers.get(entry.speakerId);
        if (speaker === undefined) return null;
        const name = speakerLabel(t, speaker);
        return (
          <div key={entry.speakerId} className="flex flex-col gap-1" data-testid="speaker-review-sample-group" data-speaker-id={entry.speakerId}>
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <SpeakerAvatar contentId={props.contentId} speaker={speaker} size={18} decorative />
              <span className="truncate">{name}</span>
            </p>
            <ul className="flex flex-col">
              {entry.clips.map((clip) => {
                const time = formatDuration(clip.startMs);
                const active = playing !== undefined && playing.startMs === clip.startMs && playing.endMs === clip.endMs;
                return (
                  <li key={clip.segmentId} className="flex items-center gap-2 py-0.5 text-xs" data-testid="speaker-review-sample" data-segment-id={clip.segmentId}>
                    <span className="w-12 shrink-0 font-mono text-muted tabular-nums">{time}</span>
                    <span className="min-w-0 flex-1 truncate" title={texts.get(clip.segmentId)}>
                      {texts.get(clip.segmentId)}
                    </span>
                    {active ? (
                      <span className="shrink-0 text-accent" role="status" data-testid="speaker-review-sample-playing">
                        {t("speakerReview.samples.playing")}
                      </span>
                    ) : null}
                    {mode === "unsupported" ? null : (
                      <button
                        type="button"
                        className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-accent hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
                        aria-label={t(mode === "play" ? "speakerReview.samples.playClip" : "speakerReview.samples.jumpClip", { name, time })}
                        onClick={() => playRange(clip.startMs, clip.endMs)}
                        data-testid="speaker-review-sample-play"
                      >
                        {mode === "play" ? <Play size={12} aria-hidden="true" /> : <SkipForward size={12} aria-hidden="true" />}
                        {t(mode === "play" ? "speakerReview.samples.play" : "speakerReview.samples.jump")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
