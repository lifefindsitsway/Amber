import { afterEach, describe, expect, it } from "vitest";
import { SPEAKER_AVATAR_MAX_BYTES, SPEAKER_AVATAR_MAX_PX, SPEAKER_NAME_MAX_GRAPHEMES, SPEAKER_SUGGESTIONS_MAX, SPEAKERS_PER_CONTENT_MAX } from "../../../src/shared/defaults.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { resolveSpeakerContext } from "../../../src/server/application/speaker-context.ts";
import { SpeakerService } from "../../../src/server/application/speakers.ts";
import { UNASSIGNED_SPEAKER_LABEL } from "../../../src/server/domain/speaker-context.ts";
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

describe("SpeakerService name confirmation", () => {
  function confirmable() {
    const h = createHarness();
    open.push(h);
    let now = 1_000;
    const speakers = new SpeakerService({ repository: h.repository, newId: h.newId, now: () => now });
    const contentId = createLocalContent(h);
    const stored = (id: string) => h.repository.withTransaction((scope) => scope.speakers.get(LOCAL.userId, contentId, id));
    return { h, speakers, contentId, stored, tick: () => (now += 1) };
  }

  it("confirms a name created or saved with nameConfirmed, and only then", () => {
    const { speakers, contentId, stored, tick } = confirmable();
    const confirmed = speakers.create(LOCAL, contentId, { name: "蒋炎岩", nameConfirmed: true });
    const plain = speakers.create(LOCAL, contentId, { name: "张三" });
    const unnamed = speakers.create(LOCAL, contentId, { nameConfirmed: true });
    expect(confirmed.nameConfirmed).toBe(true);
    expect(stored(confirmed.id)?.nameConfirmedAt).toBe(1_000);
    expect(plain).not.toHaveProperty("nameConfirmed");
    expect(stored(unnamed.id)).not.toHaveProperty("nameConfirmedAt");
    tick();
    expect(speakers.patch(LOCAL, contentId, plain.id, { name: "张三丰", nameConfirmed: true }).nameConfirmed).toBe(true);
    expect(stored(plain.id)?.nameConfirmedAt).toBe(1_001);
    expect(speakers.list(LOCAL, contentId).items.map((item) => item.nameConfirmed)).toEqual([true, true, undefined]);
  });

  it("drops the confirmation when the name changes without it or is cleared, and keeps it through colour and photo changes", () => {
    const { speakers, contentId, stored } = confirmable();
    const speaker = speakers.create(LOCAL, contentId, { name: "蒋炎岩", nameConfirmed: true });
    expect(speakers.patch(LOCAL, contentId, speaker.id, { colorIndex: 4 }).nameConfirmed).toBe(true);
    expect(speakers.patch(LOCAL, contentId, speaker.id, upload(png())).nameConfirmed).toBe(true);
    // The same name sent again is no change of name.
    expect(speakers.patch(LOCAL, contentId, speaker.id, { name: " 蒋炎岩 " }).nameConfirmed).toBe(true);
    const renamed = speakers.patch(LOCAL, contentId, speaker.id, { name: "蒋老师" });
    expect(renamed).not.toHaveProperty("nameConfirmed");
    expect(stored(speaker.id)).not.toHaveProperty("nameConfirmedAt");
    speakers.patch(LOCAL, contentId, speaker.id, { name: "蒋老师", nameConfirmed: true });
    const cleared = speakers.patch(LOCAL, contentId, speaker.id, { name: null, nameConfirmed: true });
    expect(cleared).not.toHaveProperty("nameConfirmed");
    expect(stored(speaker.id)).not.toHaveProperty("nameConfirmedAt");
  });

  it("confirms an existing name only when the request writes it: the same name re-sent does, colour, photo or the flag alone do not", () => {
    const { speakers, contentId, stored, tick } = confirmable();
    const speaker = speakers.create(LOCAL, contentId, { name: "主持人" });
    const colour = speakers.patch(LOCAL, contentId, speaker.id, { colorIndex: 3, nameConfirmed: true });
    expect(colour).toMatchObject({ name: "主持人", colorIndex: 3 });
    expect(colour).not.toHaveProperty("nameConfirmed");
    expect(speakers.patch(LOCAL, contentId, speaker.id, { ...upload(png()), nameConfirmed: true })).not.toHaveProperty("nameConfirmed");
    // The flag on its own is a valid request that writes nothing.
    const alone = speakers.patch(LOCAL, contentId, speaker.id, { nameConfirmed: true });
    expect(alone).toMatchObject({ name: "主持人" });
    expect(alone).not.toHaveProperty("nameConfirmed");
    expect(stored(speaker.id)).not.toHaveProperty("nameConfirmedAt");
    tick();
    expect(speakers.patch(LOCAL, contentId, speaker.id, { name: "主持人", nameConfirmed: true }).nameConfirmed).toBe(true);
    expect(stored(speaker.id)?.nameConfirmedAt).toBe(1_001);
    // A confirmed name keeps its time through a colour change that carries the flag.
    tick();
    expect(speakers.patch(LOCAL, contentId, speaker.id, { colorIndex: 5, nameConfirmed: true }).nameConfirmed).toBe(true);
    expect(stored(speaker.id)?.nameConfirmedAt).toBe(1_001);
  });

  it("treats a copied name as a new name: confirmed with the flag, unconfirmed without", () => {
    const { h, speakers, contentId, stored } = confirmable();
    const other = createLocalContent(h);
    const source = speakers.create(LOCAL, other, { name: "蒋炎岩", nameConfirmed: true });
    const target = speakers.create(LOCAL, contentId, { name: "旧名", nameConfirmed: true });
    const copied = speakers.patch(LOCAL, contentId, target.id, { copyFrom: { contentId: other, speakerId: source.id } });
    expect(copied).toMatchObject({ name: "蒋炎岩" });
    expect(copied).not.toHaveProperty("nameConfirmed");
    const confirmedCopy = speakers.patch(LOCAL, contentId, target.id, { copyFrom: { contentId: other, speakerId: source.id }, nameConfirmed: true });
    expect(confirmedCopy.nameConfirmed).toBe(true);
    expect(stored(target.id)?.nameConfirmedAt).toBe(1_000);
  });
});

describe("SpeakerService names that read like labels", () => {
  it("saves names equal to a number label or the unassigned label, with a bracketed number, or shared, keeping every id, and labels them apart", () => {
    const h = createHarness();
    open.push(h);
    const speakers = new SpeakerService({ repository: h.repository, newId: h.newId, now: () => 1_000 });
    const contentId = createLocalContent(h);
    const created = ["甲", "乙", "丙", "丁", "戊"].map((name) => speakers.create(LOCAL, contentId, { name }));
    const ids = created.map((speaker) => speaker.id);
    // One reviewed revision naming every speaker, so a submission now would read them all.
    const revisionId = h.newId();
    const segments: TranscriptSegment[] = ids.map((speakerId, ordinal) => ({
      id: h.newId() as SegmentId, revisionId, ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, text: `第${ordinal + 1}句`, speakerId, sourceSegmentIds: [],
    }));
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(
        LOCAL.userId,
        { id: revisionId, contentId, kind: "asr", language: "zh-CN", timingFidelity: "segment_only", generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe" }, segmentCount: ids.length, createdAt: 1 },
        segments,
      );
      scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 1);
      scope.speakerConfirmations.set(LOCAL.userId, contentId, revisionId, 1);
    });

    // The first speaker takes the second one's number label, the second the unassigned label.
    const names = ["发言人 2", UNASSIGNED_SPEAKER_LABEL, "张伟（发言人 2）", "张伟", "张伟"];
    names.forEach((name, index) => {
      const saved = speakers.patch(LOCAL, contentId, ids[index] as string, { name, nameConfirmed: true });
      expect(saved).toMatchObject({ id: ids[index], ordinal: index + 1, name, nameConfirmed: true });
    });
    // A new speaker may be created under such a name as well.
    const extra = speakers.create(LOCAL, contentId, { name: "发言人 1", nameConfirmed: true });
    expect(extra).toMatchObject({ ordinal: 6, name: "发言人 1", nameConfirmed: true });

    expect(speakers.list(LOCAL, contentId).items.map((speaker) => [speaker.id, speaker.name])).toEqual([
      ...ids.map((id, index) => [id, names[index]]),
      [extra.id, "发言人 1"],
    ]);
    // Renaming touched no sentence: they still name the same ids.
    expect(h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revisionId)).map((segment) => segment.speakerId)).toEqual(ids);

    const snapshot = h.repository.withTransaction((scope) => resolveSpeakerContext(scope, LOCAL.userId, contentId, revisionId, "transcript"));
    const labels = snapshot?.speakers.map((speaker) => speaker.label) ?? [];
    expect(snapshot?.speakers.map((speaker) => speaker.id)).toEqual(ids);
    expect(labels).toHaveLength(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain(UNASSIGNED_SPEAKER_LABEL);
    for (const label of labels) expect(label).not.toBe("");
  });

  it("keeps a speaker's id through every rename, with or without the confirmation", () => {
    const { speakers, contentId } = setup();
    const speaker = speakers.create(LOCAL, contentId, { name: "张伟" });
    const other = speakers.create(LOCAL, contentId, { name: "李娜" });
    for (const patch of [{ name: "张伟老师" }, { name: "李娜", nameConfirmed: true }, { name: null }, { name: "发言人 2" }, { name: "张伟（发言人 1）", nameConfirmed: true }]) {
      expect(speakers.patch(LOCAL, contentId, speaker.id, patch)).toMatchObject({ id: speaker.id, ordinal: 1 });
    }
    expect(speakers.list(LOCAL, contentId).items.map((item) => [item.id, item.ordinal, item.name])).toEqual([
      [speaker.id, 1, "张伟（发言人 1）"],
      [other.id, 2, "李娜"],
    ]);
  });
});

describe("SpeakerService speakers of comparison transcriptions", () => {
  /** A revision naming `speakerIds` one sentence each; `comparison` marks it as made only for comparison. */
  function revisionWith(h: Harness, contentId: string, speakerIds: readonly string[], options: { comparison?: boolean; archived?: boolean } = {}): string {
    const id = h.newId();
    const revision: TranscriptRevision = {
      id, contentId, kind: "asr", language: "zh-CN", timingFidelity: "segment_only",
      generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe", ...(options.comparison === true ? { purpose: "comparison" as const } : {}) },
      segmentCount: speakerIds.length, createdAt: 1,
    };
    const segments: TranscriptSegment[] = speakerIds.map((speakerId, ordinal) => ({
      id: h.newId() as SegmentId, revisionId: id, ordinal, startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, text: `${ordinal}`, speakerId, sourceSegmentIds: [],
    }));
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
      if (options.archived === true) scope.transcripts.setArchived(LOCAL.userId, id, 2);
    });
    return id;
  }

  const flagged = (speakers: SpeakerService, contentId: string) =>
    speakers.list(LOCAL, contentId).items.filter((speaker) => speaker.comparisonOnly === true).map((speaker) => speaker.ordinal);

  it("flags the speakers only comparison transcriptions name, and only those", () => {
    const { h, speakers, contentId } = setup();
    const [a, b, c, d] = [1, 2, 3, 4].map(() => speakers.create(LOCAL, contentId, {}).id) as [string, string, string, string];
    const primary = revisionWith(h, contentId, [a, b]);
    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, primary, 2));
    // c only in a comparison; b in both; d in nothing at all.
    revisionWith(h, contentId, [b, c], { comparison: true });
    expect(flagged(speakers, contentId)).toEqual([3]);
    const listed = speakers.list(LOCAL, contentId).items;
    expect(listed.find((speaker) => speaker.id === c)).toMatchObject({ used: true, comparisonOnly: true });
    expect(listed.find((speaker) => speaker.id === d)).toMatchObject({ used: false });
    expect(listed.filter((speaker) => speaker.id !== c).every((speaker) => !("comparisonOnly" in speaker))).toBe(true);
    // The patch answer carries the flag too.
    expect(speakers.patch(LOCAL, contentId, c, { colorIndex: 4 })).toMatchObject({ comparisonOnly: true });
  });

  it("stops flagging a speaker once anything else names it: an archived revision, a draft, or the comparison made primary", () => {
    const { h, speakers, contentId } = setup();
    const [a, c, e] = [1, 2, 3].map(() => speakers.create(LOCAL, contentId, {}).id) as [string, string, string];
    const primary = revisionWith(h, contentId, [a]);
    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, primary, 2));
    const comparison = revisionWith(h, contentId, [c, e], { comparison: true });
    expect(flagged(speakers, contentId)).toEqual([2, 3]);

    revisionWith(h, contentId, [e], { archived: true });
    expect(flagged(speakers, contentId)).toEqual([2]);

    h.transcripts.putDraft(LOCAL, contentId, { baseRevisionId: primary, expectedVersion: null, segments: [{ startMs: 0, endMs: 900, text: "一句", sourceSegmentIds: [], speakerId: c }] });
    expect(flagged(speakers, contentId)).toEqual([]);
    h.transcripts.discardDraft(LOCAL, contentId);
    expect(flagged(speakers, contentId)).toEqual([2]);

    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, comparison, 3));
    expect(flagged(speakers, contentId)).toEqual([]);
  });

  it("leaves speakers only comparison transcriptions name out of the suggestions for other Contents", () => {
    const { h, speakers, contentId } = setup();
    const other = createLocalContent(h);
    const kept = speakers.create(LOCAL, contentId, { name: "王老师" }).id;
    const compared = speakers.create(LOCAL, contentId, { name: "王同学" }).id;
    revisionWith(h, contentId, [kept]);
    revisionWith(h, contentId, [compared], { comparison: true });
    expect(speakers.suggestions(LOCAL, "王", other).items.map((item) => item.name)).toEqual(["王老师"]);
    // Once the user works with that speaker in a regular version it is suggested again.
    revisionWith(h, contentId, [compared]);
    expect(speakers.suggestions(LOCAL, "王", other).items.map((item) => item.name).sort()).toEqual(["王同学", "王老师"]);
  });
});
