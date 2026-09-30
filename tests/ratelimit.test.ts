import { describe, it, expect } from "vitest";
import { checkRateLimit } from "../lib/ratelimit";

describe("Rate Limiter", () => {
  it("allows requests within extract limit (20 per 10 min)", async () => {
    const ip = "192.168.1.100";
    for (let i = 0; i < 20; i++) {
      const res = await checkRateLimit(ip, "extract");
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(20 - (i + 1));
    }

    // 21st request must be rejected
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

  it("enforces separate limits for thumbnail (60 per 10 min)", async () => {
    const ip = "192.168.2.200";
    const res = await checkRateLimit(ip, "thumbnail");
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(59);
  });
});
