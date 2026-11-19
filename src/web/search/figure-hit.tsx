import { useTranslation } from "react-i18next";
import type { FigureHitDto } from "../../shared/dto/search.ts";
import { formatDuration } from "../format.ts";

/**
 * What tells a figure hit apart from the Content's other figures: the frame's time for a
 * capture (the time a reader also sees beside the figure), otherwise 「图 N」, its place among
 * the live figures.
 */
export function useFigureHitLabel(): (hit: Pick<FigureHitDto, "ordinal" | "capturedAtMs">) => string {
  const { t } = useTranslation();
  return (hit) => (hit.capturedAtMs === undefined ? t("search.kind.figure", { n: hit.ordinal }) : t("search.kind.figureCapture", { time: formatDuration(hit.capturedAtMs) }));
}
