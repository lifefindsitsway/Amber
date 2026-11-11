import { afterEach, describe, expect, it } from "vitest";
import { SPEAKER_AVATAR_MAX_BYTES, SPEAKER_AVATAR_MAX_PX, SPEAKER_NAME_MAX_GRAPHEMES, SPEAKER_SUGGESTIONS_MAX, SPEAKERS_PER_CONTENT_MAX } from "../../../src/shared/defaults.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { SpeakerService } from "../../../src/server/application/speakers.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  open.push(h);
  const speakers = new SpeakerService({ repository: h.repository, newId: h.newId });
  return { h, speakers, contentId: createLocalContent(h) };
}

function errorOf(work: () => unknown): { class: string; code: string; userMessage: string; details?: unknown } {
  try {
    work();
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected an error");
}

const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

/** A PNG of the given size without pixel data, with `padding` bytes between the header and the closing IEND chunk. */
function png(width = 64, height = 64, padding = 0): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0];
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  return Uint8Array.from([...header, ...new Array<number>(padding).fill(0), ...iend]);
}

const upload = (bytes: Uint8Array, mime: "image/webp" | "image/png" | "image/jpeg" = "image/png") => ({ avatar: { data: Buffer.from(bytes).toString("base64"), mime } });

/** An ASR-like revision whose first sentence names `speakerId`. */
function revisionNaming(h: Harness, contentId: string, speakerId: string | undefined, archived = false): void {
  const id = h.newId();
  const revision: TranscriptRevision = {
    id, contentId, kind: "asr", language: "zh-CN", timingFidelity: "segment_only",
    generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe" }, segmentCount: 1, createdAt: 1,
  };
  const segment: TranscriptSegment = {
    id: h.newId() as SegmentId, revisionId: id, ordinal: 0, startMs: 0, endMs: 900, text: "一句", ...(speakerId === undefined ? {} : { speakerId }), sourceSegmentIds: [],
  };
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, [segment]);
    if (archived) scope.transcripts.setArchived(LOCAL.userId, id, 2);
  });
}

describe("SpeakerService create and list", () => {
  it("creates speakers in ordinal order, each with its own color and a normalized name", () => {
    const { speakers, contentId } = setup();
    expect(speakers.list(LOCAL, contentId)).toEqual({ items: [] });
    const first = speakers.create(LOCAL, contentId, { name: "  Ann ‮  Lee\u0007 " });
    const second = speakers.create(LOCAL, contentId, {});
    const third = speakers.create(LOCAL, contentId, { name: "Cy", colorIndex: 5 });
    expect(first).toMatchObject({ ordinal: 1, name: "Ann Lee", colorIndex: 0, used: false });
    expect(second).toMatchObject({ ordinal: 2, colorIndex: 1 });
    expect("name" in second).toBe(false);
    expect(third).toMatchObject({ ordinal: 3, name: "Cy", colorIndex: 5 });
    expect(speakers.list(LOCAL, contentId).items.map((speaker) => speaker.id)).toEqual([first.id, second.id, third.id]);
  });

  it("treats a name of only white space or controls as unnamed", () => {
    const { speakers, contentId } = setup();
    const created = speakers.create(LOCAL, contentId, { name: " \t‏\n " });
    expect("name" in created).toBe(false);
  });

  it("refuses a name past the grapheme limit, counting clusters and not code units", () => {
    const { speakers, contentId } = setup();
    const exact = "👨‍👩‍👧".repeat(SPEAKER_NAME_MAX_GRAPHEMES);
    expect(speakers.create(LOCAL, contentId, { name: exact }).name).toBe(exact);
    const error = errorOf(() => speakers.create(LOCAL, contentId, { name: `${exact}x` }));
    expect(error.class).toBe("invalid_request");
    expect(error.userMessage.length).toBeGreaterThan(0);
    expect(speakers.list(LOCAL, contentId).items).toHaveLength(1);
  });

  it("refuses a speaker past the per-Content limit", () => {
    const { h, speakers, contentId } = setup();
    h.repository.withTransaction((scope) =>
      scope.speakers.insert(LOCAL.userId, contentId, Array.from({ length: SPEAKERS_PER_CONTENT_MAX - 1 }, () => ({ id: h.newId() })), 1),
    );
    speakers.create(LOCAL, contentId, {});
    expect(errorOf(() => speakers.create(LOCAL, contentId, {})).class).toBe("invalid_request");
    expect(speakers.list(LOCAL, contentId).items).toHaveLength(SPEAKERS_PER_CONTENT_MAX);
  });

  it("marks a speaker used when an unarchived revision or the draft names it, not an archived revision", () => {
    const { h, speakers, contentId } = setup();
    const [named, archived, drafted, idle] = [0, 1, 2, 3].map(() => speakers.create(LOCAL, contentId, {}));
    revisionNaming(h, contentId, (named as { id: string }).id);
    revisionNaming(h, contentId, (archived as { id: string }).id, true);
    const base = h.repository.withTransaction((scope) => scope.transcripts.listRevisions(LOCAL.userId, contentId)[0] as TranscriptRevision);
    const baseSegment = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, base.id)[0] as TranscriptSegment);
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: base.id, expectedVersion: null,
      segments: [{ startMs: 0, endMs: 900, text: "一句", sourceSegmentIds: [baseSegment.id], speakerId: (drafted as { id: string }).id }],
    });
    const used = Object.fromEntries(speakers.list(LOCAL, contentId).items.map((speaker) => [speaker.id, speaker.used]));
    expect(used).toEqual({ [(named as { id: string }).id]: true, [(archived as { id: string }).id]: false, [(drafted as { id: string }).id]: true, [(idle as { id: string }).id]: false });
  });
});

describe("SpeakerService patch", () => {
  it("changes name and color; null or blank clears the name; an empty patch changes nothing", () => {
    const { speakers, contentId } = setup();
    const { id } = speakers.create(LOCAL, contentId, { name: "Ann" });
    expect(speakers.patch(LOCAL, contentId, id, { name: " Bea  Lee ", colorIndex: 3 })).toMatchObject({ name: "Bea Lee", colorIndex: 3 });
    expect(speakers.patch(LOCAL, contentId, id, {})).toMatchObject({ name: "Bea Lee", colorIndex: 3 });
    expect("name" in speakers.patch(LOCAL, contentId, id, { name: "   " })).toBe(false);
    speakers.patch(LOCAL, contentId, id, { name: "Cy" });
    expect("name" in speakers.patch(LOCAL, contentId, id, { name: null })).toBe(false);
    expect(errorOf(() => speakers.patch(LOCAL, contentId, id, { name: "x".repeat(SPEAKER_NAME_MAX_GRAPHEMES + 1) })).class).toBe("invalid_request");
  });

  it("stores the photo by its bytes, ignoring the declared type, and raises the version with each new one", () => {
    const { speakers, contentId } = setup();
    const { id } = speakers.create(LOCAL, contentId, {});
    const first = speakers.patch(LOCAL, contentId, id, upload(png(), "image/webp"));
    expect(first.avatarVersion).toBe(1);
    expect(speakers.avatar(LOCAL, contentId, id)).toMatchObject({ mime: "image/png", version: 1 });
    expect(Buffer.from(speakers.avatar(LOCAL, contentId, id).bytes).equals(Buffer.from(png()))).toBe(true);
    expect(speakers.patch(LOCAL, contentId, id, upload(png(32, 32), "image/jpeg")).avatarVersion).toBe(2);
    const removed = speakers.patch(LOCAL, contentId, id, { avatar: null });
    expect("avatarVersion" in removed).toBe(false);
    expect(errorOf(() => speakers.avatar(LOCAL, contentId, id)).class).toBe("not_found");
  });

  it("refuses an unacceptable photo and changes nothing, not even the name sent with it", () => {
    const { speakers, contentId } = setup();
    const { id } = speakers.create(LOCAL, contentId, { name: "Ann" });
    speakers.patch(LOCAL, contentId, id, upload(png()));
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    const bad: Array<[string, Uint8Array]> = [
      ["svg", svg],
      ["truncated header", png().slice(0, 20)],
      ["truncated data", png().slice(0, png().length - 12)],
      ["oversize pixels", png(SPEAKER_AVATAR_MAX_PX + 1, 10)],
      ["oversize bytes", png(10, 10, SPEAKER_AVATAR_MAX_BYTES - 40)],
      ["empty", new Uint8Array()],
      ["text", new TextEncoder().encode("not an image")],
    ];
    for (const [label, bytes] of bad) {
      const error = errorOf(() => speakers.patch(LOCAL, contentId, id, { name: "Changed", ...upload(bytes, "image/png") }));
      expect([label, error.class]).toEqual([label, "invalid_request"]);
    }
    expect(speakers.list(LOCAL, contentId).items[0]).toMatchObject({ name: "Ann", avatarVersion: 1 });
  });

  it("copies another speaker of the same user as a snapshot: name, color and photo, then independent", () => {
    const { h, speakers, contentId } = setup();
    const otherContent = createLocalContent(h);
    const source = speakers.create(LOCAL, otherContent, { name: "Host", colorIndex: 6 });
    speakers.patch(LOCAL, otherContent, source.id, upload(png(48, 48)));
    const target = speakers.create(LOCAL, contentId, { name: "Old", colorIndex: 1 });
    const copied = speakers.patch(LOCAL, contentId, target.id, { copyFrom: { contentId: otherContent, speakerId: source.id } });
    expect(copied).toMatchObject({ id: target.id, name: "Host", colorIndex: 6, avatarVersion: 1 });
    expect(Buffer.from(speakers.avatar(LOCAL, contentId, target.id).bytes).equals(Buffer.from(png(48, 48)))).toBe(true);
    // Changing the source afterwards leaves the copy alone.
    speakers.patch(LOCAL, otherContent, source.id, { name: "Renamed", avatar: null });
    expect(speakers.list(LOCAL, contentId).items[0]).toMatchObject({ name: "Host", avatarVersion: 1 });
    // Copying a speaker with no name and no photo clears the target's.
    const bare = speakers.create(LOCAL, otherContent, {});
    const cleared = speakers.patch(LOCAL, contentId, target.id, { copyFrom: { contentId: otherContent, speakerId: bare.id } });
    expect("name" in cleared).toBe(false);
    expect("avatarVersion" in cleared).toBe(false);
  });

  it("answers not_found for foreign, missing and trashed Contents and speakers, and for a foreign copy source", () => {
    const { h, speakers, contentId } = setup();
    const { id } = speakers.create(LOCAL, contentId, { name: "Ann" });
    speakers.patch(LOCAL, contentId, id, upload(png()));
    const bobContent = createLocalContent(h, BOB.userId);
    const bobSpeaker = h.repository.withTransaction((scope) => scope.speakers.insert(BOB.userId, bobContent, [{ id: h.newId(), name: "Bob" }], 1)[0]);
    const notFound = (work: () => unknown) => errorOf(work).class;
    expect(notFound(() => speakers.list(BOB, contentId))).toBe("not_found");
    expect(notFound(() => speakers.create(BOB, contentId, {}))).toBe("not_found");
    expect(notFound(() => speakers.patch(BOB, contentId, id, { name: "x" }))).toBe("not_found");
    expect(notFound(() => speakers.avatar(BOB, contentId, id))).toBe("not_found");
    expect(notFound(() => speakers.patch(LOCAL, contentId, "missing", { name: "x" }))).toBe("not_found");
    // A speaker id of another Content does not resolve through this one.
    const mine = speakers.create(LOCAL, createLocalContent(h), {});
    expect(notFound(() => speakers.patch(LOCAL, contentId, mine.id, { name: "x" }))).toBe("not_found");
    // Neither side of a copy may belong to someone else.
    expect(notFound(() => speakers.patch(LOCAL, contentId, id, { copyFrom: { contentId: bobContent, speakerId: bobSpeaker?.id as string } }))).toBe("not_found");
    expect(notFound(() => speakers.patch(LOCAL, contentId, id, { copyFrom: { contentId, speakerId: "missing" } }))).toBe("not_found");
    expect(speakers.list(LOCAL, contentId).items[0]).toMatchObject({ name: "Ann" });
    h.trash.trash(LOCAL, contentId);
    expect(notFound(() => speakers.list(LOCAL, contentId))).toBe("not_found");
    expect(notFound(() => speakers.patch(LOCAL, contentId, id, { name: "x" }))).toBe("not_found");
    expect(notFound(() => speakers.avatar(LOCAL, contentId, id))).toBe("not_found");
  });
});

describe("SpeakerService on Contents in the trash", () => {
  it("refuses to create a speaker on a trashed Content and to copy from one, changing nothing", () => {
    const { h, speakers, contentId } = setup();
    const trashed = createLocalContent(h);
    const source = speakers.create(LOCAL, trashed, { name: "Host", colorIndex: 6 });
    const target = speakers.create(LOCAL, contentId, { name: "Keep" });
    h.trash.trash(LOCAL, trashed);
    expect(errorOf(() => speakers.create(LOCAL, trashed, { name: "More" })).class).toBe("not_found");
    expect(errorOf(() => speakers.patch(LOCAL, contentId, target.id, { copyFrom: { contentId: trashed, speakerId: source.id } })).class).toBe("not_found");
    expect(speakers.list(LOCAL, contentId).items[0]).toMatchObject({ name: "Keep" });
    h.trash.restore(LOCAL, trashed);
    expect(speakers.list(LOCAL, trashed).items).toHaveLength(1);
  });
});

describe("SpeakerService suggestions", () => {
  it("leaves the named Content's own speakers out, and treats an unknown or foreign id as no exclusion at all", () => {
    const { h, speakers, contentId } = setup();
    const other = createLocalContent(h);
    speakers.create(LOCAL, contentId, { name: "Here" });
    speakers.create(LOCAL, other, { name: "There" });
    const bobContent = createLocalContent(h, BOB.userId);
    expect(speakers.suggestions(LOCAL, "", contentId).items.map((item) => item.name)).toEqual(["There"]);
    expect(speakers.suggestions(LOCAL, "", other).items.map((item) => item.name)).toEqual(["Here"]);
    expect(speakers.suggestions(LOCAL, "", "missing").items.map((item) => item.name).sort()).toEqual(["Here", "There"]);
    expect(speakers.suggestions(LOCAL, "", bobContent).items.map((item) => item.name).sort()).toEqual(["Here", "There"]);
  });

  it("lists the user's own named speakers, capped, never another user's", () => {
    const { h, speakers, contentId } = setup();
    const created = Array.from({ length: SPEAKER_SUGGESTIONS_MAX + 2 }, (_, index) => speakers.create(LOCAL, contentId, { name: `Guest ${index}` }));
    speakers.create(LOCAL, contentId, {});
    const bobContent = createLocalContent(h, BOB.userId);
    speakers.create(BOB, bobContent, { name: "Guest Bob" });
    const all = speakers.suggestions(LOCAL, "");
    expect(all.items).toHaveLength(SPEAKER_SUGGESTIONS_MAX);
    expect(all.items.every((item) => item.contentId === contentId && item.name.startsWith("Guest "))).toBe(true);
    expect(all.items.some((item) => item.name === "Guest Bob")).toBe(false);
    expect(speakers.suggestions(LOCAL, "guest 3").items.map((item) => item.name)).toEqual(["Guest 3"]);
    expect(speakers.suggestions(BOB, "guest").items.map((item) => item.name)).toEqual(["Guest Bob"]);
    expect(speakers.suggestions(LOCAL, "no-such-name").items).toEqual([]);
    expect(created.length).toBe(SPEAKER_SUGGESTIONS_MAX + 2);
  });

  it("carries the photo version and Content title, and skips unnamed speakers and trashed Contents", () => {
    const { h, speakers, contentId } = setup();
    const named = speakers.create(LOCAL, contentId, { name: "Ann", colorIndex: 4 });
    speakers.patch(LOCAL, contentId, named.id, upload(png()));
    speakers.create(LOCAL, contentId, {});
    const [suggestion] = speakers.suggestions(LOCAL, "ann").items;
    expect(suggestion).toMatchObject({ contentId, speakerId: named.id, name: "Ann", colorIndex: 4, avatarVersion: 1 });
    expect(speakers.suggestions(LOCAL, "").items).toHaveLength(1);
    h.trash.trash(LOCAL, contentId);
    expect(speakers.suggestions(LOCAL, "").items).toEqual([]);
  });
});
