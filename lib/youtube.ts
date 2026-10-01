import { spawn } from "node:child_process";
import { getYtDlpPath } from "@/lib/binaries";

export interface ThumbnailItem {
  quality: "maxres" | "standard" | "high" | "medium";
  url: string;
  width: number;
  height: number;
}

export interface VideoQualityOption {
  id: string; // "1080p", "720p", "480p", "360p", "240p", "144p", "2160p"
  label: string; // "1080p", "4K"
  height: number;
  sub: string; // "Full HD", "HD", "4K UHD"
  isDefault: boolean;
  estimatedBytes: number | null;
  estimatedSize: string | null;
}

export interface AudioDownloadOption {
  id: string; // "mp3", "m4a"
  label: string;
  sub: string;
  estimatedBytes: number | null;
  estimatedSize: string | null;
}

export interface ExtractedVideoData {
  videoId: string;
  originalUrl?: string;
  title: string;
  description: string | null;
  tags: string[];
  thumbnails: ThumbnailItem[];
  channel: string;
  publishedAt: string | null;
  duration: number | null; // in seconds
  viewCount: number | null;
  categoryId: string | null;
  limited: boolean;
  availableQualities?: VideoQualityOption[];
  audioOptions?: AudioDownloadOption[];
}

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export interface MediaParseResult {
  success: boolean;
  platform: "youtube";
  id?: string;
  originalUrl: string;
  error?: string;
}

export function parseMediaUrl(rawInput: string): MediaParseResult {
  if (!rawInput || typeof rawInput !== "string") {
    return { success: false, platform: "youtube", originalUrl: "", error: "Please provide a valid YouTube URL." };
  }

  const trimmed = rawInput.trim();
  if (trimmed.length > 500) {
    return { success: false, platform: "youtube", originalUrl: trimmed, error: "URL exceeds maximum permitted length." };
  }

  // YouTube detection
  const yt = parseYouTubeVideoId(trimmed);
  return {
    success: yt.success,
    platform: "youtube",
    id: yt.videoId,
    originalUrl: yt.videoId ? `https://www.youtube.com/watch?v=${yt.videoId}` : trimmed,
    error: yt.error,
  };
}

export function parseYouTubeVideoId(rawInput: string): {
  success: boolean;
  videoId?: string;
  error?: string;
} {
  if (!rawInput || typeof rawInput !== "string") {
    return { success: false, error: "Please provide a valid YouTube URL." };
  }

  // Reject excessively long URLs to prevent memory abuse
  if (rawInput.length > 500) {
    return { success: false, error: "URL exceeds maximum permitted length." };
  }

  const trimmed = rawInput.trim();

  // If user passes raw 11-char ID directly
  if (VIDEO_ID_REGEX.test(trimmed)) {
    return { success: true, videoId: trimmed };
  }

  let urlString = trimmed;
  if (!/^https?:\/\//i.test(urlString)) {
    urlString = `https://${urlString}`;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return { success: false, error: "Invalid URL format." };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(hostname)) {
    return { success: false, error: "Only YouTube links are supported (e.g. youtube.com/watch, youtu.be, youtube.com/shorts)." };
  }

  let candidateId: string | null = null;

  if (hostname === "youtu.be") {
    const pathPart = parsedUrl.pathname.slice(1).split("/")[0];
    candidateId = pathPart || null;
  } else {
    const pathname = parsedUrl.pathname;
    if (pathname === "/watch") {
      candidateId = parsedUrl.searchParams.get("v");
    } else if (pathname.startsWith("/shorts/")) {
      candidateId = pathname.split("/shorts/")[1]?.split("/")[0] || null;
    } else if (pathname.startsWith("/live/")) {
      candidateId = pathname.split("/live/")[1]?.split("/")[0] || null;
    } else if (pathname.startsWith("/embed/")) {
      candidateId = pathname.split("/embed/")[1]?.split("/")[0] || null;
    } else if (pathname.startsWith("/v/")) {
      candidateId = pathname.split("/v/")[1]?.split("/")[0] || null;
    }
  }

  if (!candidateId || !VIDEO_ID_REGEX.test(candidateId)) {
    return {
      success: false,
      error: "Could not find a valid 11-character video ID in this YouTube link.",
    };
  }

  return { success: true, videoId: candidateId };
}

export function parseIsoDurationSeconds(durationStr?: string | null): number | null {
  if (!durationStr) return null;
  const matches = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!matches) return null;

  const hours = parseInt(matches[1] || "0", 10);
  const minutes = parseInt(matches[2] || "0", 10);
  const seconds = parseInt(matches[3] || "0", 10);

  return hours * 3600 + minutes * 60 + seconds;
}

export function buildThumbnails(
  videoId: string,
  apiThumbnails?: Record<string, { url: string; width: number; height: number }>
): ThumbnailItem[] {
  return [
    {
      quality: "maxres",
      url: apiThumbnails?.maxres?.url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      width: apiThumbnails?.maxres?.width || 1280,
      height: apiThumbnails?.maxres?.height || 720,
    },
    {
      quality: "standard",
      url: apiThumbnails?.standard?.url || `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
      width: apiThumbnails?.standard?.width || 640,
      height: apiThumbnails?.standard?.height || 480,
    },
    {
      quality: "high",
      url: apiThumbnails?.high?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      width: apiThumbnails?.high?.width || 480,
      height: apiThumbnails?.high?.height || 360,
    },
    {
      quality: "medium",
      url: apiThumbnails?.medium?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      width: apiThumbnails?.medium?.width || 320,
      height: apiThumbnails?.medium?.height || 180,
    },
  ];
}

/**
 * Fetch with an 8-second AbortController timeout.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Probes the real formats of a YouTube video using yt-dlp.
 * Returns only the resolutions that actually exist for this video,
 * along with real file size estimates.
 */
export async function probeVideoFormats(
  videoId: string,
  knownDuration?: number | null
): Promise<{
  availableQualities: VideoQualityOption[];
  audioOptions: AudioDownloadOption[];
}> {
  try {
    const ytDlpPath = await getYtDlpPath();
    if (!ytDlpPath) {
      return getFallbackFormatOptions();
    }

    const args = [
      "--dump-json",
      "--no-playlist",
      "--skip-download",
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    if (process.env.YOUTUBE_PLAYER_CLIENT) {
      args.push("--extractor-args", `youtube:player_client=${process.env.YOUTUBE_PLAYER_CLIENT}`);
    }

    const rawJson = await new Promise<string>((resolve, reject) => {
      const child = spawn(ytDlpPath, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error("Format probe timed out"));
      }, 7000);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 200000) {
          stdout += chunk.toString("utf-8");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 5000) {
          stderr += chunk.toString("utf-8");
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const parsed = JSON.parse(rawJson);
    const formats: any[] = Array.isArray(parsed.formats) ? parsed.formats : [];
    const duration = parsed.duration || knownDuration || 0;

    // 1. Identify best audio stream size
    const audioStreams = formats.filter(
      (f) => f.vcodec === "none" && f.acodec && f.acodec !== "none"
    );
    const bestAudio = audioStreams.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
    let audioSize = bestAudio ? (bestAudio.filesize || bestAudio.filesize_approx || 0) : 0;
    if (!audioSize && bestAudio && bestAudio.tbr && duration) {
      audioSize = Math.round((bestAudio.tbr * 1000 / 8) * duration);
    }

    // 2. Map standard video resolutions
    const standardHeights = [2160, 1440, 1080, 720, 480, 360, 240, 144];
    const foundHeights = new Set<number>();

    for (const f of formats) {
      const h = f.height || 0;
      const w = f.width || 0;
      const dim = Math.min(w, h) > 0 ? Math.min(w, h) : h;
      if (dim > 0 && f.vcodec && f.vcodec !== "none") {
        for (const std of standardHeights) {
          if (Math.abs(dim - std) <= 15) {
            foundHeights.add(std);
          }
        }
      }
    }

    // If no formats were categorized, fall back to safe standards
    if (foundHeights.size === 0) {
      return getFallbackFormatOptions();
    }

    const sortedHeights = Array.from(foundHeights).sort((a, b) => b - a);
    const defaultHeight = sortedHeights.find((h) => h <= 1080) || sortedHeights[0] || 1080;

    const subMap: Record<number, string> = {
      2160: "4K UHD",
      1440: "2K QHD",
      1080: "Full HD",
      720: "HD",
      480: "SD",
      360: "360p",
      240: "240p",
      144: "144p",
    };

    const qualityOptions: VideoQualityOption[] = [];

    for (const h of sortedHeights) {
      const matching = formats.filter((f) => {
        const dim = Math.min(f.width || 0, f.height || 0) > 0 ? Math.min(f.width || 0, f.height || 0) : f.height;
        return Math.abs((dim || 0) - h) <= 15 && f.vcodec && f.vcodec !== "none";
      });

      const bestV = matching.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
      let vSize = bestV ? (bestV.filesize || bestV.filesize_approx || 0) : 0;
      if (!vSize && bestV && (bestV.tbr || bestV.vbr) && duration) {
        const bitrate = bestV.tbr || bestV.vbr || 0;
        vSize = Math.round((bitrate * 1000 / 8) * duration);
      }

      const isProgressive = bestV && bestV.acodec && bestV.acodec !== "none";
      const totalBytes = vSize ? (isProgressive ? vSize : vSize + audioSize) : null;

      qualityOptions.push({
        id: `${h}p`,
        label: h === 2160 ? "4K" : `${h}p`,
        height: h,
        sub: subMap[h] || `${h}p`,
        isDefault: h === defaultHeight,
        estimatedBytes: totalBytes,
        estimatedSize: totalBytes ? `~${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : null,
      });
    }

    const audioOptions: AudioDownloadOption[] = [
      {
        id: "mp3",
        label: "MP3",
        sub: "Universal Audio (MP3)",
        estimatedBytes: audioSize ? Math.round(audioSize * 1.1) : null,
        estimatedSize: audioSize ? `~${((audioSize * 1.1) / (1024 * 1024)).toFixed(1)} MB` : null,
      },
      {
        id: "m4a",
        label: "M4A",
        sub: "Native High-Quality AAC",
        estimatedBytes: audioSize || null,
        estimatedSize: audioSize ? `~${(audioSize / (1024 * 1024)).toFixed(1)} MB` : null,
      },
    ];

    return { availableQualities: qualityOptions, audioOptions };
  } catch {
    return getFallbackFormatOptions();
  }
}

function getFallbackFormatOptions(): {
  availableQualities: VideoQualityOption[];
  audioOptions: AudioDownloadOption[];
} {
  return {
    availableQualities: [
      { id: "1080p", label: "1080p", height: 1080, sub: "Full HD", isDefault: true, estimatedBytes: null, estimatedSize: null },
      { id: "720p", label: "720p", height: 720, sub: "HD", isDefault: false, estimatedBytes: null, estimatedSize: null },
      { id: "480p", label: "480p", height: 480, sub: "SD", isDefault: false, estimatedBytes: null, estimatedSize: null },
      { id: "360p", label: "360p", height: 360, sub: "360p", isDefault: false, estimatedBytes: null, estimatedSize: null },
    ],
    audioOptions: [
      { id: "mp3", label: "MP3", sub: "Universal Audio (MP3)", estimatedBytes: null, estimatedSize: null },
      { id: "m4a", label: "M4A", sub: "Native High-Quality AAC", estimatedBytes: null, estimatedSize: null },
    ],
  };
}
