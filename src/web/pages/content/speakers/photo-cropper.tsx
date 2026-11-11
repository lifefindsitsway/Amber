import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../ui/button.tsx";
import { Spinner } from "../../../ui/feedback.tsx";
import { CROP_ZOOM_MAX, drawCrop, encodeAvatar, initialCrop, normalizeCrop, panCrop, type CropState, type EncodedAvatar, type LoadedPhoto } from "./photo-crop.ts";

/** Side of the crop view in CSS pixels. */
export const CROP_VIEW_PX = 224;
/** Dims everything outside the circle, and rims the circle itself. */
const CROP_MASK_SHADOW = ["0 0 0 999px rgb(0 0 0 / 0.42)", "inset 0 0 0 1.5px rgb(255 255 255 / 0.8)"].join(", ");
/** Distance an arrow key moves the photo, in view pixels; Shift takes the larger step. */
const KEY_PAN_PX = 6;
const KEY_PAN_FAST_PX = 24;

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/**
 * Square cropping of a chosen photo: drag (or use the arrow keys) to position it under the
 * circle, a slider to zoom. The view is a canvas drawn from the decoded photo, and
 * confirming re-encodes exactly that square at avatar size.
 */
export function PhotoCropper(props: { photo: LoadedPhoto; onConfirm: (avatar: EncodedAvatar) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { photo } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined);
  const [crop, setCrop] = useState<CropState>(() => initialCrop(photo));
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || element === undefined || context === null || context === undefined) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const px = Math.round(CROP_VIEW_PX * ratio);
    if (element.width !== px) {
      element.width = px;
      element.height = px;
    }
    drawCrop(context, photo, crop, px);
  }, [photo, crop]);

  const pan = (dx: number, dy: number): void => setCrop((current) => panCrop(photo, current, dx, dy, CROP_VIEW_PX));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || drag.current !== undefined) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // A synthetic pointer cannot be captured; the move events still arrive.
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    pan(event.clientX - current.x, event.clientY - current.y);
    drag.current = { ...current, x: event.clientX, y: event.clientY };
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId === event.pointerId) drag.current = undefined;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const direction = ARROWS[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const step = event.shiftKey ? KEY_PAN_FAST_PX : KEY_PAN_PX;
    pan(direction[0] * step, direction[1] * step);
  };

  const confirm = async (): Promise<void> => {
    setWorking(true);
    setFailed(false);
    try {
      props.onConfirm(await encodeAvatar(photo, crop));
    } catch {
      // Only an unusable canvas or encoder lands here; the user can adjust and try again.
      setFailed(true);
      setWorking(false);
    }
  };

  const hintId = useId();
  return (
    <div className="flex flex-col items-center gap-3" data-testid="speaker-cropper">
      {/* The crop view is operated by pointer or arrow keys; the hint says so for everyone. */}
      <div
        role="group"
        tabIndex={0}
        aria-label={t("speakerIdentity.crop.area")}
        aria-describedby={hintId}
        className="relative cursor-grab touch-none overflow-hidden rounded-md bg-sunken outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
        style={{ width: CROP_VIEW_PX, height: CROP_VIEW_PX }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        data-testid="speaker-crop-area"
      >
        <canvas ref={canvas} width={CROP_VIEW_PX} height={CROP_VIEW_PX} className="block size-full" aria-hidden="true" />
        {/* Everything outside the circle is dimmed: what is inside becomes the avatar. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full" style={{ boxShadow: CROP_MASK_SHADOW }} />
      </div>
      <p id={hintId} className="max-w-56 text-center text-xs text-muted">
        {t("speakerIdentity.crop.areaHint")}
      </p>
      <label className="flex w-full items-center gap-3 text-xs text-muted">
        <span className="shrink-0">{t("speakerIdentity.crop.zoom")}</span>
        <input
          type="range"
          min={1}
          max={CROP_ZOOM_MAX}
          step={0.01}
          value={crop.zoom}
          className="min-w-0 flex-1 accent-[var(--color-accent)]"
          onChange={(event) => setCrop((current) => normalizeCrop(photo, { ...current, zoom: Number(event.target.value) }))}
          data-testid="speaker-crop-zoom"
        />
      </label>
      {failed ? (
        <p className="w-full text-xs text-danger" role="alert">
          {t("speakerIdentity.edit.photoEncodeFailed")}
        </p>
      ) : null}
      <div className="flex w-full justify-end gap-2">
        <Button size="sm" onClick={props.onCancel} disabled={working}>
          {t("speakerIdentity.crop.cancel")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void confirm()} disabled={working} data-testid="speaker-crop-confirm">
          {working ? <Spinner size={12} /> : null}
          {t("speakerIdentity.crop.confirm")}
        </Button>
      </div>
    </div>
  );
}
