import type { Migration } from "../migrations.ts";

/**
 * A chat thread may be renamed and pinned. `custom_title` is the user's own title (NULL: the
 * title stays derived from the first question); `pinned_at` is when it was pinned (NULL: not
 * pinned), so pinned threads list first, the latest pin first. Existing threads keep NULL in
 * both, which changes nothing they show.
 */
export const migration0023: Migration = {
  version: 23,
  name: "chat-thread-title-and-pin",
  sql: `
    ALTER TABLE chat_thread ADD COLUMN custom_title TEXT;
    ALTER TABLE chat_thread ADD COLUMN pinned_at INTEGER;
  `,
};
