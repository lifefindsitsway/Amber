import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { HitSpeakerDto, SpeakerHitDto } from "../../shared/dto/search.ts";
import { SpeakerAvatar, type SpeakerAvatarSubject } from "../pages/content/speakers/speaker-avatar.tsx";
import { speakerLabel } from "../pages/content/speakers/speaker-data.ts";
import { speakerHitLink } from "./search.ts";

/** A speaker of a search hit as an avatar and a label take it; search hits carry no photo version. */
export function hitSpeakerSubject(speaker: Pick<HitSpeakerDto, "id" | "ordinal" | "colorIndex" | "name">): SpeakerAvatarSubject {
  return { id: speaker.id, ordinal: speaker.ordinal, colorIndex: speaker.colorIndex, ...(speaker.name === undefined ? {} : { name: speaker.name }) };
}

/** The speaker of a name match, in the same shape. */
export function speakerHitSubject(hit: SpeakerHitDto): SpeakerAvatarSubject {
  return hitSpeakerSubject({ id: hit.speakerId, ordinal: hit.ordinal, colorIndex: hit.colorIndex, name: hit.name });
}

/**
 * Who a matched sentence is given to. When its transcript's speakers are not reviewed the
 * name is only a label, so 「未核对」 follows it, in words rather than colour or fading. Search
 * hits carry no photo version, so the avatar is the letter and costs no request.
 */
export function HitSpeaker(props: { contentId: string; speaker: HitSpeakerDto; className?: string }) {
  const { t } = useTranslation();
  const { speaker } = props;
  const subject = hitSpeakerSubject(speaker);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${props.className ?? ""}`} data-testid="hit-speaker" data-confirmed={speaker.confirmed}>
      <SpeakerAvatar contentId={props.contentId} speaker={subject} size={14} decorative />
      <span className="truncate">
        {speakerLabel(t, subject)}
        {speaker.confirmed ? null : <span className="ml-1">{t("speakerContext.search.unconfirmed")}</span>}
      </span>
    </span>
  );
}

/** 「人物依据已变化」 beside a summary hit whose speaker basis no longer holds; the hit stays where relevance put it. */
export function BasisChangedMark(props: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`shrink-0 rounded bg-sunken px-1 text-xs text-muted ${props.className ?? ""}`} data-testid="hit-basis-changed">
      {t("speakerContext.search.basisChanged")}
    </span>
  );
}

/**
 * The speakers whose name matches the query, each opening its Content's reading view
 * filtered to them. The heading says it is a name match: equal names in two Contents are two
 * entries, never one person.
 */
export function SpeakerHitsGroup(props: { hits: readonly SpeakerHitDto[]; className?: string }) {
  const { t } = useTranslation();
  if (props.hits.length === 0) return null;
  return (
    <section className={props.className} aria-label={t("speakerContext.search.group")} data-testid="speaker-hits">
      <h2 className="mb-1 text-xs font-medium text-muted">{t("speakerContext.search.group")}</h2>
      <ul className="flex flex-wrap gap-2">
        {props.hits.map((hit) => (
          <li key={`${hit.contentId}:${hit.speakerId}`}>
            <Link
              to={speakerHitLink(hit)}
              className="flex max-w-80 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs hover:bg-sunken"
              data-testid="speaker-hit"
              data-speaker-id={hit.speakerId}
            >
              <SpeakerAvatar contentId={hit.contentId} speaker={speakerHitSubject(hit)} size={18} decorative />
              <span className="shrink-0 font-medium text-ink">{hit.name}</span>
              <span className="min-w-0 truncate text-muted">{t("speakerContext.search.hitDetail", { title: hit.contentTitle ?? t("search.untitled"), count: hit.sentences })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
