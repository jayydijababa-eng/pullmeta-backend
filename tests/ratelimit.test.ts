import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { checkRateLimit, getClientIp } from "../lib/ratelimit";

describe("Rate Limiter & IP Detection", () => {
  it("allows requests within extract limit (30 per 15 min default)", async () => {
    const ip = "192.168.1.100";
    for (let i = 0; i < 30; i++) {
      const res = await checkRateLimit(ip, "extract");
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(30 - (i + 1));
    }

    // 31st request must be rejected
    const blocked = await checkRateLimit(ip, "extract");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetInMs).toBeGreaterThan(0);
  });

  it("handles different IPs independently", async () => {
    const resA = await checkRateLimit("10.0.0.1", "extract");
    const resB = await checkRateLimit("10.0.0.2", "extract");
    expect(resA.allowed).toBe(true);
    expect(resB.allowed).toBe(true);
  });

  it("enforces separate limits for download (20 per 15 min default)", async () => {
    const ip = "192.168.3.150";
    for (let i = 0; i < 20; i++) {
      const res = await checkRateLimit(ip, "download");
      expect(res.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(ip, "download");
    expect(blocked.allowed).toBe(false);
  });

  it("enforces limits for thumbnail (100 per 15 min)", async () => {
    const ip = "192.168.2.200";
    const res = await checkRateLimit(ip, "thumbnail");
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(99);
  });

  describe("getClientIp proxy resolution", () => {
    it("extracts cf-connecting-ip first when behind Cloudflare / Railway edge", () => {
      const req = new NextRequest("http://localhost:4000/api/download", {
        headers: {
          "cf-connecting-ip": "203.0.113.195",
          "x-forwarded-for": "10.0.0.1, 10.0.0.2",
        },
      });
      expect(getClientIp(req)).toBe("203.0.113.195");
    });

    it("extracts x-real-ip if cf-connecting-ip is absent", () => {
      const req = new NextRequest("http://localhost:4000/api/download", {
        headers: {
          "x-real-ip": "198.51.100.42",
        },
      });
      expect(getClientIp(req)).toBe("198.51.100.42");
    });

    it("filters internal hops from x-forwarded-for and chooses public client IP", () => {
      const req = new NextRequest("http://localhost:4000/api/download", {
        headers: {
          "x-forwarded-for": "10.0.0.5, 198.51.100.99, 172.16.0.1",
        },
      });
      expect(getClientIp(req)).toBe("198.51.100.99");
    });

    it("strips port from IPv4 address", () => {
      const req = new NextRequest("http://localhost:4000/api/download", {
        headers: {
          "x-real-ip": "198.51.100.55:54321",
        },
      });
      expect(getClientIp(req)).toBe("198.51.100.55");
    });
  });
});
