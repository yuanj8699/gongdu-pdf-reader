import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { OcrCapabilities, OcrJob, OcrResult } from "./src/ocr-types.js";

export const OCR_MAX_BYTES = 8 * 1024 * 1024;
export const OCR_MAX_DIMENSION = 4096;
export const OCR_MAX_PIXELS = 16_000_000;
const JOB_TTL_MS = 5 * 60_000;
const OCR_TIMEOUT_MS = 60_000;

// Only this fixed script is executed. User data travels in JSON on stdin, never
// in command text or paths. Images and decoded bitmaps remain in memory.
const WINDOWS_OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($inputData.action -eq 'capabilities') {
  $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {
    @{ tag = $_.LanguageTag; name = $_.DisplayName }
  })
  @{ languages = $languages; maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
  $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
} | Select-Object -First 1
function Await-WinRT($operation, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
$writer = $null
$bitmap = $null
try {
  $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
  $writer.WriteBytes([Convert]::FromBase64String($inputData.pngBase64))
  $null = Await-WinRT ($writer.StoreAsync()) ([uint32])
  $writer.DetachStream() | Out-Null
  $writer.Dispose()
  $writer = $null
  $stream.Seek(0)
  $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $language = [Windows.Globalization.Language]::new($inputData.language)
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -eq $engine) { throw 'The selected OCR language is not installed.' }
  $result = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $width = $bitmap.PixelWidth
  $height = $bitmap.PixelHeight
  $lines = @($result.Lines | ForEach-Object {
    @{ text = $_.Text; words = @($_.Words | ForEach-Object {
      $box = $_.BoundingRect
      @{ text = $_.Text; x = $box.X / $width; y = $box.Y / $height; width = $box.Width / $width; height = $box.Height / $height }
    }) }
  })
  @{ text = ($lines | ForEach-Object { $_.text }) -join [Environment]::NewLine; language = $engine.RecognizerLanguage.LanguageTag;
    width = $width; height = $height; angle = $result.TextAngle; lines = $lines } | ConvertTo-Json -Depth 8 -Compress
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  if ($null -ne $writer) { $writer.Dispose() }
  $stream.Dispose()
}
`;

const capabilitiesSchema = z.object({
  languages: z.array(z.object({ tag: z.string(), name: z.string() })).max(200),
  maxDimension: z.number().int().positive(),
});
const coordinate = z.number().finite().min(0).max(1);
const resultSchema = z.object({
  text: z.string().max(200_000), language: z.string(),
  width: z.number().int().positive().max(OCR_MAX_DIMENSION),
  height: z.number().int().positive().max(OCR_MAX_DIMENSION),
  angle: z.number().finite().min(-180).max(180).nullable(),
  lines: z.array(z.object({ text: z.string(), words: z.array(z.object({
    text: z.string(), x: coordinate, y: coordinate, width: coordinate, height: coordinate,
  })).max(20_000) })).max(20_000),
});

export function validateOcrPng(pngBase64: string): { width: number; height: number } {
  if (pngBase64.length > Math.ceil(OCR_MAX_BYTES / 3) * 4 || pngBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pngBase64)) {
    throw new Error("OCR 图片必须是有效的 PNG Base64，且不超过 8 MB。");
  }
  const bytes = Buffer.from(pngBase64, "base64");
  if (bytes.length < 33 || bytes.length > OCR_MAX_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("OCR 仅接受 PNG 图片。");
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > OCR_MAX_DIMENSION || height > OCR_MAX_DIMENSION || width * height > OCR_MAX_PIXELS) {
    throw new Error("OCR 图片尺寸超出限制：单边最多 4096 像素，总像素最多 1600 万。");
  }
  return { width, height };
}

function runWindowsOcr(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_OCR_SCRIPT, "utf16le").toString("base64")], { windowsHide: true }); }
    catch (error) { reject(error); return; }
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new Error("OCR 已取消。"));
    const timer = setTimeout(() => finish(new Error("OCR 超过 60 秒，已停止；可降低页面分辨率后重试。")), OCR_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) finish(new Error("OCR 结果过大，请缩小识别范围。"));
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.on("close", code => {
      if (code !== 0) { finish(new Error(`Windows OCR 失败：${stderr.trim() || `进程退出码 ${code}`}`)); return; }
      try { finish(undefined, JSON.parse(stdout.replace(/^\uFEFF/, ""))); }
      catch (error) { finish(new Error(`Windows OCR 返回了无效结果：${error instanceof Error ? error.message : String(error)}`)); }
    });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(JSON.stringify(input));
  });
}

interface ActiveJob { value: OcrJob; controller: AbortController; expires: ReturnType<typeof setTimeout> | null }

export class OcrService {
  private readonly jobs = new Map<string, ActiveJob>();
  private active: string | null = null;
  private disposed = false;
  private capabilitiesRequest: Promise<OcrCapabilities> | null = null;

  capabilities(): Promise<OcrCapabilities> {
    if (!this.capabilitiesRequest) this.capabilitiesRequest = this.inspectCapabilities().then(result => {
      if (!result.available) this.capabilitiesRequest = null;
      return result;
    });
    return this.capabilitiesRequest;
  }

  private async inspectCapabilities(): Promise<OcrCapabilities> {
    const limits = { engine: "windows-media-ocr" as const, maxDimension: OCR_MAX_DIMENSION, maxPixels: OCR_MAX_PIXELS, maxBytes: OCR_MAX_BYTES };
    if (process.platform !== "win32") return { ...limits, available: false, languages: [], reason: "本地 OCR 目前需要 Windows 10/11 的文字识别组件。" };
    try {
      const data = capabilitiesSchema.parse(await runWindowsOcr({ action: "capabilities" }));
      return { ...limits, maxDimension: Math.min(limits.maxDimension, data.maxDimension), languages: data.languages,
        available: data.languages.length > 0, ...(data.languages.length ? {} : { reason: "Windows 未安装 OCR 语言。请在系统设置中为所需语言添加文字识别组件。" }) };
    } catch (error) {
      return { ...limits, available: false, languages: [], reason: `无法启动本地 OCR：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async start(pngBase64: string, language?: string): Promise<OcrJob> {
    if (this.disposed) throw new Error("OCR 服务已关闭。");
    const dimensions = validateOcrPng(pngBase64);
    const capabilities = await this.capabilities();
    if (this.disposed) throw new Error("OCR 服务已关闭。");
    if (!capabilities.available) throw new Error(capabilities.reason ?? "本地 OCR 不可用。");
    const chosen = language ?? capabilities.languages[0].tag;
    if (!capabilities.languages.some(item => item.tag === chosen)) throw new Error("所选 OCR 语言未安装，请使用可用语言列表中的语言。");
    if (dimensions.width > capabilities.maxDimension || dimensions.height > capabilities.maxDimension) throw new Error("图片超出当前 Windows OCR 引擎的尺寸限制。");
    if (this.active) throw new Error("已有一页正在识别，请等待完成或取消后再试。");
    const job: ActiveJob = { value: { jobId: randomUUID(), status: "running" }, controller: new AbortController(), expires: null };
    // Completed jobs only support short-lived polling; keep large word lists bounded.
    if (this.jobs.size >= 8) {
      const oldest = this.jobs.entries().next().value;
      if (oldest) {
        if (oldest[1].expires) clearTimeout(oldest[1].expires);
        this.jobs.delete(oldest[0]);
      }
    }
    this.jobs.set(job.value.jobId, job);
    this.active = job.value.jobId;
    void runWindowsOcr({ action: "recognize", pngBase64, language: chosen }, job.controller.signal)
      .then(data => {
        if (job.value.status !== "running") return;
        const result: OcrResult = resultSchema.parse(data);
        if (result.width !== dimensions.width || result.height !== dimensions.height) throw new Error("OCR 返回的图片尺寸不一致。");
        job.value = { jobId: job.value.jobId, status: "complete", result };
      }).catch(error => {
        if (job.value.status === "running") job.value = { jobId: job.value.jobId, status: "failed", error: error instanceof Error ? error.message : String(error) };
      }).finally(() => {
        if (this.active === job.value.jobId) this.active = null;
        if (this.disposed) return;
        job.expires = setTimeout(() => this.jobs.delete(job.value.jobId), JOB_TTL_MS);
        job.expires.unref();
      });
    return { ...job.value };
  }

  status(jobId: string): OcrJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("OCR 任务不存在或已过期，请重新识别当前页。");
    return structuredClone(job.value);
  }

  cancel(jobId: string): OcrJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("OCR 任务不存在或已过期。");
    if (job.value.status === "running") {
      job.value = { jobId, status: "cancelled" };
      job.controller.abort();
    }
    return { ...job.value };
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) {
      if (job.expires) clearTimeout(job.expires);
      job.controller.abort();
    }
    this.jobs.clear();
  }
}
