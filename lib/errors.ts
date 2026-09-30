import { NextResponse } from "next/server";

export type ErrorCode =
  | "INVALID_URL"
  | "VIDEO_NOT_FOUND"
  | "THUMBNAIL_NOT_AVAILABLE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  VIDEO_NOT_FOUND: 404,
  THUMBNAIL_NOT_AVAILABLE: 404,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export function createErrorResponse(
  code: ErrorCode,
  message: string,
  extraHeaders: Record<string, string> = {}
): NextResponse<ErrorPayload> {
  const status = ERROR_STATUS_MAP[code] || 500;
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    }
  );
}
