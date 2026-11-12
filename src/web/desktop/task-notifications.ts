import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TaskDto } from "../../shared/dto/task.ts";
import { useTaskHub } from "../api/context.tsx";
import { taskKindLabel } from "../components/task-kind-label.ts";
import { useDesktop } from "./use-desktop.ts";

/** Sends one system notification, asking for permission the first time; failures stay silent. */
export async function notifySystem(title: string, body: string): Promise<void> {
  try {
    const notification = await import("@tauri-apps/plugin-notification");
    let granted = await notification.isPermissionGranted();
    if (!granted) {
      granted = (await notification.requestPermission()) === "granted";
    }
    if (granted) {
      notification.sendNotification({ title, body });
    }
  } catch {
    // A missing permission or plugin only loses the notification; the task list still shows the result.
  }
}

/**
 * Desktop client: a system notification when a Task reaches its final state while the
 * window is not focused; in the foreground the task list already shows it.
 */
export function useTaskNotifications(): void {
  const hub = useTaskHub();
  const desktop = useDesktop();
  const { t } = useTranslation();
  useEffect(() => {
    if (!desktop) return undefined;
    return hub.onEvent((event) => {
      if (event.type !== "task.finished" || document.hasFocus()) return;
      const { title, body } = taskNotification(event.task, t);
      void notifySystem(title, body);
    });
  }, [hub, desktop, t]);
}

/** Title = what the Task worked on (its kind when untitled); body = kind and final status. */
export function taskNotification(task: Pick<TaskDto, "kind" | "comparison" | "statusProjection" | "targetTitle">, t: TFunction): { title: string; body: string } {
  const kind = taskKindLabel(task, t);
  return {
    title: task.targetTitle ?? kind,
    body: t("shell.notification.finished", { kind, status: t(`common.status.${task.statusProjection}`) }),
  };
}
