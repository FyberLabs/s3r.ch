import { isSeaPubkey } from './identity/forum-check';
import type { FeedItem } from './feed-types';

export const LEDGER_PREFIX = 's3rch-ledger:v1:';
export const LEDGER_TEXT_MAX = 120;
export type LedgerEntry = Readonly<{kind:'decision'|'work';text:string;owner:string|null}>;
/** A recorded owner is descriptive, never an assignment of permissions. */
export function encodeLedgerEntry(entry:LedgerEntry):string {
  if (!entry || !['decision','work'].includes(entry.kind) || typeof entry.text !== 'string' ||
      !entry.text.trim() || entry.text !== entry.text.trim() || entry.text.length > LEDGER_TEXT_MAX ||
      /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(entry.text) ||
      (entry.owner !== null && (typeof entry.owner !== 'string' || !isSeaPubkey(entry.owner)))) throw Error('Invalid ledger entry');
  const body = LEDGER_PREFIX + JSON.stringify([entry.kind,entry.text,entry.owner]);
  if (body.length > 280) throw Error('Ledger entry is too long');
  return body;
}
export function parseLedgerEntry(body:string):LedgerEntry|null {
  if (typeof body !== 'string' || body.length > 280 || !body.startsWith(LEDGER_PREFIX)) return null;
  try {
    const values:unknown = JSON.parse(body.slice(LEDGER_PREFIX.length));
    if (!Array.isArray(values) || values.length !== 3) return null;
    const entry = {kind:values[0],text:values[1],owner:values[2]} as LedgerEntry;
    return encodeLedgerEntry(entry) === body ? Object.freeze(entry) : null;
  } catch { return null; }
}
/** Call only with the forum's currently authenticated, readable chat projection.
 * Parsing a transport row does not establish its author or its read authority. */
export function ledgerEntries(rows:readonly FeedItem[]) {
  return rows.flatMap(row => {
    const entry = parseLedgerEntry(row.body);
    return entry ? [{...entry,id:row.id,author:row.author,ts:row.ts}] : [];
  });
}
