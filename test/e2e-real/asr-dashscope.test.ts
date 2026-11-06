import { createReadStream, existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DashscopeAsrProviderFactory } from "../../src/server/adapters/asr/dashscope/index.ts";
import { DirectOutboundHttpClient } from "../../src/server/adapters/outbound-http/direct.ts";
import { truncateTerminologyForAsr } from "../../src/server/domain/asr.ts";
import type { MediaAsset } from "../../src/server/domain/media-asset.ts";
import type { AsrProviderProfile } from "../../src/server/domain/provider-profile.ts";
import type { AsrJobProvider, AsrJobStatus } from "../../src/server/ports/asr-provider.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../src/server/ports/outbound-http.ts";
import { ASR_PRESETS } from "../../src/shared/asr-presets.ts";
import { ASR_KEYTERMS_MAX, ASR_POLL_INTERVAL_MAX_MS, ASR_POLL_INTERVAL_MS } from "../../src/shared/defaults.ts";
import { KNOWN_MISHEARD_TERMS } from "../fixtures/asr/index.ts";

/**
 * Real recorded-file recognition on Alibaba Cloud Model Studio (DashScope). Runs only with
 * `AMBER_E2E_ASR=1` and a per-run approval (no paid call without the env switch and
 * per-run approval). Inputs come from the environment and never enter git:
 *
 * - `AMBER_E2E_BAILIAN_API_KEY`: used in memory only, never printed;
 * - `AMBER_E2E_ASR_SAMPLE_FILE`: a short FLAC clip outside the repo;
 * - `AMBER_E2E_ASR_MODEL` (optional): one of the preset's models, the default one if unset;
 * - `AMBER_E2E_ASR_LANGUAGE` (optional): the sample's BCP-47 language, sent as the hint.
 *
 * One job is submitted and queried until it is done; the evidence printed is counts,
 * timings, the request parameters and the first sentences, never the key or a URL.
 */

const enabled = process.env["AMBER_E2E_ASR"] === "1";
const MAX_WAIT_MS = 15 * 60_000;
const SHOWN_SENTENCES = 3;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** Keeps the JSON body of the job submission; headers (the key) are never kept. */
class CapturingHttp implements OutboundHttpClient {
  submission: Record<string, unknown> | undefined;
  readonly kinds: string[] = [];
  private readonly inner = new DirectOutboundHttpClient();

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const path = new URL(request.url).pathname;
    this.kinds.push(path.endsWith("/asr/transcription") ? "submit" : path.startsWith("/api/v1/uploads") ? "policy" : path.startsWith("/api/v1/tasks/") ? "poll" : "storage");
    if (path.endsWith("/asr/transcription") && typeof request.body === "string") {
      this.submission = JSON.parse(request.body) as Record<string, unknown>;
    }
    return this.inner.request(request);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)("real ASR (Alibaba Cloud Model Studio)", () => {
  it(
    "transcribes a short sample as a job and normalizes the result",
    async () => {
      const apiKey = required("AMBER_E2E_BAILIAN_API_KEY");
      const sample = required("AMBER_E2E_ASR_SAMPLE_FILE");
      expect(existsSync(sample)).toBe(true);
      const model = process.env["AMBER_E2E_ASR_MODEL"] || ASR_PRESETS.dashscope.defaultModel;
      expect(ASR_PRESETS.dashscope.models).toContain(model);

      const language = process.env["AMBER_E2E_ASR_LANGUAGE"];
      const http = new CapturingHttp();
      const factory = new DashscopeAsrProviderFactory({
        http,
        files: { read: (ref) => createReadStream(ref) as AsyncIterable<Uint8Array> },
        secrets: { reveal: () => apiKey, revealVersioned: () => ({ plaintext: apiKey, version: { versionId: "e2e", setAt: 0 } }) },
      });
      const profile: AsrProviderProfile = { id: "e2e", userId: "e2e", name: "e2e", provider: "dashscope", models: [{ modelId: model }], credentialRef: "e2e", createdAt: Date.now() };
      const provider = factory.create(profile, model) as AsrJobProvider;
      const sizeBytes = statSync(sample).size;
      const audio: MediaAsset = {
        id: "e2e",
        userId: "e2e",
        contentId: "e2e",
        kind: "extracted_audio",
        storageRef: sample,
        mimeType: "audio/flac",
        sizeBytes,
        availability: "available",
        retentionPolicy: "ephemeral",
        createdAt: Date.now(),
      };
      const terminology = provider.capabilities.terminologyBias
        ? truncateTerminologyForAsr(KNOWN_MISHEARD_TERMS, provider.capabilities, ASR_KEYTERMS_MAX).entries
        : [];

      const signal = AbortSignal.timeout(MAX_WAIT_MS);
      let paidCalls = 0;
      const startedAt = Date.now();
      const handle = await provider.submit(
        { audio, terminology, ...(language === undefined || language === "" ? {} : { language }) },
        { signal, onRequestStart: () => (paidCalls += 1) },
      );
      const submittedAt = Date.now();
      expect(paidCalls).toBe(1);
      expect(handle).toMatchObject({ version: 1, provider: "dashscope" });

      let status: AsrJobStatus = { state: "pending" };
      let polls = 0;
      let wait = ASR_POLL_INTERVAL_MS;
      while (status.state === "pending") {
        await sleep(status.retryAfterMs ?? wait);
        wait = Math.min(ASR_POLL_INTERVAL_MAX_MS, Math.round(wait * 1.5));
        polls += 1;
        status = await provider.poll(handle, { signal });
      }
      expect(status.state).toBe("done");
      if (status.state !== "done") {
        return;
      }
      const { result } = status;
      expect(result.segments.length).toBeGreaterThan(0);
      for (const [index, segment] of result.segments.entries()) {
        expect(segment.startMs).toBeLessThanOrEqual(segment.endMs);
        if (index > 0) {
          expect(segment.startMs).toBeGreaterThanOrEqual((result.segments[index - 1] as { startMs: number }).startMs);
        }
      }

      const transcript = result.segments.map((segment) => segment.text).join("");
      const evidence = {
        model,
        uploadBytes: sizeBytes,
        uploadAndSubmitMs: submittedAt - startedAt,
        jobMs: Date.now() - submittedAt,
        polls,
        requests: http.kinds,
        parameters: (http.submission?.["parameters"] as Record<string, unknown> | undefined) ?? null,
        segments: result.segments.length,
        words: result.words?.length ?? 0,
        timing: result.words === undefined ? "segment_only" : "exact_words",
        language: result.language,
        durationMs: result.durationMs,
        lastEndMs: result.segments.at(-1)?.endMs,
        termSpelling: Object.fromEntries(KNOWN_MISHEARD_TERMS.map((entry) => [entry.term, transcript.includes(entry.term)])),
        firstSentences: result.segments.slice(0, SHOWN_SENTENCES).map((segment) => segment.text),
      };
      console.info(`dashscope evidence ${JSON.stringify(evidence)}`);
    },
    MAX_WAIT_MS + 60_000,
  );
});
