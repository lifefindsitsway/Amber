import { PLATFORM_METADATA_TIMEOUT_MS } from "../../shared/defaults.ts";
import type { ContentDescriptionFetchDto, DescriptionFetchResult } from "../../shared/dto/content.ts";
import { capDescription, type DescriptionClock, type PlatformDescription } from "../domain/content-description.ts";
import type { Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { FairGroupRef } from "../pipeline/fair-semaphore.ts";
import { platformTarget, type PlatformAccess } from "../pipeline/stages/platform-access.ts";
import type { ContentService } from "./contents.ts";

export interface ContentDescriptionServiceOptions {
  repository: Repository;
  /** The platform adapters and logins; YouTube's guest-first rule lives in its adapter. */
  platforms: PlatformAccess;
  /** The process's one issuer of description request times, shared with the source stage. */
  descriptionClock: DescriptionClock;
  /** Builds the answer's Content exactly as the detail endpoint does. */
  details: Pick<ContentService, "detailIn">;
  /** The managed heavy-job governor: the read runs the platform's extractor. */
  heavy?: { run<T>(ref: FairGroupRef, signal: AbortSignal, work: () => Promise<T>): Promise<T> };
  now?: () => number;
}

/**
 * Settles with `signal`'s reason as soon as it aborts, else as `promise` does. `promise`
 * always gets a handler, so a rejection after the abort is never unhandled.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function notPlatformContent(): Error {
  return amberError("invalid_request", "only platform contents have a platform description", { params: { detail: "contentId" } });
}

/** Whether `now` still points at the platform video `then` was read from; the part does not matter, every part shares one description. */
function samePlatformVideo(then: Content, now: Content): boolean {
  return then.source.kind === now.source.kind && then.source.platformContentId === now.source.platformContentId;
}

/**
 * `POST /api/contents/:id/description/fetch`: reads a platform Content's description from
 * the platform once, on the user's request, and stores it. Only the three description
 * fields are written — never `updatedAt`, the title, chapters, transcripts, Tasks, the
 * search projection or artifacts — so asking for a description is not an edit.
 */
export class ContentDescriptionService {
  private readonly options: ContentDescriptionServiceOptions;
  private readonly now: () => number;
  /**
   * The read in flight per owner and Content. A second click, or a second window, joins it
   * instead of starting another extractor run; the entry goes when the read settles, so
   * the next click reads again.
   */
  private readonly executions = new Map<string, Promise<ContentDescriptionFetchDto>>();

  constructor(options: ContentDescriptionServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * The answer is `found` / `empty` when this read settled the stored description,
   * `superseded` when a request sent later had settled it already (or the Content now
   * points at another video), `unknown` when the platform gave nothing readable (nothing is
   * written). A platform failure is passed on and writes nothing. `signal` is this caller's:
   * when it aborts, the caller stops waiting, but the shared read goes on for the others
   * and still stores its answer.
   */
  async fetch(principal: RequestPrincipal, contentId: string, signal: AbortSignal): Promise<ContentDescriptionFetchDto> {
    signal.throwIfAborted();
    const owner = principal.userId;
    // Checked for every caller, also one that joins a read in flight; no transaction is held while waiting.
    const content = this.options.repository.withTransaction((scope) => this.platformContent(scope, owner, contentId));
    const key = JSON.stringify([owner, contentId]);
    let execution = this.executions.get(key);
    if (execution === undefined) {
      const started = this.execute(owner, content);
      const forget = (): void => {
        if (this.executions.get(key) === started) {
          this.executions.delete(key);
        }
      };
      started.then(forget, forget);
      this.executions.set(key, started);
      execution = started;
    }
    return untilAborted(execution, signal);
  }

  /** The owner's Content as a description source: it must exist outside the trash and come from a platform. */
  private platformContent(scope: RepositoryScope, owner: string, contentId: string): Content {
    const content = scope.contents.get(owner, contentId);
    if (content === undefined) {
      throw amberError("not_found", "content not found");
    }
    if (content.source.kind === "local") {
      throw notPlatformContent();
    }
    return content;
  }

  /**
   * One shared read. Its own abort controller and `PLATFORM_METADATA_TIMEOUT_MS` deadline
   * start now and cover the wait for a heavy-job slot as well as the extractor run: a read
   * that cannot finish in time leaves the queue or stops the process and fails as the
   * platform being unreachable, the same class a metadata read that times out has. No
   * caller's disconnect reaches this controller.
   */
  private execute(owner: string, content: Content): Promise<ContentDescriptionFetchDto> {
    const controller = new AbortController();
    const timedOut = amberError("source_unreachable", "the description read timed out");
    const timer = setTimeout(() => controller.abort(timedOut), PLATFORM_METADATA_TIMEOUT_MS);
    const run = async (): Promise<ContentDescriptionFetchDto> => {
      const { checkedAt, answer } = await this.heavyJob(owner, controller.signal, async () => {
        // The login is read once the slot is granted, so one changed while waiting is used.
        const target = platformTarget(this.options.platforms, content);
        if (target === undefined) {
          throw notPlatformContent();
        }
        // Taken as the request goes out, after any wait: a request sent later must win over this one.
        const checkedAt = this.options.descriptionClock.issue();
        return { checkedAt, answer: await target.adapter.fetchDescription(target.ref, target.auth, controller.signal) };
      });
      // An answer that arrives after the deadline is dropped, not stored.
      controller.signal.throwIfAborted();
      return this.settle(owner, content, checkedAt, answer);
    };
    return untilAborted(run(), controller.signal)
      .catch((error: unknown) => {
        // Whatever the aborted extractor or queue rejected with, the caller learns of the timeout.
        throw controller.signal.aborted ? timedOut : error;
      })
      .finally(() => clearTimeout(timer));
  }

  private heavyJob<T>(owner: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const heavy = this.options.heavy;
    return heavy === undefined ? work() : heavy.run({ key: `foreground:${owner}`, createdAt: this.now() }, signal, work);
  }

  /**
   * Stores the platform's answer and reads the Content back, in one transaction. A Content
   * gone or trashed meanwhile is `not_found` and nothing is written; one that now points at
   * another platform video keeps what it has.
   */
  private settle(owner: string, read: Content, checkedAt: number, answer: PlatformDescription): ContentDescriptionFetchDto {
    return this.options.repository.withTransaction((scope) => {
      const current = scope.contents.get(owner, read.id);
      if (current === undefined) {
        throw amberError("not_found", "content not found");
      }
      const result = samePlatformVideo(read, current) ? this.store(scope, owner, read.id, checkedAt, answer) : "superseded";
      const latest = scope.contents.get(owner, read.id) as Content;
      return { result, content: this.options.details.detailIn(scope, owner, latest) };
    });
  }

  private store(scope: RepositoryScope, owner: string, contentId: string, checkedAt: number, answer: PlatformDescription): DescriptionFetchResult {
    switch (answer.state) {
      case "unknown":
        return "unknown";
      case "empty":
        return scope.contents.setDescription(owner, contentId, { description: null, truncated: false, checkedAt }, this.now()) ? "empty" : "superseded";
      case "found": {
        const capped = capDescription(answer.text);
        return scope.contents.setDescription(owner, contentId, { description: capped.text, truncated: capped.truncated, checkedAt }, this.now()) ? "found" : "superseded";
      }
    }
  }
}
