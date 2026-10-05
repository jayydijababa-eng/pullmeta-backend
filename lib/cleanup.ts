import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileCache } from "@/lib/fileCache";

let cleanupInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;

/**
 * Sweeps the OS temp folder for orphaned PullMeta directories older than maxAgeMs (default: 15 min).
 */
export async function cleanOrphanedTempDirs(maxAgeMs: number = 15 * 60 * 1000): Promise<number> {
  const tmpDir = os.tmpdir();
  let cleanedCount = 0;
  const now = Date.now();

  try {
    const entries = await fs.promises.readdir(tmpDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Only clean PullMeta's own temporary download directories
      if (entry.name.startsWith("pullmeta-dl-")) {
        const fullPath = path.join(tmpDir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          const age = now - stat.mtimeMs;
          if (age > maxAgeMs) {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
            cleanedCount++;
          }
        } catch {
          // Ignore individual folder stat/deletion errors
        }
      }
    }
  } catch (err) {
    console.warn("[Cleanup] Failed to read temp directory during orphan sweep:", err);
  }

  return cleanedCount;
}

/**
 * Initializes background scheduled cleanup tasks and process shutdown hooks.
 */
export function initServerMaintenance(): void {
  if (cleanupInterval) return;

  // Run orphan temp cleanup and expired cache purge every 5 minutes
  cleanupInterval = setInterval(async () => {
    try {
      const orphans = await cleanOrphanedTempDirs();
      const expiredCache = await fileCache.cleanupExpired();
      if (orphans > 0 || expiredCache > 0) {
        console.log(
          `[Server Maintenance] Cleaned ${orphans} orphaned temp folders and purged ${expiredCache} expired cache files.`
        );
      }
    } catch (err) {
      console.warn("[Server Maintenance] Maintenance sweep encountered error:", err);
    }
  }, 5 * 60 * 1000);

  // Initial sweep at startup (after 10s)
  setTimeout(() => {
    cleanOrphanedTempDirs().catch(() => {});
    fileCache.cleanupExpired().catch(() => {});
  }, 10000);

  // Setup graceful shutdown handling
  setupGracefulShutdown();
}

/**
 * Handles SIGTERM and SIGINT to allow active operations to terminate cleanly.
 */
function setupGracefulShutdown(): void {
  const handleSignal = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Process] Received ${signal}. Starting graceful shutdown...`);

    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }

    // Allow 5 seconds for in-flight responses to finish before exiting
    setTimeout(() => {
      console.log("[Process] Shutdown complete. Exiting.");
      process.exit(0);
    }, 5000);
  };

  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGINT", () => handleSignal("SIGINT"));

  // Prevent uncaught errors from crashing the entire Next.js server
  process.on("unhandledRejection", (reason) => {
    console.error("[Process] Unhandled Promise Rejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("[Process] Uncaught Exception:", err);
  });
}
