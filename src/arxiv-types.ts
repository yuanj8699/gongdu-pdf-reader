export interface ArxivPaper {
  provider: "arxiv";
  id: string;
  baseId: string;
  version: number;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  updated: string;
  abstractUrl: string;
  pdfUrl: string;
}

export type ImportState = "queued" | "resolving" | "downloading" | "validating" | "completed" | "failed" | "cancelled" | "interrupted";
export interface ArxivJob {
  jobId: string;
  requestedId: string;
  state: ImportState;
  receivedBytes: number;
  totalBytes: number | null;
  paper?: ArxivPaper;
  assetId?: string;
  error?: string;
  updatedAt: string;
}
export const ACTIVE_IMPORT_STATES: ImportState[] = ["queued", "resolving", "downloading", "validating"];
