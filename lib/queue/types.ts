export type JobStatus = "queued" | "processing" | "ready" | "failed";

export interface DownloadJob {
  id: string;
  targetKey: string;
  url: string;
  videoId: string;
  type: "video" | "audio";
  quality: string;
  format: string;
  audioQuality: string;
  status: JobStatus;
  stage?: "downloading" | "transcoding" | "verifying" | "caching";
  progress?: number; // 0-100%
  queuePosition?: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  errorCode?: string;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
  filePath?: string;
  tempDir?: string;
  downloadUrl?: string;
  subscribersCount: number; // Coalesced request count
}

export interface CreateJobParams {
  url: string;
  videoId: string;
  type: "video" | "audio";
  quality?: string;
  format?: string;
  audioQuality?: string;
  clientIp?: string;
}

export interface QueueStats {
  activeJobs: number;
  queuedJobs: number;
  maxConcurrent: number;
  maxQueueSize: number;
  totalTrackedJobs: number;
  driver: "bullmq" | "in-memory";
}

export interface IJobQueue {
  readonly driver: "bullmq" | "in-memory";
  getTargetKey(params: {
    videoId: string;
    type: "video" | "audio";
    quality?: string;
    format?: string;
    audioQuality?: string;
  }): string;
  createOrGetJob(params: CreateJobParams): Promise<{
    job: DownloadJob;
    coalesced: boolean;
    cached: boolean;
  }>;
  getJob(jobId: string): Promise<DownloadJob | null>;
  getStats(): Promise<QueueStats>;
}
