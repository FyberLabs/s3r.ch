import { parseJsonInput } from "sociacl-ids";

/** SociACL owns duplicate-member, depth, number and Unicode validation.
 * Existing witness callers expect malformed input to throw and deny admission.
 */
export function uniqueJson(source: string): unknown {
  const parsed = parseJsonInput(source);
  if (!parsed.ok) throw Error(`Invalid witness JSON: ${parsed.reason}`);
  return parsed.value;
}
