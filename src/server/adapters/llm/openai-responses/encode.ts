import { amberError } from "../../../domain/errors.ts";
import type { LlmContentPart, LlmRequest } from "../../../domain/llm.ts";

/** The name the JSON schema travels under; the protocol requires one. */
export const OUTPUT_FORMAT_NAME = "output";

interface InputMessage {
  role: "user" | "assistant";
  content: string;
}

/** A function tool in the protocol's flat shape (no `function` wrapper). */
export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  strict: boolean;
}

/**
 * The Responses request body. Optional parameters appear only when the request sets
 * them: some relays reject optional parameters for some models, so an absent value is an
 * absent key, never `null`.
 *
 * `store` is always `false`: the upstream would otherwise keep every prompt and answer for
 * at least 30 days, and history is resent as plain text anyway, never referenced by id. An
 * upstream that refuses it fails the request; it is never dropped to make a call pass.
 * Streams carry their usage in the terminal event, so there are no stream options to send.
 */
export interface ResponsesBody {
  model: string;
  instructions?: string;
  input: InputMessage[];
  stream?: true;
  store: false;
  max_output_tokens?: number;
  temperature?: number;
  text?: { format: { type: "json_schema"; name: string; schema: unknown; strict: true } };
  tools?: FunctionTool[];
}

/**
 * The wire body of a request. History goes out as plain text only: reasoning items are
 * never sent back. The protocol has no audio input here, so an audio part is a capability
 * error raised before anything is sent.
 */
export function encodeRequest(request: LlmRequest, streaming: boolean): ResponsesBody {
  const input = request.messages.map((message) => ({ role: message.role, content: textOf(message.content) }));
  const body: ResponsesBody = { model: request.modelRef.modelId, input, store: false };
  if (request.system !== "") {
    body.instructions = request.system;
  }
  if (streaming) {
    body.stream = true;
  }
  if (request.maxOutputTokens !== undefined) {
    body.max_output_tokens = request.maxOutputTokens;
  }
  if (request.optional?.temperature !== undefined) {
    body.temperature = request.optional.temperature;
  }
  if (request.responseFormat !== undefined) {
    body.text = { format: { type: "json_schema", name: OUTPUT_FORMAT_NAME, schema: request.responseFormat.schema, strict: true } };
  }
  return body;
}

/**
 * A message's text parts as one string: the plain form needs no role-specific part types
 * (input versus output text). The parts of one message are consecutive pieces of it.
 */
function textOf(parts: readonly LlmContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type !== "text") {
        throw amberError("llm_capability", "the responses protocol has no audio input");
      }
      return part.text;
    })
    .join("");
}
