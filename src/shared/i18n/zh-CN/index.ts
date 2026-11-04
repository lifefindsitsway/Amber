import { cacheFile } from "./cache-file.ts";
import { backup } from "./ui-backup.ts";
import { cacheDirErrors, errors, refinedErrors } from "./errors.ts";
import { exportFile } from "./export-file.ts";
import { languageNames } from "./languages.ts";
import { summaryTemplate } from "./summary-templates.ts";
import { admin } from "./ui-admin.ts";
import { auth } from "./ui-auth.ts";
import { chat } from "./ui-chat.ts";
import { common } from "./ui-common.ts";
import { contentView } from "./ui-content.ts";
import { editor } from "./ui-editor.ts";
import { library } from "./ui-library.ts";
import { notes } from "./ui-notes.ts";
import { search } from "./ui-search.ts";
import { settings } from "./ui-settings.ts";
import { shell } from "./ui-shell.ts";
import { trash } from "./ui-trash.ts";

/** zh-CN resource bundle; namespaces are added as UI areas land. */
export const zhCN = {
  errors,
  refinedErrors,
  cacheDirErrors,
  languageNames,
  summaryTemplate,
  common,
  shell,
  contentView,
  editor,
  library,
  settings,
  search,
  chat,
  exportFile,
  cacheFile,
  auth,
  admin,
  notes,
  trash,
  backup,
} as const;
