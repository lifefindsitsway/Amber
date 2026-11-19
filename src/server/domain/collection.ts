export interface Collection {
  id: string;
  userId: string;
  name: string;
  description?: string;
  platformCollectionId?: string;
  /**
   * The id this collection had on the device a content pack carried it from; absent for one
   * created here. Its transfer identity is `originId ?? id`. Written on insert only.
   */
  originId?: string;
  createdAt: number;
  /**
   * Refreshed in the transaction of each change to the collection itself: creation, a new
   * name or description, members added or removed (a purge included), a member entering or
   * leaving the trash, reordering, a new collection summary. A member's own processing or
   * renaming does not count.
   */
  updatedAt: number;
}

/**
 * References `contentId` only: a URL added to a collection first becomes a Content and
 * is then enrolled, so an item never has two identities. Unique per (collectionId, contentId).
 */
export interface CollectionItem {
  id: string;
  collectionId: string;
  contentId: string;
  position: number;
  addedAt: number;
}
