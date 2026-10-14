import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export type WebFetchFormat = "markdown" | "text" | "html" | "json"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_USER_AGENT = "Kuntyy-Crawl/0.1.23"
const COMPAT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"

function blockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
}

function blockedAddress(address: string): boolean {
  if (isIP(address) === 4) return blockedIpv4(address)
  if (isIP(address) !== 6) return true
  const normalized = address.toLowerCase()
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7)
    return isIP(mapped) !== 4 || blockedIpv4(mapped)
  }
  // Only globally routed 2000::/3 IPv6 unicast is permitted.
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16)
  return normalized === "::" || normalized === "::1" || first < 0x2000 || first >= 0x4000
    || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb")
    || normalized.startsWith("ff") || normalized.startsWith("2001:db8:")
}

export function validateWebFetchUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error("web_fetch requires a valid absolute URL.") }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("web_fetch only supports http:// and https:// URLs.")
  if (url.username || url.password) throw new Error("web_fetch does not allow credentials embedded in URLs.")
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home")) {
    throw new Error("web_fetch blocked a local or internal network hostname.")
  }
  if (isIP(hostname) && blockedAddress(hostname)) throw new Error("web_fetch blocked a private, loopback, link-local, or reserved IP address.")
  return url
}

async function assertPublicTarget(url: URL): Promise<void> {
  const validated = validateWebFetchUrl(url.href)
  const hostname = validated.hostname.replace(/^\[|\]$/g, "")
  if (isIP(hostname)) {
    if (blockedAddress(hostname)) throw new Error("web_fetch blocked a non-public network address.")
    return
  }
  let addresses: Array<{ address: string; family: number }>
  try { addresses = await lookup(hostname, { all: true, verbatim: true }) }
  catch { throw new Error("web_fetch could not resolve the requested public hostname.") }
  if (!addresses.length || addresses.some((entry) => blockedAddress(entry.address))) {
    throw new Error("web_fetch blocked a hostname that resolves to a private or reserved network address.")
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
}

function htmlToText(html: string, markdown: boolean): { title: string; content: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()).slice(0, 300)
  let content = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|canvas|template|iframe)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  if (markdown) {
    content = content
      .replace(/<h1[^>]*>/gi, "\n# ").replace(/<\/h1>/gi, "\n\n")
      .replace(/<h2[^>]*>/gi, "\n## ").replace(/<\/h2>/gi, "\n\n")
      .replace(/<h3[^>]*>/gi, "\n### ").replace(/<\/h3>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "")
      .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|article|ul|ol|blockquote|tr)>/gi, "\n\n")
  } else {
    content = content.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|article|ul|ol|blockquote|tr|li|h[1-6])>/gi, "\n")
  }
  content = decodeEntities(content.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return { title, content }
}

export async function fetchWebResource(
  rawUrl: string,
  format: WebFetchFormat = "markdown",
  maxChars = 20_000,
  signal?: AbortSignal,
): Promise<{
  url: string
  status: number
  contentType: string
  title: string
  content: string
}> {
  const limit = Math.max(1_000, Math.min(100_000, Number.isFinite(maxChars) ? Math.floor(maxChars) : 20_000))
  let current = validateWebFetchUrl(rawUrl)
  let usedCompatAgent = false
  let response: Response | undefined
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicTarget(current)
    const headers = {
      accept: format === "json" ? "application/json, text/plain;q=0.8, */*;q=0.2"
        : format === "html" ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.2"
        : "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.2",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": usedCompatAgent ? COMPAT_USER_AGENT : DEFAULT_USER_AGENT,
    }
    response = await fetch(current, { headers, redirect: "manual", signal: signal ? AbortSignal.any([AbortSignal.timeout(25_000), signal]) : AbortSignal.timeout(25_000) })
    const challenge = response.status === 403 || response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
    if (challenge && !usedCompatAgent) {
      usedCompatAgent = true
      continue
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) throw new Error(`web_fetch received HTTP ${response.status} without a redirect location.`)
      if (redirectCount === 5) throw new Error("web_fetch stopped after five redirects.")
      current = validateWebFetchUrl(new URL(location, current).href)
      continue
    }
    break
  }
  if (!response) throw new Error("web_fetch did not receive a response.")
  if (!response.ok) throw new Error(`web_fetch was blocked or failed with HTTP ${response.status}; no successful extraction is claimed.`)
  const lengthHeader = response.headers.get("content-length")
  if (lengthHeader && Number(lengthHeader) > MAX_RESPONSE_BYTES) throw new Error("web_fetch response exceeds the 2 MiB response limit.")
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("web_fetch response exceeds the 2 MiB response limit.")
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream"
  const source = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  let title = ""
  let content = source
  if (contentType.includes("html") || /<html[\s>]/i.test(source)) {
    const extracted = htmlToText(source, format === "markdown")
    title = extracted.title
    content = format === "html" ? source
      .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .slice(0, limit) : extracted.content
  } else if (format === "json" && !contentType.includes("json")) {
    throw new Error(`web_fetch expected JSON but received ${contentType}.`)
  }
  return { url: current.href, status: response.status, contentType, title, content: content.slice(0, limit) }
}
