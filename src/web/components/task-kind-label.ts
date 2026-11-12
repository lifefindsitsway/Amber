import type { TFunction } from "i18next";
import type { TaskDto } from "../../shared/dto/task.ts";

/**
 * The name of a Task's kind. A re-transcription made only to compare speakers with changes
 * nothing about the Content, so it is named for what it is rather than as the Content's
 * re-transcription.
 */
export function taskKindLabel(task: Pick<TaskDto, "kind" | "comparison">, t: TFunction): string {
  return task.comparison === true ? t("speakerCompare.taskKind") : t(`common.taskKind.${task.kind}`);
}
