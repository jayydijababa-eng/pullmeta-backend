import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ErrorCode } from "@/lib/errors";
import { getYtDlpPath, getFfmpegPath } from "@/lib/binaries";

export type DownloadQuality = "best" | "2160p" | "1440p" | "1080p" | "720p";

export const VALID_QUALITIES: DownloadQuality[] = [
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
];

export const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 50 * 1000; // 50 seconds (fits Vercel Hobby 60s limit)

export class DownloadError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
  }
}

// In-memory concurrency limiter (max 2 concurrent downloads per serverless instance)
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 2;

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
 * Returns format selector and whether FFmpeg is required for the chosen quality.
 */
export function getFormatSelector(
  quality: DownloadQuality,
  hasFfmpeg: boolean
): { selector: string; requiresFfmpeg: boolean } {
  switch (quality) {
    case "2160p":
      return {
        requiresFfmpeg: true,
        selector:
          "bestvideo[height=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=2160]+bestaudio/best[height=2160]",
      };
    case "1440p":
      return {
        requiresFfmpeg: true,
        selector:
          "bestvideo[height=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=1440]+bestaudio/best[height=1440]",
      };
    case "1080p":
      return {
        requiresFfmpeg: true,
        selector:
          "bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=1080]+bestaudio/best[height=1080]",
      };
    case "720p":
      if (hasFfmpeg) {
        return {
          requiresFfmpeg: false,
          selector:
            "bestvideo[height=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=720]+bestaudio/best[height=720][ext=mp4]/best[height=720]",
        };
      }
      return {
        requiresFfmpeg: false,
        selector: "best[height=720][ext=mp4]/best[height=720]",
      };
    case "best":
    default:
      if (hasFfmpeg) {
        return {
          requiresFfmpeg: false,
          selector:
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best",
        };
      }
      return {
        requiresFfmpeg: false,
        selector: "best[ext=mp4]/best",
      };
  }
}

/**
 * Generates a safe, sanitized filename from the video title.
 * Strips path traversal characters, control characters, and reserved filesystem symbols.
 */
export function sanitizeDownloadFilename(
  title: string | undefined | null,
  videoId: string,
  quality: string,
  ext: string = "mp4"
): string {
  if (!title || typeof title !== "string") {
    return `${videoId}-${quality}.${ext}`;
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
    clean = `${videoId}-${quality}`;
  }

  // Truncate length to maximum 80 characters
  if (clean.length > 80) {
    clean = clean.slice(0, 80).trim();
  }

  // Remove any remaining trailing/leading dots or spaces after truncation
  clean = clean.replace(/^[./\\]+/, "").replace(/[./\\]+$/, "");
  if (!clean) {
    clean = `${videoId}-${quality}`;
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
  quality: DownloadQuality;
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
    quality,
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

    const formatInfo = getFormatSelector(quality, !!ffmpegPath);

    if (formatInfo.requiresFfmpeg && !ffmpegPath) {
      throw new DownloadError(
        "DOWNLOAD_UNAVAILABLE",
        `Quality ${quality} requires video and audio stream merging with FFmpeg, which is not available in this environment.`
      );
    }

    const outputTemplate = path.join(tempDir, "video.%(ext)s");
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
      "-f",
      formatInfo.selector,
      "--max-filesize",
      `${maxFilesizeMb}M`,
      "-o",
      outputTemplate,
      "--write-info-json",
    ];

    if (ffmpegPath) {
      args.push("--ffmpeg-location", ffmpegPath);
      args.push("--merge-output-format", "mp4");
    }

    // Pass strict, normalized YouTube URL
    args.push(`https://www.youtube.com/watch?v=${videoId}`);

    await new Promise<void>((resolve, reject) => {
      let isSettled = false;
      let timedOut = false;
      let aborted = false;
      let stderrOutput = "";

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

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrOutput.length < 10000) {
          stderrOutput += chunk.toString("utf-8");
        }
      });

      child.on("error", (err) => {
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
              "Video processing exceeded execution time limit. For long videos, try a lower quality."
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
          const lower = stderrOutput.toLowerCase();
          if (
            lower.includes("requested format is not available") ||
            lower.includes("format not available") ||
            lower.includes("no video formats found")
          ) {
            return reject(
              new DownloadError(
                "DOWNLOAD_UNAVAILABLE",
                `The requested quality (${quality}) is not available for this video.`
              )
            );
          }

          if (
            lower.includes("sign in to confirm") ||
            lower.includes("private video") ||
            lower.includes("video unavailable") ||
            lower.includes("members-only") ||
            lower.includes("bot")
          ) {
            return reject(
              new DownloadError(
                "DOWNLOAD_UNAVAILABLE",
                "This video is private, restricted, or unavailable for download."
              )
            );
          }

          if (
            lower.includes("max-filesize") ||
            lower.includes("file is larger than max-filesize")
          ) {
            return reject(
              new DownloadError(
                "DOWNLOAD_TOO_LARGE",
                `The video file exceeds the maximum permitted file size (${maxFilesizeMb} MB).`
              )
            );
          }

          if (lower.includes("timed out") || lower.includes("timeout")) {
            return reject(
              new DownloadError(
                "DOWNLOAD_TIMEOUT",
                "Network timeout occurred while fetching the video."
              )
            );
          }

          return reject(
            new DownloadError(
              "DOWNLOAD_FAILED",
              "Failed to process video download. Please try again with a different quality or video."
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
        "Video file could not be generated."
      );
    }

    const mediaFilePath = path.join(tempDir, mediaFile);
    const stat = await fs.promises.stat(mediaFilePath);

    if (stat.size === 0) {
      throw new DownloadError(
        "DOWNLOAD_FAILED",
        "Downloaded video file is empty."
      );
    }

    if (stat.size > maxSizeBytes) {
      throw new DownloadError(
        "DOWNLOAD_TOO_LARGE",
        `The video file size (${Math.round(stat.size / (1024 * 1024))} MB) exceeds the maximum allowed limit.`
      );
    }

    // Read metadata title if written
    let videoTitle = "";
    try {
      const infoJsonPath = path.join(tempDir, "video.info.json");
      if (fs.existsSync(infoJsonPath)) {
        const rawJson = await fs.promises.readFile(infoJsonPath, "utf-8");
        const parsed = JSON.parse(rawJson);
        videoTitle = parsed.title || "";
      }
    } catch {
      // Ignore metadata parsing error
    }

    const ext = path.extname(mediaFile).replace(/^\./, "").toLowerCase() || "mp4";
    const safeFileName = sanitizeDownloadFilename(
      videoTitle,
      videoId,
      quality,
      ext
    );
    const contentType = ext === "webm" ? "video/webm" : "video/mp4";

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
