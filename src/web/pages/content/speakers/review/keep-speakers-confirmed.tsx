import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRevisions, useSegments } from "../../content-data.ts";
import type { DraftSegment } from "../../speaker-draft.ts";
import { draftAttribution } from "./draft-attribution.ts";

/** Where the commit stands on keeping the base revision's speaker review. */
export interface KeepSpeakersConfirmedState {
  /** The base is reviewed and the commit changes who says something: the user decides. */
  visible: boolean;
  /** Changed sentences when unconfirmed suggestions are left unassigned (the default) and when they are accepted. */
  changed: { unassign: number; accept: number };
  /** Whether the two differ, so both are named: the choice is made later, for the sentences still to confirm. */
  dependsOnChoice: boolean;
  checked: boolean;
  setChecked: (checked: boolean) => void;
  /** What the commit request sends: `true` only while the box is shown and ticked. */
  speakersConfirmed: boolean;
}

/**
 * Whether committing the draft may keep the base revision's speaker review, and how many
 * sentences change hands compared with that base (the revision the draft was started from,
 * not whatever the history is later folded onto). Counted here from the draft and the base's
 * sentences with the same comparison the server makes, because nothing tells the editor
 * before the commit; the server decides again on commit.
 *
 * Nothing to decide when the base is not reviewed (the new revision is not, whatever is
 * sent), when no sentence changes hands (the review carries over by itself), or when the
 * commit names no speaker at all (such a revision is never reviewed). The box starts unticked
 * and unticks itself whenever the count changes, so a tick never vouches for edits made after it.
 */
export function useKeepSpeakersConfirmed(input: { contentId: string; baseRevisionId: string | undefined; segments: readonly DraftSegment[] | undefined }): KeepSpeakersConfirmedState {
  const revisions = useRevisions(input.contentId);
  const base = input.baseRevisionId === undefined ? undefined : revisions.data?.revisions.find((revision) => revision.id === input.baseRevisionId);
  const baseConfirmed = base?.speakersConfirmedAt !== undefined;
  const baseSegments = useSegments(baseConfirmed ? input.baseRevisionId : undefined);
  const counts = useMemo(() => {
    if (!baseConfirmed || baseSegments.data === undefined || input.segments === undefined) return undefined;
    const pending = input.segments.some((segment) => segment.speakerReview === "needs_review");
    const unassign = draftAttribution(baseSegments.data, input.segments, "unassign");
    const accept = pending ? draftAttribution(baseSegments.data, input.segments, "accept_suggestions") : unassign;
    return { unassign, accept };
  }, [baseConfirmed, baseSegments.data, input.segments]);
  const key = counts === undefined ? "" : `${counts.unassign.changed}/${counts.accept.changed}`;
  const [tick, setTick] = useState<{ key: string; checked: boolean }>({ key: "", checked: false });
  const visible =
    counts !== undefined && ((counts.unassign.changed > 0 && counts.unassign.namesSpeakers) || (counts.accept.changed > 0 && counts.accept.namesSpeakers));
  const checked = visible && tick.key === key && tick.checked;
  return {
    visible,
    changed: { unassign: counts?.unassign.changed ?? 0, accept: counts?.accept.changed ?? 0 },
    dependsOnChoice: counts !== undefined && counts.unassign.changed !== counts.accept.changed,
    checked,
    setChecked: (next) => setTick({ key, checked: next }),
    speakersConfirmed: checked,
  };
}

/** The commit request field for the box: present only when ticked. */
export function keepSpeakersConfirmedField(state: Pick<KeepSpeakersConfirmedState, "speakersConfirmed">): { speakersConfirmed?: true } {
  return state.speakersConfirmed ? { speakersConfirmed: true } : {};
}

/**
 * 「保持发言人已核对」 where the draft is committed: unticked by default, naming how many
 * sentences changed speaker compared with the base and that ticking vouches for the whole
 * transcript. Nothing is rendered when there is nothing to decide.
 */
export function KeepSpeakersConfirmed(props: { state: KeepSpeakersConfirmedState; disabled?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const { state } = props;
  if (!state.visible) return null;
  return (
    <div className="flex items-start gap-1.5 text-xs" data-testid="keep-speakers-confirmed">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={state.checked}
        disabled={props.disabled}
        aria-describedby={`${id}-detail`}
        onChange={(event) => state.setChecked(event.target.checked)}
        data-testid="keep-speakers-confirmed-input"
      />
      <span className="flex flex-col">
        <label htmlFor={id} className="font-medium">
          {t("speakerReview.keep.label")}
        </label>
        <span id={`${id}-detail`} className="text-muted" data-testid="keep-speakers-confirmed-detail">
          {state.dependsOnChoice
            ? t("speakerReview.keep.changedByChoice", { unassign: state.changed.unassign, accept: state.changed.accept })
            : t("speakerReview.keep.changed", { count: state.changed.unassign })}
        </span>
      </span>
    </div>
  );
}
