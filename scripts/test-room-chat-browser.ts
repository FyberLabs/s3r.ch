import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { p256 } from "@noble/curves/nist.js";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createBotStatementAdmission } from "../lib/forum-bot-statement-admission";
import { parseForumAuthority } from "../lib/identity/forum-authority-records";
import { seaToPrincipalKey } from "../lib/identity/forum-check";
import type { SeaPair } from "../lib/identity/sea";
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "schedule") throw Error("Room browser scenario runs only in the scheduled nightly batch");
async function main() {
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const [owner, writer] = await Promise.all([sea.pair(), sea.pair()]);
const at = 1700000060, config = { keys: [], pinnedIssuers: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] } };
const squad = { owner: owner.pub, forumId: `forum_${seaToPrincipalKey(owner.pub)}_${"a".repeat(32)}`, label: "Browser fixture" };
const sign = (kind: "object" | "see" | "post", fields: Record<string, unknown>) => {
  const row = { ...fields, issuedAt: at - 10, sig: "pending" }, parsed = parseForumAuthority(kind, row)!;
  row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(owner.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
  return { kind, soul: parsed.soul, record: row };
};
const rows = [sign("object", { object: squad.forumId, owner: owner.pub }), ...(["see", "post"] as const).map(kind => sign(kind,
  { object: squad.forumId, owner: owner.pub, accessor: writer.pub, stated: 1, from: at - 20, until: at + 1000, hamState: 1 }))];
const snapshot = () => ({ completeThrough: at, rows: revoked ? [...rows, sign("see", { object: squad.forumId, owner: owner.pub, accessor: writer.pub, stated: 0, from: at - 20, until: at + 1000, hamState: 2 })] : rows, history: { completeThrough: at, links: [], accounts: [owner, writer].map(pair =>
  ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } });
let revision = 0, posts = 0, revoked = false;
const service = createBotStatementAdmission({ origin: "https://fixture.example.test", squad, config, clock: () => at,
  objectKind: "room", authenticate: async () => ({ key: writer.pub }), source: { read: async () => ({ snapshot: snapshot(), fence: String(revision) }),
    append: async (fence, additions, guard) => { guard(); if (fence !== String(revision)) return false; rows.push(...additions as typeof rows); revision++; return true; } } });
const bundle = await build({ stdin: { contents: `
import {admitBrowserRoom} from './lib/room-authority-browser';
import {createHttpForumAuthorityReader} from './lib/forum-authority-http';
import {createForumAuthority} from './lib/identity/forum-authority';
import {createRoomChatAdmission} from './lib/room-chat-admission';
import {encodeKey} from './lib/identity/check';
window.initialize = async fixture => {
 const {pair,squad,config,item,at} = fixture;
 const read=createHttpForumAuthorityReader({endpoint:'/authority',squad});
 const authority=createForumAuthority(config,()=>at);
 const refresh=async()=>authority.refresh(await read(at,new AbortController().signal),at);
 if(fixture.create) await admitBrowserRoom({pair,squad,config,item,share:true,endpoint:'/statement',read,fetch,signal:new AbortController().signal,clock:()=>at});
 await refresh();
 const admission=createRoomChatAdmission({graph:authority.graph,parent:squad.forumId,readerKey:()=>pair.pub,clock:()=>at});
 window.send=body=>admission.compose(item.id,body,()=>pair);
 window.receive=async row=>{
  await refresh();
  const received=await admission.receive(row,item.id,encodeKey(row.id));
  return received ? {author:received.author,body:received.body} : null;
 };
};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "browser", format: "iife", external: ["node:module", "crypto", "@peculiar/webcrypto"] });
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); return; }
    if (req.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString();
      assert.ok(!body.includes(writer.priv));
      if (req.url === "/authority") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ version: 1, forumId: squad.forumId, owner: squad.owner, evaluatedAt: at, snapshot: snapshot() })); return; }
      if (req.url === "/statement") { posts++; const result = await service(new Request("https://fixture.example.test/statement", { method: "POST", headers: { Origin: "https://fixture.example.test", "Content-Type": "application/json" }, body })); res.writeHead(result.status, { "Content-Type": "application/json" }); res.end(await result.text()); return; }
    }
    res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><script src="/fixture.js"></script>');
  } catch { res.writeHead(500); res.end(); }
});
let browser;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true });
  const first = await browser.newPage(), second = await browser.newPage();
  const errors: string[] = []; for (const page of [first,second]) page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${address.port}`;
  await Promise.all([first.goto(url),second.goto(url)]);
  const item = {id:`room_${seaToPrincipalKey(writer.pub)}_${"b".repeat(32)}`,author:writer.pub,ts:at};
  await first.evaluate(f => (window as any).initialize(f), {pair:writer,squad,config,item,at,create:true});
  await second.evaluate(f => (window as any).initialize(f), {pair:owner,squad,config,item,at,create:false});
  const row = await first.evaluate(() => (window as any).send("signed hello")); assert.ok(row);
  assert.deepEqual(await second.evaluate(value => (window as any).receive(value),row),{author:writer.pub,body:"signed hello"});
  for (const forged of [{...row,author:owner.pub},{...row,id:"s3rch:chat:"+"a".repeat(64)},{...row,sig:undefined}])
    assert.equal(await second.evaluate(value => (window as any).receive(value),forged),null);
  const reply = await second.evaluate(() => (window as any).send("signed reply")); assert.ok(reply);
  assert.deepEqual(await first.evaluate(value => (window as any).receive(value),reply),{author:owner.pub,body:"signed reply"});
  revoked = true;
  assert.equal(await first.evaluate(value => (window as any).receive(value),reply),null);
  assert.equal(await second.evaluate(value => (window as any).receive(value),row),null);
  assert.equal(posts,1); assert.equal(revision,1); assert.deepEqual(errors,[]);
  console.log("PASS two-identity room chat, signed author/ID binding, unsigned refusal and parent revocation");
} finally { await browser?.close(); server.close(); }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
