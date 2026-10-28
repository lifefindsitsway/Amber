import { useTranslation } from "react-i18next";
import type { TaskDto } from "../../shared/dto/task.ts";
import { Button } from "../ui/button.tsx";
import { useStoredValue } from "../use-stored-value.ts";
import { TaskFlow } from "./task-flow.tsx";

/**
 * The stage flow of a failed Task, so a failed stage can be re-run from where the work is
 * shown rather than only from the task panel. Closing it remembers the Task's id under
 * `storageKey`: that failure stays out of sight after a reload, while a later failed Task
 * (another id) shows again. The caller passes the latest Task of its kind and decides when
 * no notice belongs (an unfinished Task of that kind is shown instead).
 */
export function FailedTaskNotice(props: { task: TaskDto | null | undefined; storageKey: string; message: string; testId: string; className?: string }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useStoredValue(props.storageKey);
  const task = props.task;
  if (task === null || task === undefined || task.statusProjection !== "failed" || dismissed === task.id) return null;
  return (
    <section className={`flex flex-col gap-2 rounded-md border border-danger/40 p-3 ${props.className ?? ""}`} data-testid={props.testId} data-task-id={task.id}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm">{props.message}</p>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(task.id)}>
          {t("common.action.close")}
        </Button>
      </div>
      <TaskFlow taskId={task.id} />
    </section>
  );
}
