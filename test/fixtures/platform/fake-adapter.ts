import { writeFile } from "node:fs/promises";
import { parseBilibiliUrl } from "../../../src/server/adapters/platform/bilibili/url.ts";
import { parseYoutubeUrl } from "../../../src/server/adapters/platform/youtube/url.ts";
import { amberError } from "../../../src/server/domain/errors.ts";
import type { Platform } from "../../../src/server/domain/platform.ts";
import type {
  CanonicalSubtitle,
  ParsedPlatformUrl,
  PlatformCollection,
  PlatformContentRef,
  PlatformCredential,
  PlatformDescription,
  PlatformMetadata,
  PlatformPart,
  PlatformSourceAdapter,
  SubtitleTrackRef,
} from "../../../src/server/ports/platform-source.ts";

/** One scripted video: parts (bilibili only), metadata and subtitle bodies by track locator. */
export interface FakeVideo {
  parts?: Array<{ platformPartId: string; title?: string; durationMs?: number }>;
  metadata?: Partial<PlatformMetadata>;
  subtitles?: Record<string, CanonicalSubtitle["cues"]>;
  /** Thrown by fetchMetadata instead of answering. */
  metadataError?: Error;
  subtitleError?: Error;
  /** What fetchDescription answers; `{ state: "unknown" }` when unset. Metadata takes its own from `metadata.description`. */
  description?: PlatformDescription;
  /** Thrown by fetchDescription instead of answering. */
  descriptionError?: Error;
}

export interface FakeCall {
  method: string;
  target: string;
  /** Whether a credential was handed in (never its value). */
  withAuth: boolean;
}

/**
 * A scripted `PlatformSourceAdapter` for tests: URL recognition is the real adapter's
 * parser; everything that would go online answers from the script and is logged. As
 * bilibili it also resolves part ids and short links.
 */
export class FakePlatformAdapter implements PlatformSourceAdapter {
  readonly kind: Platform;
  readonly cookieDomains: readonly string[];
  readonly calls: FakeCall[] = [];
  readonly videos = new Map<string, FakeVideo>();
  readonly collections = new Map<string, PlatformCollection>();
  readonly shortLinks = new Map<string, string>();
  credentialStatus: "valid" | "expired" | "unknown" = "valid";
  declare resolveParts?: NonNullable<PlatformSourceAdapter["resolveParts"]>;
  declare resolveUrl?: NonNullable<PlatformSourceAdapter["resolveUrl"]>;

  constructor(kind: Platform) {
    this.kind = kind;
    this.cookieDomains = kind === "bilibili" ? ["bilibili.com"] : ["youtube.com"];
    if (kind === "bilibili") {
      this.resolveParts = async (ref, auth) => {
        this.log("resolveParts", ref.platformContentId, auth);
        return this.partsOf(ref.platformContentId);
      };
      this.resolveUrl = async (url) => {
        this.log("resolveUrl", url, undefined);
        return this.shortLinks.get(url) ?? null;
      };
    }
  }

  parse(url: string): ParsedPlatformUrl | null {
    return this.kind === "bilibili" ? parseBilibiliUrl(url) : parseYoutubeUrl(url);
  }

  video(id: string, video: FakeVideo): this {
    this.videos.set(id, video);
    return this;
  }

  async fetchMetadata(ref: PlatformContentRef, auth: PlatformCredential | undefined): Promise<PlatformMetadata> {
    this.log("fetchMetadata", ref.platformContentId, auth);
    await auth?.cookies();
    const video = this.videos.get(ref.platformContentId) ?? {};
    if (video.metadataError !== undefined) {
      throw video.metadataError;
    }
    return { title: `title ${ref.platformContentId}`, durationMs: 600_000, subtitleTracks: [], description: { state: "unknown" }, ...video.metadata };
  }

  async fetchDescription(ref: PlatformContentRef, auth: PlatformCredential | undefined): Promise<PlatformDescription> {
    this.log("fetchDescription", ref.platformContentId, auth);
    await auth?.cookies();
    const video = this.videos.get(ref.platformContentId) ?? {};
    if (video.descriptionError !== undefined) {
      throw video.descriptionError;
    }
    return video.description ?? { state: "unknown" };
  }

  async fetchSubtitle(ref: PlatformContentRef, track: SubtitleTrackRef, auth: PlatformCredential | undefined): Promise<CanonicalSubtitle> {
    this.log("fetchSubtitle", `${ref.platformContentId}#${track.locator}`, auth);
    const video = this.videos.get(ref.platformContentId) ?? {};
    if (video.subtitleError !== undefined) {
      throw video.subtitleError;
    }
    const cues = video.subtitles?.[track.locator];
    if (cues === undefined) {
      throw amberError("source_unreachable", "no scripted subtitle");
    }
    return { language: track.language, cues, acquisition: auth === undefined ? "guest" : "authenticated" };
  }

  async checkCredential(auth: PlatformCredential): Promise<"valid" | "expired" | "unknown"> {
    this.log("checkCredential", "", auth);
    await auth.cookies();
    return this.credentialStatus;
  }

  async fetchCollection(platformCollectionId: string, auth: PlatformCredential | undefined): Promise<PlatformCollection> {
    this.log("fetchCollection", platformCollectionId, auth);
    const collection = this.collections.get(platformCollectionId);
    if (collection === undefined) {
      throw amberError("source_unreachable", "no scripted collection");
    }
    return collection;
  }

  async fetchAudio(
    ref: PlatformContentRef,
    auth: PlatformCredential | undefined,
    output: { path: string },
    onProgress: (progress: number) => void = () => undefined,
  ): Promise<{ sizeBytes: number }> {
    this.log("fetchAudio", ref.platformContentId, auth);
    const bytes = Buffer.from(`audio of ${ref.platformContentId}`);
    onProgress(0.5);
    await writeFile(output.path, bytes);
    onProgress(1);
    return { sizeBytes: bytes.length };
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private partsOf(bvid: string): PlatformPart[] {
    const parts = this.videos.get(bvid)?.parts ?? [{ platformPartId: `${bvid}-cid` }];
    return parts.map((part, index) => ({
      platformPartId: part.platformPartId,
      index: index + 1,
      title: part.title ?? "",
      durationMs: part.durationMs ?? 600_000,
      canonicalUrl: `https://www.bilibili.com/video/${bvid}${parts.length > 1 ? `?p=${index + 1}` : ""}`,
    }));
  }

  private log(method: string, target: string, auth: PlatformCredential | undefined): void {
    this.calls.push({ method, target, withAuth: auth !== undefined });
  }
}
