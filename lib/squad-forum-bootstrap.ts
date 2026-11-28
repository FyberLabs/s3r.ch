import { p256 } from "@noble/curves/nist.js";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { mintSquadForumId } from "./squad-forum-mint";
import type { SeaPair } from "./identity/sea";

export async function squadForumBootstrapRows(pair: SeaPair, at: number, forumId?: string) {
  const forum = forumId ?? mintSquadForumId(pair.pub);
  const sign = (kind: AuthorityKind, fields: Record<string, unknown>) => {
    const row = { issuedAt: at, ...fields, sig: "pending" };
    const parsed = parseForumAuthority(kind, row);
    if (!parsed) throw Error("Invalid bootstrap row");
    row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(pair.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: parsed.soul, record: row };
  };
  return [
    sign("object", { object: forum, owner: pair.pub }),
    sign("see", { owner: pair.pub, object: forum, accessor: pair.pub, stated: 1, hamState: 1, from: at, until: at + 86_400 * 365 }),
    sign("post", { owner: pair.pub, object: forum, accessor: pair.pub, stated: 1, hamState: 1, from: at, until: at + 86_400 * 365 }),
  ];
}