import type { Request, Route } from "@playwright/test";
import { searchResultDtoSchema, type SearchRange, type SpeakerHitDto } from "../../src/shared/dto/search.ts";
import { BILI_REVISION, BILIBILI_CONTENT, segmentId } from "./mock-backend.ts";
import { BASIS_LECTURE, lectureConfirmed, lectureSummaryText, NAMESAKE_LECTURE, speakerBasisState, type SpeakerBasisState } from "./mock-outputs.ts";

/**
 * `GET /api/search` of the fake backend over the always-processed bilibili lecture: its
 * title and its twelve sentences (the texts mirror the fake segments). Every term must
 * occur, like the real service; ranges mark each term occurrence in the returned text.
 */
const TITLE = "第二讲：B 站模拟课程";
const SEGMENT_COUNT = 12;
const SEGMENT_MS = 10_000;
const sentence = (index: number): string => `第 ${index + 1} 句模拟字幕。`;

function match(text: string, terms: readonly string[]): SearchRange[] | undefined {
  const lower = text.toLowerCase();
  const ranges: SearchRange[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!lower.includes(needle)) {
      return undefined;
    }
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      ranges.push({ start: at, end: at + needle.length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export async function handleSearch(route: Route, request: Request, url: URL, hidden: (contentId: string) => boolean = () => false): Promise<boolean> {
  if (request.method() !== "GET" || url.pathname !== "/api/search") {
    return false;
  }
  const terms = (url.searchParams.get("q") ?? "").split(/\s+/).filter((term) => term !== "");
  // A trashed lecture leaves the search projection: nothing of it is found.
  const gone = hidden(BILIBILI_CONTENT);
  const titleRanges = gone ? undefined : match(TITLE, terms);
  const segments = gone ? [] : Array.from({ length: SEGMENT_COUNT }, (_, index) => ({ index, ranges: match(sentence(index), terms) })).flatMap(({ index, ranges }) =>
    ranges === undefined
      ? []
      : [
          {
            contentId: BILIBILI_CONTENT,
            contentTitle: TITLE,
            transcriptRevisionId: BILI_REVISION,
            segmentId: segmentId(BILI_REVISION, index),
            startMs: index * SEGMENT_MS,
            snippet: sentence(index),
            ranges,
          },
        ],
  );
  const lectures = speakerBasisState(request.frame().page());
  const extra = lectures === undefined ? undefined : lectureHits(lectures, terms);
  const body = searchResultDtoSchema.parse({
    contents: titleRanges === undefined ? [] : [{ contentId: BILIBILI_CONTENT, title: TITLE, matchedIn: "title", snippet: TITLE, ranges: titleRanges }],
    segments: [...segments, ...(extra?.segments ?? [])],
    summaries: extra?.summaries ?? [],
    collections: [],
    ...(extra?.speakers === undefined || extra.speakers.length === 0 ? {} : { speakers: extra.speakers }),
  });
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  return true;
}

/**
 * Hits in the two speaker lectures, when the page installed them: each matched sentence with
 * its speaker as now and whether that lecture's speakers are reviewed; each matched summary
 * with the state of the speakers it was generated with; and every named speaker whose name
 * holds all terms, once per lecture — two lectures' namesakes are two hits. Names are matched
 * on their own and never through the sentences, titles or summaries, as on the server.
 */
function lectureHits(state: SpeakerBasisState, terms: readonly string[]): { segments: unknown[]; summaries: unknown[]; speakers: SpeakerHitDto[] } {
  const lectures = [BASIS_LECTURE, NAMESAKE_LECTURE];
  const segments = lectures.flatMap((lecture) =>
    lecture.sequence.flatMap((speakerId, index) => {
      const ranges = match(lecture.sentence(index), terms);
      const speaker = lecture.speakers.find((candidate) => candidate.id === speakerId);
      if (ranges === undefined || speaker === undefined) return [];
      return [
        {
          contentId: lecture.contentId,
          contentTitle: lecture.title,
          transcriptRevisionId: lecture.revisionId,
          segmentId: segmentId(lecture.revisionId, index),
          startMs: index * SEGMENT_MS,
          speaker: {
            id: speaker.id,
            ordinal: speaker.ordinal,
            ...(speaker.name === undefined ? {} : { name: speaker.name }),
            colorIndex: speaker.colorIndex,
            confirmed: lectureConfirmed(lecture, state),
          },
          snippet: lecture.sentence(index),
          ranges,
        },
      ];
    }),
  );
  const summaries = lectures.flatMap((lecture) => {
    const text = lectureSummaryText(lecture);
    const ranges = match(text, terms);
    if (ranges === undefined) return [];
    // The first lecture's summary reports the basis the spec set; the second one's still holds.
    const contextState = lecture === BASIS_LECTURE ? state.basis?.state : "consistent";
    return [
      {
        contentId: lecture.contentId,
        contentTitle: lecture.title,
        artifactId: `01J00000000000000000ARTSB${lecture.contentId.slice(-1)}`,
        templateId: "summary.core",
        summaryRevisionId: `01J00000000000000000SUMSB${lecture.contentId.slice(-1)}`,
        ...(contextState === undefined ? {} : { speakerContextState: contextState }),
        snippet: text,
        ranges,
      },
    ];
  });
  const speakers = lectures.flatMap((lecture) =>
    lecture.speakers.flatMap((speaker) =>
      speaker.name === undefined || match(speaker.name, terms) === undefined
        ? []
        : [
            {
              contentId: lecture.contentId,
              contentTitle: lecture.title,
              speakerId: speaker.id,
              ordinal: speaker.ordinal,
              name: speaker.name,
              colorIndex: speaker.colorIndex,
              sentences: lecture.sequence.filter((id) => id === speaker.id).length,
            },
          ],
    ),
  );
  return { segments, summaries, speakers };
}
