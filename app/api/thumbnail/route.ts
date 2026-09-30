import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { createErrorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/ratelimit";
import { fetchWithTimeout } from "@/lib/youtube";

export const runtime = "nodejs";

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const QUALITY_TO_FILENAME: Record<string, string> = {
  maxres: "maxresdefault.jpg",
  standard: "sddefault.jpg",
  high: "hqdefault.jpg",
  medium: "mqdefault.jpg",
};

const VALID_QUALITIES = ["maxres", "standard", "high", "medium", "best"];

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

export async function GET(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);
  const ip = getClientIp(req);

  // 1. Rate limiting (60 per 10 min)
  const rateLimit = await checkRateLimit(ip, "thumbnail");
  if (!rateLimit.allowed) {
    const retryAfter = Math.ceil(rateLimit.resetInMs / 1000).toString();
    return createErrorResponse(
      "RATE_LIMITED",
      "Rate limit exceeded. Maximum 60 thumbnail requests per 10 minutes.",
      {
        ...corsHeaders,
        "Retry-After": retryAfter,
      }
    );
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const quality = (searchParams.get("quality") || "best").toLowerCase();

  // 2. Validation
  if (!id || !VIDEO_ID_REGEX.test(id)) {
    return createErrorResponse(
      "INVALID_URL",
      "Invalid or missing video ID. Must be exactly 11 characters.",
      corsHeaders
    );
  }

  if (!VALID_QUALITIES.includes(quality)) {
    return createErrorResponse(
      "INVALID_URL",
      `Invalid quality option. Supported qualities: ${VALID_QUALITIES.join(", ")}.`,
      corsHeaders
    );
  }

  // 3. Fallback resolution logic for "best" or specific quality
  const candidateFilenames: string[] =
    quality === "best"
      ? ["maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg", "mqdefault.jpg"]
      : [QUALITY_TO_FILENAME[quality]];

  let imageResponse: Response | null = null;

  for (const filename of candidateFilenames) {
    const upstreamUrl = `https://i.ytimg.com/vi/${id}/${filename}`;
    try {
      const res = await fetchWithTimeout(upstreamUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PullMeta/1.0)",
        },
      });

      if (res.ok) {
        imageResponse = res;
        break;
      }
    } catch {
      // Continue to next quality in chain
    }
  }

  if (!imageResponse) {
    return createErrorResponse(
      "THUMBNAIL_NOT_AVAILABLE",
      "Thumbnail could not be found or retrieved from YouTube.",
      corsHeaders
    );
  }

  try {
    const imageBuffer = await imageResponse.arrayBuffer();
    const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
    const downloadFilename = `${id}-${quality}.jpg`;

    return new NextResponse(imageBuffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${downloadFilename}"`,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return createErrorResponse(
      "INTERNAL",
      "Failed to stream thumbnail image.",
      corsHeaders
    );
  }
}
