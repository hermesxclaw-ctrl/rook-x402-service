import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import dns from "node:dns/promises";
import net from "node:net";

export interface ReadResult {
  url: string;
  finalUrl: string;
  title: string;
  byline: string | null;
  siteName: string | null;
  text: string;
  charCount: number;
  truncated: boolean;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const MAX_CHARS_DEFAULT = 20_000;

/** Dev-only escape hatch for testing against localhost fixtures. NEVER enable in production. */
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === "1";

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // 0/8
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return (
      low === "::1" ||
      low.startsWith("fc") ||
      low.startsWith("fd") || // unique local
      low.startsWith("fe80") // link-local
    );
  }
  return true; // unknown format -> block
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  if (u.username || u.password) throw new Error("credentials in URL are not allowed");
  if (ALLOW_PRIVATE) return u;
  // Resolve and check every address (TOCTOU-hardened as far as practical for a microservice)
  const records = await dns.lookup(u.hostname, { all: true, verbatim: true }).catch(() => {
    throw new Error("DNS resolution failed");
  });
  if (records.length === 0 || records.some((r) => isBlockedIp(r.address))) {
    throw new Error("private/internal addresses are not allowed");
  }
  return u;
}

async function fetchCapped(u: URL, redirectsLeft: number): Promise<{ body: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: "manual",
      headers: {
        "user-agent": "rook-reader/0.1 (+paid API; contact via service listing)",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirectsLeft <= 0) throw new Error("too many redirects");
    const loc = res.headers.get("location");
    if (!loc) throw new Error("redirect without location");
    const next = new URL(loc, u.toString());
    await assertPublicUrl(next.toString());
    return fetchCapped(next, redirectsLeft - 1);
  }

  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!/html|text/i.test(ct)) throw new Error(`unsupported content-type: ${ct || "unknown"}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("empty response body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) throw new Error("response too large (>2MB)");
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return { body, finalUrl: res.url || u.toString() };
}

export async function readUrl(rawUrl: string, maxChars = MAX_CHARS_DEFAULT): Promise<ReadResult> {
  const u = await assertPublicUrl(rawUrl);
  const { body, finalUrl } = await fetchCapped(u, MAX_REDIRECTS);

  const dom = new JSDOM(body, { url: finalUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article || !article.textContent || article.textContent.trim().length < 50) {
    throw new Error("no readable article content found");
  }

  let text = article.textContent.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  return {
    url: rawUrl,
    finalUrl,
    title: article.title ?? "",
    byline: article.byline ?? null,
    siteName: article.siteName ?? null,
    text,
    charCount: text.length,
    truncated,
  };
}
