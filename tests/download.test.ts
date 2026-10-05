import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { POST } from "../app/api/download/route";
import * as downloadModule from "../lib/download";
import { resetRateLimitStore } from "../lib/ratelimit";
import {
  sanitizeDownloadFilename,
  getFormatSelector,
  formatCookiesForYtDlp,
  DownloadError,
} from "../lib/download";

describe("Download Service Unit Tests", () => {

  describe("sanitizeDownloadFilename", () => {
    it("handles regular video titles", () => {
      const result = sanitizeDownloadFilename(
        "Rick Astley - Never Gonna Give You Up",
        "dQw4w9WgXcQ",
        "1080p",
        "mp4"
      );
      expect(result).toBe("Rick Astley - Never Gonna Give You Up.mp4");
    });

    it("strips path traversal and filesystem special characters", () => {
      const result = sanitizeDownloadFilename(
        "../../../etc/passwd:<>|*?file",
        "dQw4w9WgXcQ",
        "720p",
        "mp4"
      );
      expect(result).not.toContain("..");
      expect(result).not.toContain("/");
      expect(result).not.toContain("\\");
      expect(result).not.toContain(":");
      expect(result).toBe("etcpasswdfile.mp4");
    });

    it("falls back to videoId-quality when title is null or empty", () => {
      const result = sanitizeDownloadFilename("", "dQw4w9WgXcQ", "best", "mp4");
      expect(result).toBe("dQw4w9WgXcQ-best.mp4");

      const nullResult = sanitizeDownloadFilename(null, "dQw4w9WgXcQ", "best", "mp4");
      expect(nullResult).toBe("dQw4w9WgXcQ-best.mp4");
    });

    it("truncates excessively long titles to 80 chars", () => {
      const longTitle = "A".repeat(120);
      const result = sanitizeDownloadFilename(longTitle, "dQw4w9WgXcQ", "1080p", "mp4");
      expect(result.length).toBeLessThanOrEqual(85); // 80 chars + .mp4
      expect(result).toBe(`${"A".repeat(80)}.mp4`);
    });
  });

  describe("formatCookiesForYtDlp", () => {
    it("converts JSON formatted cookies into valid Netscape format", () => {
      const jsonCookies = JSON.stringify([
        {
          domain: ".youtube.com",
          name: "SID",
          value: "test_sid_123",
          path: "/",
          secure: true,
          httpOnly: true,
          expirationDate: 1800000000,
        },
        {
          domain: ".youtube.com",
          name: "HSID",
          value: "test_hsid_456",
          path: "/",
          secure: false,
          httpOnly: false,
          expirationDate: 1800000000,
        },
      ]);

      const netscape = formatCookiesForYtDlp(jsonCookies);
      expect(netscape).toContain("# Netscape HTTP Cookie File");
      expect(netscape).toContain("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\ttest_sid_123");
      expect(netscape).toContain(".youtube.com\tTRUE\t/\tFALSE\t1800000000\tHSID\ttest_hsid_456");
    });

    it("leaves existing Netscape formatted cookies intact with header", () => {
      const rawNetscape = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\txyz\n";
      const result = formatCookiesForYtDlp(rawNetscape);
      expect(result).toContain("# Netscape HTTP Cookie File");
      expect(result).toContain(".youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\txyz");
    });

    it("handles base64 encoded JSON cookies", () => {
      const json = JSON.stringify([{ domain: ".youtube.com", name: "PREF", value: "f1=50000000" }]);
      const base64 = `base64:${Buffer.from(json).toString("base64")}`;
      const result = formatCookiesForYtDlp(base64);
      expect(result).toContain("# Netscape HTTP Cookie File");
      expect(result).toContain("PREF\tf1=50000000");
    });

    it("handles empty or whitespace strings safely", () => {
      expect(formatCookiesForYtDlp("")).toBe("");
      expect(formatCookiesForYtDlp("   ")).toBe("");
    });
  });

  describe("getFormatSelector", () => {
    it("requires FFmpeg for 1080p, 1440p, and 2160p and sorts by resolution", () => {
      const q1080 = getFormatSelector("1080p", true);
      expect(q1080.requiresFfmpeg).toBe(true);
      expect(q1080.formatSort).toContain("res:1080");

      const q1440 = getFormatSelector("1440p", true);
      expect(q1440.requiresFfmpeg).toBe(true);
      expect(q1440.formatSort).toContain("res:1440");

      const q2160 = getFormatSelector("2160p", true);
      expect(q2160.requiresFfmpeg).toBe(true);
      expect(q2160.formatSort).toContain("res:2160");
    });

    it("does not require FFmpeg for 720p and best without ffmpeg", () => {
      const q720Without = getFormatSelector("720p", false);
      expect(q720Without.requiresFfmpeg).toBe(false);
      expect(q720Without.formatSort).toContain("res:720");

      const qBestWithout = getFormatSelector("best", false);
      expect(qBestWithout.requiresFfmpeg).toBe(false);
      expect(qBestWithout.selector).toContain("vcodec!=none");
    });
  });

  describe("getAudioFormatConfig", () => {
    it("configures MP3 extraction with specified bitrates", () => {
      const mp3_320 = downloadModule.getAudioFormatConfig("mp3", "320", true);
      expect(mp3_320.ext).toBe("mp3");
      expect(mp3_320.contentType).toBe("audio/mpeg");
      expect(mp3_320.args).toContain("320k");

      const mp3_128 = downloadModule.getAudioFormatConfig("mp3", "128", true);
      expect(mp3_128.args).toContain("128k");
    });

    it("configures M4A and WAV formats correctly", () => {
      const m4a = downloadModule.getAudioFormatConfig("m4a", "best", true);
      expect(m4a.ext).toBe("m4a");
      expect(m4a.contentType).toBe("audio/mp4");

      const wav = downloadModule.getAudioFormatConfig("wav", "best", true);
      expect(wav.ext).toBe("wav");
      expect(wav.contentType).toBe("audio/wav");
    });
  });
});

describe("POST /api/download Route Handler", () => {
  const dummyFilePath = path.join(os.tmpdir(), "test-video-dummy.mp4");
  const dummyTempDir = path.join(os.tmpdir(), "test-temp-dir");

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetRateLimitStore();
    await fs.promises.mkdir(dummyTempDir, { recursive: true });
    await fs.promises.writeFile(dummyFilePath, Buffer.from("dummy mp4 video content"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.promises.rm(dummyFilePath, { force: true });
      await fs.promises.rm(dummyTempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("successfully streams video for a valid YouTube URL and quality", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockResolvedValueOnce({
      filePath: dummyFilePath,
      tempDir: dummyTempDir,
      fileName: "Test Video.mp4",
      fileSize: 24,
      contentType: "video/mp4",
    });

    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        quality: "1080p",
        sync: true,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Disposition")).toContain("Test Video.mp4");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Length")).toBe("24");
  });

  it("returns INVALID_URL (400) for missing or invalid URL", async () => {
    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({ url: "not-a-valid-url" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("INVALID_URL");
  });

  it("returns INVALID_URL (400) for SSRF attempt with non-YouTube IP", async () => {
    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("INVALID_URL");
    expect(data.error.message).toContain("Only YouTube links are supported");
  });

  it("returns INVALID_URL (400) for unsupported video domain", async () => {
    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({ url: "https://vimeo.com/12345678" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("INVALID_URL");
    expect(data.error.message).toContain("Only YouTube links are supported");
  });

  it("returns INVALID_URL (400) for command injection payload in video ID", async () => {
    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=;rm -rf /;test",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("INVALID_URL");
  });

  it("returns INVALID_URL (400) for unsupported quality parameter", async () => {
    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        quality: "8k_hdr_ultra",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("INVALID_URL");
    expect(data.error.message).toContain("Invalid quality option");
  });

  it("handles timeout error correctly (504 DOWNLOAD_TIMEOUT)", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockRejectedValueOnce(
      new DownloadError("DOWNLOAD_TIMEOUT", "Video processing exceeded execution time limit.")
    );

    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        quality: "best",
        sync: true,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(504);
    const data = await res.json();
    expect(data.error.code).toBe("DOWNLOAD_TIMEOUT");
    expect(data.error.message).toContain("Video processing exceeded execution time limit");
  });

  it("handles file size exceeded error (413 DOWNLOAD_TOO_LARGE)", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockRejectedValueOnce(
      new DownloadError("DOWNLOAD_TOO_LARGE", "The video file size exceeds the maximum allowed limit.")
    );

    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        quality: "2160p",
        sync: true,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error.code).toBe("DOWNLOAD_TOO_LARGE");
  });

  it("handles unavailable quality or restricted video (404 DOWNLOAD_UNAVAILABLE)", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockRejectedValueOnce(
      new DownloadError(
        "DOWNLOAD_UNAVAILABLE",
        "The requested quality (2160p) is not available for this video."
      )
    );

    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        quality: "2160p",
        sync: true,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("DOWNLOAD_UNAVAILABLE");
    expect(data.error.message).toContain("2160p");
  });

  it("handles general download failure safely without leaking stderr (500 DOWNLOAD_FAILED)", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockRejectedValueOnce(
      new DownloadError(
        "DOWNLOAD_FAILED",
        "Failed to process video download. Please try again with a different quality or video."
      )
    );

    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        quality: "720p",
        sync: true,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.code).toBe("DOWNLOAD_FAILED");
    expect(data.error).not.toHaveProperty("stderr");
    expect(data.error).not.toHaveProperty("stack");
  });

  it("enforces rate limit of 20 requests per 15 minutes", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockResolvedValue({
      filePath: dummyFilePath,
      tempDir: dummyTempDir,
      fileName: "Test.mp4",
      fileSize: 24,
      contentType: "video/mp4",
    });

    // Make 20 requests from the same IP (192.168.1.100)
    for (let i = 0; i < 20; i++) {
      const req = new NextRequest("http://localhost:4000/api/download", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.100" },
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", sync: true }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
    }

    // 21st request should be rate limited (429)
    const blockedReq = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      headers: { "x-forwarded-for": "192.168.1.100" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });

    const blockedRes = await POST(blockedReq);
    expect(blockedRes.status).toBe(429);
    const blockedData = await blockedRes.json();
    expect(blockedData.error.code).toBe("DOWNLOAD_RATE_LIMITED");
    expect(blockedRes.headers.get("Retry-After")).toBeDefined();
  });

  it("catches YouTube 429 error and returns friendly user message without leaking internals", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockRejectedValueOnce(
      new DownloadError("DOWNLOAD_RATE_LIMITED", "This video is temporarily unavailable due to high demand on YouTube. Please try again in a few minutes.")
    );

    const req = new NextRequest("http://localhost:4000/api/download", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", sync: true }),
    });

    const res = await POST(req);
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.code).toBe("DOWNLOAD_RATE_LIMITED");
    expect(data.error.message).toContain("high demand on YouTube");
  });

  describe("Cookie and Proxy Security & Management", () => {
    it("converts JSON cookie array export to valid Netscape format with correct flags", async () => {
      const { convertToNetscapeCookies } = await import("../lib/cookies");
      const jsonStr = JSON.stringify([
        {
          domain: ".youtube.com",
          name: "MOCK_COOKIE",
          value: "mock_value_123",
          path: "/",
          secure: true,
          httpOnly: true,
          expirationDate: 1900000000,
        },
      ]);

      const netscape = convertToNetscapeCookies(jsonStr);
      expect(netscape).toBeDefined();
      expect(netscape).toContain("# Netscape HTTP Cookie File");
      expect(netscape).toContain("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1900000000\tMOCK_COOKIE\tmock_value_123");
    });

    it("creates isolated request-scoped cookie file and cleans up on demand", async () => {
      const { createRequestCookieFile } = await import("../lib/cookies");
      process.env.YOUTUBE_COOKIES = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1900000000\tTEST\tval";

      const { cookiePath, cleanup } = await createRequestCookieFile();
      expect(cookiePath).toBeDefined();
      expect(fs.existsSync(cookiePath!)).toBe(true);

      const content = fs.readFileSync(cookiePath!, "utf-8");
      expect(content).toContain("TEST\tval");

      await cleanup();
      expect(fs.existsSync(cookiePath!)).toBe(false);
      delete process.env.YOUTUBE_COOKIES;
    });

    it("respects PROXY_URL and returns boolean safely in isProxyConfigured", async () => {
      const { getProxyUrl, isProxyConfigured } = await import("../lib/cookies");
      delete process.env.PROXY_URL;
      delete process.env.YOUTUBE_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;

      expect(isProxyConfigured()).toBe(false);
      expect(getProxyUrl()).toBeNull();

      process.env.PROXY_URL = "http://proxy.example.com:8080";
      expect(isProxyConfigured()).toBe(true);
      expect(getProxyUrl()).toBe("http://proxy.example.com:8080");
      delete process.env.PROXY_URL;
    });

    it("health check endpoint returns booleans and never exposes secret values", async () => {
      const { GET: healthGET } = await import("../app/api/health/route");
      const req = new NextRequest("http://localhost:4000/api/health");
      const res = await healthGET(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(typeof json.cookiesLoaded).toBe("boolean");
      expect(typeof json.proxyConfigured).toBe("boolean");
      expect(typeof json.hasFfmpeg).toBe("boolean");
      expect(json).not.toHaveProperty("cookies");
      expect(json).not.toHaveProperty("YOUTUBE_COOKIES");
      expect(json).not.toHaveProperty("proxy");
      expect(json).not.toHaveProperty("PROXY_URL");
    });
  });
});
