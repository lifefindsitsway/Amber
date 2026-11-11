import { expect, test, type Download, type Page } from "@playwright/test";
import { installMockBackend } from "./mock-backend.ts";
import { SPEAKER_SEQUENCE, SPEAKER_TEACHER, SPEAKERS_CONTENT, SPEAKERS_REVISION, speakerSentence, speakersRequests } from "./mock-speakers.ts";

async function downloadedText(file: Download): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of await file.createReadStream()) {
    text += decoder.decode(chunk as Uint8Array, { stream: true });
  }
  return text + decoder.decode();
}

/** The cues a browser's own WebVTT parser reads from `text`, with the voice each cue names. */
async function parsedCues(page: Page, text: string): Promise<Array<{ text: string; voice: string | null; plain: string }>> {
  return page.evaluate(async (vtt) => {
    const video = document.createElement("video");
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    video.append(track);
    document.body.append(video);
    // A hidden text track is still loaded and parsed, which is all this needs.
    track.track.mode = "hidden";
    await new Promise<void>((resolve, reject) => {
      track.addEventListener("load", () => resolve());
      track.addEventListener("error", () => reject(new Error("track failed to load")));
    });
    const cues = Array.from(track.track.cues ?? []) as VTTCue[];
    const result = cues.map((cue) => {
      const fragment = cue.getCueAsHTML();
      // A voice span becomes an element titled with its annotation.
      const voice = fragment.querySelector("span[title]")?.getAttribute("title") ?? null;
      return { text: cue.text, voice, plain: fragment.textContent ?? "" };
    });
    video.remove();
    return result;
  }, text);
}

test("speakers: a VTT exported with speakers is read by the browser's own parser as voice spans", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(`/contents/${SPEAKERS_CONTENT}`);
  await page.getByTestId("summary-export").click();
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  // The version names speakers, so the box is ticked from the start.
  await expect(page.getByTestId("export-speakers")).toBeChecked();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-format-vtt").click();
  const text = await downloadedText(await download);
  expect(speakersRequests(page).exports.at(-1)).toEqual({ format: "vtt", revisionId: SPEAKERS_REVISION, includeSpeakers: true });

  const cues = await parsedCues(page, text);
  expect(cues).toHaveLength(SPEAKER_SEQUENCE.length);
  // Each assigned cue is a voice span with the name; the text outside it is the sentence alone.
  expect(cues.map((cue) => cue.voice)).toEqual(["林老师", "林老师", "发言人 2", "林老师", "林老师", null]);
  expect(cues.map((cue) => cue.plain)).toEqual(SPEAKER_SEQUENCE.map((_, index) => speakerSentence(index)));
  expect(cues[0]?.text).toBe(`<v 林老师>${speakerSentence(0)}`);

  // Without the box ticked the request is the plain one and the file has no voices.
  await page.getByTestId("export-speakers").uncheck();
  const plain = page.waitForEvent("download");
  await page.getByTestId("export-format-vtt").click();
  await plain;
  expect(speakersRequests(page).exports.at(-1)).toEqual({ format: "vtt", revisionId: SPEAKERS_REVISION });
});

test("speakers: the subtitle list tags the first row of each turn without moving the text", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=subtitles`);
  const tags = page.getByTestId("subtitle-turn-tag");
  // Three speaker turns, then the sentence nobody was assigned to, marked neutrally.
  await expect(tags).toHaveCount(4);
  await expect(page.getByTestId("subtitle-turn-name")).toHaveText(["林老师", "发言人 2", "林老师", "未分配"]);
  await expect(tags.nth(3)).toHaveAttribute("data-unassigned", "true");
  // The tag sits on the turn's first row only; its neighbours carry none.
  const rows = page.locator("[data-segment-id]");
  await expect(rows.nth(0).getByTestId("subtitle-turn-tag")).toHaveCount(1);
  await expect(rows.nth(1).getByTestId("subtitle-turn-tag")).toHaveCount(0);
  await expect(rows.nth(5).getByTestId("subtitle-turn-tag")).toHaveCount(1);
  // Timestamps and text keep their columns whether or not a row carries a tag.
  const stamps = await rows.evaluateAll((elements) => elements.map((row) => (row.querySelector(".font-mono") as HTMLElement).getBoundingClientRect().x));
  expect(new Set(stamps.map(Math.round)).size).toBe(1);
  const texts = await rows.evaluateAll((elements) => elements.map((row) => (row.querySelector(".font-mono")?.nextElementSibling as HTMLElement).getBoundingClientRect().x));
  expect(new Set(texts.map(Math.round)).size).toBe(1);
  await expect(page.getByTestId("subtitles-version")).toHaveAttribute("title", "发言人识别：已识别发言人");
});

const FUN_ASR = "阿里云百炼 · fun-asr";

test("speakers: re-transcribing asks for identification, with the count, unless the model offers none", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=subtitles`);
  // A model the user typed in is never known to identify speakers.
  await page.evaluate(async () => {
    const response = await fetch("/api/asr-profiles/01J0000000000000000000ASR1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [{ modelId: "qwen-audio-3.1-asr-flash-filetrans" }, { modelId: "fun-asr" }, { modelId: "custom-asr", family: "fun_asr" }] }),
    });
    if (!response.ok) throw new Error(`patch failed: ${response.status}`);
  });
  await page.reload();

  const retranscribed = () => backend.mutations.filter((mutation) => mutation.path.endsWith("/transcript/retranscribe")).map((mutation) => mutation.body);
  const model = page.getByTestId("retranscribe-model");
  const toggle = page.getByTestId("diarization-switch");
  await model.selectOption({ label: FUN_ASR });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await page.getByTestId("retranscribe").click();
  await expect.poll(retranscribed).toHaveLength(1);
  expect(retranscribed()[0]).toMatchObject({ diarization: { mode: "required" } });

  await page.getByLabel("参考人数（2–100）").fill("3");
  await page.getByTestId("retranscribe").click();
  await expect.poll(retranscribed).toHaveLength(2);
  expect(retranscribed()[1]).toMatchObject({ diarization: { mode: "required", speakerCount: 3 } });

  await model.selectOption({ label: "阿里云百炼 · custom-asr" });
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("diarization-reason")).toHaveText("此模型不识别发言人");
  await expect(page.getByTestId("diarization-count")).toHaveCount(0);
  await page.getByTestId("retranscribe").click();
  await expect.poll(retranscribed).toHaveLength(3);
  // The setting still wants identification, so the server is asked as a preference and records why nobody was identified.
  expect(retranscribed()[2]).toMatchObject({ asrModelRef: { modelId: "custom-asr" }, diarization: { mode: "preferred" } });
});

test("speakers: the transcription settings switch is saved through the settings patch", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/settings/transcription");
  const toggle = page.getByTestId("asr-diarization");
  await expect(toggle).toBeChecked();
  await page.locator("label", { has: toggle }).click();
  await expect(toggle).not.toBeChecked();
  expect(backend.mutations.at(-1)).toEqual({ method: "PATCH", path: "/api/settings", body: { asrDiarization: false } });
  // The saved setting is what the switch starts from the next time.
  await page.reload();
  await expect(page.getByTestId("asr-diarization")).not.toBeChecked();
});

test("speakers: a refused identification is explained; the user continues without it or cancels", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=subtitles`);
  const retranscribed = () => backend.mutations.filter((mutation) => mutation.path.endsWith("/transcript/retranscribe")).map((mutation) => mutation.body);
  await page.getByTestId("retranscribe-model").selectOption({ label: FUN_ASR });
  const notice = page.getByTestId("diarization-unavailable");

  // Cancel: the notice goes and nothing more is sent.
  speakersRequests(page).refuseNextRetranscribe = "over_recommended";
  await page.getByTestId("retranscribe").click();
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-reason", "over_recommended");
  await expect(notice).toContainText("内容时长超过该模型建议识别发言人的上限");
  await notice.getByRole("button", { name: "取消" }).click();
  await expect(notice).toBeHidden();
  expect(retranscribed()).toHaveLength(1);
  expect(retranscribed()[0]).toMatchObject({ diarization: { mode: "required" } });

  // Continue without identification: the same request again, with identification off.
  speakersRequests(page).refuseNextRetranscribe = "unsupported";
  await page.getByTestId("retranscribe").click();
  await expect(notice).toHaveAttribute("data-reason", "unsupported");
  await notice.getByRole("button", { name: "不识别发言人，继续转录" }).click();
  await expect(notice).toBeHidden();
  await expect.poll(retranscribed).toHaveLength(3);
  expect(retranscribed()[1]).toMatchObject({ diarization: { mode: "required" } });
  expect(retranscribed()[2]).toMatchObject({ asrModelRef: { modelId: "fun-asr" }, diarization: { mode: "off" } });
  await expect(page.getByTestId("diarization-switch")).not.toBeChecked();
});

/** The reading text of the first sentence: what the typography settings style. */
const readerText = (page: Page) => page.getByText(speakerSentence(0), { exact: true });

test("speakers: the reading view names each turn and its typography follows the Aa panel, resets and survives a reload", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(`/contents/${SPEAKERS_CONTENT}?tab=transcript`);
  // Turn headers: the named speaker, the unnamed one by its ordinal, the unassigned sentences neutrally.
  await expect(page.getByRole("group", { name: "林老师，0:00" })).toBeVisible();
  await expect(page.getByRole("group", { name: "发言人 2，0:20" })).toBeVisible();
  await expect(page.getByRole("group", { name: "林老师，0:30" })).toBeVisible();
  const unassigned = page.getByRole("group", { name: "未分配，0:50" });
  await expect(unassigned).toBeVisible();
  await expect(unassigned.getByTestId("turn-speaker")).toHaveAttribute("data-unassigned", "true");

  const metrics = () => readerText(page).evaluate((element) => ({ size: parseFloat(getComputedStyle(element).fontSize), line: parseFloat(getComputedStyle(element).lineHeight) }));
  const before = await metrics();
  await page.getByRole("button", { name: "Aa 阅读排版" }).click();
  const panel = page.getByTestId("reader-typography-popover");
  await panel.getByRole("button", { name: "增大字号" }).click();
  await panel.getByRole("button", { name: "增大字号" }).click();
  await panel.getByRole("radio", { name: "2.0" }).check({ force: true });
  await expect.poll(async () => (await metrics()).size).toBe(before.size + 2);
  const changed = await metrics();
  expect(changed.line / changed.size).toBeCloseTo(2, 1);
  expect(changed.line).toBeGreaterThan(before.line);

  // A reload keeps the choice.
  await page.reload();
  await expect.poll(async () => (await metrics()).size).toBe(before.size + 2);
  expect((await metrics()).line / (await metrics()).size).toBeCloseTo(2, 1);

  // Restoring the defaults puts the text back as it was first.
  await page.getByRole("button", { name: "Aa 阅读排版" }).click();
  await page.getByTestId("reader-typography-reset").click();
  await expect.poll(async () => (await metrics()).size).toBe(before.size);
  expect((await metrics()).line).toBeCloseTo(before.line, 1);
  await page.reload();
  await expect.poll(async () => (await metrics()).size).toBe(before.size);
});

test("speakers: a rename in one tab shows in another without a reload, and photos are requested with the request marker", async ({ page, context }) => {
  await installMockBackend(page, { mode: "server" });
  const other = await context.newPage();
  await installMockBackend(other, { mode: "server" });
  const url = `/contents/${SPEAKERS_CONTENT}?tab=transcript`;
  await page.goto(url);
  await other.goto(url);
  await expect(page.getByRole("group", { name: "林老师，0:00" })).toBeVisible();
  await expect(other.getByRole("group", { name: "林老师，0:00" })).toBeVisible();
  // The second tab must not be reloaded: the mark would go with it.
  await other.evaluate(() => ((window as unknown as { __opened: boolean }).__opened = true));

  await page.locator(`[data-testid="turn-speaker"][data-speaker-id="${SPEAKER_TEACHER}"]`).first().click();
  await page.getByTestId("speaker-card-edit").click();
  await page.getByTestId("speaker-name-input").fill("陈老师");
  await page.getByTestId("speaker-edit-save").click();

  await expect(page.getByRole("group", { name: "陈老师，0:00" })).toBeVisible();
  await expect(other.getByRole("group", { name: "陈老师，0:00" })).toBeVisible();
  await expect(other.getByRole("group", { name: "林老师，0:00" })).toHaveCount(0);
  expect(await other.evaluate(() => (window as unknown as { __opened?: boolean }).__opened)).toBe(true);

  // The teacher's photo is fetched through the API client, so every request carries its marker.
  const photos = speakersRequests(page).avatarHeaders;
  expect(photos.length).toBeGreaterThan(0);
  for (const headers of photos) {
    expect(headers["x-amber-request"]).toBe("1");
    expect(headers["accept"]).toContain("image/");
  }
  await expect(page.getByTestId("turn-speaker").first().locator('[data-kind="photo"]')).toBeVisible();
});
