import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DiskSpaceInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

/**
 * Returns current disk space information for the temp / storage mount.
 */
export async function getDiskSpace(targetDir: string = os.tmpdir()): Promise<DiskSpaceInfo> {
  try {
    const stats = await fs.promises.statfs(targetDir);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

    return {
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent,
    };
  } catch {
    // Fallback if statfs is unavailable on certain platforms
    const defaultTotal = 10 * 1024 * 1024 * 1024; // Assume 10GB
    return {
      totalBytes: defaultTotal,
      freeBytes: defaultTotal,
      usedBytes: 0,
      usedPercent: 0,
    };
  }
}

/**
 * Checks whether the disk has sufficient free space to accept a new download job.
 * Minimum free space required default: 500 MB, max disk percent default: 92%.
 */
export async function hasSufficientDiskSpace(
  minFreeMb: number = 500,
  maxUsedPercent: number = 92
): Promise<{ sufficient: boolean; reason?: string; info: DiskSpaceInfo }> {
  const info = await getDiskSpace();
  const freeMb = Math.round(info.freeBytes / (1024 * 1024));

  if (info.totalBytes > 0 && info.usedPercent >= maxUsedPercent) {
    return {
      sufficient: false,
      reason: `Disk utilization is high (${info.usedPercent}%). Temporary queue freeze active.`,
      info,
    };
  }

  if (info.totalBytes > 0 && freeMb < minFreeMb) {
    return {
      sufficient: false,
      reason: `Available storage (${freeMb} MB) is below the safe threshold (${minFreeMb} MB).`,
      info,
    };
  }

  return { sufficient: true, info };
}
