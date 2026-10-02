export interface OcrCapabilities {
  available: boolean;
  engine: "windows-media-ocr";
  languages: { tag: string; name: string }[];
  maxDimension: number;
  maxPixels: number;
  maxBytes: number;
  reason?: string;
}

/** Word boxes are normalized to 0..1 in the input image. Rotate the whole overlay
 * around its center by `angle` degrees to align with skewed text. */
export interface OcrResult {
  text: string;
  language: string;
  width: number;
  height: number;
  angle: number | null;
  lines: { text: string; words: { text: string; x: number; y: number; width: number; height: number }[] }[];
}

export interface OcrJob {
  jobId: string;
  status: "running" | "complete" | "failed" | "cancelled";
  result?: OcrResult;
  error?: string;
}
