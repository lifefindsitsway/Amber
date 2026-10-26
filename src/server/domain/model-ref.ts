import type { LlmProtocol } from "../../shared/enums.ts";

/**
 * Model identity is "which model of which Profile": two relays exposing the same model
 * name must stay distinguishable.
 */
export interface ModelRef {
  providerProfileId: string;
  modelId: string;
}

/** "Which model of which ASR profile". */
export interface AsrModelRef {
  asrProfileId: string;
  modelId: string;
}

/**
 * Keeps historical artifacts explainable after the Profile is renamed, switched to another
 * protocol or deleted: history shows the snapshot, never the Profile as it is now.
 */
export interface ModelRefSnapshot extends ModelRef {
  providerNameSnapshot: string;
  modelDisplaySnapshot: string;
  /** The Profile's protocol at the time of the call; absent on records stored before it was kept. */
  protocolSnapshot?: LlmProtocol;
}

/** Identity of a builtin or custom prompt / template version. */
export interface PromptRef {
  id: string;
  version: number;
}
