import type { NotPromise, Repository, RepositoryScope } from "../../ports/repository.ts";
import type { SqliteConnection } from "./database.ts";
import { sqliteAsrUsageRepository } from "./repositories/asr-usage.ts";
import { sqliteChapterRepository } from "./repositories/chapters.ts";
import { sqliteChatRepository } from "./repositories/chat.ts";
import { sqliteCollectionSummaryRepository } from "./repositories/collection-summaries.ts";
import { sqliteCollectionRepository } from "./repositories/collections.ts";
import { sqliteContentRepository } from "./repositories/contents.ts";
import { sqliteHighlightRepository } from "./repositories/highlights.ts";
import { sqliteIdempotencyRepository } from "./repositories/idempotency.ts";
import { sqliteImportBatchRepository } from "./repositories/import-batches.ts";
import { sqliteInstanceSettingsRepository } from "./repositories/instance-settings.ts";
import { sqliteMediaAssetRepository } from "./repositories/media-assets.ts";
import { sqliteNetworkAllowlistRepository } from "./repositories/network-allowlist.ts";
import { sqliteNoteRepository } from "./repositories/notes.ts";
import { sqlitePendingFileDeleteRepository } from "./repositories/pending-file-deletes.ts";
import { sqlitePlatformAccountRepository } from "./repositories/platform-accounts.ts";
import { sqliteOtherModelProfileRepository } from "./repositories/other-model-profiles.ts";
import { sqliteAsrProfileRepository, sqliteProviderProfileRepository } from "./repositories/provider-profiles.ts";
import { sqliteReferenceTextRepository } from "./repositories/reference-texts.ts";
import { sqliteRevisionReferenceRepository } from "./repositories/revision-references.ts";
import { sqliteRollupPartialRepository } from "./repositories/rollup-partials.ts";
import { sqliteSearchIndexRepository } from "./repositories/search-index.ts";
import { sqliteSecretEnvelopeStore } from "./repositories/secret-envelopes.ts";
import { sqliteSessionRepository } from "./repositories/sessions.ts";
import { sqliteStageRunRepository } from "./repositories/stage-runs.ts";
import { sqliteSummaryRepository } from "./repositories/summaries.ts";
import { sqliteSummaryTemplateRepository } from "./repositories/summary-templates.ts";
import { sqliteTerminologyRepository } from "./repositories/terminology.ts";
import { sqliteTaskRepository } from "./repositories/tasks.ts";
import { sqliteTokenUsageRepository } from "./repositories/token-usage.ts";
import { sqliteTranscriptRepository } from "./repositories/transcripts.ts";
import { sqliteTranslationRepository } from "./repositories/translations.ts";
import { sqliteUserSettingsRepository } from "./repositories/user-settings.ts";
import { sqliteUserRepository } from "./repositories/users.ts";
import { sqliteWorkUnitRepository } from "./repositories/work-units.ts";

/**
 * Repository on one SQLite connection. Statements are prepared once; the scope is shared
 * by every transaction because all of them run on this single connection.
 */
export class SqliteRepository implements Repository {
  private readonly db: SqliteConnection;
  private readonly scope: RepositoryScope;

  constructor(db: SqliteConnection) {
    this.db = db;
    this.scope = {
      users: sqliteUserRepository(db),
      sessions: sqliteSessionRepository(db),
      networkAllowlist: sqliteNetworkAllowlistRepository(db),
      contents: sqliteContentRepository(db),
      collections: sqliteCollectionRepository(db),
      mediaAssets: sqliteMediaAssetRepository(db),
      transcripts: sqliteTranscriptRepository(db),
      revisionReferences: sqliteRevisionReferenceRepository(db),
      secretEnvelopes: sqliteSecretEnvelopeStore(db),
      importBatches: sqliteImportBatchRepository(db),
      tasks: sqliteTaskRepository(db),
      stageRuns: sqliteStageRunRepository(db),
      workUnits: sqliteWorkUnitRepository(db),
      idempotency: sqliteIdempotencyRepository(db),
      instanceSettings: sqliteInstanceSettingsRepository(db),
      userSettings: sqliteUserSettingsRepository(db),
      providerProfiles: sqliteProviderProfileRepository(db),
      asrProfiles: sqliteAsrProfileRepository(db),
      otherModelProfiles: sqliteOtherModelProfileRepository(db),
      asrUsage: sqliteAsrUsageRepository(db),
      terminology: sqliteTerminologyRepository(db),
      tokenUsage: sqliteTokenUsageRepository(db),
      chapters: sqliteChapterRepository(db),
      highlights: sqliteHighlightRepository(db),
      translations: sqliteTranslationRepository(db),
      summaryTemplates: sqliteSummaryTemplateRepository(db),
      summaries: sqliteSummaryRepository(db),
      collectionSummaries: sqliteCollectionSummaryRepository(db),
      rollupPartials: sqliteRollupPartialRepository(db),
      referenceTexts: sqliteReferenceTextRepository(db),
      platformAccounts: sqlitePlatformAccountRepository(db),
      search: sqliteSearchIndexRepository(db),
      chat: sqliteChatRepository(db),
      notes: sqliteNoteRepository(db),
      pendingFileDeletes: sqlitePendingFileDeleteRepository(db),
    };
  }

  withTransaction<T>(work: (scope: RepositoryScope) => NotPromise<T>): T {
    return this.db.transaction(() => {
      const result = work(this.scope);
      if (typeof (result as { then?: unknown } | null)?.then === "function") {
        // Committing here would publish whatever ran before the first await.
        throw new TypeError("transaction callbacks must be synchronous");
      }
      return result;
    })() as T;
  }
}
