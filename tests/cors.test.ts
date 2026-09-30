import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { getCorsHeaders, isOriginAllowed, handleCorsPreflight } from "../lib/cors";

describe("CORS Handling", () => {
  it("allows localhost:3000 in non-production", () => {
    expect(isOriginAllowed("http://localhost:3000")).toBe(true);
  });

  it("handles preflight OPTIONS requests with 204 status", () => {
    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    const res = handleCorsPreflight(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("includes correct headers on normal request", () => {
    const req = new NextRequest("http://localhost:4000/api/extract", {
      headers: { Origin: "http://localhost:3000" },
    });
    const headers = getCorsHeaders(req);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });
});
