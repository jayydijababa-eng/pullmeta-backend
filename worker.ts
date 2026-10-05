import { Worker, Job as BullJob } from "bullmq";
import { QUEUE_NAME, BullDownloadJobPayload } from "@/lib/queue/bullmqQueue";
import { createRedisClient, getRedisUrl } from "@/lib/redis";
import { storageDriver } from "@/lib/storage";
import { executeDownload, cleanupDirectory, DownloadError } from "@/lib/download";
import { hasSufficientDiskSpace } from "@/lib/disk";

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "2", 10);

async function startWorker() {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    console.error("[PullMeta Worker] ERROR: REDIS_URL is required to run standalone background workers.");
    process.exit(1);
  }

  console.log(`[PullMeta Worker] Starting background worker for queue: "${QUEUE_NAME}"`);
  console.log(`[PullMeta Worker] Concurrency: ${WORKER_CONCURRENCY} jobs | Storage Driver: ${storageDriver.name}`);

  const redis = createRedisClient();

  const worker = new Worker<BullDownloadJobPayload>(
    QUEUE_NAME,
    async (job: BullJob<BullDownloadJobPayload>) => {
      const { jobId, targetKey, url, videoId, type, quality, format, audioQuality } = job.data;
      console.log(`[Worker Processing Job ${jobId}] Target: ${targetKey} (Video: ${videoId}, Type: ${type}, Quality: ${quality})`);

      const updateMeta = async (updates: Record<string, string>) => {
        const pipeline = redis.pipeline();
        pipeline.hmset(`pullmeta:job:${jobId}`, updates);
        pipeline.expire(`pullmeta:job:${jobId}`, 7200);
        await pipeline.exec();
      };

      try {
        // 1. Check local disk headroom
        const disk = await hasSufficientDiskSpace();
        if (!disk.sufficient) {
          throw new DownloadError(
            "DOWNLOAD_RATE_LIMITED",
            "Worker container disk headroom is constrained. Waiting for cleanup."
          );
        }

        // 2. Mark processing
        await job.updateProgress(15);
        await updateMeta({
          status: "processing",
          stage: "downloading",
          progress: "15",
          startedAt: Date.now().toString(),
        });

        // 3. Execute media download subprocess via yt-dlp + ffmpeg
        const result = await executeDownload({
          videoId,
          url,
          type,
          quality,
          format,
          audioQuality,
        });

        await job.updateProgress(85);
        await updateMeta({
          stage: "caching",
          progress: "85",
        });

        // 4. Offload to Cloud Storage (R2 / S3) or Local Cache
        const uploadResult = await storageDriver.uploadFile(result.filePath, targetKey, {
          fileName: result.fileName,
          contentType: result.contentType,
          fileSize: result.fileSize,
        });

        // 5. Instantly clean local worker temp folder to preserve container disk space
        await cleanupDirectory(result.tempDir).catch(() => {});

        // 6. Finalize job in Redis
        const completedAt = Date.now().toString();
        await updateMeta({
          status: "ready",
          stage: "complete",
          progress: "100",
          completedAt,
          fileName: result.fileName,
          fileSize: uploadResult.fileSize.toString(),
          contentType: uploadResult.contentType,
          downloadUrl: uploadResult.downloadUrl,
        });

        // 7. Store in distributed cache key (7-day cache)
        await redis.set(
          `pullmeta:cached:${targetKey}`,
          JSON.stringify({
            fileName: result.fileName,
            fileSize: uploadResult.fileSize,
            contentType: uploadResult.contentType,
            downloadUrl: uploadResult.downloadUrl,
            completedAt,
          }),
          "EX",
          86400 * 7
        );

        // 8. Remove active lock for this target key
        await redis.del(`pullmeta:target:${targetKey}`);

        await job.updateProgress(100);
        console.log(`[Worker Job Complete: ${jobId}] URL: ${uploadResult.downloadUrl}`);
        return {
          downloadUrl: uploadResult.downloadUrl,
          fileSize: uploadResult.fileSize,
        };
      } catch (err: any) {
        console.error(`[Worker Job ${jobId} Error]`, err?.message || err);
        const errorMessage =
          err instanceof DownloadError
            ? err.message
            : err?.message || "An unexpected error occurred during media processing.";
        const errorCode = err?.code || "DOWNLOAD_FAILED";

        await updateMeta({
          status: "failed",
          progress: "0",
          completedAt: Date.now().toString(),
          error: errorMessage,
          errorCode,
        });

        // Delete active target key so users can retry
        await redis.del(`pullmeta:target:${targetKey}`);
        throw err;
      }
    },
    {
      connection: createRedisClient(),
      concurrency: WORKER_CONCURRENCY,
      lockDuration: 60000, // 60-second lock with auto-renew
    }
  );

  worker.on("active", (job) => {
    console.log(`[Worker] Job ${job.id} is now ACTIVE`);
  });

  worker.on("completed", (job) => {
    console.log(`[Worker] Job ${job.id} has COMPLETED`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job?.id} FAILED: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("[Worker Internal Error]", err);
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`\n[PullMeta Worker] Received ${signal}. Gracefully stopping worker...`);
    await worker.close();
    await redis.quit();
    console.log("[PullMeta Worker] Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startWorker().catch((err) => {
  console.error("[Fatal Worker Startup Error]", err);
  process.exit(1);
});
