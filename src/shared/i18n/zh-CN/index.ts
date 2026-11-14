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
import { readerFont } from "./ui-reader-font.ts";
import { search } from "./ui-search.ts";
import { settings } from "./ui-settings.ts";
import { shell } from "./ui-shell.ts";
import { speakerEditor } from "./ui-speaker-editor.ts";
import { speakerIdentity } from "./ui-speaker-identity.ts";
import { speakerCompare } from "./ui-speaker-compare.ts";
import { speakerContext } from "./ui-speaker-context.ts";
import { speakerReader } from "./ui-speaker-reader.ts";
import { speakerReview } from "./ui-speaker-review.ts";
import { speakerTools } from "./ui-speaker-tools.ts";
import { subtitleImport } from "./ui-subtitle-import.ts";
import { subtitleSpeaker } from "./ui-subtitle-speaker.ts";
import { trash } from "./ui-trash.ts";
import { usage } from "./ui-usage.ts";

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
  usage,
  speakerIdentity,
  speakerReader,
  speakerEditor,
  speakerTools,
  speakerReview,
  speakerCompare,
  speakerContext,
  readerFont,
  subtitleSpeaker,
  subtitleImport,
} as const;
