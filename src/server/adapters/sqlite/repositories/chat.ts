import type { AppError } from "../../../../shared/errors.ts";
import type { Citation } from "../../../domain/artifact.ts";
import type { ChatCompaction, ChatMessage, ChatThread } from "../../../domain/chat.ts";
import type { ModelRefSnapshot, PromptRef } from "../../../domain/model-ref.ts";
import type { ChatWebSearch } from "../../../domain/web-search.ts";
import type { ChatRepository, ChatThreadSummary } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface ThreadRow {
  id: string;
  content_id: string;
  current_compaction_id: string | null;
  custom_title: string | null;
  pinned_at: number | null;
  created_at: number;
  first_question: string | null;
  last_message_at: number | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: ChatMessage["role"];
  text: string;
  status: ChatMessage["status"];
  model_ref_json: string | null;
  context_transcript_revision_id: string | null;
  citations_json: string;
  suggestions_json: string | null;
  web_search_json: string | null;
  replaces_message_id: string | null;
  error_json: string | null;
  created_at: number;
  finished_at: number | null;
}

interface CompactionRow {
  id: string;
  thread_id: string;
  through_message_id: string;
  body: string;
  model_ref_json: string;
  prompt_ref_json: string;
  prompt_snapshot: string;
  created_at: number;
}

function toThread(row: ThreadRow): ChatThreadSummary {
  return withoutNulls<ChatThreadSummary>({
    id: row.id,
    contentId: row.content_id,
    currentCompactionId: row.current_compaction_id,
    customTitle: row.custom_title,
    pinnedAt: row.pinned_at,
    createdAt: row.created_at,
    firstQuestion: row.first_question,
    lastMessageAt: row.last_message_at,
  });
}

function toMessage(row: MessageRow): ChatMessage {
  return withoutNulls<ChatMessage>({
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    text: row.text,
    status: row.status,
    modelRef: parseJsonOrNull<ModelRefSnapshot>(row.model_ref_json),
    contextTranscriptRevisionId: row.context_transcript_revision_id,
    citations: parseJson<Citation[]>(row.citations_json),
    suggestions: parseJsonOrNull<string[]>(row.suggestions_json),
    webSearch: parseJsonOrNull<ChatWebSearch>(row.web_search_json),
    replacesMessageId: row.replaces_message_id,
    error: parseJsonOrNull<AppError>(row.error_json),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  });
}

function toCompaction(row: CompactionRow): ChatCompaction {
  return {
    id: row.id,
    threadId: row.thread_id,
    throughMessageId: row.through_message_id,
    body: row.body,
    modelRef: parseJson<ModelRefSnapshot>(row.model_ref_json),
    promptRef: parseJson<PromptRef>(row.prompt_ref_json),
    promptSnapshot: row.prompt_snapshot,
    createdAt: row.created_at,
  };
}

/** A thread row with the title source and the latest message time derived from its messages. */
const THREAD_SELECT = `
  SELECT chat_thread.*,
    (SELECT m.text FROM chat_message AS m WHERE m.thread_id = chat_thread.id AND m.role = 'user' ORDER BY m.created_at, m.id LIMIT 1) AS first_question,
    (SELECT max(m.created_at) FROM chat_message AS m WHERE m.thread_id = chat_thread.id) AS last_message_at
  FROM chat_thread JOIN content ON content.id = chat_thread.content_id`;

/** Ids of the owner's threads (the second parameter of the statement using it). */
const OWNED_THREADS = "SELECT chat_thread.id FROM chat_thread JOIN content ON content.id = chat_thread.content_id WHERE content.user_id = ?";

/** Invariant: ownership of chat rows goes through the thread's Content, and every lookup checks its owner. */
export function sqliteChatRepository(db: SqliteConnection): ChatRepository {
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  // Pinned first, the latest pin first; then the newest. NULLs sort first in SQLite, hence the explicit flag.
  const threadsOf = db.prepare(
    `${THREAD_SELECT} WHERE chat_thread.content_id = ? AND content.user_id = ?
     ORDER BY chat_thread.pinned_at IS NULL, chat_thread.pinned_at DESC, chat_thread.created_at DESC, chat_thread.id DESC`,
  );
  const updateThread = db.prepare(
    `UPDATE chat_thread SET custom_title = @customTitle, pinned_at = @pinnedAt WHERE id = @id AND id IN (${OWNED_THREADS.replace("?", "@owner")})`,
  );
  const threadById = db.prepare(`${THREAD_SELECT} WHERE chat_thread.id = ? AND content.user_id = ?`);
  const latestOf = db.prepare(`${THREAD_SELECT} WHERE chat_thread.content_id = ? AND content.user_id = ? ORDER BY chat_thread.created_at DESC, chat_thread.id DESC LIMIT 1`);
  const ownedThread = db.prepare(
    `SELECT 1 FROM chat_thread JOIN content ON content.id = chat_thread.content_id WHERE chat_thread.id = ? AND content.user_id = ?`,
  );
  const insertThread = db.prepare("INSERT INTO chat_thread (id, content_id, current_compaction_id, created_at) VALUES (@id, @contentId, NULL, @createdAt)");
  const deleteThread = db.prepare(`DELETE FROM chat_thread WHERE id = ? AND id IN (${OWNED_THREADS})`);
  const deleteThreadsOf = db.prepare("DELETE FROM chat_thread WHERE content_id = ? AND content_id IN (SELECT id FROM content WHERE user_id = ?)");
  const messagesOf = db.prepare(
    `SELECT chat_message.* FROM chat_message
     JOIN chat_thread ON chat_thread.id = chat_message.thread_id JOIN content ON content.id = chat_thread.content_id
     WHERE chat_message.thread_id = ? AND content.user_id = ? ORDER BY chat_message.created_at, chat_message.id`,
  );
  const messageById = db.prepare(
    `SELECT chat_message.* FROM chat_message
     JOIN chat_thread ON chat_thread.id = chat_message.thread_id JOIN content ON content.id = chat_thread.content_id
     WHERE chat_message.id = ? AND content.user_id = ?`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO chat_message (id, thread_id, role, text, status, model_ref_json, context_transcript_revision_id, citations_json, suggestions_json,
       web_search_json, replaces_message_id, error_json, created_at, finished_at)
     VALUES (@id, @threadId, @role, @text, @status, @modelRef, @contextTranscriptRevisionId, @citations, @suggestions,
       @webSearch, @replacesMessageId, @error, @createdAt, @finishedAt)`,
  );
  const finishMessage = db.prepare(
    `UPDATE chat_message SET text = @text, status = @status, citations_json = @citations, suggestions_json = @suggestions,
       web_search_json = @webSearch, error_json = @error, finished_at = @finishedAt
     WHERE id = @id`,
  );
  const deleteMessages = db.prepare(`DELETE FROM chat_message WHERE id IN (SELECT value FROM json_each(?)) AND thread_id IN (${OWNED_THREADS})`);
  const compactionById = db.prepare(
    `SELECT chat_compaction.* FROM chat_compaction
     JOIN chat_thread ON chat_thread.id = chat_compaction.thread_id JOIN content ON content.id = chat_thread.content_id
     WHERE chat_compaction.id = ? AND content.user_id = ?`,
  );
  const compactionsOf = db.prepare(
    `SELECT chat_compaction.* FROM chat_compaction
     JOIN chat_thread ON chat_thread.id = chat_compaction.thread_id JOIN content ON content.id = chat_thread.content_id
     WHERE chat_compaction.thread_id = ? AND content.user_id = ? ORDER BY chat_compaction.created_at, chat_compaction.id`,
  );
  const insertCompaction = db.prepare(
    `INSERT INTO chat_compaction (id, thread_id, through_message_id, body, model_ref_json, prompt_ref_json, prompt_snapshot, created_at)
     VALUES (@id, @threadId, @throughMessageId, @body, @modelRef, @promptRef, @promptSnapshot, @createdAt)`,
  );
  const moveCompaction = db.prepare(`UPDATE chat_compaction SET through_message_id = ? WHERE id = ? AND thread_id IN (${OWNED_THREADS})`);
  const deleteCompaction = db.prepare(`DELETE FROM chat_compaction WHERE id = ? AND thread_id IN (${OWNED_THREADS})`);
  const setCurrentCompaction = db.prepare("UPDATE chat_thread SET current_compaction_id = ? WHERE id = ?");
  const interrupt = db.prepare("UPDATE chat_message SET status = 'interrupted', finished_at = ? WHERE status = 'streaming'");

  const requireThread = (ownerUserId: string, threadId: string): void => {
    if (ownedThread.get(threadId, ownerUserId) === undefined) {
      throw notFound("chat thread", threadId);
    }
  };

  return {
    listThreads(ownerUserId, contentId) {
      return (threadsOf.all(contentId, ownerUserId) as ThreadRow[]).map(toThread);
    },
    getThread(ownerUserId, threadId) {
      const row = threadById.get(threadId, ownerUserId) as ThreadRow | undefined;
      return row === undefined ? undefined : toThread(row);
    },
    latestThread(ownerUserId, contentId) {
      const row = latestOf.get(contentId, ownerUserId) as ThreadRow | undefined;
      return row === undefined ? undefined : toThread(row);
    },
    insertThread(ownerUserId, thread: ChatThread) {
      if (ownedContent.get(thread.contentId, ownerUserId) === undefined) {
        throw notFound("content", thread.contentId);
      }
      insertThread.run({ id: thread.id, contentId: thread.contentId, createdAt: thread.createdAt });
    },
    deleteThread(ownerUserId, threadId) {
      return deleteThread.run(threadId, ownerUserId).changes > 0;
    },
    deleteThreadsOf(ownerUserId, contentId) {
      return deleteThreadsOf.run(contentId, ownerUserId).changes;
    },
    updateThread(ownerUserId, threadId, fields) {
      return updateThread.run({ id: threadId, owner: ownerUserId, customTitle: nullable(fields.customTitle), pinnedAt: nullable(fields.pinnedAt) }).changes > 0;
    },
    listMessages(ownerUserId, threadId) {
      return (messagesOf.all(threadId, ownerUserId) as MessageRow[]).map(toMessage);
    },
    getMessage(ownerUserId, messageId) {
      const row = messageById.get(messageId, ownerUserId) as MessageRow | undefined;
      return row === undefined ? undefined : toMessage(row);
    },
    insertMessage(ownerUserId, message) {
      requireThread(ownerUserId, message.threadId);
      insertMessage.run({
        id: message.id,
        threadId: message.threadId,
        role: message.role,
        text: message.text,
        status: message.status,
        modelRef: jsonOrNull(message.modelRef),
        contextTranscriptRevisionId: nullable(message.contextTranscriptRevisionId),
        citations: JSON.stringify(message.citations),
        suggestions: jsonOrNull(message.suggestions),
        webSearch: jsonOrNull(message.webSearch),
        replacesMessageId: nullable(message.replacesMessageId),
        error: jsonOrNull(message.error),
        createdAt: message.createdAt,
        finishedAt: nullable(message.finishedAt),
      });
    },
    finishMessage(ownerUserId, message) {
      if (messageById.get(message.id, ownerUserId) === undefined) {
        throw notFound("chat message", message.id);
      }
      finishMessage.run({
        id: message.id,
        text: message.text,
        status: message.status,
        citations: JSON.stringify(message.citations),
        suggestions: jsonOrNull(message.suggestions),
        webSearch: jsonOrNull(message.webSearch),
        error: jsonOrNull(message.error),
        finishedAt: nullable(message.finishedAt),
      });
    },
    deleteMessages(ownerUserId, messageIds) {
      if (messageIds.length === 0) {
        return 0;
      }
      return deleteMessages.run(JSON.stringify(messageIds), ownerUserId).changes;
    },
    getCompaction(ownerUserId, compactionId) {
      const row = compactionById.get(compactionId, ownerUserId) as CompactionRow | undefined;
      return row === undefined ? undefined : toCompaction(row);
    },
    listCompactions(ownerUserId, threadId) {
      return (compactionsOf.all(threadId, ownerUserId) as CompactionRow[]).map(toCompaction);
    },
    insertCompaction(ownerUserId, compaction) {
      requireThread(ownerUserId, compaction.threadId);
      insertCompaction.run({
        id: compaction.id,
        threadId: compaction.threadId,
        throughMessageId: compaction.throughMessageId,
        body: compaction.body,
        modelRef: JSON.stringify(compaction.modelRef),
        promptRef: JSON.stringify(compaction.promptRef),
        promptSnapshot: compaction.promptSnapshot,
        createdAt: compaction.createdAt,
      });
      setCurrentCompaction.run(compaction.id, compaction.threadId);
    },
    moveCompaction(ownerUserId, compactionId, throughMessageId) {
      if (moveCompaction.run(throughMessageId, compactionId, ownerUserId).changes === 0) {
        throw notFound("chat compaction", compactionId);
      }
    },
    deleteCompaction(ownerUserId, compactionId) {
      deleteCompaction.run(compactionId, ownerUserId);
    },
    setCurrentCompaction(ownerUserId, threadId, compactionId) {
      requireThread(ownerUserId, threadId);
      setCurrentCompaction.run(nullable(compactionId), threadId);
    },
    interruptStreaming(finishedAt) {
      return interrupt.run(finishedAt).changes;
    },
  };
}
