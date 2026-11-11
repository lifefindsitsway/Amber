import { describe, expect, it, vi } from "vitest";
import { SPEAKER_AVATAR_PX } from "../../../../../src/shared/defaults.ts";
import {
  CROP_ZOOM_MAX,
  cropSquare,
  encodeAvatar,
  initialCrop,
  loadPhoto,
  normalizeCrop,
  panCrop,
  PHOTO_DECODE_MAX_SIDE,
  PHOTO_SOURCE_MAX_BYTES,
  PhotoError,
  type LoadedPhoto,
} from "../../../../../src/web/pages/content/speakers/photo-crop.ts";

const WIDE = { width: 1600, height: 900 };

describe("crop geometry", () => {
  it("starts with the whole short side, centred", () => {
    expect(cropSquare(WIDE, initialCrop(WIDE))).toEqual({ side: 900, x: 350, y: 0 });
  });

  it("shrinks the square when zoomed in and never past the zoom limit", () => {
    expect(cropSquare(WIDE, { zoom: 2, centerX: 800, centerY: 450 }).side).toBe(450);
    expect(cropSquare(WIDE, { zoom: 99, centerX: 800, centerY: 450 }).side).toBe(900 / CROP_ZOOM_MAX);
    expect(cropSquare(WIDE, { zoom: 0.2, centerX: 800, centerY: 450 }).side).toBe(900);
  });

  it("keeps the square inside the photo wherever the centre is put", () => {
    expect(cropSquare(WIDE, { zoom: 1, centerX: -500, centerY: 5000 })).toEqual({ side: 900, x: 0, y: 0 });
    expect(cropSquare(WIDE, { zoom: 2, centerX: 5000, centerY: 5000 })).toEqual({ side: 450, x: 1150, y: 450 });
    expect(normalizeCrop(WIDE, { zoom: 2, centerX: 5000, centerY: -9 })).toEqual({ zoom: 2, centerX: 1375, centerY: 225 });
  });

  it("moves the photo under the circle: a drag to the right shows more of the left", () => {
    const start = { zoom: 2, centerX: 800, centerY: 450 };
    const moved = panCrop(WIDE, start, 56, 0, 225);
    // A 225 px view shows the 450 px square at half size: 56 px of drag = 112 source px.
    expect(moved.centerX).toBe(688);
    expect(moved.centerY).toBe(450);
    expect(panCrop(WIDE, start, 0, -112, 225).centerY).toBe(450 + 224);
  });

  it("stops dragging at the photo's edge", () => {
    const start = { zoom: 1, centerX: 800, centerY: 450 };
    expect(panCrop(WIDE, start, 100000, 0, 224).centerX).toBe(450);
    expect(panCrop(WIDE, start, -100000, 0, 224).centerX).toBe(1150);
  });
});

describe("loadPhoto", () => {
  it("refuses a file that is too large before decoding it", async () => {
    const huge = new File([new Uint8Array(8)], "big.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: PHOTO_SOURCE_MAX_BYTES + 1 });
    await expect(loadPhoto(huge)).rejects.toMatchObject({ reason: "too_large" });
  });

  it("decodes with a bounded size, taking the aspect ratio from a small probe that honours the orientation", async () => {
    const close = vi.fn();
    const createImageBitmap = vi.fn(async (_file: File, options: ImageBitmapOptions) => {
      if (options.resizeHeight === undefined) return { width: 64, height: 36, close };
      return { width: options.resizeWidth, height: options.resizeHeight, close };
    });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = new File([new Uint8Array(4)], "a.jpg", { type: "image/jpeg" });
    const photo = await loadPhoto(file);
    expect(createImageBitmap).toHaveBeenNthCalledWith(1, file, { imageOrientation: "from-image", resizeWidth: 64 });
    expect(createImageBitmap).toHaveBeenNthCalledWith(2, file, { imageOrientation: "from-image", resizeWidth: PHOTO_DECODE_MAX_SIDE, resizeHeight: 576, resizeQuality: "high" });
    expect([photo.width, photo.height]).toEqual([PHOTO_DECODE_MAX_SIDE, 576]);
    // The probe is freed at once; the photo when released.
    expect(close).toHaveBeenCalledTimes(1);
    photo.release();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("bounds a portrait photo by its height", async () => {
    const createImageBitmap = vi.fn(async (_file: File, options: ImageBitmapOptions) =>
      options.resizeHeight === undefined ? { width: 64, height: 128, close: () => undefined } : { width: options.resizeWidth, height: options.resizeHeight, close: () => undefined },
    );
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const photo = await loadPhoto(new File([new Uint8Array(4)], "p.jpg", { type: "image/jpeg" }));
    expect([photo.width, photo.height]).toEqual([PHOTO_DECODE_MAX_SIDE / 2, PHOTO_DECODE_MAX_SIDE]);
  });

  it("falls back to an image element when the browser cannot decode a bounded bitmap", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("unsupported");
    });
    class LoadingImage {
      naturalWidth = 30;
      naturalHeight = 20;
      onload: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadingImage);
    const photo = await loadPhoto(new File([new Uint8Array(4)], "a.png", { type: "image/png" }));
    expect([photo.width, photo.height]).toEqual([30, 20]);
  });

  it("reports a file the browser cannot read as unreadable", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("bad");
    });
    class BrokenImage {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    await expect(loadPhoto(new File(["not an image"], "x.png", { type: "image/png" }))).rejects.toBeInstanceOf(PhotoError);
  });
});

describe("encodeAvatar", () => {
  const photo: LoadedPhoto = { source: {} as CanvasImageSource, width: 1600, height: 900, release: () => undefined };

  function stubCanvas(encoders: Record<string, number | null>) {
    const draw = vi.fn();
    const context = { clearRect: vi.fn(), drawImage: draw, imageSmoothingQuality: "low" };
    const requested: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback: BlobCallback, type?: string) {
      requested.push(type ?? "");
      const size = type === undefined ? null : encoders[type];
      // A browser without an encoder for a type answers with PNG.
      if (size === undefined || size === null) callback(new Blob([new Uint8Array(10)], { type: "image/png" }));
      else callback(new Blob([new Uint8Array(size)], { type: type ?? "" }));
    } as never);
    return { draw, requested };
  }

  it("draws the crop square at avatar size and prefers WebP", async () => {
    const { draw, requested } = stubCanvas({ "image/webp": 20 });
    const avatar = await encodeAvatar(photo, initialCrop(photo));
    expect(avatar.mime).toBe("image/webp");
    expect(requested).toEqual(["image/webp"]);
    expect(draw).toHaveBeenCalledWith(photo.source, 350, 0, 900, 900, 0, 0, SPEAKER_AVATAR_PX, SPEAKER_AVATAR_PX);
    expect(avatar.previewUrl).toBe(`data:image/webp;base64,${avatar.data}`);
    expect(atob(avatar.data)).toHaveLength(20);
  });

  it("falls back to PNG when the browser cannot encode WebP", async () => {
    const { requested } = stubCanvas({ "image/png": 30 });
    const avatar = await encodeAvatar(photo, initialCrop(photo));
    expect(avatar.mime).toBe("image/png");
    expect(requested).toEqual(["image/webp", "image/png"]);
  });

  it("falls through to JPEG when the PNG would exceed the size limit", async () => {
    stubCanvas({ "image/png": 10_000_000, "image/jpeg": 40 });
    expect((await encodeAvatar(photo, initialCrop(photo))).mime).toBe("image/jpeg");
  });

  it("fails when nothing fits", async () => {
    stubCanvas({ "image/webp": 10_000_000, "image/png": 10_000_000, "image/jpeg": 10_000_000 });
    await expect(encodeAvatar(photo, initialCrop(photo))).rejects.toMatchObject({ reason: "encode_failed" });
  });
});
