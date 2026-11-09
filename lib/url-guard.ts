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

// Prefix lists follow the IANA special-purpose registries. See docs/pull-relay.md.
function ipv4Number(address: string): bigint {
  return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Number(words: number[]): bigint {
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

type Prefix = { network: bigint; shift: bigint };

function prefix(cidr: string): Prefix {
  const [address, bits] = cidr.split("/");
  const v6 = address.includes(":");
  const network = v6 ? ipv6Number(parseIpv6(address)!) : ipv4Number(address);
  const shift = BigInt((v6 ? 128 : 32) - Number(bits));
  return { network: network >> shift, shift };
}

function within(value: bigint, range: Prefix): boolean {
  return value >> range.shift === range.network;
}

const blockedV4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
  "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
].map(prefix);
const publicV4Exceptions = new Set(["192.0.0.9", "192.0.0.10"].map(ipv4Number));

function blockedIpv4(value: bigint): boolean {
  return !publicV4Exceptions.has(value) && blockedV4.some(range => within(value, range));
}

const globalUnicast = prefix("2000::/3");
const mappedV4 = prefix("::ffff:0:0/96");
const wellKnownNat64 = prefix("64:ff9b::/96");
const blockedV6 = ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"].map(prefix);
const publicV6Exceptions = [
  "2001:1::1/128", "2001:1::2/128", "2001:1::3/128",
  "2001:3::/32", "2001:4:112::/48", "2001:20::/28", "2001:30::/28",
].map(prefix);

/** URL hosts are canonicalized by WHATWG. The DNS caller checks raw syntax and family first. */
export function isBlockedIpAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (!bare.includes(":")) {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bare)) return false;
    if (bare.split(".").some(octet => Number(octet) > 255)) return true;
    return blockedIpv4(ipv4Number(bare));
  }
  const words = parseIpv6(bare);
  if (!words) return true;
  const value = ipv6Number(words);
  if (within(value, mappedV4) || within(value, wellKnownNat64)) {
    return blockedIpv4(value & 0xffffffffn);
  }
  if (!within(value, globalUnicast)) return true;
  // ISATAP interface identifiers can occur under ordinary unicast prefixes.
  if ((words[4] === 0 || words[4] === 0x0200) && words[5] === 0x5efe) return true;
  if (publicV6Exceptions.some(range => within(value, range))) return false;
  return blockedV6.some(range => within(value, range));
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
