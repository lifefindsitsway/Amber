import { z } from "zod";

/**
 * The danmaku preferences of the local player, kept in local storage under
 * `DANMAKU_PREFS_KEY` and carried by backups. Off until the user turns it on.
 * `density`: share of items shown in dense stretches (1 = all); `opacity`: 0.2–1;
 * `fontScale`: size relative to the default.
 */
export const danmakuPrefsSchema = z
  .object({
    enabled: z.boolean(),
    density: z.number().min(0.1).max(1),
    opacity: z.number().min(0.2).max(1),
    fontScale: z.number().min(0.5).max(2),
  })
  .strict();
export type DanmakuPrefs = z.infer<typeof danmakuPrefsSchema>;

export const DANMAKU_PREFS_KEY = "amber.player.danmaku";
export const DANMAKU_PREFS_DEFAULT: DanmakuPrefs = { enabled: false, density: 1, opacity: 0.85, fontScale: 1 };

/** The width the user last gave a figure, used for new ones; a number in [FIGURE_WIDTH_MIN_RATIO, 1]. */
export const FIGURE_WIDTH_PREF_KEY = "amber.figures.width";
