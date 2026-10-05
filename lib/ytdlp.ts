import { spawnSync } from "node:child_process";

/**
 * Shared yt-dlp runtime helpers.
 *
 * Why this exists (fix for "HTTP Error 403: Forbidden" on video data):
 *  - YouTube requires a GVS PO Token for the `android`, `ios`, `mweb`, `web_music`,
 *    `web_creator` and `tv_simply` clients. Forcing those clients without a PO token
 *    makes yt-dlp pick format URLs that YouTube rejects with HTTP 403 at download time.
 *  - yt-dlp must solve YouTube's JS (signature / n) challenges with an external JS runtime
 *    (EJS). Deno >= 2.3 or Node >= 22 is required. Node 20 is NOT supported, so the
 *    previous `--js-runtimes node` on a node:20 image silently disabled challenge solving.
 */

/** Clients that need a GVS/Player PO token -> 403 without a PO token provider. */
const PO_TOKEN_REQUIRED_CLIENTS = new Set([
  "android",
  "ios",
  "mweb",
  "web_music",
  "web_creator",
  "tv_simply",
]);

const MIN_NODE_MAJOR_FOR_EJS = 22;

let cachedJsRuntimeArgs: string[] | null = null;

function isDenoAvailable(): boolean {
  const denoBin = process.env.DENO_PATH || "deno";
  try {
    const probe = spawnSync(denoBin, ["--version"], { timeout: 5000, windowsHide: true });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * Returns `--js-runtimes` arguments for yt-dlp based on what is actually available.
 * Prefers Deno (yt-dlp's recommended runtime), then the current Node binary if >= v22.
 */
export function getJsRuntimeArgs(): string[] {
  if (cachedJsRuntimeArgs) return cachedJsRuntimeArgs;

  const args: string[] = [];

  if (isDenoAvailable()) {
    args.push("--js-runtimes", process.env.DENO_PATH ? `deno:${process.env.DENO_PATH}` : "deno");
  }

  const nodeMajor = parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (nodeMajor >= MIN_NODE_MAJOR_FOR_EJS) {
    // Use the exact Node binary running this server so PATH lookups can't pick an old one.
    args.push("--js-runtimes", `node:${process.execPath}`);
  }

  if (args.length === 0) {
    console.error(
      `[yt-dlp] No supported JavaScript runtime found (need Deno >= 2.3 or Node >= ${MIN_NODE_MAJOR_FOR_EJS}, ` +
        `running Node ${process.versions.node}). YouTube downloads will likely fail with HTTP 403.`
    );
  }

  cachedJsRuntimeArgs = args;
  return args;
}

export function hasSupportedJsRuntime(): boolean {
  return getJsRuntimeArgs().length > 0;
}

/**
 * Removes clients that require PO tokens from a user-supplied client list,
 * unless explicitly allowed (e.g. when a PO token provider plugin is installed).
 */
export function sanitizePlayerClients(raw: string | undefined | null): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  if (process.env.YOUTUBE_ALLOW_PO_TOKEN_CLIENTS === "true") return raw.trim();

  const clients = raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const kept = clients.filter((c) => !PO_TOKEN_REQUIRED_CLIENTS.has(c.replace(/^-/, "")));
  const dropped = clients.filter((c) => !kept.includes(c));

  if (dropped.length > 0) {
    console.warn(
      `[yt-dlp] Ignoring player clients that require a PO token (cause HTTP 403): ${dropped.join(", ")}. ` +
        `Set YOUTUBE_ALLOW_PO_TOKEN_CLIENTS=true only if you run a PO token provider plugin.`
    );
  }

  return kept.length > 0 ? kept.join(",") : undefined;
}

export interface ClientStrategy {
  /** Value for `youtube:player_client=`. undefined = let yt-dlp choose its own defaults. */
  playerClient?: string;
  useCookies: boolean;
  label: string;
}

/**
 * Ordered list of extraction strategies. Every client used here works WITHOUT a PO token.
 *  1. Optional user override (sanitized)
 *  2. yt-dlp defaults (adapt automatically to cookies / JS runtime availability)
 *  3. tv + web_safari (tv needs no PO token; web_safari serves HLS that needs none)
 *  4. android_vr + web_embedded without cookies (no PO token, no cookies support needed)
 */
export function getClientStrategies(hasCookies: boolean): ClientStrategy[] {
  const strategies: ClientStrategy[] = [];
  const override = sanitizePlayerClients(process.env.YOUTUBE_PLAYER_CLIENT);

  if (override) {
    strategies.push({ playerClient: override, useCookies: hasCookies, label: `override(${override})` });
  }

  if (hasCookies) {
    strategies.push({ useCookies: true, label: "default+cookies" });
  }
  strategies.push({ useCookies: false, label: "default" });

  if (hasCookies) {
    strategies.push({ playerClient: "tv,web_safari", useCookies: true, label: "tv,web_safari+cookies" });
  } else {
    strategies.push({ playerClient: "tv,web_safari", useCookies: false, label: "tv,web_safari" });
  }

  strategies.push({ playerClient: "android_vr,web_embedded", useCookies: false, label: "android_vr,web_embedded" });

  // De-duplicate identical strategies
  const seen = new Set<string>();
  return strategies.filter((s) => {
    const key = `${s.playerClient || "default"}|${s.useCookies}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether a failed yt-dlp run is worth retrying with a different client / cookie strategy.
 * Permanent failures (private, geo-blocked, too large, timeouts) are not retried.
 */
export function isRetryableYtDlpFailure(output: string): boolean {
  const lower = output.toLowerCase();

  const permanent = [
    "max-filesize",
    "private video",
    "members-only",
    "not available in your country",
    "blocked in your country",
    "geo-restricted",
    "video unavailable. this video has been removed",
    "this live event will begin",
  ];
  if (permanent.some((p) => lower.includes(p))) return false;

  return true;
}

/** Common network-resilience arguments for every yt-dlp invocation. */
export function getResilienceArgs(): string[] {
  return ["--extractor-retries", "3", "--retries", "5", "--fragment-retries", "5"];
}
