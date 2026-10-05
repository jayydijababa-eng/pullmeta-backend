import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { jobQueue } from "@/lib/jobs";
import { fileCache } from "@/lib/fileCache";
import * as downloadModule from "@/lib/download";
import { GET as getStatus } from "@/app/api/download/status/[jobId]/route";
import { GET as getFile } from "@/app/api/download/file/[jobId]/route";
import { POST as postDownload } from "@/app/api/download/route";

describe("Async Job Queue & Scaling Architecture", () => {
  let dummyDir: string;
  let dummyFile: string;

  beforeEach(async () => {
    dummyDir = path.join(os.tmpdir(), `test-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.promises.mkdir(dummyDir, { recursive: true });
    dummyFile = path.join(dummyDir, "dummy.mp4");
    await fs.promises.writeFile(dummyFile, "PULLMETA_DUMMY_MP4_CONTENT_1234567890");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(dummyDir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates a queued download job and tracks queue position", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        filePath: dummyFile,
        tempDir: dummyDir,
        fileName: "Test Video.mp4",
        fileSize: 36,
        contentType: "video/mp4",
      }), 500))
    );

    const { job, coalesced, cached } = await jobQueue.createOrGetJob({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      videoId: "dQw4w9WgXcQ",
      type: "video",
      quality: "1080p",
    });

    expect(job.id).toBeDefined();
    expect(job.videoId).toBe("dQw4w9WgXcQ");
    expect(job.status).toMatch(/queued|processing/);
    expect(cached).toBe(false);
  });

  it("coalesces duplicate concurrent requests for the exact same video and quality", async () => {
    vi.spyOn(downloadModule, "executeDownload").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        filePath: dummyFile,
        tempDir: dummyDir,
        fileName: "Coalesced.mp4",
        fileSize: 36,
        contentType: "video/mp4",
      }), 1000))
    );

    const req1 = await jobQueue.createOrGetJob({
      url: "https://www.youtube.com/watch?v=coalesceTest",
      videoId: "coalesceTest",
      type: "video",
      quality: "720p",
    });

    const req2 = await jobQueue.createOrGetJob({
      url: "https://www.youtube.com/watch?v=coalesceTest",
      videoId: "coalesceTest",
      type: "video",
      quality: "720p",
    });

    expect(req2.job.id).toBe(req1.job.id);
    expect(req2.coalesced).toBe(true);
    expect(req2.job.subscribersCount).toBeGreaterThanOrEqual(2);
  });

  it("serves completed files instantly from on-disk fileCache", async () => {
    const targetKey = fileCache.generateKey({ videoId: "cachedVid", type: "video", quality: "1080p" });
    await fileCache.put(targetKey, dummyFile, {
      fileName: "Cached Video.mp4",
      fileSize: 36,
      contentType: "video/mp4",
    });

    const res = await jobQueue.createOrGetJob({
      url: "https://www.youtube.com/watch?v=cachedVid",
      videoId: "cachedVid",
      type: "video",
      quality: "1080p",
    });

    expect(res.cached).toBe(true);
    expect(res.job.status).toBe("ready");
    expect(res.job.fileName).toBe("Cached Video.mp4");
    expect(res.job.downloadUrl).toContain("/api/download/file/");
  });

  it("polls job status via GET /api/download/status/[jobId]", async () => {
    const { job } = await jobQueue.createOrGetJob({
      url: "https://www.youtube.com/watch?v=statusTest",
      videoId: "statusTest",
      type: "video",
      quality: "480p",
    });

    const req = new NextRequest(`http://localhost:4000/api/download/status/${job.id}`);
    const res = await getStatus(req, { params: Promise.resolve({ jobId: job.id }) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.jobId).toBe(job.id);
    expect(data.status).toBeDefined();
  });

  it("streams completed file with Range request (206) via GET /api/download/file/[jobId]", async () => {
    const targetKey = fileCache.generateKey({ videoId: "rangeVid", type: "video", quality: "1080p" });
    await fileCache.put(targetKey, dummyFile, {
      fileName: "Range Video.mp4",
      fileSize: 36,
      contentType: "video/mp4",
    });

    const { job } = await jobQueue.createOrGetJob({
      url: "https://www.youtube.com/watch?v=rangeVid",
      videoId: "rangeVid",
      type: "video",
      quality: "1080p",
    });

    const req = new NextRequest(`http://localhost:4000/api/download/file/${job.id}`, {
      headers: { Range: "bytes=0-9" },
    });

    const res = await getFile(req, { params: Promise.resolve({ jobId: job.id }) });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-9/37");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  });
});
