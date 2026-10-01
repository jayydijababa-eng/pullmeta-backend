import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/extract/route";
import { cache } from "../lib/cache";

describe("POST /api/extract Handler", () => {
  beforeEach(() => {
    cache.clear();
    process.env.YOUTUBE_API_KEY = "test_mock_key";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles successful YouTube API v3 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              snippet: {
                title: "Mock Title",
                description: "Mock Description",
                channelTitle: "Mock Channel",
                tags: ["tag1", "tag2"],
                publishedAt: "2024-01-01T00:00:00Z",
                categoryId: "10",
              },
              contentDetails: { duration: "PT3M30S" },
              statistics: { viewCount: "100000" },
            },
          ],
        }),
        { status: 200 }
      )
    );

    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.videoId).toBe("dQw4w9WgXcQ");
    expect(data.title).toBe("Mock Title");
    expect(data.duration).toBe(210);
    expect(data.viewCount).toBe(100000);
    expect(data.limited).toBe(false);
  });

  it("returns VIDEO_NOT_FOUND (404) when YouTube API returns empty items", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), { status: 200 })
    );

    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=00000000000" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("VIDEO_NOT_FOUND");
  });

  it("falls back to oEmbed with limited: true when quota is exceeded (403)", async () => {
    // 1st call to YouTube API returns 403
    // 2nd call to oEmbed returns 200
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Quota exceeded", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Fallback Title",
            author_name: "Fallback Author",
          }),
          { status: 200 }
        )
      );

    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe("Fallback Title");
    expect(data.limited).toBe(true);
    expect(data.description).toBeNull();
    expect(data.tags).toEqual([]);
  });

  it("falls back to oEmbed when API key is missing", async () => {
    delete process.env.YOUTUBE_API_KEY;

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "oEmbed Only Video",
          author_name: "Author Name",
        }),
        { status: 200 }
      )
    );

    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.limited).toBe(true);
    expect(data.title).toBe("oEmbed Only Video");
  });

  it("returns VIDEO_NOT_FOUND (404) when oEmbed returns 404", async () => {
    delete process.env.YOUTUBE_API_KEY;

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not found", { status: 404 })
    );

    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=99999999999" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("VIDEO_NOT_FOUND");
  });

  it("returns UPSTREAM_ERROR (502) on network failure or timeout", async () => {
    delete process.env.YOUTUBE_API_KEY;

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Connection timeout"));

    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error.code).toBe("UPSTREAM_ERROR");
  });

  it("returns INVALID_URL (400) for non-YouTube links", async () => {
    const req = new NextRequest("http://localhost:4000/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://vimeo.com/12345678" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("INVALID_URL");
    expect(data.error.message).toBe("Only YouTube and Instagram links are supported.");
  });
});
