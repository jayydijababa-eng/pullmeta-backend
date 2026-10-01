import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { getYtDlpPath, getFfmpegPath } from "@/lib/binaries";
import { spawn } from "node:child_process";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function GET(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);
  const ffmpegPath = await getFfmpegPath().catch(() => null);
  const ytDlpPath = await getYtDlpPath().catch(() => null);

  const hasYtCookies = Boolean(process.env.YOUTUBE_COOKIES || process.env.COOKIES);
  const hasIgCookies = Boolean(process.env.INSTAGRAM_COOKIES || process.env.COOKIES);

  let probeResult: any = null;
  const shouldProbe = req.nextUrl.searchParams.get("probe") === "1";

  if (shouldProbe && ytDlpPath) {
    try {
      probeResult = await new Promise((resolve) => {
        const child = spawn(ytDlpPath, [
          "--no-playlist",
          "--no-warnings",
          "-F",
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ]);
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => { if (stdout.length < 5000) stdout += d.toString(); });
        child.stderr?.on("data", (d) => { if (stderr.length < 5000) stderr += d.toString(); });
        child.on("close", (code) => resolve({ code, stdout: stdout.slice(-1000), stderr: stderr.slice(-1000) }));
        setTimeout(() => { child.kill(); resolve({ timedOut: true }); }, 10000);
      });
    } catch (e: any) {
      probeResult = { error: e.message };
    }
  }

  return NextResponse.json(
    {
      ok: true,
      version: "2.2.0",
      hasFfmpeg: Boolean(ffmpegPath),
      ffmpegPath: ffmpegPath ? "available" : "missing",
      hasYtDlp: Boolean(ytDlpPath),
      hasYtCookies,
      hasIgCookies,
      probe: probeResult,
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
