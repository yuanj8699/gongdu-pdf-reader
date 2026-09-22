/** Persistent identity is separate from the transient viewer UUID. */
export interface LibraryAsset {
  documentId: string;
  versionId: string;
  assetId: string;
  title: string;
  fileName: string;
  sha256: string;
  byteLength: number;
  pageCount: number;
  fingerprint: string;
  createdAt: string;
}

export interface Bookmark { page: number; title: string }
export interface ReadingState {
  page: number | null;
  bookmarks: Bookmark[];
}
export interface LibraryEntry extends LibraryAsset { lastPage: number | null }
