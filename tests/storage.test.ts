import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LocalStorageDriver, S3StorageDriver, isS3Configured, getStorageDriver } from "@/lib/storage";

describe("Cloud Storage & Local Storage Driver Suite", () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `test-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    testFilePath = path.join(tempDir, "sample.mp4");
    await fs.promises.writeFile(testFilePath, "SAMPLE_VIDEO_CONTENT_12345");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("LocalStorageDriver", () => {
    it("stores files locally and generates local download URL", async () => {
      const driver = new LocalStorageDriver();
      expect(driver.name).toBe("local");

      const uploadResult = await driver.uploadFile(testFilePath, "test-target-key-1", {
        fileName: "Sample.mp4",
        contentType: "video/mp4",
        fileSize: 26,
      });

      expect(uploadResult.key).toBe("test-target-key-1");
      expect(uploadResult.downloadUrl).toBe("/api/download/file/test-target-key-1");
      expect(uploadResult.driver).toBe("local");

      const exists = await driver.exists("test-target-key-1");
      expect(exists).toBe(true);

      const downloadUrl = await driver.getDownloadUrl("test-target-key-1", "Sample.mp4");
      expect(downloadUrl).toBe("/api/download/file/test-target-key-1");

      await driver.delete("test-target-key-1");
      const existsAfterDelete = await driver.exists("test-target-key-1");
      expect(existsAfterDelete).toBe(false);
    });
  });

  describe("S3StorageDriver & Factory", () => {
    it("identifies when S3 is not configured", () => {
      const origBucket = process.env.S3_BUCKET;
      delete process.env.S3_BUCKET;

      expect(isS3Configured()).toBe(false);

      if (origBucket) process.env.S3_BUCKET = origBucket;
    });

    it("generates CDN URL when S3_PUBLIC_DOMAIN is configured", async () => {
      process.env.S3_BUCKET = "test-bucket";
      process.env.S3_ACCESS_KEY_ID = "test-key";
      process.env.S3_SECRET_ACCESS_KEY = "test-secret";
      process.env.S3_PUBLIC_DOMAIN = "https://cdn.pullmeta.com";

      const s3Driver = new S3StorageDriver();
      expect(s3Driver.name).toBe("s3");

      const cdnUrl = await s3Driver.getDownloadUrl("video_123.mp4", "Video 123.mp4");
      expect(cdnUrl).toBe("https://cdn.pullmeta.com/video_123.mp4");

      delete process.env.S3_PUBLIC_DOMAIN;
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;
    });
  });
});
