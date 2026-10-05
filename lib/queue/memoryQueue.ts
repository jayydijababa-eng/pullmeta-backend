import { randomUUID } from "node:crypto";
import { executeDownload, DownloadError, cleanupDirectory } from "@/lib/download";
import { fileCache } from "@/lib/fileCache";
import { hasSufficientDiskSpace } from "@/lib/disk";
import { storageDriver } from "@/lib/storage";
import { DownloadJob, CreateJobParams, QueueStats, IJobQueue } from "./types";

const MAX_CONCURRENT_JOBS = process.env.MAX_CONCURRENT_JOBS
  ? parseInt(process.env.MAX_CONCURRENT_JOBS, 10)
  : 2;

const MAX_QUEUE_SIZE = process.env.MAX_QUEUE_SIZE
  ? parseInt(process.env.MAX_QUEUE_SIZE, 10)
  : 200;

export class InMemoryJobQueue implements IJobQueue {
  public readonly driver = "in-memory" as const;
  private jobs = new Map<string, DownloadJob>();
  private activeTargetMap = new Map<string, string>(); // targetKey -> active/queued jobId
  private queue: string[] = []; // FIFO list of queued jobIds
  private activeJobsCount = 0;
  private isProcessingLoopActive = false;
  private creationLocks = new Map<string, Promise<{ job: DownloadJob; coalesced: boolean; cached: boolean }>>();

  constructor() {
    this.scheduleQueueTick();
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

    // 1. STEP 3 REQUEST COALESCING: Check if a job is already active/queued
    const existingJobId = this.activeTargetMap.get(targetKey);
    if (existingJobId) {
      const existingJob = this.jobs.get(existingJobId);
      if (existingJob && (existingJob.status === "queued" || existingJob.status === "processing")) {
        existingJob.subscribersCount++;
        const queuePos = this.calculateQueuePosition(existingJob.id);
        if (queuePos > 0) existingJob.queuePosition = queuePos;
        return { job: existingJob, coalesced: true, cached: false };
      }
    }

    // 2. Check if another concurrent request is currently in the middle of creating this target
    const pendingCreation = this.creationLocks.get(targetKey);
    if (pendingCreation) {
      const res = await pendingCreation;
      if (res.job && (res.job.status === "queued" || res.job.status === "processing")) {
        res.job.subscribersCount++;
        return { job: res.job, coalesced: true, cached: false };
      }
      return res;
    }

    // 3. Atomically register creation lock before any async operation
    const creationPromise = this.doCreateOrGetJob(targetKey, params);
    this.creationLocks.set(targetKey, creationPromise);

    try {
      return await creationPromise;
    } finally {
      this.creationLocks.delete(targetKey);
    }
  }

  private async doCreateOrGetJob(
    targetKey: string,
    params: CreateJobParams
  ): Promise<{
    job: DownloadJob;
    coalesced: boolean;
    cached: boolean;
  }> {
    // 1. CACHE HIT: Check if finished file already exists on disk / storage
    const cachedFile = await fileCache.get(targetKey);
    if (cachedFile) {
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
        startedAt: Date.now(),
        completedAt: Date.now(),
        fileName: cachedFile.fileName,
        fileSize: cachedFile.fileSize,
        contentType: cachedFile.contentType,
        filePath: cachedFile.filePath,
        downloadUrl: `/api/download/file/${jobId}`,
        subscribersCount: 1,
      };

      this.jobs.set(jobId, cachedJob);
      return { job: cachedJob, coalesced: false, cached: true };
    }

    // 2. DISK CEILING: Check available storage before accepting a new job
    const diskCheck = await hasSufficientDiskSpace();
    if (!diskCheck.sufficient) {
      throw new DownloadError(
        "DOWNLOAD_RATE_LIMITED",
        diskCheck.reason || "Server storage is temporarily full. Please retry in a few minutes."
      );
    }

    // 3. QUEUE CAPACITY: Verify queue capacity
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      throw new DownloadError(
        "DOWNLOAD_RATE_LIMITED",
        "Server is currently very busy with high user demand. Please retry in 1–2 minutes."
      );
    }

    // 4. Create new queued job
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
    };

    this.jobs.set(jobId, newJob);
    this.activeTargetMap.set(targetKey, jobId);
    this.queue.push(jobId);
    newJob.queuePosition = this.calculateQueuePosition(jobId);

    // Trigger queue processing
    this.processNextJobs();

    return { job: newJob, coalesced: false, cached: false };
  }

  public async getJob(jobId: string): Promise<DownloadJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (job.status === "queued") {
      job.queuePosition = this.calculateQueuePosition(job.id);
    }

    return job;
  }

  private calculateQueuePosition(jobId: string): number {
    const index = this.queue.indexOf(jobId);
    return index !== -1 ? index + 1 : 0;
  }

  private scheduleQueueTick(): void {
    setInterval(() => {
      this.processNextJobs();
      this.cleanupOldJobs();
    }, 1500);
  }

  private async processNextJobs(): Promise<void> {
    if (this.isProcessingLoopActive) return;
    this.isProcessingLoopActive = true;

    try {
      while (this.activeJobsCount < MAX_CONCURRENT_JOBS && this.queue.length > 0) {
        const jobId = this.queue.shift();
        if (!jobId) break;

        const job = this.jobs.get(jobId);
        if (!job || job.status !== "queued") continue;

        this.activeJobsCount++;
        job.status = "processing";
        job.startedAt = Date.now();
        job.queuePosition = undefined;
        job.stage = "downloading";
        job.progress = 10;

        // Execute job in background
        this.runJob(job).finally(() => {
          this.activeJobsCount = Math.max(0, this.activeJobsCount - 1);
          this.processNextJobs();
        });
      }
    } finally {
      this.isProcessingLoopActive = false;
    }
  }

  private async runJob(job: DownloadJob): Promise<void> {
    try {
      const cached = await fileCache.get(job.targetKey);
      if (cached) {
        job.status = "ready";
        job.progress = 100;
        job.completedAt = Date.now();
        job.fileName = cached.fileName;
        job.fileSize = cached.fileSize;
        job.contentType = cached.contentType;
        job.filePath = cached.filePath;
        job.downloadUrl = `/api/download/file/${job.id}`;
        this.activeTargetMap.delete(job.targetKey);
        return;
      }

      job.stage = "downloading";
      job.progress = 25;

      const result = await executeDownload({
        videoId: job.videoId,
        url: job.url,
        type: job.type,
        quality: job.quality,
        format: job.format,
        audioQuality: job.audioQuality,
      });

      job.stage = "verifying";
      job.progress = 85;

      let finalDownloadUrl = `/api/download/file/${job.id}`;
      let finalFilePath = result.filePath;

      if (storageDriver.name === "s3") {
        job.stage = "caching";
        const uploaded = await storageDriver.uploadFile(result.filePath, job.targetKey, {
          fileName: result.fileName,
          contentType: result.contentType,
          fileSize: result.fileSize,
        });
        finalDownloadUrl = uploaded.downloadUrl;
        await cleanupDirectory(result.tempDir).catch(() => {});
      } else {
        const cachedFile = await fileCache.put(job.targetKey, result.filePath, {
          fileName: result.fileName,
          fileSize: result.fileSize,
          contentType: result.contentType,
        });
        finalFilePath = cachedFile.filePath;
        await cleanupDirectory(result.tempDir).catch(() => {});
      }

      job.status = "ready";
      job.stage = undefined;
      job.progress = 100;
      job.completedAt = Date.now();
      job.fileName = result.fileName;
      job.fileSize = result.fileSize;
      job.contentType = result.contentType;
      job.filePath = finalFilePath;
      job.downloadUrl = finalDownloadUrl;
    } catch (err: any) {
      console.error(`[Job ${job.id} Failed] ${err?.message || err}`);
      job.status = "failed";
      job.stage = undefined;
      job.completedAt = Date.now();
      job.error =
        err instanceof DownloadError
          ? err.message
          : err?.message || "Failed to process media download. Please try again.";
      job.errorCode = err?.code || "DOWNLOAD_FAILED";
    } finally {
      this.activeTargetMap.delete(job.targetKey);
    }
  }

  private cleanupOldJobs(): void {
    const now = Date.now();
    const RETENTION_MS = 60 * 60 * 1000; // 1 hour

    for (const [id, job] of this.jobs.entries()) {
      if (job.completedAt && now - job.completedAt > RETENTION_MS) {
        this.jobs.delete(id);
      }
    }
  }

  public async getStats(): Promise<QueueStats> {
    return {
      activeJobs: this.activeJobsCount,
      queuedJobs: this.queue.length,
      maxConcurrent: MAX_CONCURRENT_JOBS,
      maxQueueSize: MAX_QUEUE_SIZE,
      totalTrackedJobs: this.jobs.size,
      driver: "in-memory",
    };
  }
}
