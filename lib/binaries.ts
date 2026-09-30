import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

let cachedYtDlpPath: string | null = null;
let cachedFfmpegPath: string | null = null;

export function resetBinaryCache(): void {
  cachedYtDlpPath = null;
  cachedFfmpegPath = null;
}

/**
 * Resolves the path to the yt-dlp executable.
 * Checks environment variable, project bin folder, system PATH,
 * and falls back to a Vercel-compatible standalone binary in os.tmpdir().
 */
export async function getYtDlpPath(): Promise<string> {
  if (
    cachedYtDlpPath &&
    (cachedYtDlpPath === "yt-dlp" ||
      cachedYtDlpPath === "yt-dlp.exe" ||
      fs.existsSync(/*turbopackIgnore: true*/ cachedYtDlpPath))
  ) {
    return cachedYtDlpPath;
  }

  // 1. Explicit environment variable
  if (process.env.YT_DLP_PATH && fs.existsSync(/*turbopackIgnore: true*/ process.env.YT_DLP_PATH)) {
    cachedYtDlpPath = process.env.YT_DLP_PATH;
    return cachedYtDlpPath;
  }

  // 2. Project bin/ folder (e.g. backend/bin/yt-dlp)
  const binName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const projectBinPath = path.join(process.cwd(), "bin", binName);
  if (fs.existsSync(/*turbopackIgnore: true*/ projectBinPath)) {
    cachedYtDlpPath = projectBinPath;
    return cachedYtDlpPath;
  }

  // 3. System PATH
  try {
    const probe = spawnSync(binName, ["--version"], { timeout: 3000, windowsHide: true });
    if (probe.status === 0) {
      cachedYtDlpPath = binName;
      return cachedYtDlpPath;
    }
  } catch {
    // Not found in system PATH
  }

  // 4. Temporary binary cache in /tmp/pullmeta-bin
  const tmpBinDir = path.join(os.tmpdir(), "pullmeta-bin");
  const tmpBinPath = path.join(tmpBinDir, binName);
  if (fs.existsSync(/*turbopackIgnore: true*/ tmpBinPath)) {
    try {
      if (process.platform !== "win32") {
        fs.chmodSync(tmpBinPath, 0o755);
      }
      cachedYtDlpPath = tmpBinPath;
      return cachedYtDlpPath;
    } catch {
      // Permission or corrupted file, fall through to re-download
    }
  }

  // 5. On-demand standalone binary download for Vercel/serverless environments
  await fs.promises.mkdir(tmpBinDir, { recursive: true });

  const downloadUrl =
    process.platform === "win32"
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

  const res = await fetch(downloadUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download yt-dlp binary from ${downloadUrl}: ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await fs.promises.writeFile(tmpBinPath, Buffer.from(arrayBuffer));

  if (process.platform !== "win32") {
    fs.chmodSync(tmpBinPath, 0o755);
  }

  cachedYtDlpPath = tmpBinPath;
  return cachedYtDlpPath;
}

/**
 * Resolves the path to the FFmpeg executable if available.
 * Checks environment variable, project bin folder, system PATH,
 * and falls back to a minimal static binary in os.tmpdir() for Linux.
 */
export async function getFfmpegPath(): Promise<string | null> {
  if (
    cachedFfmpegPath &&
    (cachedFfmpegPath === "ffmpeg" ||
      cachedFfmpegPath === "ffmpeg.exe" ||
      fs.existsSync(/*turbopackIgnore: true*/ cachedFfmpegPath))
  ) {
    return cachedFfmpegPath;
  }

  // 1. Explicit environment variable
  if (process.env.FFMPEG_PATH && fs.existsSync(/*turbopackIgnore: true*/ process.env.FFMPEG_PATH)) {
    cachedFfmpegPath = process.env.FFMPEG_PATH;
    return cachedFfmpegPath;
  }

  // 2. Project bin/ folder
  const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const projectBinPath = path.join(process.cwd(), "bin", binName);
  if (fs.existsSync(/*turbopackIgnore: true*/ projectBinPath)) {
    cachedFfmpegPath = projectBinPath;
    return cachedFfmpegPath;
  }

  // 3. System PATH
  try {
    const probe = spawnSync(binName, ["-version"], { timeout: 3000, windowsHide: true });
    if (probe.status === 0) {
      cachedFfmpegPath = binName;
      return cachedFfmpegPath;
    }
  } catch {
    // Not found in system PATH
  }

  // 4. Temporary binary cache in /tmp/pullmeta-bin
  const tmpBinDir = path.join(os.tmpdir(), "pullmeta-bin");
  const tmpBinPath = path.join(tmpBinDir, binName);
  if (fs.existsSync(/*turbopackIgnore: true*/ tmpBinPath)) {
    try {
      if (process.platform !== "win32") {
        fs.chmodSync(tmpBinPath, 0o755);
      }
      cachedFfmpegPath = tmpBinPath;
      return cachedFfmpegPath;
    } catch {
      // ignore
    }
  }

  // 5. On Linux x64 in serverless (e.g. Vercel), fetch gzipped static ffmpeg if needed
  if (process.platform === "linux" && process.arch === "x64") {
    try {
      await fs.promises.mkdir(tmpBinDir, { recursive: true });
      const downloadUrl = "https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4/linux-x64.gz";
      const res = await fetch(downloadUrl, { redirect: "follow" });
      if (res.ok) {
        const compressed = await res.arrayBuffer();
        const unzipped = zlib.gunzipSync(Buffer.from(compressed));
        await fs.promises.writeFile(tmpBinPath, unzipped);
        fs.chmodSync(tmpBinPath, 0o755);
        cachedFfmpegPath = tmpBinPath;
        return cachedFfmpegPath;
      }
    } catch {
      // Fetch or uncompress failed, fallback to null
    }
  }

  return null;
}
