import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { jobQueue } from "@/lib/jobs";

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

  const job = jobQueue.getJob(jobId);
  if (!job) {
    return NextResponse.json(
      {
        error: {
          code: "JOB_NOT_FOUND",
          message: "Download job not found or has expired. Please initiate a new download.",
        },
      },
      { status: 404, headers: corsHeaders }
    );
  }

  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress || 0,
      queuePosition: job.queuePosition,
      error: job.error,
      errorCode: job.errorCode,
      fileName: job.fileName,
      fileSize: job.fileSize,
      downloadUrl: job.downloadUrl,
      subscribersCount: job.subscribersCount,
      createdAt: job.createdAt,
    },
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    }
  );
}
