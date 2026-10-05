import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CachedFileMetadata {
  key: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  accessCount: number;
}

// Default 60 minutes TTL for completed files
const DEFAULT_FILE_CACHE_TTL_MS = process.env.FILE_CACHE_TTL_MS
  ? parseInt(process.env.FILE_CACHE_TTL_MS, 10)
  : 60 * 60 * 1000;

// Default 3 GB maximum disk cache for completed downloads
const DEFAULT_MAX_CACHE_BYTES = process.env.MAX_FILE_CACHE_BYTES
  ? parseInt(process.env.MAX_FILE_CACHE_BYTES, 10)
  : 3 * 1024 * 1024 * 1024;

export class FileCacheManager {
  private cacheDir: string;
  private entries = new Map<string, CachedFileMetadata>();
  private activeReaders = new Map<string, number>(); // filePath -> active readers count
  private initialized = false;

  constructor() {
    this.cacheDir = path.join(os.tmpdir(), "pullmeta-file-cache");
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true });
      this.initialized = true;
    } catch (err) {
      console.error("[FileCache] Failed to initialize cache directory:", err);
    }
  }

  public getCacheDir(): string {
    return this.cacheDir;
  }

  /**
   * Generates a normalized cache key from target download parameters.
   */
  public generateKey(params: {
    videoId: string;
    type: "video" | "audio";
    quality?: string;
    format?: string;
    audioQuality?: string;
  }): string {
    const { videoId, type, quality = "best", format = "mp3", audioQuality = "best" } = params;
    if (type === "video") {
      return `vid_${videoId}_${quality.toLowerCase()}`;
    }
    return `aud_${videoId}_${format.toLowerCase()}_${audioQuality.toLowerCase()}`;
  }

  /**
   * Retrieves an existing cached file if valid and not expired.
   */
  public async get(key: string): Promise<CachedFileMetadata | null> {
    await this.init();
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      await this.remove(key);
      return null;
    }

    // Verify file still exists on disk
    try {
      const stat = await fs.promises.stat(entry.filePath);
      if (stat.size === 0) {
        await this.remove(key);
        return null;
      }
      entry.lastAccessedAt = Date.now();
      entry.accessCount++;
      return entry;
    } catch {
      this.entries.delete(key);
      return null;
    }
  }

  /**
   * Adds or updates a completed download file in the cache.
   * Moves or copies the source file into the persistent cache directory.
   */
  public async put(
    key: string,
    sourceFilePath: string,
    meta: {
      fileName: string;
      fileSize: number;
      contentType: string;
      ttlMs?: number;
    }
  ): Promise<CachedFileMetadata> {
    await this.init();

    const ext = path.extname(sourceFilePath) || ".mp4";
    const destPath = path.join(this.cacheDir, `${key}${ext}`);

    try {
      // If destination already exists, remove it first
      if (fs.existsSync(destPath) && destPath !== sourceFilePath) {
        await fs.promises.unlink(destPath).catch(() => {});
      }

      // Copy file to cache directory
      await fs.promises.copyFile(sourceFilePath, destPath);
    } catch (err) {
      console.warn(`[FileCache] Failed to copy file into cache (${key}):`, err);
      // Fallback: use source path directly
      const fallbackEntry: CachedFileMetadata = {
        key,
        filePath: sourceFilePath,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        contentType: meta.contentType,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        expiresAt: Date.now() + (meta.ttlMs || DEFAULT_FILE_CACHE_TTL_MS),
        accessCount: 1,
      };
      this.entries.set(key, fallbackEntry);
      return fallbackEntry;
    }

    const ttl = meta.ttlMs || DEFAULT_FILE_CACHE_TTL_MS;
    const entry: CachedFileMetadata = {
      key,
      filePath: destPath,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      contentType: meta.contentType,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      expiresAt: Date.now() + ttl,
      accessCount: 1,
    };

    this.entries.set(key, entry);

    // Evict if cache exceeds max allowed size
    await this.evictIfOverQuota();

    return entry;
  }

  /**
   * Marks a file as currently being read/streamed so eviction does not delete it.
   */
  public acquireReader(filePath: string): () => void {
    const current = this.activeReaders.get(filePath) || 0;
    this.activeReaders.set(filePath, current + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.activeReaders.get(filePath) || 1;
      if (count <= 1) {
        this.activeReaders.delete(filePath);
      } else {
        this.activeReaders.set(filePath, count - 1);
      }
    };
  }

  /**
   * Removes a cached entry and deletes its file.
   */
  public async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;

    this.entries.delete(key);

    // If file is currently being read, don't delete immediately
    if ((this.activeReaders.get(entry.filePath) || 0) > 0) {
      return;
    }

    try {
      if (fs.existsSync(entry.filePath)) {
        await fs.promises.unlink(entry.filePath);
      }
    } catch {
      // Ignore deletion errors
    }
  }

  /**
   * Calculates total current cached bytes.
   */
  public getTotalSizeBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.fileSize || 0;
    }
    return total;
  }

  /**
   * Evicts least recently accessed entries if cache size exceeds quota.
   */
  private async evictIfOverQuota(): Promise<void> {
    let totalSize = this.getTotalSizeBytes();
    if (totalSize <= DEFAULT_MAX_CACHE_BYTES) return;

    // Sort entries by lastAccessedAt ascending (oldest first)
    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt
    );

    for (const entry of sorted) {
      if (totalSize <= DEFAULT_MAX_CACHE_BYTES) break;

      // Skip entries currently being read
      if ((this.activeReaders.get(entry.filePath) || 0) > 0) continue;

      totalSize -= entry.fileSize;
      await this.remove(entry.key);
    }
  }

  /**
   * Periodic maintenance: removes expired cache files.
   */
  public async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let removedCount = 0;

    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        if ((this.activeReaders.get(entry.filePath) || 0) === 0) {
          await this.remove(key);
          removedCount++;
        }
      }
    }

    return removedCount;
  }

  public getStats() {
    return {
      entriesCount: this.entries.size,
      totalBytes: this.getTotalSizeBytes(),
      maxBytes: DEFAULT_MAX_CACHE_BYTES,
      ttlMs: DEFAULT_FILE_CACHE_TTL_MS,
    };
  }
}

export const fileCache = new FileCacheManager();
