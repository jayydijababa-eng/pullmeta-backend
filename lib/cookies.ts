import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const MASTER_COOKIE_FILENAME = "yt_cookies.txt";

/**
 * Returns the path to the master cookie file created at server startup.
 */
export function getMasterCookieFilePath(): string {
  if (process.platform !== "win32" && fs.existsSync("/tmp")) {
    return path.join("/tmp", MASTER_COOKIE_FILENAME);
  }
  return path.join(os.tmpdir(), MASTER_COOKIE_FILENAME);
}

/**
 * Converts a raw cookie string (Netscape or JSON array export) into standard Netscape format.
 * NEVER prints or logs cookie values.
 */
export function convertToNetscapeCookies(raw: string, defaultDomain = ".youtube.com"): string | null {
  if (!raw || typeof raw !== "string") return null;

  let content = raw.trim();
  if (!content) return null;

  // Strip wrapping single or double quotes
  if (
    (content.startsWith('"') && content.endsWith('"')) ||
    (content.startsWith("'") && content.endsWith("'"))
  ) {
    content = content.slice(1, -1).trim();
  }

  // Handle base64: prefix if passed
  if (content.startsWith("base64:")) {
    try {
      content = Buffer.from(content.slice(7), "base64").toString("utf-8").trim();
    } catch {
      // ignore
    }
  }

  // Detect and parse JSON array export
  if (content.startsWith("[") || content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      const cookieList = Array.isArray(parsed) ? parsed : [parsed];

      const lines: string[] = [
        "# Netscape HTTP Cookie File",
        "# https://curl.se/docs/http-cookies.html",
        "",
      ];

      for (const c of cookieList) {
        if (!c || typeof c !== "object") continue;
        const name = c.name || c.key;
        const value = c.value !== undefined ? String(c.value) : "";
        if (!name) continue;

        let domain = c.domain || c.host || defaultDomain;
        const isHttpOnly = Boolean(c.httpOnly);
        const prefix = isHttpOnly ? "#HttpOnly_" : "";
        const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
        const cookiePath = c.path || "/";
        const secure = c.secure !== false ? "TRUE" : "FALSE";
        const expiry = Math.floor(
          c.expirationDate || c.expires || c.expiry || Date.now() / 1000 + 365 * 24 * 3600
        );

        lines.push(
          `${prefix}${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${value}`
        );
      }

      if (lines.length > 3) {
        return lines.join("\n") + "\n";
      }
    } catch {
      // not valid JSON, proceed
    }
  }

  // Check if content is Netscape formatted
  if (content.includes("\t") || content.includes("# Netscape HTTP Cookie File")) {
    if (!content.includes("# Netscape HTTP Cookie File")) {
      content = `# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n\n${content}\n`;
    }
    return content;
  }

  return null;
}

/**
 * Initializes the master cookie file at server startup with permissions 0600.
 * Logs a clear warning if missing or invalid without printing cookie contents.
 */
export async function initServerCookiesStartup(): Promise<boolean> {
  const cookieEnv = process.env.YOUTUBE_COOKIES;

  if (!cookieEnv || !cookieEnv.trim()) {
    console.warn(
      "[YouTube Cookies] Warning: YOUTUBE_COOKIES environment variable is not configured. Cloud server IP may be subject to YouTube bot checks."
    );
    return false;
  }

  const netscapeData = convertToNetscapeCookies(cookieEnv);

  if (!netscapeData) {
    console.warn(
      "[YouTube Cookies] Warning: YOUTUBE_COOKIES is set but could not be parsed into valid Netscape or JSON format."
    );
    return false;
  }

  try {
    const masterPath = getMasterCookieFilePath();
    await fs.promises.writeFile(masterPath, netscapeData, { encoding: "utf-8", mode: 0o600 });
    try {
      await fs.promises.chmod(masterPath, 0o600);
    } catch {
      // Windows or non-POSIX filesystem ignore
    }
    console.log(
      `[YouTube Cookies] Successfully initialized and secured authentication cookies at server startup.`
    );
    return true;
  } catch (err: any) {
    console.error(
      `[YouTube Cookies] Failed to write startup cookie file: ${err?.message || "Filesystem error"}`
    );
    return false;
  }
}

/**
 * Checks whether valid cookies are configured. Never returns secret values.
 */
export function areCookiesConfigured(): boolean {
  if (fs.existsSync(getMasterCookieFilePath())) {
    return true;
  }
  return Boolean(process.env.YOUTUBE_COOKIES && convertToNetscapeCookies(process.env.YOUTUBE_COOKIES));
}

/**
 * Creates an isolated, request-scoped copy of the cookie file for a single yt-dlp call.
 * Permissions are set to 0600, and caller must invoke cleanup() in a finally block.
 */
export async function createRequestCookieFile(): Promise<{
  cookiePath: string | null;
  cleanup: () => Promise<void>;
}> {
  const masterPath = getMasterCookieFilePath();
  let cookieContent: string | null = null;

  if (fs.existsSync(masterPath)) {
    try {
      cookieContent = await fs.promises.readFile(masterPath, "utf-8");
    } catch {
      cookieContent = null;
    }
  }

  if (!cookieContent && process.env.YOUTUBE_COOKIES) {
    cookieContent = convertToNetscapeCookies(process.env.YOUTUBE_COOKIES);
  }

  if (!cookieContent) {
    return {
      cookiePath: null,
      cleanup: async () => {},
    };
  }

  const reqCookiePath = path.join(
    os.tmpdir(),
    `yt_cookie_req_${randomUUID()}.txt`
  );

  try {
    await fs.promises.writeFile(reqCookiePath, cookieContent, { encoding: "utf-8", mode: 0o600 });
    try {
      await fs.promises.chmod(reqCookiePath, 0o600);
    } catch {
      // Windows ignore
    }

    return {
      cookiePath: reqCookiePath,
      cleanup: async () => {
        try {
          await fs.promises.unlink(reqCookiePath);
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    console.error("[YouTube Cookies] Failed to create per-request cookie copy:", err);
    return {
      cookiePath: null,
      cleanup: async () => {},
    };
  }
}

/**
 * Resolves optional proxy URL from PROXY_URL or fallback environment variables.
 */
export function getProxyUrl(): string | null {
  const proxy = process.env.PROXY_URL || process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxy && proxy.trim()) {
    return proxy.trim();
  }
  return null;
}

/**
 * Checks if a proxy URL is configured. Never returns the proxy string or credentials.
 */
export function isProxyConfigured(): boolean {
  return Boolean(getProxyUrl());
}
