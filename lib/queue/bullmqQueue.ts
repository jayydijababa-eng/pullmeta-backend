import { randomUUID } from "node:crypto";
import { Queue, Job as BullJob } from "bullmq";
import Redis from "ioredis";
import { fileCache } from "@/lib/fileCache";
import { storageDriver } from "@/lib/storage";
import { DownloadError } from "@/lib/download";
import { getSharedRedisClient, createRedisClient } from "@/lib/redis";
import { DownloadJob, CreateJobParams, QueueStats, IJobQueue, JobStatus } from "./types";

export const QUEUE_NAME = "pullmeta-downloads";

const MAX_QUEUE_SIZE = process.env.MAX_QUEUE_SIZE
  ? parseInt(process.env.MAX_QUEUE_SIZE, 10)
  : 1000;

export interface BullDownloadJobPayload {
  jobId: string;
  targetKey: string;
  url: string;
  videoId: string;
  type: "video" | "audio";
  quality: string;
  format: string;
  audioQuality: string;
  clientIp?: string;
  createdAt: number;
}

export class BullMQJobQueue implements IJobQueue {
  public readonly driver = "bullmq" as const;
  private queue: Queue<BullDownloadJobPayload>;
  private redis: Redis;

  constructor() {
    this.redis = getSharedRedisClient();
    this.queue = new Queue<BullDownloadJobPayload>(QUEUE_NAME, {
      connection: createRedisClient(),
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: "exponential",
          delay: 3000,
        },
        removeOnComplete: { age: 3600 }, // retain 1 hour
        removeOnFail: { age: 7200 }, // retain 2 hours
      },
    });
  }

  public getTargetKey(params: {
    videoId: string;
    type: "video" | "audio";
    quality?: string;
    format?: string;
    audioQuality?: string;
  }): string {
    return fileCache.generateKey({
      videoId: params.videoId,
      type: params.type,
      quality: params.quality,
      format: params.format,
      audioQuality: params.audioQuality,
    });
  }

  public async createOrGetJob(params: CreateJobParams): Promise<{
    job: DownloadJob;
    coalesced: boolean;
    cached: boolean;
  }> {
    const targetKey = this.getTargetKey({
      videoId: params.videoId,
      type: params.type,
      quality: params.quality,
      format: params.format,
      audioQuality: params.audioQuality,
    });

    // 1. STEP 3 CACHE HIT: Check distributed cache first
    const cachedData = await this.redis.get(`pullmeta:cached:${targetKey}`);
    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        const jobId = `cached_${randomUUID()}`;
        const cachedJob: DownloadJob = {
          id: jobId,
          targetKey,
          url: params.url,
          videoId: params.videoId,
          type: params.type,
          quality: params.quality || "1080p",
          format: params.format || "mp3",
          audioQuality: params.audioQuality || "best",
          status: "ready",
          progress: 100,
          createdAt: Date.now(),
          completedAt: Date.now(),
          fileName: parsed.fileName,
          fileSize: parsed.fileSize,
          contentType: parsed.contentType,
          downloadUrl: parsed.downloadUrl,
          subscribersCount: 1,
        };
        return { job: cachedJob, coalesced: false, cached: true };
      } catch {
        // Fall through on JSON parse error
      }
    }

    // Also check storage driver directly (e.g. S3 object or local cache)
    const existsInStorage = await storageDriver.exists(targetKey);
    if (existsInStorage) {
      const downloadUrl = await storageDriver.getDownloadUrl(targetKey);
      const jobId = `cached_${randomUUID()}`;
      const cachedJob: DownloadJob = {
        id: jobId,
        targetKey,
        url: params.url,
        videoId: params.videoId,
        type: params.type,
        quality: params.quality || "1080p",
        format: params.format || "mp3",
        audioQuality: params.audioQuality || "best",
        status: "ready",
        progress: 100,
        createdAt: Date.now(),
        completedAt: Date.now(),
        downloadUrl,
        subscribersCount: 1,
      };

      await this.redis.set(
        `pullmeta:cached:${targetKey}`,
        JSON.stringify({ downloadUrl }),
        "EX",
        86400 * 7 // 7 days cache TTL
      );

      return { job: cachedJob, coalesced: false, cached: true };
    }

    // 2. STEP 3 DISTRIBUTED REQUEST COALESCING:
    // Check if another user already triggered an active/queued job for this target
    const existingJobId = await this.redis.get(`pullmeta:target:${targetKey}`);
    if (existingJobId) {
      const existingJob = await this.getJob(existingJobId);
      if (existingJob && (existingJob.status === "queued" || existingJob.status === "processing")) {
        await this.redis.hincrby(`pullmeta:job:${existingJobId}`, "subscribersCount", 1);
        existingJob.subscribersCount = (existingJob.subscribersCount || 1) + 1;
        return { job: existingJob, coalesced: true, cached: false };
      }
    }

    // 3. STEP 2 QUEUE CAPACITY:
    const waitingCount = await this.queue.getWaitingCount();
    if (waitingCount >= MAX_QUEUE_SIZE) {
      throw new DownloadError(
        "DOWNLOAD_RATE_LIMITED",
        "Server is currently experiencing very high demand. Please try again in 1–2 minutes."
      );
    }

    // 4. Create new BullMQ Job
    const jobId = randomUUID();
    const newJob: DownloadJob = {
      id: jobId,
      targetKey,
      url: params.url,
      videoId: params.videoId,
      type: params.type,
      quality: params.quality || "1080p",
      format: params.format || "mp3",
      audioQuality: params.audioQuality || "best",
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      subscribersCount: 1,
      queuePosition: waitingCount + 1,
    };

    // Store metadata hash in Redis
    await this.saveJobToRedis(newJob);

    // Atomically set active target lock with 30 min TTL
    await this.redis.set(`pullmeta:target:${targetKey}`, jobId, "EX", 1800);

    // Enqueue to BullMQ
    await this.queue.add(
      "download",
      {
        jobId,
        targetKey,
        url: params.url,
        videoId: params.videoId,
        type: params.type,
        quality: newJob.quality,
        format: newJob.format,
        audioQuality: newJob.audioQuality,
        clientIp: params.clientIp,
        createdAt: newJob.createdAt,
      },
      {
        jobId,
      }
    );

    return { job: newJob, coalesced: false, cached: false };
  }

  public async getJob(jobId: string): Promise<DownloadJob | null> {
    const raw = await this.redis.hgetall(`pullmeta:job:${jobId}`);
    if (!raw || Object.keys(raw).length === 0) {
      // Fallback check in BullMQ directly
      const bullJob = await this.queue.getJob(jobId);
      if (!bullJob) return null;
      const state = await bullJob.getState();
      return {
        id: jobId,
        targetKey: bullJob.data.targetKey,
        url: bullJob.data.url,
        videoId: bullJob.data.videoId,
        type: bullJob.data.type,
        quality: bullJob.data.quality,
        format: bullJob.data.format,
        audioQuality: bullJob.data.audioQuality,
        status: (state === "completed" ? "ready" : state === "failed" ? "failed" : state === "active" ? "processing" : "queued") as JobStatus,
        progress: bullJob.progress ? Number(bullJob.progress) : 0,
        createdAt: bullJob.timestamp,
        subscribersCount: 1,
      };
    }

    const job: DownloadJob = {
      id: raw.id || jobId,
      targetKey: raw.targetKey || "",
      url: raw.url || "",
      videoId: raw.videoId || "",
      type: (raw.type as "video" | "audio") || "video",
      quality: raw.quality || "1080p",
      format: raw.format || "mp3",
      audioQuality: raw.audioQuality || "best",
      status: (raw.status as JobStatus) || "queued",
      stage: raw.stage as any,
      progress: raw.progress ? parseInt(raw.progress, 10) : 0,
      createdAt: raw.createdAt ? parseInt(raw.createdAt, 10) : Date.now(),
      startedAt: raw.startedAt ? parseInt(raw.startedAt, 10) : undefined,
      completedAt: raw.completedAt ? parseInt(raw.completedAt, 10) : undefined,
      error: raw.error,
      errorCode: raw.errorCode,
      fileName: raw.fileName,
      fileSize: raw.fileSize ? parseInt(raw.fileSize, 10) : undefined,
      contentType: raw.contentType,
      downloadUrl: raw.downloadUrl,
      subscribersCount: raw.subscribersCount ? parseInt(raw.subscribersCount, 10) : 1,
    };

    if (job.status === "queued") {
      const waiting = await this.queue.getWaitingCount();
      job.queuePosition = Math.max(1, waiting);
    }

    return job;
  }

  private async saveJobToRedis(job: DownloadJob): Promise<void> {
    const data: Record<string, string> = {
      id: job.id,
      targetKey: job.targetKey,
      url: job.url,
      videoId: job.videoId,
      type: job.type,
      quality: job.quality,
      format: job.format,
      audioQuality: job.audioQuality,
      status: job.status,
      progress: (job.progress || 0).toString(),
      subscribersCount: (job.subscribersCount || 1).toString(),
      createdAt: (job.createdAt || Date.now()).toString(),
    };

    if (job.stage) data.stage = job.stage;
    if (job.startedAt) data.startedAt = job.startedAt.toString();
    if (job.completedAt) data.completedAt = job.completedAt.toString();
    if (job.error) data.error = job.error;
    if (job.errorCode) data.errorCode = job.errorCode;
    if (job.fileName) data.fileName = job.fileName;
    if (job.fileSize) data.fileSize = job.fileSize.toString();
    if (job.contentType) data.contentType = job.contentType;
    if (job.downloadUrl) data.downloadUrl = job.downloadUrl;

    const pipeline = this.redis.pipeline();
    pipeline.hmset(`pullmeta:job:${job.id}`, data);
    pipeline.expire(`pullmeta:job:${job.id}`, 7200); // 2 hours TTL
    await pipeline.exec();
  }

  public async getStats(): Promise<QueueStats> {
    const [active, waiting] = await Promise.all([
      this.queue.getActiveCount().catch(() => 0),
      this.queue.getWaitingCount().catch(() => 0),
    ]);

    const workerConcurrency = parseInt(process.env.WORKER_CONCURRENCY || "3", 10);

    return {
      activeJobs: active,
      queuedJobs: waiting,
      maxConcurrent: workerConcurrency,
      maxQueueSize: MAX_QUEUE_SIZE,
      totalTrackedJobs: active + waiting,
      driver: "bullmq",
    };
  }
}
