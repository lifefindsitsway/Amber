import type { SpeakerDto } from "../../../src/shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../src/shared/dto/transcript.ts";
import type { RecordedCall } from "./render.tsx";
import { editorRoutes } from "./speaker-editor.tsx";

/** The two speakers of the default talk, named by its revision; and a third nothing refers to. */
export const MANAGED: readonly SpeakerDto[] = [
  { id: "spk-a", ordinal: 1, name: "陈明", colorIndex: 0, used: true, referenced: true },
  { id: "spk-b", ordinal: 2, name: "林雪", colorIndex: 1, used: true, referenced: true },
  { id: "spk-c", ordinal: 3, colorIndex: 2, used: false, referenced: false },
];

type Reply = { status?: number; body?: unknown } | ((call: RecordedCall) => { status?: number; body?: unknown });

/**
 * The editor's routes over a speaker list that the speakers API changes as the server would:
 * creation appends with the next ordinal, deletion removes. `deleteReply` answers a deletion
 * instead, for refusals.
 */
export function managedRoutes(options: { base?: readonly TranscriptSegmentDto[]; speakers?: readonly SpeakerDto[]; deleteReply?: (speakerId: string) => Reply | undefined } = {}) {
  const list: SpeakerDto[] = (options.speakers ?? MANAGED).map((speaker) => ({ ...speaker }));
  let created = 0;
  const routes: Record<string, Reply> = {
    ...editorRoutes(options.base, list),
    "GET /api/contents/c1/speakers": () => ({ body: { items: list } }),
    // The editor waits for the chapters; a Content with none answers with an empty list.
    "GET /api/contents/c1/chapters": { body: { revisions: [] } },
    "POST /api/contents/c1/speakers": (call) => {
      const request = (call.body ?? {}) as { name?: string; nameConfirmed?: boolean };
      created += 1;
      const ordinal = Math.max(0, ...list.map((speaker) => speaker.ordinal)) + 1;
      const speaker: SpeakerDto = {
        id: `spk-new-${created}`,
        ordinal,
        colorIndex: ordinal % 8,
        used: false,
        referenced: false,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.nameConfirmed === true ? { nameConfirmed: true } : {}),
      };
      list.push(speaker);
      addSpeakerRoutes(speaker.id);
      return { status: 201, body: speaker };
    },
  };
  const addSpeakerRoutes = (speakerId: string): void => {
    routes[`DELETE /api/contents/c1/speakers/${speakerId}`] = (call) => {
      const refused = options.deleteReply?.(speakerId);
      if (refused !== undefined) return typeof refused === "function" ? refused(call) : refused;
      const at = list.findIndex((speaker) => speaker.id === speakerId);
      if (at < 0) return { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } };
      list.splice(at, 1);
      return { status: 204 };
    };
    routes[`PATCH /api/contents/c1/speakers/${speakerId}`] = (call) => {
      const at = list.findIndex((speaker) => speaker.id === speakerId);
      const patch = call.body as { name?: string | null; nameConfirmed?: boolean };
      const current = list[at] as SpeakerDto;
      const { name: _name, nameConfirmed: _confirmed, ...rest } = current;
      const name = patch.name === undefined ? current.name : (patch.name ?? undefined);
      const next: SpeakerDto = { ...rest, ...(name === undefined ? {} : { name }), ...(name !== undefined && patch.nameConfirmed === true ? { nameConfirmed: true } : {}) };
      list[at] = next;
      return { body: next };
    };
  };
  for (const speaker of list) addSpeakerRoutes(speaker.id);
  return { routes, list };
}

/** The refusal of deleting a speaker something refers to. */
export const SPEAKER_IN_USE = { status: 409, body: { error: { class: "conflict", code: "conflict.speaker_in_use", retryDisposition: "never", userMessage: "" } } };

export const creations = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.path === "/api/contents/c1/speakers").map((call) => call.body);
export const deletions = (calls: RecordedCall[]) => calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/api/contents/c1/speakers/")).map((call) => call.path.split("/").at(-1));
