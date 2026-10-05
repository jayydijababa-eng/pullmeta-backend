import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { jobQueue } from "@/lib/jobs";
import { fileCache } from "@/lib/fileCache";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ jobId: string }> | { jobId: string } }
) {
  const corsHeaders = getCorsHeaders(req);
  const resolvedParams = await Promise.resolve(context.params);
  const jobId = resolvedParams?.jobId || req.nextUrl.searchParams.get("jobId");

  if (!jobId) {
    return NextResponse.json(
      { error: { code: "INVALID_JOB", message: "Job ID is required." } },
      { status: 400, headers: corsHeaders }
    );
  }

  const job = await Promise.resolve(jobQueue.getJob(jobId));
  if (!job || job.status !== "ready") {
    return NextResponse.json(
      {
        error: {
          code: "FILE_NOT_READY",
          message: "Media file is not ready for download or has expired.",
        },
      },
      { status: 404, headers: corsHeaders }
    );
  }

  // If the file is stored in Cloud Storage (S3 / Cloudflare R2), redirect directly to edge URL
  if (job.downloadUrl && (job.downloadUrl.startsWith("http://") || job.downloadUrl.startsWith("https://"))) {
    return NextResponse.redirect(job.downloadUrl, 307);
  }

  if (!job.filePath) {
    return NextResponse.json(
      {
        error: {
          code: "FILE_NOT_FOUND",
          message: "Media file location is unavailable.",
        },
      },
      { status: 404, headers: corsHeaders }
    );
  }

  // Verify file existence and get accurate size
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(job.filePath);
    if (stat.size === 0) {
      throw new Error("File is empty.");
    }
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "FILE_NOT_FOUND",
          message: "Media file was purged from disk cache. Please request the download again.",
        },
      },
      { status: 410, headers: corsHeaders }
    );
  }

  const fileSize = stat.size;
  const fileName = job.fileName || `download-${job.videoId}.mp4`;
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_");
  const encodedName = encodeURIComponent(fileName);
  const contentType = job.contentType || "video/mp4";

  // Lock file from cache eviction during streaming
  const releaseReader = fileCache.acquireReader(job.filePath);

  const rangeHeader = req.headers.get("range");

  // Handle HTTP 206 Range requests (video seek / resume support)
  if (rangeHeader && rangeHeader.startsWith("bytes=")) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
      releaseReader();
      return new Response(null, {
        status: 416,
        headers: {
          ...corsHeaders,
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    }

    const chunkSize = end - start + 1;
    const nodeStream = fs.createReadStream(job.filePath, { start, end });

    let released = false;
    const doRelease = () => {
      if (!released) {
        released = true;
        releaseReader();
      }
    };

    nodeStream.on("close", doRelease);
    nodeStream.on("error", doRelease);

    if (req.signal) {
      req.signal.addEventListener("abort", () => {
        try {
          nodeStream.destroy();
        } catch {
          // ignore
        }
        doRelease();
      });
    }

    const webStream = Readable.toWeb(nodeStream) as unknown as BodyInit;

    return new Response(webStream, {
      status: 206,
      headers: {
        ...corsHeaders,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize.toString(),
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // Full file streaming (200 OK)
  const nodeStream = fs.createReadStream(job.filePath);

  let released = false;
  const doRelease = () => {
    if (!released) {
      released = true;
      releaseReader();
    }
  };

  nodeStream.on("close", doRelease);
  nodeStream.on("error", doRelease);

  if (req.signal) {
    req.signal.addEventListener("abort", () => {
      try {
        nodeStream.destroy();
      } catch {
        // ignore
      }
      doRelease();
    });
  }

  const webStream = Readable.toWeb(nodeStream) as unknown as BodyInit;

  return new Response(webStream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      "Content-Length": fileSize.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
