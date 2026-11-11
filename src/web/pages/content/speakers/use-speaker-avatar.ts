import { useQuery } from "@tanstack/react-query";
import { SPEAKER_AVATAR_MAX_BYTES } from "../../../../shared/defaults.ts";
import { SPEAKER_AVATAR_MIMES } from "../../../../shared/dto/speaker.ts";
import { useApi } from "../../../api/context.tsx";
import { contentKeys } from "../content-data.ts";
import { base64Of } from "./photo-crop.ts";

/** The types the server stores; offered as the request's `Accept`. */
const AVATAR_ACCEPT = SPEAKER_AVATAR_MIMES.join(", ");
/** The response type is checked by family; the bytes are then checked against the stored types here. */
const AVATAR_ACCEPT_PREFIX = "image/";

/**
 * The image type of photo bytes, from their header: a `data:` URL needs one, and the
 * response body is only bytes.
 */
export function imageMimeOf(bytes: Uint8Array): (typeof SPEAKER_AVATAR_MIMES)[number] | undefined {
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

/**
 * A URL an `<img>` can show for a speaker's photo, or `undefined` while it loads, when the
 * speaker has none, or when it cannot be read (the caller then shows the letter avatar).
 *
 * The bytes come through `ApiClient`, which authenticates the request: a plain `<img src>`
 * on the photo route would arrive without the sidecar token. They are cached under a key that
 * includes `avatarVersion`, so a new photo is a new key and an unchanged one is never fetched
 * twice. The URL is a `data:` URL because the page's image policy admits `data:` and `https:`
 * sources but not `blob:`; it holds no resource, so there is nothing to revoke when the
 * avatar leaves the screen, and the cache entry is dropped with the query once unused.
 */
export function useSpeakerAvatar(contentId: string, speaker: { id: string; avatarVersion?: number | undefined }): string | undefined {
  const client = useApi();
  const version = speaker.avatarVersion;
  const photo = useQuery({
    queryKey: contentKeys.speakerAvatar(contentId, speaker.id, version ?? 0),
    queryFn: async ({ signal }) => {
      const bytes = new Uint8Array(
        await client.bytes(`/api/contents/${encodeURIComponent(contentId)}/speakers/${encodeURIComponent(speaker.id)}/avatar`, {
          accept: AVATAR_ACCEPT,
          acceptPrefix: AVATAR_ACCEPT_PREFIX,
          maxBytes: SPEAKER_AVATAR_MAX_BYTES,
          signal,
        }),
      );
      const mime = imageMimeOf(bytes);
      if (mime === undefined) throw new Error("unrecognized image");
      return `data:${mime};base64,${base64Of(bytes)}`;
    },
    enabled: version !== undefined,
    // The version is part of the key, so a cached photo never goes stale.
    staleTime: Infinity,
    retry: false,
  });
  return version === undefined ? undefined : photo.data;
}
