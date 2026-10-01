import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ErrorCode } from "@/lib/errors";
import { getYtDlpPath, getFfmpegPath, getFfprobePath } from "@/lib/binaries";
import { createRequestCookieFile, getProxyUrl, convertToNetscapeCookies, areCookiesConfigured } from "@/lib/cookies";

export type DownloadType = "video" | "audio";
export type VideoQuality =
  | "best"
  | "2160p"
  | "1440p"
  | "1080p"
  | "720p"
  | "480p"
  | "360p"
  | "240p"
  | "144p";
export type AudioFormat = "mp3" | "m4a" | "wav" | "webm";
export type AudioQuality = "320" | "256" | "192" | "128" | "best";

// Backwards-compatible type alias
export type DownloadQuality = VideoQuality | string;

export const VALID_VIDEO_QUALITIES: VideoQuality[] = [
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
  "240p",
  "144p",
];

export const VALID_AUDIO_FORMATS: AudioFormat[] = ["mp3", "m4a", "wav", "webm"];
export const VALID_AUDIO_QUALITIES: AudioQuality[] = ["320", "256", "192", "128", "best"];

// Export for backwards compatibility
export const VALID_QUALITIES = VALID_VIDEO_QUALITIES;

export const DEFAULT_MAX_FILE_SIZE = process.env.MAX_FILE_SIZE_BYTES
  ? parseInt(process.env.MAX_FILE_SIZE_BYTES, 10)
  : 100 * 1024 * 1024; // 100 MB default (for Vercel), can be set up to 5GB+ on Docker

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = process.env.DOWNLOAD_TIMEOUT_MS
  ? parseInt(process.env.DOWNLOAD_TIMEOUT_MS, 10)
  : 50 * 1000; // 50 seconds default (for Vercel), can be set up to 10m on Docker

export class DownloadError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
  }
}

// In-memory concurrency limiter (defaults to 2 for serverless, configurable on Docker)
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = process.env.MAX_CONCURRENT_DOWNLOADS
  ? parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10)
  : 2;

export function acquireDownloadSlot(): boolean {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return false;
  }
  activeDownloads++;
  return true;
}

export function releaseDownloadSlot(): void {
  activeDownloads = Math.max(0, activeDownloads - 1);
}

export function getActiveDownloadsCount(): number {
  return activeDownloads;
}

/**
 * Returns format selector for video downloads.
 * Explicitly requires vcodec!=none to NEVER download an audio-only stream.
 */
export function getVideoFormatSelector(
  quality: string,
  hasFfmpeg: boolean
): { selector: string; requiresFfmpeg: boolean } {
  const heightMap: Record<string, number> = {
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
    "240p": 240,
    "144p": 144,
  };

  const normQuality = (quality || "1080p").toLowerCase();
  const targetHeight = heightMap[normQuality] || (normQuality === "best" ? 1080 : 1080);

  if (hasFfmpeg) {
    return {
      requiresFfmpeg: true,
      selector: `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${targetHeight}]+bestaudio/best[height<=${targetHeight}]`,
    };
  }
  return {
    requiresFfmpeg: false,
    selector: `best[height<=${targetHeight}][vcodec!=none]/best[height<=${targetHeight}]`,
  };
}

export const getFormatSelector = getVideoFormatSelector;

/**
 * Returns configuration for audio downloads (MP3, M4A, WAV, WEBM).
 */
export function getAudioFormatConfig(
  format: string = "mp3",
  quality: string = "best",
  hasFfmpeg: boolean
): {
  args: string[];
  ext: string;
  contentType: string;
} {
  const normFormat = (format || "mp3").toLowerCase();
  const normQuality = (quality || "best").toLowerCase();

  const audioQualityBitrateMap: Record<string, string> = {
    "320": "320k",
    "256": "256k",
    "192": "192k",
    "128": "128k",
    "best": "0",
  };

  const bitrateArg = audioQualityBitrateMap[normQuality] || "0";

  switch (normFormat) {
    case "m4a":
      if (hasFfmpeg) {
        return {
          args: ["-f", "ba[ext=m4a]/ba", "-x", "--audio-format", "m4a"],
          ext: "m4a",
          contentType: "audio/mp4",
        };
      }
      return {
        args: ["-f", "ba[ext=m4a]/ba"],
        ext: "m4a",
        contentType: "audio/mp4",
      };

    case "wav":
      return {
        args: ["-f", "ba", "-x", "--audio-format", "wav"],
        ext: "wav",
        contentType: "audio/wav",
      };

    case "webm":
    case "opus":
      return {
        args: ["-f", "ba[ext=webm]/ba", "-x", "--audio-format", "opus"],
        ext: "webm",
        contentType: "audio/webm",
      };

    case "mp3":
    default:
      if (hasFfmpeg) {
        return {
          args: [
            "-f",
            "ba",
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            bitrateArg,
          ],
          ext: "mp3",
          contentType: "audio/mpeg",
        };
      }
      // If FFmpeg is unavailable, fall back to native AAC m4a audio stream
      return {
        args: ["-f", "ba[ext=m4a]/ba"],
        ext: "m4a",
        contentType: "audio/mp4",
      };
  }
}

/**
 * Normalizes cookies to the standard Netscape HTTP Cookie format expected by yt-dlp.
 * Automatically handles:
 * 1. File paths on disk (e.g. /app/cookies.txt, ./cookies.txt)
 * 2. Standard HTTP Cookie header format (name1=val1; name2=val2)
 * 3. Base64-encoded strings (with or without 'base64:' prefix)
 * 4. JSON array of cookies (from Cookie-Editor extension or Chrome DevTools)
 * 5. Raw Netscape format strings
 */
export function formatCookiesForYtDlp(raw: string, defaultDomain = ".youtube.com"): string {
  if (!raw || typeof raw !== "string") return "";

  let content = raw.trim();
  if (!content) return "";

  // Strip wrapping quotes if added by shell or env variable
  if (
    (content.startsWith('"') && content.endsWith('"')) ||
    (content.startsWith("'") && content.endsWith("'"))
  ) {
    content = content.slice(1, -1).trim();
  }

  // Check if content points to an existing file on disk
  try {
    if (fs.existsSync(content)) {
      const stats = fs.statSync(content);
      if (stats.isFile()) {
        content = fs.readFileSync(content, "utf-8").trim();
      }
    }
  } catch {
    // ignore filesystem errors
  }

  // Handle base64: prefix or raw base64 string
  if (content.startsWith("base64:")) {
    try {
      content = Buffer.from(content.slice(7), "base64").toString("utf-8").trim();
    } catch {
      // ignore
    }
  } else if (!content.includes("\n") && !content.includes(" ") && content.length > 30) {
    try {
      const decoded = Buffer.from(content, "base64").toString("utf-8").trim();
      if (
        decoded.includes("Netscape") ||
        decoded.includes("youtube.com") ||
        decoded.startsWith("[") ||
        decoded.startsWith("{") ||
        decoded.includes("\t")
      ) {
        content = decoded;
      }
    } catch {
      // ignore
    }
  }

  // Strip Cookie: prefix if pasted from HTTP request header
  if (content.toLowerCase().startsWith("cookie:")) {
    content = content.replace(/^cookie:\s*/i, "").trim();
  }

  // Check if content is JSON
  if (content.startsWith("[") || content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      const cookieList = Array.isArray(parsed) ? parsed : [parsed];

      const lines: string[] = [
        "# Netscape HTTP Cookie File",
        "# https://curl.se/docs/http-cookies.html",
        "",
      ];

      for (const c of cookieList) {
        if (!c || typeof c !== "object") continue;
        const name = c.name || c.key;
        const value = c.value !== undefined ? String(c.value) : "";
        if (!name) continue;

        let domain = c.domain || c.host || defaultDomain;
        const isHttpOnly = Boolean(c.httpOnly);
        const prefix = isHttpOnly ? "#HttpOnly_" : "";
        const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
        const path = c.path || "/";
        const secure = c.secure !== false ? "TRUE" : "FALSE";
        const expiry = Math.floor(
          c.expirationDate || c.expires || c.expiry || Date.now() / 1000 + 365 * 24 * 3600
        );

        lines.push(
          `${prefix}${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expiry}\t${name}\t${value}`
        );
      }

      return lines.join("\n") + "\n";
    } catch {
      // not valid JSON, proceed as plain text
    }
  }

  // Check if content is key-value cookie pairs (e.g. "SID=abc; HSID=def; SSID=ghi")
  if (content.includes("=") && content.includes(";") && !content.includes("\t")) {
    const pairs = content.split(";").map((p) => p.trim()).filter(Boolean);
    const lines: string[] = [
      "# Netscape HTTP Cookie File",
      "# https://curl.se/docs/http-cookies.html",
      "",
    ];
    const expiry = Math.floor(Date.now() / 1000 + 365 * 24 * 3600);
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (name) {
        lines.push(`${defaultDomain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${value}`);
      }
    }
    if (lines.length > 3) {
      return lines.join("\n") + "\n";
    }
  }

  // Ensure header if not already present
  if (!content.includes("# Netscape HTTP Cookie File")) {
    content = `# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n\n${content}`;
  }

  return content;
}

/**
 * Resolves cookies from environment variables or common local filesystem locations.
 */
export function resolveCookieContent(): string | null {
  const envVal = process.env.YOUTUBE_COOKIES || process.env.COOKIES;
  if (envVal && envVal.trim()) {
    const formatted = formatCookiesForYtDlp(envVal, ".youtube.com");
    if (formatted) return formatted;
  }

  const candidatePaths = [
    path.join(process.cwd(), "cookies.txt"),
    path.join(process.cwd(), ".cookies.txt"),
    path.join(process.cwd(), "..", "cookies.txt"),
    "/app/cookies.txt",
    "/etc/secrets/cookies.txt",
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const stats = fs.statSync(p);
        if (stats.isFile()) {
          const fileContent = fs.readFileSync(p, "utf-8").trim();
          if (fileContent) {
            const formatted = formatCookiesForYtDlp(fileContent, ".youtube.com");
            if (formatted) return formatted;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Generates a safe, sanitized filename from the title.
 * Strips path traversal characters, control characters, and reserved filesystem symbols.
 */
export function sanitizeDownloadFilename(
  title: string | undefined | null,
  videoId: string,
  qualityOrFormat: string,
  ext: string = "mp4"
): string {
  if (!title || typeof title !== "string") {
    return `${videoId}-${qualityOrFormat}.${ext}`;
  }

  // Remove illegal characters, path traversal indicators, and control chars
  let clean = title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[./\\]+/, "")
    .replace(/[./\\]+$/, "")
    .trim();

  // Normalize consecutive spaces
  clean = clean.replace(/\s+/g, " ");

  // Fallback if empty or period only
  if (!clean || clean === ".") {
    clean = `${videoId}-${qualityOrFormat}`;
  }

  // Truncate length to maximum 80 characters
  if (clean.length > 80) {
    clean = clean.slice(0, 80).trim();
  }

  // Remove any remaining trailing/leading dots or spaces after truncation
  clean = clean.replace(/^[./\\]+/, "").replace(/[./\\]+$/, "");
  if (!clean) {
    clean = `${videoId}-${qualityOrFormat}`;
  }

  return `${clean}.${ext}`;
}

/**
 * Safely removes a temporary directory and all its contents.
 */
export async function cleanupDirectory(dirPath: string): Promise<void> {
  if (!dirPath) return;
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

export interface ExecuteDownloadOptions {
  videoId: string;
  url?: string;
  type?: DownloadType;
  quality?: string;
  format?: string;
  audioQuality?: string;
  timeoutMs?: number;
  maxSizeBytes?: number;
  abortSignal?: AbortSignal;
}

export interface DownloadResult {
  filePath: string;
  tempDir: string;
  fileName: string;
  fileSize: number;
  contentType: string;
}

/**
 * Executes yt-dlp safely in a temporary directory and prepares the output file for streaming.
 */
export async function executeDownload(
  options: ExecuteDownloadOptions
): Promise<DownloadResult> {
  const {
    videoId,
    type = "video",
    quality = "best",
    format = "mp3",
    audioQuality = "best",
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxSizeBytes = DEFAULT_MAX_FILE_SIZE,
    abortSignal,
  } = options;

  if (!acquireDownloadSlot()) {
    throw new DownloadError(
      "DOWNLOAD_RATE_LIMITED",
      "Server is currently processing maximum concurrent downloads. Please try again shortly."
    );
  }

  const tempDir = path.join(os.tmpdir(), `pullmeta-dl-${randomUUID()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    const ytDlpPath = await getYtDlpPath();
    const ffmpegPath = await getFfmpegPath();

    const outputTemplate = path.join(tempDir, "media.%(ext)s");
    const maxFilesizeMb = Math.max(1, Math.floor(maxSizeBytes / (1024 * 1024)));

    const baseArgs: string[] = [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--no-part",
      "--js-runtimes",
      "node",
    ];

    const proxy = getProxyUrl();
    if (proxy) {
      baseArgs.push("--proxy", proxy);
    }

    const { cookiePath, cleanup: cleanupCookie } = await createRequestCookieFile();
    if (cookiePath) {
      baseArgs.push("--cookies", cookiePath);
    }

    let expectedExt = "mp4";
    let defaultContentType = "video/mp4";

    const targetUrl = options.url || `https://www.youtube.com/watch?v=${videoId}`;

    const buildYtDlpArgs = (playerClient: string): string[] => {
      const runArgs: string[] = [
        ...baseArgs,
        "--extractor-args",
        `youtube:player_client=${playerClient}`,
      ];

      if (type === "audio") {
        const audioConfig = getAudioFormatConfig(format, audioQuality, !!ffmpegPath);
        runArgs.push(...audioConfig.args);
        expectedExt = audioConfig.ext;
        defaultContentType = audioConfig.contentType;
      } else {
        const formatInfo = getVideoFormatSelector(quality, !!ffmpegPath);
        if (formatInfo.requiresFfmpeg && !ffmpegPath) {
          throw new DownloadError(
            "DOWNLOAD_UNAVAILABLE",
            `Quality ${quality} requires video and audio stream merging with FFmpeg, which is not available in this environment.`
          );
        }
        runArgs.push("-f", formatInfo.selector);
        if (ffmpegPath) {
          runArgs.push("--merge-output-format", "mp4");
          // Ensure merged audio is always universally playable AAC in the MP4 container (plays on Windows Media Player, iOS, etc.)
          runArgs.push("--postprocessor-args", "Merger:-c:a aac");
        }
        expectedExt = "mp4";
        defaultContentType = "video/mp4";
      }

      if (ffmpegPath && (ffmpegPath.includes("/") || ffmpegPath.includes("\\"))) {
        runArgs.push("--ffmpeg-location", ffmpegPath);
      }

      runArgs.push(
        "--max-filesize",
        `${maxFilesizeMb}M`,
        "-o",
        outputTemplate,
        "--write-info-json",
        targetUrl
      );

      return runArgs;
    };

    const runYtDlpProcess = (
      argsToRun: string[]
    ): Promise<{ code: number | null; outputBuffer: string; timedOut: boolean; aborted: boolean }> => {
      return new Promise((resolve) => {
        let outputBuffer = "";
        let timedOut = false;
        let aborted = false;

        const child = spawn(ytDlpPath, argsToRun, {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, timeoutMs);

        const abortHandler = () => {
          aborted = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        };

        if (abortSignal) {
          if (abortSignal.aborted) {
            abortHandler();
          } else {
            abortSignal.addEventListener("abort", abortHandler, { once: true });
          }
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          if (outputBuffer.length < 25000) {
            outputBuffer += chunk.toString("utf-8");
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          if (outputBuffer.length < 25000) {
            outputBuffer += chunk.toString("utf-8");
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          if (abortSignal) {
            abortSignal.removeEventListener("abort", abortHandler);
          }
          resolve({
            code: 1,
            outputBuffer: outputBuffer + "\n" + (err?.message || "Failed to start download process."),
            timedOut,
            aborted,
          });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (abortSignal) {
            abortSignal.removeEventListener("abort", abortHandler);
          }
          resolve({ code, outputBuffer, timedOut, aborted });
        });
      });
    };

    let runResult: { code: number | null; outputBuffer: string; timedOut: boolean; aborted: boolean };
    try {
      const primaryClient = process.env.YOUTUBE_PLAYER_CLIENT || "visionos,android,mweb";
      runResult = await runYtDlpProcess(buildYtDlpArgs(primaryClient));

      // If initial attempt failed specifically due to a bot/sign-in check and no custom client was forced,
      // automatically retry once with alternative mobile/fallback client
      if (
        runResult.code !== 0 &&
        !runResult.timedOut &&
        !runResult.aborted &&
        !process.env.YOUTUBE_PLAYER_CLIENT
      ) {
        const lower = runResult.outputBuffer.toLowerCase();
        if (lower.includes("sign in to confirm") || lower.includes("bot")) {
          runResult = await runYtDlpProcess(buildYtDlpArgs("android,mweb"));
        }
      }
    } finally {
      await cleanupCookie().catch(() => {});
    }

    if (runResult.timedOut) {
      throw new DownloadError(
        "DOWNLOAD_TIMEOUT",
        "Media processing exceeded execution time limit. For long videos or high quality, try a lower quality."
      );
    }

    if (runResult.aborted) {
      throw new DownloadError(
        "DOWNLOAD_FAILED",
        "Download was aborted by the client."
      );
    }

    if (runResult.code !== 0) {
      const lower = runResult.outputBuffer.toLowerCase();

      // Check max-filesize first before generic messages
      if (
        lower.includes("max-filesize") ||
        lower.includes("file is larger than max-filesize") ||
        lower.includes("is larger than max-filesize")
      ) {
        throw new DownloadError(
          "DOWNLOAD_TOO_LARGE",
          `The file exceeds the maximum permitted serverless size (${maxFilesizeMb} MB). For long videos, try 360p, 480p, or Audio Only.`
        );
      }

      if (
        lower.includes("requested format is not available") ||
        lower.includes("format not available") ||
        lower.includes("no video formats found")
      ) {
        throw new DownloadError(
          "DOWNLOAD_UNAVAILABLE",
          `The requested ${type} quality or format is not available for this video.`
        );
      }

      if (lower.includes("sign in to confirm") || lower.includes("bot")) {
        console.error(
          `[YouTube Bot/Sign-in Detected] Exit code: ${runResult.code}. Technical details: ${runResult.outputBuffer.slice(-500)}`
        );
        throw new DownloadError(
          "DOWNLOAD_UNAVAILABLE",
          "This video is temporarily unavailable. Please try again in a few minutes."
        );
      }

      if (lower.includes("sign in to confirm your age") || lower.includes("age-restricted")) {
        console.error(`[YouTube Age-Restricted Detected] Sign-in required for video.`);
        throw new DownloadError(
          "DOWNLOAD_UNAVAILABLE",
          "This video is temporarily unavailable. Please try again in a few minutes."
        );
      }

      if (
        lower.includes("not available in your country") ||
        lower.includes("blocked in your country") ||
        lower.includes("geo-restricted")
      ) {
        throw new DownloadError(
          "DOWNLOAD_UNAVAILABLE",
          "This video is region-restricted or blocked in the server location."
        );
      }

      if (
        lower.includes("this live event has ended") ||
        lower.includes("live stream recording") ||
        lower.includes("is a live stream")
      ) {
        throw new DownloadError(
          "DOWNLOAD_UNAVAILABLE",
          "Active or newly completed live streams cannot be downloaded until YouTube finishes processing the archive."
        );
      }

      if (lower.includes("private video") || lower.includes("members-only")) {
        throw new DownloadError(
          "DOWNLOAD_UNAVAILABLE",
          "This video is private, members-only, or unavailable on YouTube."
        );
      }

      if (lower.includes("timed out") || lower.includes("timeout")) {
        throw new DownloadError(
          "DOWNLOAD_TIMEOUT",
          "Network timeout occurred while fetching the media."
        );
      }

      console.error(`[PullMeta Download Error] exit code: ${runResult.code}, output: ${runResult.outputBuffer}`);
      const errorLine =
        runResult.outputBuffer
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("ERROR:") || l.toLowerCase().includes("error:"))
          .pop() || runResult.outputBuffer.slice(-250).trim();

      throw new DownloadError(
        "DOWNLOAD_FAILED",
        errorLine
          ? `Download failed: ${errorLine}`
          : "Failed to process media download. Please try again with a different format or quality."
      );
    }

    // Locate downloaded media file (strictly match media extensions, never cookies.txt or info.json)
    const MEDIA_EXTS = new Set([".mp4", ".m4a", ".mp3", ".webm", ".wav", ".mkv", ".opus", ".aac", ".flv"]);
    const files = await fs.promises.readdir(tempDir);
    const mediaFile = files.find((f) => {
      const ext = path.extname(f).toLowerCase();
      return MEDIA_EXTS.has(ext) && !f.endsWith(".part");
    }) || files.find((f) => !f.endsWith(".info.json") && !f.endsWith(".part") && !f.endsWith(".txt"));

    if (!mediaFile) {
      throw new DownloadError(
        "DOWNLOAD_FAILED",
        `${type === "audio" ? "Audio" : "Video"} file could not be generated.`
      );
    }

    const mediaFilePath = path.join(tempDir, mediaFile);
    const stat = await fs.promises.stat(mediaFilePath);

    if (stat.size === 0) {
      throw new DownloadError(
        "DOWNLOAD_FAILED",
        "Downloaded file is empty."
      );
    }

    if (stat.size > maxSizeBytes) {
      throw new DownloadError(
        "DOWNLOAD_TOO_LARGE",
        `The file size (${Math.round(stat.size / (1024 * 1024))} MB) exceeds the maximum allowed limit.`
      );
    }

    // Verify downloaded media with ffprobe (height, codecs, audio stream presence)
    const verification = await verifyDownloadedMedia(mediaFilePath, type, quality);
    if (!verification.valid) {
      console.warn(`[PullMeta Verification Mismatch] ${verification.error}`);
      throw new DownloadError(
        "DOWNLOAD_FAILED",
        verification.error || "The downloaded media file failed stream verification."
      );
    }

    // Read metadata title if written
    let videoTitle = "";
    try {
      const infoJsonPath = path.join(tempDir, "media.info.json");
      if (fs.existsSync(infoJsonPath)) {
        const rawJson = await fs.promises.readFile(infoJsonPath, "utf-8");
        const parsed = JSON.parse(rawJson);
        videoTitle = parsed.title || "";
      }
    } catch {
      // Ignore metadata parsing error
    }

    const ext =
      path.extname(mediaFile).replace(/^\./, "").toLowerCase() || expectedExt;

    const qualityLabel =
      type === "audio"
        ? format.toLowerCase() === "mp3" && audioQuality !== "best"
          ? `${audioQuality}kbps`
          : format.toUpperCase()
        : quality;

    const safeFileName = sanitizeDownloadFilename(
      videoTitle,
      videoId,
      qualityLabel,
      ext
    );

    let contentType = defaultContentType;
    if (ext === "mp3") contentType = "audio/mpeg";
    else if (ext === "m4a") contentType = "audio/mp4";
    else if (ext === "wav") contentType = "audio/wav";
    else if (ext === "webm") contentType = type === "audio" ? "audio/webm" : "video/webm";
    else if (ext === "mp4") contentType = "video/mp4";

    return {
      filePath: mediaFilePath,
      tempDir,
      fileName: safeFileName,
      fileSize: stat.size,
      contentType,
    };
  } catch (err) {
    // Ensure temp directory is cleaned and slot released if error happens before streaming
    await cleanupDirectory(tempDir);
    releaseDownloadSlot();
    throw err;
  }
}

export interface MediaVerification {
  valid: boolean;
  actualHeight: number | null;
  videoCodec: string | null;
  hasAudio: boolean;
  audioCodec: string | null;
  error?: string;
}

/**
 * Inspects the downloaded media file using ffprobe to verify streams, codecs, and resolution.
 */
export async function verifyDownloadedMedia(
  filePath: string,
  type: "video" | "audio",
  expectedQuality?: string
): Promise<MediaVerification> {
  const ffprobePath = await getFfprobePath();
  if (!ffprobePath) {
    return { valid: true, actualHeight: null, videoCodec: null, hasAudio: true, audioCodec: null };
  }

  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,width,height",
        "-of",
        "json",
        filePath,
      ],
      { windowsHide: true }
    );

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return resolve({ valid: true, actualHeight: null, videoCodec: null, hasAudio: true, audioCodec: null });
      }

      try {
        const parsed = JSON.parse(output);
        const streams: Array<{
          codec_type: string;
          codec_name: string;
          width?: number;
          height?: number;
        }> = parsed.streams || [];

        const videoStream = streams.find((s) => s.codec_type === "video");
        const audioStream = streams.find((s) => s.codec_type === "audio");

        if (type === "video") {
          if (!videoStream) {
            return resolve({
              valid: false,
              actualHeight: null,
              videoCodec: null,
              hasAudio: Boolean(audioStream),
              audioCodec: audioStream?.codec_name || null,
              error: "Downloaded media contains no video stream.",
            });
          }

          if (!audioStream) {
            return resolve({
              valid: false,
              actualHeight: videoStream.height || null,
              videoCodec: videoStream.codec_name,
              hasAudio: false,
              audioCodec: null,
              error: "Downloaded video is missing audio stream.",
            });
          }

          const h = videoStream.height || 0;
          const w = videoStream.width || 0;
          const resolutionDim = Math.min(w, h) > 0 ? Math.min(w, h) : h;

          const heightMap: Record<string, number> = {
            "2160p": 2160,
            "1440p": 1440,
            "1080p": 1080,
            "720p": 720,
            "480p": 480,
            "360p": 360,
            "240p": 240,
            "144p": 144,
          };
          const target = expectedQuality ? heightMap[expectedQuality.toLowerCase()] : undefined;

          if (target && target >= 720 && resolutionDim < 720 && resolutionDim < target * 0.7) {
            console.warn(
              `[PullMeta Quality Mismatch] Requested ${expectedQuality} (${target}p) but ffprobe measured ${resolutionDim}p (${w}x${h}, codec: ${videoStream.codec_name})`
            );
            return resolve({
              valid: false,
              actualHeight: resolutionDim,
              videoCodec: videoStream.codec_name,
              hasAudio: true,
              audioCodec: audioStream.codec_name,
              error: `Resolution mismatch: Requested ${expectedQuality}, but actual video resolution is ${resolutionDim}p (${w}x${h}). YouTube restricted the high-definition stream for this video.`,
            });
          }

          return resolve({
            valid: true,
            actualHeight: resolutionDim,
            videoCodec: videoStream.codec_name,
            hasAudio: true,
            audioCodec: audioStream.codec_name,
          });
        }

        if (!audioStream) {
          return resolve({
            valid: false,
            actualHeight: null,
            videoCodec: null,
            hasAudio: false,
            audioCodec: null,
            error: "Downloaded media contains no audio stream.",
          });
        }

        return resolve({
          valid: true,
          actualHeight: null,
          videoCodec: null,
          hasAudio: true,
          audioCodec: audioStream.codec_name,
        });
      } catch {
        return resolve({ valid: true, actualHeight: null, videoCodec: null, hasAudio: true, audioCodec: null });
      }
    });

    child.on("error", () => {
      resolve({ valid: true, actualHeight: null, videoCodec: null, hasAudio: true, audioCodec: null });
    });
  });
}
