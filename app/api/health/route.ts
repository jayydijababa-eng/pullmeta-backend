import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflight(req);
}

export async function GET(req: NextRequest) {
  const corsHeaders = getCorsHeaders(req);
  return NextResponse.json(
    { ok: true },
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-cache",
      },
    }
  );
}
