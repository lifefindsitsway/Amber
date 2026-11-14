import { ChevronsDown, ChevronsUp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { READER_SCROLLER_CLASS } from "./reader-sentences.tsx";

/** A round button floating over the reader's corner; translucent so it hides little text. */
function ReaderJump(props: { label: string; onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      className="flex size-[28px] items-center justify-center rounded-full border border-line bg-surface/90 text-muted shadow hover:bg-sunken hover:text-ink"
      onClick={props.onClick}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

/**
 * The 「去顶部 / 去底部」 buttons in the reader's bottom right corner.
 *
 * The reading text keeps its side margin from the inside of the scroller's scrollbar gutters, and
 * how wide those gutters are depends on the platform's scrollbars. So the buttons are placed in a
 * still copy of the scroller's box: the same class reserves the same gutters (`overflow-hidden`
 * still reserves a stable gutter), and an absolutely positioned child is placed against its
 * containing block's padding box, which lies inside those gutters. The box is therefore 8px from
 * the gutter's inner edge whatever the scrollbar takes, and being 28px wide it spans 8–36px from
 * that edge: clear of text at the default side margin or wider, and never over the scrollbar. The
 * side margin is in px, so the box and its buttons are sized in px too: in rem they would grow
 * with the browser's font size and reach into text the margin no longer keeps clear. The copy has
 * no inline padding, and its block padding does not move a `bottom` offset, which is measured
 * from the padding box's bottom edge, so the box stays 16px above the host's bottom.
 *
 * The copy lets pointer input through to the rows below except on the buttons. It stacks above
 * the rows and the sticky speaker marker and below anything that floats over the reader.
 */
export function ReaderJumpButtons(props: { onTop: () => void; onBottom: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={`${READER_SCROLLER_CLASS} pointer-events-none absolute inset-0 z-20 overflow-hidden`} data-testid="reader-jump-layer">
      {/* One tight box, the direct parent of both buttons, so its bounds are the buttons' bounds. */}
      <div className="pointer-events-auto absolute right-[8px] bottom-[16px] flex flex-col gap-[8px]">
        <ReaderJump label={t("contentView.transcript.toTop")} onClick={props.onTop} testId="reader-to-top">
          <ChevronsUp size={16} />
        </ReaderJump>
        <ReaderJump label={t("contentView.transcript.toBottom")} onClick={props.onBottom} testId="reader-to-bottom">
          <ChevronsDown size={16} />
        </ReaderJump>
      </div>
    </div>
  );
}
