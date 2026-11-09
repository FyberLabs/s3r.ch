const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.azure.com",
]);

/**
 * http(s) only. Rejects loopback, private, link-local, CGNAT, multicast,
 * and cloud-metadata hosts. WHATWG parsing folds decimal, octal, and hex
 * IPv4 into dotted form before this check.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) feed URLs are accepted.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("That host is not allowed.");
  }
  if (isBlockedIpAddress(host)) {
    throw new Error("That host is not allowed.");
  }
  return url;
}

/** True when `address` is an IP literal in a non-public range. */
export function isBlockedIpAddress(address: string): boolean {
  const bare = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return isPrivateIpv6(bare);
  return isPrivateIpv4(bare);
}

/** Dotted IPv4 or an IPv6 literal (brackets optional). Hostnames are false. */
export function isIpLiteralHost(hostname: string): boolean {
  const bare = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bare)) return true;
  return bare.includes(":");
}

function isPrivateIpv4(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** Eight 16-bit words, or null when the text is not an IPv6 address. */
function parseIpv6(host: string): number[] | null {
  let text = host;
  const tail: number[] = [];
  const v4 = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const bytes = v4.slice(2).map(Number);
    if (bytes.some((n) => n > 255)) return null;
    tail.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
    text = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (![...head, ...rest].every((word) => /^[0-9a-f]{1,4}$/i.test(word))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 && known !== 8) return null;
  if (halves.length === 2 && known > 7) return null;
  const zeros = halves.length === 2 ? new Array<number>(8 - known).fill(0) : [];
  return [...head.map((w) => parseInt(w, 16)), ...zeros, ...rest.map((w) => parseInt(w, 16)), ...tail];
}

function ipv4FromWords(hi: number, lo: number): string {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** Unspecified, loopback, unique-local, link-local, multicast, and embedded private IPv4. */
function isPrivateIpv6(host: string): boolean {
  const words = parseIpv6(host);
  if (!words || words.length !== 8) return true;
  if (words.slice(0, 7).every((w) => w === 0) && (words[7] === 0 || words[7] === 1)) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((words[0] & 0xffc0) === 0xfec0) return true; // fec0::/10
  if ((words[0] & 0xff00) === 0xff00) return true; // ff00::/8
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return isPrivateIpv4(ipv4FromWords(words[6], words[7]));
  }
  // 6to4 and well-known NAT64 embed an IPv4 address that must itself be public.
  if (words[0] === 0x2002 && isPrivateIpv4(ipv4FromWords(words[1], words[2]))) return true;
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true; // 64:ff9b:1::/48
  if (
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((w) => w === 0) &&
    isPrivateIpv4(ipv4FromWords(words[6], words[7]))
  ) {
    return true;
  }
  return false;
}
