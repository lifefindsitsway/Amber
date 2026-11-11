import { PARAGRAPH_GAP_MS } from "../../../src/shared/defaults.ts";
import type { TranscriptRevisionListItemDto } from "../../../src/shared/dto/content.ts";
import type { SpeakerDto } from "../../../src/shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../src/shared/dto/transcript.ts";
import { ContentPageProvider, type ContentPageState } from "../../../src/web/pages/content/content-context.tsx";
import { TranscriptTab } from "../../../src/web/pages/content/transcript-tab.tsx";
import { CAPABILITIES } from "../../../src/web/player/capabilities.ts";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import { contentDetail, contentRoutes, revision, segment } from "./content-data.ts";
import { renderApp } from "./render.tsx";

/** The signed-in user: the reading typography is kept per user and only written once it is known. */
export const READER_ME = { userId: "u1", role: "user", mode: "server", mustChangePassword: false };

export const TYPOGRAPHY_KEY = "amber.reader.typography.u1";

export const CHEN: SpeakerDto = { id: "sp1", ordinal: 1, name: "陈明", colorIndex: 0, used: true };
export const UNNAMED: SpeakerDto = { id: "sp2", ordinal: 2, colorIndex: 1, used: true };

const withSpeaker = (item: TranscriptSegmentDto, speakerId: string | undefined): TranscriptSegmentDto => (speakerId === undefined ? item : { ...item, speakerId });

/**
 * A conversation over the content's two chapters (0:00 and 1:00): 陈明 speaks two sentences,
 * speaker 2 answers with one word, 陈明 speaks again over two paragraphs, a sentence nobody
 * owns follows, and 陈明 opens the second chapter.
 */
export const SPEAKER_SEGMENTS: TranscriptSegmentDto[] = [
  withSpeaker(segment("g1", 0, 0, 4_000, "今天讲检索。"), "sp1"),
  withSpeaker(segment("g2", 1, 4_000, 8_000, "先看向量库。"), "sp1"),
  withSpeaker(segment("g3", 2, 8_000, 9_000, "嗯。"), "sp2"),
  withSpeaker(segment("g4", 3, 10_000, 15_000, "对，重排序是第二步，要把粗排的结果再精排一遍。"), "sp1"),
  withSpeaker(segment("g5", 4, 15_000 + PARAGRAPH_GAP_MS + 1_000, 22_000, "第二段仍然是他在讲，所以还在同一个发言轮次里。"), "sp1"),
  withSpeaker(segment("g6", 5, 30_000, 34_000, "这一句没有人认领，所以它属于未分配的轮次。"), undefined),
  withSpeaker(segment("g7", 6, 75_000, 80_000, "再看重排序，它决定了最终展示给用户的排列顺序。"), "sp1"),
];

/** The content page's routes with a conversation as its reading text and the given speakers. */
export function speakerRoutes(options: { segments?: TranscriptSegmentDto[]; speakers?: SpeakerDto[]; language?: string; revision?: Partial<TranscriptRevisionListItemDto> } = {}) {
  const items = options.segments ?? SPEAKER_SEGMENTS;
  const current = revision("r1", { ...(options.language === undefined ? {} : { language: options.language }), ...options.revision });
  return {
    ...contentRoutes(),
    "GET /api/auth/me": { body: READER_ME },
    "GET /api/contents/c1/speakers": { body: { items: options.speakers ?? [CHEN, UNNAMED] } },
    "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [current] } },
    "GET /api/transcript/revisions/r1/segments": { body: { revision: current, items } },
  };
}

/** The page state the reading view needs, with `select` recorded: a click that plays calls it with the sentence's start. */
export function pageState(select: ContentPageState["select"] = () => undefined): ContentPageState {
  return {
    content: contentDetail(),
    primaryRevisionId: "r1",
    selection: undefined,
    select,
    openTab: () => undefined,
    highlightThreshold: 0,
    setHighlightThreshold: () => undefined,
    openSubtitleEditor: () => undefined,
  };
}

/**
 * Mounts only the transcript tab, with a local player whose time the test drives
 * (`controller.reportTime`): the content page itself would own a controller of its own.
 */
export function mountReader(options: { route?: string; select?: ContentPageState["select"]; contextMenu?: boolean } = {}): { controller: PlayerController; seeks: number[] } {
  const seeks: number[] = [];
  const controller = new PlayerController();
  controller.attach({ capabilities: CAPABILITIES.local, seek: (ms) => seeks.push(ms) });
  const reader = (
    <PlayerControllerProvider controller={controller}>
      <ContentPageProvider value={pageState(options.select)}>
        <TranscriptTab />
      </ContentPageProvider>
    </PlayerControllerProvider>
  );
  renderApp(options.contextMenu === true ? <ContextMenuHost blockNative={false}>{reader}</ContextMenuHost> : reader, {
    route: options.route ?? "/contents/c1?tab=transcript&revision=r1",
    path: "/contents/:id",
  });
  return { controller, seeks };
}
