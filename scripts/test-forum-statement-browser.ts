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
if (process.env.GITHUB_ACTIONS !== "true") throw Error("Forum browser contracts run in CI only");
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
const snapshot = () => ({ completeThrough: at, rows, history: { completeThrough: at, links: [], accounts: [owner, writer].map(pair =>
  ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } });
let revision = 0, posts = 0;
const service = createBotStatementAdmission({ origin: "https://fixture.example.test", squad, config, clock: () => at,
  authenticate: async () => ({ key: writer.pub }), source: { read: async () => ({ snapshot: snapshot(), fence: String(revision) }),
    append: async (fence, additions, guard) => { guard(); if (fence !== String(revision)) return false; rows.push(...additions as typeof rows); revision++; return true; } } });
const bundle = await build({ stdin: { contents: `
import {admitBrowserStatement} from './lib/forum-statement-browser';
import {createHttpForumAuthorityReader} from './lib/forum-authority-http';
import {createForumAuthority} from './lib/identity/forum-authority';
window.exercise = async fixture => {
 const {pair,squad,config,item,at} = fixture;
 const read=createHttpForumAuthorityReader({endpoint:'/authority',squad});
 const input={pair,squad,config,item,endpoint:'/statement',read,fetch,signal:new AbortController().signal,clock:()=>at};
 const first=await admitBrowserStatement(input);
 const authority=createForumAuthority(config,()=>at);await authority.refresh(first.snapshot,at);
 const allowed=authority.graph.checkPost(item.id,item.author,at).allowed;
 await admitBrowserStatement(input);
 const abort=new AbortController();abort.abort();let denied=false;
 try{await admitBrowserStatement({...input,signal:abort.signal})}catch{denied=true}
 return {allowed,denied};
};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "browser", format: "iife" });
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
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(fixture => (window as any).exercise(fixture), { pair: writer, squad, config, at,
    item: { id: `stmt_${seaToPrincipalKey(writer.pub)}_${"b".repeat(32)}`, author: writer.pub, ts: at } });
  assert.deepEqual(result, { allowed: true, denied: true }); assert.equal(posts, 2); assert.equal(revision, 1); assert.deepEqual(errors, []);
  console.log("PASS browser statement signing, protected admission/readback, idempotent retry and cancellation");
} finally { await browser?.close(); server.close(); }
