import { NextRequest } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { createErrorResponse } from "@/lib/errors";
import { checkRateLimit, getClientIp } from "@/lib/ratelimit";
import { parseMediaUrl, parseYouTubeVideoId } from "@/lib/youtube";
import {
  DownloadType,
  VideoQuality,
  AudioFormat,
  AudioQuality,
  VALID_VIDEO_QUALITIES,
  VALID_AUDIO_FORMATS,
  VALID_AUDIO_QUALITIES,
  DownloadError,
  executeDownload,
  cleanupDirectory,
  releaseDownloadSlot,
} from "@/lib/download";

export const runtime = "nodejs";
export const maxDuration = 60; // Execution limit

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function POST(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);
  const ip = getClientIp(req);

  // 1. Rate limiting (20 downloads per IP per 15 minutes by default)
  const rateLimit = await checkRateLimit(ip, "download");
  if (!rateLimit.allowed) {
    console.warn(`[PullMeta RateLimit] Client IP ${ip} hit download rate limit.`);
    const retryAfter = Math.ceil(rateLimit.resetInMs / 1000).toString();
    return createErrorResponse(
      "DOWNLOAD_RATE_LIMITED",
      "Rate limit reached. Please wait a few minutes before downloading again.",
      {
        ...corsHeaders,
        "Retry-After": retryAfter,
      }
    );
  }

  // 2. Request body validation & length limit
  let body: {
    url?: string;
    type?: string;
    quality?: string;
    format?: string;
    audioQuality?: string;
  };
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

  const { url, type, quality, format, audioQuality } = body;
  if (!url || typeof url !== "string") {
    return createErrorResponse(
      "INVALID_URL",
      "Please provide a valid YouTube URL.",
      corsHeaders
    );
  }

  // 3. YouTube link parsing & ID validation
  const parsed = parseMediaUrl(url);
  if (!parsed.success || !parsed.id) {
    return createErrorResponse(
      "INVALID_URL",
      parsed.error || "Please enter a valid YouTube link.",
      corsHeaders
    );
  }

  const videoId = parsed.id;
  const originalUrl = parsed.originalUrl;

  // 4. Determine download type (video vs audio)
  const isAudio =
    type === "audio" ||
    (typeof format === "string" && VALID_AUDIO_FORMATS.includes(format.toLowerCase() as AudioFormat));
  const downloadType: DownloadType = isAudio ? "audio" : "video";

  // Validate parameters based on type
  let validQuality: VideoQuality = "1080p";
  let validFormat: AudioFormat = "mp3";
  let validAudioQuality: AudioQuality = "best";

  if (downloadType === "video") {
    const rawQuality = (quality || "1080p").toString().trim().toLowerCase() as VideoQuality;
    if (!VALID_VIDEO_QUALITIES.includes(rawQuality)) {
      return createErrorResponse(
        "INVALID_URL",
        `Invalid quality option. Supported video qualities: ${VALID_VIDEO_QUALITIES.join(", ")}.`,
        corsHeaders
      );
    }
    validQuality = rawQuality;
  } else {
    const rawFormat = (format || "mp3").toString().trim().toLowerCase() as AudioFormat;
    if (!VALID_AUDIO_FORMATS.includes(rawFormat)) {
      return createErrorResponse(
        "INVALID_URL",
        `Invalid audio format option. Supported formats: ${VALID_AUDIO_FORMATS.join(", ")}.`,
        corsHeaders
      );
    }
    validFormat = rawFormat;

    const rawAudioQuality = (audioQuality || "best").toString().trim().toLowerCase() as AudioQuality;
    if (!VALID_AUDIO_QUALITIES.includes(rawAudioQuality)) {
      return createErrorResponse(
        "INVALID_URL",
        `Invalid audio quality option. Supported audio qualities: ${VALID_AUDIO_QUALITIES.join(", ")}.`,
        corsHeaders
      );
    }
    validAudioQuality = rawAudioQuality;
  }

  // 5. Execute download subprocess in temporary directory
  let downloadResult;
  try {
    downloadResult = await executeDownload({
      videoId,
      url: originalUrl,
      type: downloadType,
      quality: validQuality,
      format: validFormat,
      audioQuality: validAudioQuality,
      abortSignal: req.signal,
    });
  } catch (err) {
    if (err instanceof DownloadError) {
      return createErrorResponse(err.code, err.message, corsHeaders);
    }
    return createErrorResponse(
      "DOWNLOAD_FAILED",
      "An unexpected error occurred while preparing the media download.",
      corsHeaders
    );
  }

  // 6. Stream the media file to the client with automatic cleanup
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
      "Failed to stream the media download.",
      corsHeaders
    );
  }
}
