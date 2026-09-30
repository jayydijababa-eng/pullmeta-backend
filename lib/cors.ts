import { NextRequest, NextResponse } from "next/server";

export function getAllowedOrigins(): string[] {
  const envOrigins = (process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV !== "production") {
    if (!envOrigins.includes("http://localhost:3000")) {
      envOrigins.push("http://localhost:3000");
    }
  }

  return envOrigins;
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const allowed = getAllowedOrigins();
  return allowed.includes("*") || allowed.includes(origin);
}

export function getCorsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = getAllowedOrigins();

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };

  if (allowed.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }

  return headers;
}

export function handleCorsPreflight(req: NextRequest): NextResponse {
  const headers = getCorsHeaders(req);
  return new NextResponse(null, {
    status: 204,
    headers,
  });
}
