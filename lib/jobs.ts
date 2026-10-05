import { isRedisConfigured } from "@/lib/redis";
import { InMemoryJobQueue } from "./queue/memoryQueue";
import { BullMQJobQueue } from "./queue/bullmqQueue";
import { DownloadJob, CreateJobParams, QueueStats, IJobQueue, JobStatus } from "./queue/types";

export type { JobStatus, DownloadJob, CreateJobParams, QueueStats, IJobQueue };
export { InMemoryJobQueue, BullMQJobQueue };
// Backwards compatibility alias for existing code
export { InMemoryJobQueue as AsyncJobQueue };

export function isBullMQEnabled(): boolean {
  return isRedisConfigured() && process.env.QUEUE_DRIVER !== "in-memory";
}

let activeQueueInstance: IJobQueue | null = null;

export function getJobQueue(): IJobQueue {
  if (activeQueueInstance) return activeQueueInstance;

  if (isBullMQEnabled()) {
    console.log("[JobQueue] Initializing Distributed BullMQ + Redis Queue");
    activeQueueInstance = new BullMQJobQueue();
  } else {
    activeQueueInstance = new InMemoryJobQueue();
  }

  return activeQueueInstance;
}

export const jobQueue = getJobQueue();
