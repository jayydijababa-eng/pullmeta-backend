export interface ThumbnailItem {
  quality: "maxres" | "standard" | "high" | "medium";
  url: string;
  width: number;
  height: number;
}

export interface ExtractedVideoData {
  videoId: string;
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
}

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

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
    return { success: false, error: "Only YouTube links are supported." };
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
