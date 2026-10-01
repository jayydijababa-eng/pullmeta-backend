import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { getYtDlpPath, getFfmpegPath, getFfprobePath } from "@/lib/binaries";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function GET(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);
  const ffmpegPath = await getFfmpegPath().catch(() => null);
  const ffprobePath = await getFfprobePath().catch(() => null);
  const ytDlpPath = await getYtDlpPath().catch(() => null);

  const hasYtCookies = Boolean(process.env.YOUTUBE_COOKIES || process.env.COOKIES);

  return NextResponse.json(
    {
      ok: true,
      version: "3.0.0",
      hasFfmpeg: Boolean(ffmpegPath),
      ffmpegPath: ffmpegPath ? "available" : "missing",
      hasFfprobe: Boolean(ffprobePath),
      ffprobePath: ffprobePath ? "available" : "missing",
      hasYtDlp: Boolean(ytDlpPath),
      hasYtCookies,
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
