import { describe, it, expect } from "vitest";
import {
  parseYouTubeVideoId,
  parseIsoDurationSeconds,
  buildThumbnails,
} from "../lib/youtube";

describe("YouTube URL & ID Parser", () => {
  it("parses standard watch URLs", () => {
    const res = parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses youtu.be shortlinks with query params", () => {
    const res = parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=abcdef");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses YouTube Shorts URLs", () => {
    const res = parseYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses live stream URLs", () => {
    const res = parseYouTubeVideoId("https://youtube.com/live/dQw4w9WgXcQ");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses embed URLs", () => {
    const res = parseYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses music.youtube.com URLs", () => {
    const res = parseYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses mobile m.youtube.com URLs", () => {
    const res = parseYouTubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  it("accepts bare 11-char ID directly", () => {
    const res = parseYouTubeVideoId("dQw4w9WgXcQ");
    expect(res.success).toBe(true);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  describe("Malicious and invalid inputs (10+ cases)", () => {
    const invalidInputs = [
      "https://vimeo.com/12345678",
      "https://instagram.com/p/abcdef12345",
      "https://tiktok.com/@user/video/12345678901",
      "javascript:alert(1)",
      "https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.attacker.com/watch?v=dQw4w9WgXcQ",
      "https://subdomain.youtube.com.fake/watch?v=dQw4w9WgXcQ",
      "data:text/html,<script>alert(1)</script>",
      "https://youtube.com/watch?v=tooShort",
      "https://youtube.com/watch?v=wayTooLongId123456789",
      "https://youtube.com/watch?v=with$pecial!",
      "https://youtube.com/watch?v=",
      "https://youtube.com/watch",
      "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/" + "a".repeat(600),
    ];

    it.each(invalidInputs)("rejects invalid input: %s", (input) => {
      const res = parseYouTubeVideoId(input);
      expect(res.success).toBe(false);
      expect(res.videoId).toBeUndefined();
    });
  });

  describe("Duration parsing", () => {
    it("parses standard PT durations into seconds", () => {
      expect(parseIsoDurationSeconds("PT3M33S")).toBe(213);
      expect(parseIsoDurationSeconds("PT1H2M10S")).toBe(3730);
      expect(parseIsoDurationSeconds("PT45S")).toBe(45);
      expect(parseIsoDurationSeconds("PT1H")).toBe(3600);
      expect(parseIsoDurationSeconds(null)).toBeNull();
      expect(parseIsoDurationSeconds("")).toBeNull();
    });
  });

  describe("Thumbnail builder", () => {
    it("builds all 4 qualities correctly", () => {
      const thumbs = buildThumbnails("dQw4w9WgXcQ");
      expect(thumbs).toHaveLength(4);
      expect(thumbs.map((t) => t.quality)).toEqual(["maxres", "standard", "high", "medium"]);
      expect(thumbs[0].url).toContain("maxresdefault.jpg");
    });
  });
});
