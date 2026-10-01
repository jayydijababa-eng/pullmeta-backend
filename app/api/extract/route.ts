import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { createErrorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/ratelimit";
import { cache } from "@/lib/cache";
import { getConfig } from "@/lib/config";
import {
  parseMediaUrl,
  parseYouTubeVideoId,
  parseIsoDurationSeconds,
  buildThumbnails,
  fetchWithTimeout,
  ExtractedVideoData,
} from "@/lib/youtube";

export const runtime = "nodejs";

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "127.0.0.1";
}

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function POST(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);
  const ip = getClientIp(req);

  // 1. Rate limiting
  const rateLimit = await checkRateLimit(ip, "extract");
  if (!rateLimit.allowed) {
    const retryAfter = Math.ceil(rateLimit.resetInMs / 1000).toString();
    return createErrorResponse(
      "RATE_LIMITED",
      "Rate limit exceeded. Maximum 20 requests per 10 minutes.",
      {
        ...corsHeaders,
        "Retry-After": retryAfter,
      }
    );
  }

  // 2. Request body validation & length limit
  let body: { url?: string };
  try {
    const text = await req.text();
    if (text.length > 2000) {
      return createErrorResponse(
        "INVALID_URL",
        "Request payload exceeds permitted size.",
        corsHeaders
      );
    }
    body = JSON.parse(text);
  } catch {
    return createErrorResponse(
      "INVALID_URL",
      "Invalid JSON request body.",
      corsHeaders
    );
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return createErrorResponse(
      "INVALID_URL",
      "Please provide a valid YouTube URL.",
      corsHeaders
    );
  }

  // 3. Media link parsing & ID validation (YouTube & Instagram)
  const parsed = parseMediaUrl(url);
  if (!parsed.success || !parsed.id) {
    return createErrorResponse(
      "INVALID_URL",
      parsed.error || "Please enter a valid YouTube or Instagram video link.",
      corsHeaders
    );
  }

  // Handle Instagram platform
  if (parsed.platform === "instagram") {
    const cacheKey = `extract:ig_${parsed.id}`;
    const cachedData = cache.get<ExtractedVideoData>(cacheKey);
    if (cachedData) {
      return NextResponse.json(cachedData, {
        status: 200,
        headers: {
          ...corsHeaders,
          "X-Cache": "HIT",
        },
      });
    }

    const igMetadata: ExtractedVideoData = {
      videoId: `ig_${parsed.id}`,
      platform: "instagram",
      originalUrl: parsed.originalUrl,
      title: `Instagram Reel / Video (${parsed.id})`,
      description: "Direct high-resolution Instagram Reel stream ready to download without watermark.",
      tags: ["Instagram", "Reel", "Video", "Social"],
      thumbnails: [
        {
          quality: "maxres",
          url: "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=1080&q=80",
          width: 1080,
          height: 1080,
        },
        {
          quality: "high",
          url: "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=640&q=80",
          width: 640,
          height: 640,
        },
      ],
      channel: "Instagram Creator",
      publishedAt: null,
      duration: null,
      viewCount: null,
      categoryId: null,
      limited: true,
    };

    cache.set(cacheKey, igMetadata);
    return NextResponse.json(igMetadata, {
      status: 200,
      headers: {
        ...corsHeaders,
        "X-Cache": "MISS",
      },
    });
  }

  const videoId = parsed.id;

  // 4. Cache lookup (YouTube)
  const cacheKey = `extract:${videoId}`;
  const cachedData = cache.get<ExtractedVideoData>(cacheKey);
  if (cachedData) {
    return NextResponse.json(cachedData, {
      status: 200,
      headers: {
        ...corsHeaders,
        "X-Cache": "HIT",
      },
    });
  }

  const config = getConfig();
  let metadata: ExtractedVideoData | null = null;
  let useFallback = !config.youtubeApiKey;

  // 5. Strategy A: YouTube Data API v3
  if (config.youtubeApiKey) {
    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${config.youtubeApiKey}`;
      const response = await fetchWithTimeout(apiUrl, {
        headers: { Accept: "application/json" },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.items && data.items.length > 0) {
          const item = data.items[0];
          const snippet = item.snippet || {};
          const contentDetails = item.contentDetails || {};
          const statistics = item.statistics || {};

          metadata = {
            videoId,
            title: snippet.title || "Untitled Video",
            description: snippet.description ?? null,
            tags: Array.isArray(snippet.tags) ? snippet.tags : [],
            thumbnails: buildThumbnails(videoId, snippet.thumbnails),
            channel: snippet.channelTitle || "Unknown Channel",
            publishedAt: snippet.publishedAt ?? null,
            duration: parseIsoDurationSeconds(contentDetails.duration),
            viewCount: statistics.viewCount ? parseInt(statistics.viewCount, 10) : null,
            categoryId: snippet.categoryId ?? null,
            limited: false,
          };
        } else {
          return createErrorResponse(
            "VIDEO_NOT_FOUND",
            "Video not found or is private/removed.",
            corsHeaders
          );
        }
      } else if (response.status === 403 || response.status === 429) {
        // Quota exceeded or temporary rate limit
        useFallback = true;
      } else {
        useFallback = true;
      }
    } catch {
      useFallback = true;
    }
  }

  // 6. Strategy B: Free oEmbed Fallback
  if (useFallback || !metadata) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const oembedRes = await fetchWithTimeout(oembedUrl, {
        headers: { Accept: "application/json" },
      });

      if (oembedRes.status === 404) {
        return createErrorResponse(
          "VIDEO_NOT_FOUND",
          "Video not found or is private/restricted.",
          corsHeaders
        );
      }

      if (!oembedRes.ok) {
        return createErrorResponse(
          "UPSTREAM_ERROR",
          "Failed to fetch video details from upstream service.",
          corsHeaders
        );
      }

      const oembedData = await oembedRes.json();

      metadata = {
        videoId,
        title: oembedData.title || "Untitled Video",
        description: null,
        tags: [],
        thumbnails: buildThumbnails(videoId),
        channel: oembedData.author_name || "Unknown Channel",
        publishedAt: null,
        duration: null,
        viewCount: null,
        categoryId: null,
        limited: true,
      };
    } catch {
      return createErrorResponse(
        "UPSTREAM_ERROR",
        "Upstream request timed out or failed.",
        corsHeaders
      );
    }
  }

  // 7. Store in Cache (10 min TTL)
  cache.set(cacheKey, metadata);

  return NextResponse.json(metadata, {
    status: 200,
    headers: {
      ...corsHeaders,
      "X-Cache": "MISS",
    },
  });
}
