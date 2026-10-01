import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

let cachedYtDlpPath: string | null = null;
let cachedFfmpegPath: string | null = null;
let cachedFfprobePath: string | null = null;

export function resetBinaryCache(): void {
  cachedYtDlpPath = null;
  cachedFfmpegPath = null;
  cachedFfprobePath = null;
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

  // 3. Common Linux paths (Docker / Render / Railway)
  if (process.platform !== "win32") {
    for (const linuxPath of ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"]) {
      if (fs.existsSync(/*turbopackIgnore: true*/ linuxPath)) {
        cachedYtDlpPath = linuxPath;
        return cachedYtDlpPath;
      }
    }
  }

  // 4. System PATH
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

  // 3. Common Linux paths (Docker / Render / Railway)
  if (process.platform !== "win32") {
    for (const linuxPath of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
      if (fs.existsSync(/*turbopackIgnore: true*/ linuxPath)) {
        cachedFfmpegPath = linuxPath;
        return cachedFfmpegPath;
      }
    }
  }

  // 4. System PATH
  try {
    const probe = spawnSync(binName, ["-version"], { timeout: 3000, windowsHide: true });
    if (probe.status === 0) {
      cachedFfmpegPath = binName;
      return cachedFfmpegPath;
    }
  } catch {
    // Not found in system PATH
  }

  // 4. @ffmpeg-installer package binary on disk (Turbopack build-safe, avoids dynamic require)
  const installerPlatform = `${process.platform}-${process.arch}`;
  const installerBinPath = path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    installerPlatform,
    binName
  );

  if (fs.existsSync(/*turbopackIgnore: true*/ installerBinPath)) {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(installerBinPath, 0o755);
        cachedFfmpegPath = installerBinPath;
        return cachedFfmpegPath;
      } catch {
        // If filesystem is read-only (e.g. AWS Lambda / Vercel /var/task), copy to /tmp and chmod
        const tmpBinDir = path.join(os.tmpdir(), "pullmeta-bin");
        await fs.promises.mkdir(tmpBinDir, { recursive: true });
        const tmpFfmpegPath = path.join(tmpBinDir, "ffmpeg");
        if (!fs.existsSync(tmpFfmpegPath)) {
          await fs.promises.copyFile(installerBinPath, tmpFfmpegPath);
        }
        fs.chmodSync(tmpFfmpegPath, 0o755);
        cachedFfmpegPath = tmpFfmpegPath;
        return cachedFfmpegPath;
      }
    } else {
      cachedFfmpegPath = installerBinPath;
      return cachedFfmpegPath;
    }
  }

  // 5. Temporary binary cache in /tmp/pullmeta-bin
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

  // 6. On Linux x64 in serverless (e.g. Vercel), fetch gzipped static ffmpeg if needed
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

/**
 * Resolves the path to the FFprobe executable.
 * Checks environment variable, project bin folder, same directory as ffmpeg, and system PATH.
 */
export async function getFfprobePath(): Promise<string | null> {
  if (
    cachedFfprobePath &&
    (cachedFfprobePath === "ffprobe" ||
      cachedFfprobePath === "ffprobe.exe" ||
      fs.existsSync(/*turbopackIgnore: true*/ cachedFfprobePath))
  ) {
    return cachedFfprobePath;
  }

  // 1. Explicit environment variable
  if (process.env.FFPROBE_PATH && fs.existsSync(/*turbopackIgnore: true*/ process.env.FFPROBE_PATH)) {
    cachedFfprobePath = process.env.FFPROBE_PATH;
    return cachedFfprobePath;
  }

  const binName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";

  // 2. Look in the same folder where ffmpeg was found
  const ffmpeg = await getFfmpegPath();
  if (ffmpeg && (ffmpeg.includes("/") || ffmpeg.includes("\\"))) {
    const siblingPath = path.join(path.dirname(ffmpeg), binName);
    if (fs.existsSync(/*turbopackIgnore: true*/ siblingPath)) {
      cachedFfprobePath = siblingPath;
      return cachedFfprobePath;
    }
  }

  // 3. Project bin/ folder
  const projectBinPath = path.join(process.cwd(), "bin", binName);
  if (fs.existsSync(/*turbopackIgnore: true*/ projectBinPath)) {
    cachedFfprobePath = projectBinPath;
    return cachedFfprobePath;
  }

  // 4. Common Linux paths
  if (process.platform !== "win32") {
    for (const linuxPath of ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe"]) {
      if (fs.existsSync(/*turbopackIgnore: true*/ linuxPath)) {
        cachedFfprobePath = linuxPath;
        return cachedFfprobePath;
      }
    }
  }

  // 5. System PATH
  try {
    const probe = spawnSync(binName, ["-version"], { timeout: 3000, windowsHide: true });
    if (probe.status === 0) {
      cachedFfprobePath = binName;
      return cachedFfprobePath;
    }
  } catch {
    // Not found in system PATH
  }

  return null;
}

/**
 * Startup verification check that validates FFmpeg and yt-dlp presence.
 * Fails loudly with actionable instructions if FFmpeg is missing.
 */
export async function checkServerBinariesStartup(): Promise<{
  ffmpegFound: boolean;
  ffmpegPath: string | null;
  ytDlpFound: boolean;
  ytDlpPath: string | null;
  ffprobeFound: boolean;
  ffprobePath: string | null;
}> {
  const ffmpeg = await getFfmpegPath().catch(() => null);
  const ytDlp = await getYtDlpPath().catch(() => null);
  const ffprobe = await getFfprobePath().catch(() => null);

  if (!ffmpeg) {
    console.error("\n" + "!".repeat(80));
    console.error("[CRITICAL STARTUP FAILURE] FFmpeg is NOT installed or could not be found!");
    console.error("Merging separate YouTube 1080p/4K video and audio streams requires FFmpeg.");
    console.error("Without FFmpeg, YouTube video downloads will fail or fall back to low quality.");
    console.error("Fix: Ensure ffmpeg is in your system PATH, or set the FFMPEG_PATH environment variable.");
    console.error("!".repeat(80) + "\n");
    if (process.env.NODE_ENV === "production" && process.env.STRICT_STARTUP_CHECKS === "true") {
      throw new Error("FFmpeg is missing in production environment. Halting startup.");
    }
  } else {
    console.log(`[Startup Check] FFmpeg verified: ${ffmpeg}`);
  }

  if (!ytDlp) {
    console.warn("[Startup Check Warning] yt-dlp binary could not be resolved.");
  } else {
    console.log(`[Startup Check] yt-dlp verified: ${ytDlp}`);
  }

  if (ffprobe) {
    console.log(`[Startup Check] ffprobe verified: ${ffprobe}`);
  }

  return {
    ffmpegFound: Boolean(ffmpeg),
    ffmpegPath: ffmpeg,
    ytDlpFound: Boolean(ytDlp),
    ytDlpPath: ytDlp,
    ffprobeFound: Boolean(ffprobe),
    ffprobePath: ffprobe,
  };
}
