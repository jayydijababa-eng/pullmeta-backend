import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { createErrorResponse } from "@/lib/errors";
import { checkRateLimit } from "@/lib/ratelimit";
import { parseYouTubeVideoId } from "@/lib/youtube";
import {
  DownloadQuality,
  VALID_QUALITIES,
  DownloadError,
  executeDownload,
  cleanupDirectory,
  releaseDownloadSlot,
} from "@/lib/download";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel execution limit

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

  // 1. Strict rate limiting: 5 requests per IP per 10 minutes
  const rateLimit = await checkRateLimit(ip, "download");
  if (!rateLimit.allowed) {
    const retryAfter = Math.ceil(rateLimit.resetInMs / 1000).toString();
    return createErrorResponse(
      "DOWNLOAD_RATE_LIMITED",
      "Rate limit exceeded. Maximum 5 download requests per 10 minutes.",
      {
        ...corsHeaders,
        "Retry-After": retryAfter,
      }
    );
  }

  // 2. Request body validation & length limit
  let body: { url?: string; quality?: string };
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

  const { url, quality } = body;
  if (!url || typeof url !== "string") {
    return createErrorResponse(
      "INVALID_URL",
      "Please provide a valid YouTube URL.",
      corsHeaders
    );
  }

  // 3. YouTube link parsing & ID validation using existing parser
  const parsed = parseYouTubeVideoId(url);
  if (!parsed.success || !parsed.videoId) {
    return createErrorResponse(
      "INVALID_URL",
      parsed.error || "Only YouTube links are supported.",
      corsHeaders
    );
  }

  const videoId = parsed.videoId;

  // 4. Quality selection validation
  const rawQuality = (quality || "best").toString().trim().toLowerCase() as DownloadQuality;
  if (!VALID_QUALITIES.includes(rawQuality)) {
    return createErrorResponse(
      "INVALID_URL",
      `Invalid quality option. Supported qualities: ${VALID_QUALITIES.join(", ")}.`,
      corsHeaders
    );
  }

  // 5. Execute download subprocess in temporary directory
  let downloadResult;
  try {
    downloadResult = await executeDownload({
      videoId,
      quality: rawQuality,
      abortSignal: req.signal,
    });
  } catch (err) {
    if (err instanceof DownloadError) {
      return createErrorResponse(err.code, err.message, corsHeaders);
    }
    return createErrorResponse(
      "DOWNLOAD_FAILED",
      "An unexpected error occurred while preparing the video download.",
      corsHeaders
    );
  }

  // 6. Stream the video file to the client with automatic cleanup
  try {
    const nodeStream = fs.createReadStream(downloadResult.filePath);
    let isCleaned = false;

    const doCleanup = () => {
      if (!isCleaned) {
        isCleaned = true;
        cleanupDirectory(downloadResult.tempDir).catch(() => {});
        releaseDownloadSlot();
      }
    };

    nodeStream.on("close", doCleanup);
    nodeStream.on("error", doCleanup);

    if (req.signal) {
      req.signal.addEventListener("abort", () => {
        try {
          nodeStream.destroy();
        } catch {
          // ignore
        }
        doCleanup();
      });
    }

    const webStream = Readable.toWeb(nodeStream) as unknown as BodyInit;

    const asciiName = downloadResult.fileName.replace(/[^\x20-\x7E]/g, "_");
    const encodedName = encodeURIComponent(downloadResult.fileName);

    return new Response(webStream, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": downloadResult.contentType,
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        "Content-Length": downloadResult.fileSize.toString(),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    await cleanupDirectory(downloadResult.tempDir);
    releaseDownloadSlot();
    return createErrorResponse(
      "DOWNLOAD_FAILED",
      "Failed to stream the video download.",
      corsHeaders
    );
  }
}
