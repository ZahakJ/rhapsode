import dns from "node:dns/promises"
import net from "node:net"

// yt-dlp runs with the generic extractor disabled, so it only ever talks to
// hosts a site-specific extractor picks — but the user-supplied URL is still
// resolved once here so an internal name never even reaches it.

export class UrlRejected extends Error {}

export function parseSourceUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new UrlRejected("that is not a URL")
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UrlRejected("only http(s) links")
  if (u.username || u.password) throw new UrlRejected("links with credentials are refused")
  if (raw.length > 2048) throw new UrlRejected("link too long")
  const host = u.hostname.toLowerCase().replace(/\.$/, "")
  if (!host) throw new UrlRejected("missing host")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    throw new UrlRejected("that host is not reachable from here")
  const literal = host.startsWith("[") ? host.slice(1, -1) : host
  if (net.isIP(literal) && isPrivate(literal)) throw new UrlRejected("that address is private")
  return u
}

export async function assertPublicHost(u: URL, lookup = dns.lookup): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "")
  if (net.isIP(host)) {
    if (isPrivate(host)) throw new UrlRejected("that address is private")
    return
  }
  let answers: Array<{ address: string }>
  try {
    answers = await lookup(host, { all: true })
  } catch {
    throw new UrlRejected("that host does not resolve")
  }
  if (answers.length === 0) throw new UrlRejected("that host does not resolve")
  for (const a of answers) if (isPrivate(a.address)) throw new UrlRejected("that host resolves to a private address")
}

export function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip)
  if (!net.isIPv6(ip)) return true
  const lower = ip.toLowerCase()
  // v4-mapped ::ffff:a.b.c.d
  const mapped = lower.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateV4(mapped[1]!)
  const hex = expandV6(lower)
  if (!hex) return true
  if (hex.startsWith("0".repeat(20) + "ffff")) return isPrivateV4(v4FromTail(hex)) // v4-mapped, hex form
  if (hex === "0".repeat(32)) return true // ::
  if (hex === "0".repeat(31) + "1") return true // ::1
  const first = parseInt(hex.slice(0, 4), 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (hex.startsWith("20010db8")) return true // documentation
  if (hex.startsWith("0064ff9b")) return isPrivateV4(v4FromTail(hex)) // NAT64
  return false
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p as [number, number, number, number]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast + reserved
  if (a === 192 && b === 0 && p[2] === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return false
}

function expandV6(ip: string): string | null {
  const zone = ip.indexOf("%")
  if (zone !== -1) ip = ip.slice(0, zone)
  const halves = ip.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves[1] ? halves[1].split(":") : []
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail]
  if (groups.length !== 8) return null
  return groups.map((g) => g.padStart(4, "0")).join("")
}

function v4FromTail(hex: string): string {
  const t = hex.slice(24)
  return [0, 2, 4, 6].map((i) => parseInt(t.slice(i, i + 2), 16)).join(".")
}
