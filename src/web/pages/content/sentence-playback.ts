import { usePlayRange } from "../../player/player-controller.tsx";
import type { SentencePlayback } from "./citation-card.tsx";

/**
 * 「播放这句」 for the page's player: plays the sentence and stops at its end where the player
 * can, only moves there (「跳到这句」) where it cannot, and offers nothing without a player.
 * Called by the long-lived body that holds the citations rather than by a hover card, so a
 * card closing does not cancel the stop at the sentence's end.
 */
export function useSentencePlayback(): SentencePlayback {
  const { mode, playRange } = usePlayRange();
  return { mode, playRange };
}
