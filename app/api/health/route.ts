import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { getYtDlpPath, getFfmpegPath } from "@/lib/binaries";
import { areCookiesConfigured, isProxyConfigured } from "@/lib/cookies";

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

  return NextResponse.json(
    {
      ok: true,
      cookiesLoaded: areCookiesConfigured(),
      proxyConfigured: isProxyConfigured(),
      ytDlpVersion,
      hasFfmpeg: Boolean(ffmpegPath),
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
