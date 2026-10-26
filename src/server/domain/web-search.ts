import type { AppError } from "../../shared/errors.ts";
import type { WebSearchReason, WebSearchService, WebSearchStatus } from "../../shared/enums.ts";

/**
 * One web page handed to the model for one answer, with the excerpt it actually saw, so a
 * later reader can check what the answer rested on after the page changed.
 */
export interface WebSource {
  /** ULID, unique across answers; the answer's text cites it as `[[web:<id>]]`. */
  id: string;
  /** 1-based position within the answer; the model saw it as `[[w<index>]]`. */
  index: number;
  /** http(s) only. */
  url: string;
  title: string;
  excerpt: string;
  publishedAt?: number;
  fetchedAt: number;
}

/**
 * The web search record of one answer. `planned` queries were planned, `requested` were
 * sent, `succeeded` came back; `sources` are the ones that went into the request.
 */
export interface ChatWebSearch {
  mode: "auto" | "force";
  status: WebSearchStatus;
  reason?: WebSearchReason;
  planned: number;
  requested: number;
  succeeded: number;
  queries: string[];
  sources: WebSource[];
  /** The last query error of a `failed` or `partial` search. */
  error?: AppError;
}

/** A user's web search service; at most one per user, its key only in the SecretStore. */
export interface WebSearchProfile {
  userId: string;
  service: WebSearchService;
  credentialRef?: string;
  createdAt: number;
  updatedAt: number;
}
