import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { getYtDlpPath, getFfmpegPath } from "@/lib/binaries";
import { areCookiesConfigured, isProxyConfigured } from "@/lib/cookies";
import { getJsRuntimeArgs } from "@/lib/ytdlp";
import { jobQueue } from "@/lib/jobs";
import { fileCache } from "@/lib/fileCache";
import { getDiskSpace } from "@/lib/disk";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function GET(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);
  const ffmpegPath = await getFfmpegPath().catch(() => null);
  const ytDlpPath = await getYtDlpPath().catch(() => null);

  let ytDlpVersion: string | null = null;
  if (ytDlpPath) {
    try {
      const probe = spawnSync(ytDlpPath, ["--version"], { timeout: 3000, windowsHide: true });
      if (probe.status === 0 && probe.stdout) {
        ytDlpVersion = probe.stdout.toString("utf-8").trim();
      }
    } catch {
      // ignore
    }
  }

  const disk = await getDiskSpace();
  const queueStats = jobQueue.getStats();
  const cacheStats = fileCache.getStats();

  return NextResponse.json(
    {
      ok: true,
      cookiesLoaded: areCookiesConfigured(),
      proxyConfigured: isProxyConfigured(),
      ytDlpVersion,
      hasFfmpeg: Boolean(ffmpegPath),
      nodeVersion: process.versions.node,
      jsRuntimes: getJsRuntimeArgs()
        .filter((_, i) => i % 2 === 1)
        .map((r) => r.split(":")[0]),
      queue: {
        activeJobs: queueStats.activeJobs,
        queuedJobs: queueStats.queuedJobs,
        maxConcurrent: queueStats.maxConcurrent,
        maxQueueSize: queueStats.maxQueueSize,
      },
      fileCache: {
        cachedFiles: cacheStats.entriesCount,
        totalSizeMb: Math.round(cacheStats.totalBytes / (1024 * 1024)),
      },
      disk: {
        freeMb: Math.round(disk.freeBytes / (1024 * 1024)),
        totalMb: Math.round(disk.totalBytes / (1024 * 1024)),
        usedPercent: disk.usedPercent,
      },
    },
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-cache",
      },
    }
  );
}
