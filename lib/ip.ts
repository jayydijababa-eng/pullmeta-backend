import { NextRequest } from "next/server";

/**
 * Checks whether an IP string is a valid IPv4 or IPv6 address.
 */
export function isValidIp(ip: string): boolean {
  if (!ip || typeof ip !== "string") return false;
  const trimmed = ip.trim();

  // IPv4 regex (simple check)
  const ipv4Regex = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
  if (ipv4Regex.test(trimmed)) return true;

  // IPv6 regex
  const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^([0-9a-fA-F]{1,4}:){1,7}:$|^:([0-9a-fA-F]{1,4}:){1,7}$|^([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$/;
  if (ipv6Regex.test(trimmed) || trimmed.includes(":")) return true;

  return false;
}

/**
 * Normalizes an IP string by stripping ports and IPv6-mapped IPv4 prefixes.
 */
export function cleanIp(ip: string): string {
  if (!ip) return "127.0.0.1";
  let cleaned = ip.trim();

  // Handle IPv6 mapped IPv4: ::ffff:192.168.1.1 -> 192.168.1.1
  if (cleaned.startsWith("::ffff:")) {
    cleaned = cleaned.slice(7);
  }

  // Handle IPv4 with port: 123.45.67.89:12345 -> 123.45.67.89
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(cleaned)) {
    cleaned = cleaned.split(":")[0];
  }

  // Handle bracketed IPv6 with port: [::1]:8080 -> ::1
  if (cleaned.startsWith("[") && cleaned.includes("]")) {
    cleaned = cleaned.slice(1, cleaned.indexOf("]"));
  }

  return cleaned;
}

/**
 * Checks if an IP is in a private, loopback, or link-local range.
 * Used to avoid grouping all Railway visitors under Railway's internal proxy IP.
 */
export function isPrivateOrInternalIp(ip: string): boolean {
  const cleaned = cleanIp(ip);

  // Loopback
  if (cleaned === "127.0.0.1" || cleaned === "::1" || cleaned === "localhost") {
    return true;
  }

  // Parse IPv4 octets
  const parts = cleaned.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    // 10.0.0.0 - 10.255.255.255 (Private)
    if (parts[0] === 10) return true;

    // 172.16.0.0 - 172.31.255.255 (Private)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

    // 192.168.0.0 - 192.168.255.255 (Private)
    if (parts[0] === 192 && parts[1] === 168) return true;

    // 169.254.0.0 - 169.254.255.255 (Link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;

    // 100.64.0.0 - 100.127.255.255 (Carrier-grade NAT)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }

  // IPv6 private/link-local
  if (cleaned.startsWith("fc00:") || cleaned.startsWith("fd00:") || cleaned.startsWith("fe80:")) {
    return true;
  }

  return false;
}

/**
 * Resolves the genuine client IP address behind reverse proxies (Railway, Cloudflare, Vercel, Nginx).
 * Priority:
 * 1. cf-connecting-ip (Cloudflare / Railway edge proxy)
 * 2. x-real-ip
 * 3. true-client-ip
 * 4. x-client-ip
 * 5. x-forwarded-for (first public IP, or first valid entry)
 * 6. req.ip (NextRequest internal)
 * 7. Fallback to 127.0.0.1
 */
export function getClientIp(req: NextRequest): string {
  // 1. Cloudflare / Railway edge
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) {
    const cleaned = cleanIp(cfIp);
    if (isValidIp(cleaned)) return cleaned;
  }

  // 2. X-Real-IP
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    const cleaned = cleanIp(realIp);
    if (isValidIp(cleaned)) return cleaned;
  }

  // 3. True-Client-IP
  const trueClientIp = req.headers.get("true-client-ip");
  if (trueClientIp) {
    const cleaned = cleanIp(trueClientIp);
    if (isValidIp(cleaned)) return cleaned;
  }

  // 4. X-Client-IP
  const clientIp = req.headers.get("x-client-ip");
  if (clientIp) {
    const cleaned = cleanIp(clientIp);
    if (isValidIp(cleaned)) return cleaned;
  }

  // 5. X-Forwarded-For (comma-separated list of proxies)
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((h) => cleanIp(h));

    // Prefer the first public IP address to bypass internal proxy hops
    const publicHop = hops.find((h) => isValidIp(h) && !isPrivateOrInternalIp(h));
    if (publicHop) {
      return publicHop;
    }

    // If all hops are private (e.g. local dev), return the leftmost valid hop
    const firstValid = hops.find((h) => isValidIp(h));
    if (firstValid) {
      return firstValid;
    }
  }

  // 6. Next.js internal / socket ip
  const socketIp = (req as unknown as { ip?: string }).ip;
  if (socketIp) {
    const cleaned = cleanIp(socketIp);
    if (isValidIp(cleaned)) return cleaned;
  }

  return "127.0.0.1";
}
