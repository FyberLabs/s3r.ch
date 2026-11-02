import { webUri } from "./forum-siwe-uri";
import { verifyForumWalletSignature } from "./forum-wallet-signature";

export type ForumSiwePolicy = Readonly<{
  allowedDomains: readonly string[];
  allowedUris: readonly string[];
  allowedChainIds: readonly string[];
  clockSkewSeconds?: number;
}>;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
function date(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.[0-9]+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return NaN;
  const y = +m[1], month = +m[2], day = +m[3], hour = +m[4], minute = +m[5], sec = +m[6];
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || sec > 59) return NaN;
  const d = new Date(0); d.setUTCFullYear(y, month - 1, day); d.setUTCHours(hour, minute, sec, 0);
  let offset = 0;
  if (!/^[Zz]$/.test(m[8])) {
    const h = +m[8].slice(1, 3), min = +m[8].slice(4);
    if (h > 23 || min > 59) return NaN;
    offset = (h * 60 + min) * 60 * (m[8][0] === '+' ? 1 : -1);
  }
  return d.getTime() / 1000 + Number(m[7] ?? 0) - offset;
}

/** Verify an EOA SIWE proof against exact identity-record bytes and explicit
 * policy (SociACL b7f9bc59). Does not establish recovery-link eligibility,
 * witness validity, retention, revocation status or current-key authority.
 * For historical recovery, evaluate at the witnessed event time.
 */
export async function verifyForumSiwe(
  address: string, message: string, signature: string, recordBytes: Uint8Array,
  issuedAt: number, now: number, policyInput: ForumSiwePolicy, nonce?: string,
): Promise<boolean> {
  try {
    if (typeof message !== "string" || message.length > 8192 || !(recordBytes instanceof Uint8Array) || recordBytes.length > 131072 ||
      !integer(issuedAt) || !integer(now)) return false;
    const policy = { allowedDomains: [...policyInput.allowedDomains], allowedUris: [...policyInput.allowedUris],
      allowedChainIds: [...policyInput.allowedChainIds], clockSkewSeconds: policyInput.clockSkewSeconds ?? 0 };
    if (!integer(policy.clockSkewSeconds) || policy.clockSkewSeconds > 300 ||
      (issuedAt > now && issuedAt - now > policy.clockSkewSeconds)) return false;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(recordBytes)));
    const recordHash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const lines = message.split('\n');
  if (lines.length < 10 || !/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^\s/?#]+ wants you to sign in with your Ethereum account:$/.test(lines[0]) || lines[1] !== address || lines[2] !== '' || lines[3] !== 'SociACL link: ' + recordHash || lines[4] !== '') return false;
  if (!lines[5].startsWith('URI: ') || !webUri(lines[5].slice(5)) || lines[6] !== 'Version: 1' || !/^Chain ID: [0-9]+$/.test(lines[7]) || !/^Nonce: [A-Za-z0-9]{8,128}$/.test(lines[8]) || (nonce !== undefined && lines[8] !== 'Nonce: ' + nonce) || !lines[9].startsWith('Issued At: ')) return false;
  const domain = lines[0].slice(0, -' wants you to sign in with your Ethereum account:'.length);
  if (!webUri((domain.startsWith('https://') ? domain : 'https://' + domain) + '/')) return false;
  if (!policy || !policy.allowedDomains.includes(domain) || !policy.allowedUris.includes(lines[5].slice(5)) || !policy.allowedChainIds.includes(lines[7].slice(10))) return false;
  if (date(lines[9].slice(11)) !== issuedAt) return false;
  let at = 10;
  if (lines[at]?.startsWith('Expiration Time: ')) {
    const expiry = date(lines[at++].slice(17));
    if (!Number.isFinite(expiry) || expiry <= issuedAt) return false;
    if (now - (policy.clockSkewSeconds ?? 0) >= expiry) return false;
  }
  if (lines[at]?.startsWith('Not Before: ')) {
    const start = date(lines[at++].slice(12));
    if (!Number.isFinite(start) || start > issuedAt) return false;
  }
  if (lines[at]?.startsWith('Request ID: ')) {
    if (!/^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9a-fA-F]{2})*$/.test(lines[at++].slice(12))) return false;
  }
  if (lines[at] === 'Resources:') {
    at++;
    while (at < lines.length && lines[at].startsWith('- ') && webUri(lines[at].slice(2))) at++;
  }
  if (at !== lines.length) return false;
    return await verifyForumWalletSignature(address, message, signature);
  } catch { return false; }
}
