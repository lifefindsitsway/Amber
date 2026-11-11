import { Scissors } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SPEAKER_SPLIT_MIN_MS } from "../../../shared/defaults.ts";
import { canSplit, splitPoint, type SplitPointSource } from "../../../shared/speaker-split.ts";
import { Button } from "../../ui/button.tsx";
import { formatDuration } from "../../format.ts";
import { speakerLabel } from "./speakers/speaker-data.ts";
import type { DraftSegment } from "./speaker-draft.ts";
import { useEditingPlayhead, useSpeakerEditingContext } from "./use-speaker-editing.tsx";

/** The caret of the sentence's input, as an offset into its text; `undefined` when the input is not on screen. */
function caretOf(index: number): number | undefined {
  const input = document.querySelector<HTMLTextAreaElement>(`[data-sentence-index="${index}"] textarea`);
  return input === null ? undefined : input.selectionStart;
}

/**
 * 「在此拆分」 under the active sentence: cuts it into two at the caret, giving each half a
 * speaker. The time of the cut comes from, in order, the speaker change the recognizer saw
 * inside the sentence, the playback position when it is inside the sentence, and an estimate
 * from the caret's place in the text; the source is named, and the milliseconds can be
 * changed before cutting. A sentence too short for two halves can only be given to one speaker.
 */
export function SplitControl(props: { index: number; segment: DraftSegment }) {
  const { t } = useTranslation();
  const editing = useSpeakerEditingContext();
  const { segment, index } = props;
  const splittable = canSplit(segment);
  const [caret, setCaret] = useState<number | undefined>(() => caretOf(index));
  // The caret moves with typing and clicks in the input; the control only reads it.
  const latestIndex = useRef(index);
  latestIndex.current = index;
  useEffect(() => {
    const update = (): void => setCaret(caretOf(latestIndex.current));
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  // A typed time applies to the caret it was typed for; moving the caret takes the proposal back.
  const [typed, setTyped] = useState<{ caret: number | undefined; ms: number } | undefined>(undefined);

  const hasCaret = caret !== undefined && caret > 0 && caret < segment.text.length && segment.text.slice(0, caret).trim() !== "" && segment.text.slice(caret).trim() !== "";
  const playhead = useEditingPlayhead();
  const context = editing.actions.splitContext(index);
  const proposalAt = (playheadMs: number | undefined) =>
    splitPoint(segment, {
      ...(context.changeAtMs === undefined ? {} : { changeAtMs: context.changeAtMs }),
      ...(playheadMs === undefined ? {} : { playheadMs }),
      caretRatio: caret === undefined || segment.text.length === 0 ? 0.5 : caret / segment.text.length,
    });
  const proposal = proposalAt(playhead);
  const edited = typed !== undefined && typed.caret === caret;
  const atMs = edited ? typed.ms : proposal.atMs;
  const source: SplitPointSource | "manual" = edited ? "manual" : proposal.source;
  const inRange = atMs - segment.startMs >= SPEAKER_SPLIT_MIN_MS && segment.endMs - atMs >= SPEAKER_SPLIT_MIN_MS;
  const [text, setText] = useState<string | undefined>(undefined);
  // The halves' speakers: the proposal until the user picks one, which then counts as chosen.
  const [chosen, setChosen] = useState<{ left?: string | null; right?: string | null }>({});
  const proposedRight = source === "recognized" && context.nextSpeakerId !== null && context.nextSpeakerId !== context.currentSpeakerId ? context.nextSpeakerId : context.currentSpeakerId;
  const leftSpeaker = chosen.left !== undefined ? chosen.left : context.currentSpeakerId;
  const rightSpeaker = chosen.right !== undefined ? chosen.right : proposedRight;

  const split = (): void => {
    if (!hasCaret || caret === undefined || !inRange) return;
    // The playhead may have moved since this was drawn; what was typed stays.
    const fresh = edited ? { atMs, source } : proposalAt(editing.actions.splitContext(index).playheadMs);
    const freshRight = fresh.source === "recognized" && context.nextSpeakerId !== null && context.nextSpeakerId !== context.currentSpeakerId ? context.nextSpeakerId : context.currentSpeakerId;
    editing.actions.split(index, {
      offset: caret,
      atMs: fresh.atMs,
      leftSpeakerId: leftSpeaker,
      rightSpeakerId: chosen.right !== undefined ? chosen.right : freshRight,
      leftChosen: chosen.left !== undefined,
      rightChosen: chosen.right !== undefined,
    });
  };

  if (!splittable) {
    return (
      <span className="inline-flex" title={t("speakerEditor.split.tooShort", { ms: SPEAKER_SPLIT_MIN_MS * 2 })} data-testid="split-disabled">
        <Button size="sm" variant="ghost" disabled data-testid="split-button">
          <Scissors size={13} aria-hidden="true" />
          {t("speakerEditor.split.action")}
        </Button>
      </span>
    );
  }

  const field = text ?? String(atMs);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="split-control">
      <Button size="sm" variant="ghost" disabled={!hasCaret || !inRange} onClick={split} title={hasCaret ? undefined : t("speakerEditor.split.needCaret")} data-testid="split-button">
        <Scissors size={13} aria-hidden="true" />
        {t("speakerEditor.split.action")}
      </Button>
      {hasCaret ? (
        <>
          <label className="flex items-center gap-1 text-xs text-muted">
            <span>{t("speakerEditor.split.at")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={segment.startMs + SPEAKER_SPLIT_MIN_MS}
              max={segment.endMs - SPEAKER_SPLIT_MIN_MS}
              step={1}
              value={field}
              aria-label={t("speakerEditor.split.timeLabel")}
              aria-invalid={!inRange}
              className={`h-6 w-20 rounded border bg-surface px-1.5 font-mono text-xs tabular-nums text-ink focus-visible:outline-2 focus-visible:outline-accent ${inRange ? "border-line" : "border-danger"}`}
              onChange={(event) => {
                setText(event.target.value);
                const ms = Number(event.target.value);
                if (event.target.value.trim() !== "" && Number.isFinite(ms)) setTyped({ caret, ms: Math.round(ms) });
              }}
              onBlur={() => setText(undefined)}
              data-testid="split-time"
            />
            <span aria-hidden="true">{t("speakerEditor.split.unit")}</span>
            <span className="font-mono tabular-nums" aria-hidden="true">
              {formatDuration(atMs)}
            </span>
          </label>
          <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] text-muted" data-testid="split-source" data-source={source}>
            {t(`speakerEditor.split.source.${source}`)}
          </span>
          {(["left", "right"] as const).map((half) => {
            const value = half === "left" ? leftSpeaker : rightSpeaker;
            const name = t(half === "left" ? "speakerEditor.split.leftSpeaker" : "speakerEditor.split.rightSpeaker");
            return (
              <select
                key={half}
                value={value ?? ""}
                aria-label={t("speakerEditor.split.speakerFor", { half: name })}
                title={t("speakerEditor.split.speakerFor", { half: name })}
                className="h-6 max-w-32 rounded border border-line bg-surface px-1 text-xs"
                onChange={(event) => setChosen({ ...chosen, [half]: event.target.value === "" ? null : event.target.value })}
                data-testid={`split-speaker-${half}`}
              >
                <option value="">{t("speakerEditor.split.nobody")}</option>
                {[...editing.current, ...editing.others].map((speaker) => (
                  <option key={speaker.id} value={speaker.id}>
                    {speakerLabel(t, speaker)}
                  </option>
                ))}
              </select>
            );
          })}
          {inRange ? null : (
            <span className="text-xs text-danger" role="status">
              {t("speakerEditor.split.outOfRange", { ms: SPEAKER_SPLIT_MIN_MS })}
            </span>
          )}
        </>
      ) : (
        <span className="text-xs text-muted">{t("speakerEditor.split.needCaret")}</span>
      )}
    </div>
  );
}
