import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function GET(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);

  // Secure minimal health check in production (prevents version and runtime fingerprinting)
  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    }
  );
}
