import fs from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fileCache } from "@/lib/fileCache";

export interface UploadOptions {
  fileName: string;
  contentType: string;
  fileSize?: number;
}

export interface UploadResult {
  key: string;
  downloadUrl: string;
  fileSize: number;
  contentType: string;
  driver: "local" | "s3";
}

export interface StorageStats {
  driver: "local" | "s3";
  configured: boolean;
  bucket?: string;
  endpoint?: string;
  publicDomain?: string;
}

export interface IStorageDriver {
  readonly name: "local" | "s3";
  uploadFile(localPath: string, key: string, options: UploadOptions): Promise<UploadResult>;
  getDownloadUrl(key: string, fileName?: string, expiresInSeconds?: number): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getStats(): Promise<StorageStats>;
}

/**
 * Local filesystem storage driver (zero-cost, default for dev, CI and single-instance deploys).
 */
export class LocalStorageDriver implements IStorageDriver {
  public readonly name = "local" as const;

  public async uploadFile(
    localPath: string,
    key: string,
    options: UploadOptions
  ): Promise<UploadResult> {
    const stat = await fs.promises.stat(localPath);
    const cachedFile = await fileCache.put(key, localPath, {
      fileName: options.fileName,
      fileSize: options.fileSize || stat.size,
      contentType: options.contentType,
    });

    return {
      key,
      downloadUrl: `/api/download/file/${key}`,
      fileSize: cachedFile.fileSize,
      contentType: cachedFile.contentType,
      driver: "local",
    };
  }

  public async getDownloadUrl(key: string, _fileName?: string): Promise<string> {
    return `/api/download/file/${key}`;
  }

  public async exists(key: string): Promise<boolean> {
    const cached = await fileCache.get(key);
    return Boolean(cached);
  }

  public async delete(key: string): Promise<void> {
    await fileCache.remove(key);
  }

  public async getStats(): Promise<StorageStats> {
    return {
      driver: "local",
      configured: true,
    };
  }
}

/**
 * S3-compatible cloud object storage driver (Cloudflare R2, AWS S3, Wasabi, MinIO, GCS).
 * Cloudflare R2 is strongly recommended for $0 egress bandwidth fees.
 */
export class S3StorageDriver implements IStorageDriver {
  public readonly name = "s3" as const;
  private client: S3Client;
  private bucket: string;
  private publicDomain?: string;
  private endpoint?: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET || "";
    this.publicDomain = process.env.S3_PUBLIC_DOMAIN;
    this.endpoint = process.env.S3_ENDPOINT;

    this.client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: this.endpoint || undefined,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }

  public async uploadFile(
    localPath: string,
    key: string,
    options: UploadOptions
  ): Promise<UploadResult> {
    const stat = await fs.promises.stat(localPath);
    const fileSize = options.fileSize || stat.size;
    const asciiName = options.fileName.replace(/[^\x20-\x7E]/g, "_");
    const encodedName = encodeURIComponent(options.fileName);

    const fileStream = fs.createReadStream(localPath);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fileStream,
      ContentType: options.contentType,
      ContentLength: fileSize,
      ContentDisposition: `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    });

    await this.client.send(command);

    const downloadUrl = await this.getDownloadUrl(key, options.fileName, 3600 * 4); // 4-hour pre-signed URL

    return {
      key,
      downloadUrl,
      fileSize,
      contentType: options.contentType,
      driver: "s3",
    };
  }

  public async getDownloadUrl(
    key: string,
    fileName?: string,
    expiresInSeconds: number = 3600
  ): Promise<string> {
    // If a custom CDN / public domain is configured (e.g. Cloudflare Custom Domain on R2)
    if (this.publicDomain) {
      const base = this.publicDomain.replace(/\/$/, "");
      return `${base}/${encodeURIComponent(key)}`;
    }

    const asciiName = (fileName || path.basename(key)).replace(/[^\x20-\x7E]/g, "_");
    const encodedName = encodeURIComponent(fileName || path.basename(key));

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    });

    return await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
    });
  }

  public async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      await this.client.send(command);
      return true;
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") {
        return false;
      }
      // If error is permission or network, log warning but don't crash
      console.warn(`[S3 exists check warning for ${key}]`, err?.message || err);
      return false;
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      await this.client.send(command);
    } catch (err: any) {
      console.error(`[S3 delete error for ${key}]`, err?.message || err);
    }
  }

  public async getStats(): Promise<StorageStats> {
    return {
      driver: "s3",
      configured: true,
      bucket: this.bucket,
      endpoint: this.endpoint,
      publicDomain: this.publicDomain,
    };
  }
}

/**
 * Checks if S3 / Cloudflare R2 credentials are fully configured.
 */
export function isS3Configured(): boolean {
  return Boolean(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  );
}

/**
 * Singleton factory returning appropriate storage driver based on environment variables.
 */
let cachedDriver: IStorageDriver | null = null;

export function getStorageDriver(): IStorageDriver {
  if (cachedDriver) return cachedDriver;

  if (isS3Configured()) {
    console.log("[StorageDriver] Initializing Cloud Object Storage (S3 / Cloudflare R2)");
    cachedDriver = new S3StorageDriver();
  } else {
    cachedDriver = new LocalStorageDriver();
  }

  return cachedDriver;
}

export const storageDriver = getStorageDriver();
