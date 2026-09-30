import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ErrorCode } from "@/lib/errors";
import { getYtDlpPath, getFfmpegPath } from "@/lib/binaries";

export type DownloadType = "video" | "audio";
export type VideoQuality =
  | "best"
  | "2160p"
  | "1440p"
  | "1080p"
  | "720p"
  | "480p"
  | "360p";
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
  };

  const targetHeight = heightMap[quality.toLowerCase()];

  if (targetHeight) {
    if (hasFfmpeg) {
      return {
        requiresFfmpeg: true,
        selector: `bestvideo[height<=${targetHeight}][ext=mp4][vcodec!=none]+bestaudio[ext=m4a][acodec!=none]/bestvideo[height<=${targetHeight}][vcodec!=none]+bestaudio[acodec!=none]/best[height<=${targetHeight}][vcodec!=none][acodec!=none]/best[height<=${targetHeight}][vcodec!=none]`,
      };
    }
    return {
      requiresFfmpeg: false,
      selector: `best[height<=${targetHeight}][vcodec!=none][acodec!=none]/best[height<=${targetHeight}][vcodec!=none]`,
    };
  }

  // "best" or default
  if (hasFfmpeg) {
    return {
      requiresFfmpeg: false,
      selector: `bestvideo[ext=mp4][vcodec!=none]+bestaudio[ext=m4a][acodec!=none]/bestvideo[vcodec!=none]+bestaudio[acodec!=none]/best[vcodec!=none][acodec!=none]/best[vcodec!=none]`,
    };
  }
  return {
    requiresFfmpeg: false,
    selector: `best[vcodec!=none][acodec!=none]/best[vcodec!=none]`,
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

    const args: string[] = [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--no-part",
      "--js-runtimes",
      `node:${process.execPath}`,
      "--remote-components",
      "ejs:github",
      "--extractor-args",
      "youtube:player_client=android,web;player_skip=configs,webpage",
    ];

    if (process.env.YOUTUBE_PROXY) {
      args.push("--proxy", process.env.YOUTUBE_PROXY);
    } else if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
      args.push("--proxy", (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)!);
    }

    if (process.env.YOUTUBE_COOKIES) {
      const cookiePath = path.join(tempDir, "cookies.txt");
      let cookieContent = process.env.YOUTUBE_COOKIES;
      if (cookieContent.startsWith("base64:")) {
        cookieContent = Buffer.from(cookieContent.slice(7), "base64").toString("utf-8");
      }
      await fs.promises.writeFile(cookiePath, cookieContent, "utf-8");
      args.push("--cookies", cookiePath);
    }

    let expectedExt = "mp4";
    let defaultContentType = "video/mp4";

    if (type === "audio") {
      const audioConfig = getAudioFormatConfig(format, audioQuality, !!ffmpegPath);
      args.push(...audioConfig.args);
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
      args.push("-f", formatInfo.selector);
      if (ffmpegPath) {
        args.push("--merge-output-format", "mp4");
      }
      expectedExt = "mp4";
      defaultContentType = "video/mp4";
    }

    if (ffmpegPath) {
      args.push("--ffmpeg-location", ffmpegPath);
    }

    args.push(
      "--max-filesize",
      `${maxFilesizeMb}M`,
      "-o",
      outputTemplate,
      "--write-info-json",
      `https://www.youtube.com/watch?v=${videoId}`
    );

    await new Promise<void>((resolve, reject) => {
      let isSettled = false;
      let timedOut = false;
      let aborted = false;
      let outputBuffer = "";

      const child = spawn(ytDlpPath, args, {
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

      child.on("error", () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", abortHandler);
        }
        reject(
          new DownloadError(
            "DOWNLOAD_FAILED",
            "Failed to start download process."
          )
        );
      });

      child.on("close", (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", abortHandler);
        }

        if (timedOut) {
          return reject(
            new DownloadError(
              "DOWNLOAD_TIMEOUT",
              "Media processing exceeded execution time limit. For long videos or high quality, try a lower quality."
            )
          );
        }

        if (aborted) {
          return reject(
            new DownloadError(
              "DOWNLOAD_FAILED",
              "Download was aborted by the client."
            )
          );
        }

        if (code !== 0) {
          const lower = outputBuffer.toLowerCase();

          // Check max-filesize first before generic messages
          if (
            lower.includes("max-filesize") ||
            lower.includes("file is larger than max-filesize") ||
            lower.includes("is larger than max-filesize")
          ) {
            return reject(
              new DownloadError(
                "DOWNLOAD_TOO_LARGE",
                `The file exceeds the maximum permitted serverless size (${maxFilesizeMb} MB). For long videos, try 360p, 480p, or Audio Only.`
              )
            );
          }

          if (
            lower.includes("requested format is not available") ||
            lower.includes("format not available") ||
            lower.includes("no video formats found")
          ) {
            return reject(
              new DownloadError(
                "DOWNLOAD_UNAVAILABLE",
                `The requested ${type} quality or format is not available for this video.`
              )
            );
          }

          if (lower.includes("sign in to confirm") || lower.includes("bot")) {
            return reject(
              new DownloadError(
                "DOWNLOAD_UNAVAILABLE",
                "YouTube has applied a bot/sign-in check on this cloud server for this video. Try selecting 360p or Audio, or a different video."
              )
            );
          }

          if (lower.includes("private video") || lower.includes("members-only")) {
            return reject(
              new DownloadError(
                "DOWNLOAD_UNAVAILABLE",
                "This video is private, members-only, or unavailable on YouTube."
              )
            );
          }

          if (lower.includes("timed out") || lower.includes("timeout")) {
            return reject(
              new DownloadError(
                "DOWNLOAD_TIMEOUT",
                "Network timeout occurred while fetching the media."
              )
            );
          }

          return reject(
            new DownloadError(
              "DOWNLOAD_FAILED",
              "Failed to process media download. Please try again with a different format or quality."
            )
          );
        }

        resolve();
      });
    });

    // Locate downloaded media file
    const files = await fs.promises.readdir(tempDir);
    const mediaFile = files.find(
      (f) => !f.endsWith(".info.json") && !f.endsWith(".part")
    );

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
