import { amberError } from "../../../domain/errors.ts";
import type { LlmContentPart, LlmRequest } from "../../../domain/llm.ts";
import type { FileStore } from "../../../ports/file-store.ts";

/** Audio formats the `input_audio` content part accepts, by MIME type. */
const AUDIO_FORMATS: Readonly<Record<string, "wav" | "mp3">> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
};

/**
 * The canonical MIME types advertised as `LlmProvider.audioMimeTypes`, preferred first. MP3
 * leads: clips travel base64-encoded inside the JSON body, and compatible endpoints cap that
 * body well below what uncompressed WAV needs for a chunk of speech
 * (Gemini allows 20 MB per request, Azure OpenAI 20 MB of audio).
 */
export const OPENAI_AUDIO_MIME_TYPES: readonly string[] = ["audio/mpeg", "audio/wav"];

type ContentPart = { type: "text"; text: string } | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } };

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/**
 * The Chat Completions request body. Optional parameters appear only when the request
 * sets them: some relays reject optional parameters for some models, so an absent value
 * is an absent key, never `null`.
 *
 * The output cap is sent as `max_tokens`, the name DeepSeek documents and relays accept;
 * OpenAI's reasoning models reject it in favour of `max_completion_tokens`. Which name a
 * model wants is not knowable from its capability record, and behaviour must never depend
 * on the model name, so the broadly accepted field is used. Only "test connection" sends
 * `max_completion_tokens`, after the upstream explicitly rejected `max_tokens`.
 */
export interface ChatCompletionsBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: unknown; strict: true } };
  tools?: unknown[];
}

export async function encodeRequest(
  request: LlmRequest,
  streaming: boolean,
  files: Pick<FileStore, "read">,
  signal: AbortSignal,
): Promise<ChatCompletionsBody> {
  const messages: ChatMessage[] = [];
  if (request.system !== "") {
    messages.push({ role: "system", content: request.system });
  }
  for (const message of request.messages) {
    messages.push({ role: message.role, content: await encodeContent(message.content, files, signal) });
  }
  const body: ChatCompletionsBody = { model: request.modelRef.modelId, messages, stream: streaming };
  if (streaming) {
    // Without it a stream carries no usage, and the call could not be accounted for.
    body.stream_options = { include_usage: true };
  }
  if (request.maxOutputTokens !== undefined) {
    body.max_tokens = request.maxOutputTokens;
  }
  if (request.optional?.temperature !== undefined) {
    body.temperature = request.optional.temperature;
  }
  if (request.responseFormat !== undefined) {
    body.response_format = { type: "json_schema", json_schema: { name: "output", schema: request.responseFormat.schema, strict: true } };
  }
  return body;
}

/** A single text part is sent as a plain string, the form every relay understands. */
async function encodeContent(parts: readonly LlmContentPart[], files: Pick<FileStore, "read">, signal: AbortSignal): Promise<string | ContentPart[]> {
  const [only] = parts;
  if (parts.length === 1 && only?.type === "text") {
    return only.text;
  }
  const encoded: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      encoded.push({ type: "text", text: part.text });
      continue;
    }
    const format = AUDIO_FORMATS[part.mimeType.split(";")[0]?.trim().toLowerCase() ?? ""];
    if (format === undefined) {
      throw amberError("llm_capability", "audio format cannot be encoded for chat completions");
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read(part.dataRef)) {
      signal.throwIfAborted();
      chunks.push(chunk);
    }
    encoded.push({ type: "input_audio", input_audio: { data: Buffer.concat(chunks).toString("base64"), format } });
  }
  return encoded;
}
