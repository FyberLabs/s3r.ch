/** Local acceptance harness only. Never import into the Next application.
 * Fresh synthetic keys, private durable SQLite storage and loopback binding.
 * This source knows the complete isolated history because no external writer is
 * admitted. It is not a claim of production Gun/Panopticon completeness. */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { p256 } from "@noble/curves/nist.js";
import { createAssignmentJournal } from "../lib/delegation-journal";
import { createDelegationRuntime } from "../lib/delegation-runtime";
import { parseForumAuthority, type AuthorityKind } from "../lib/identity/forum-authority-records";
import { createForumAuthority } from "../lib/identity/forum-authority";
import { seaToPrincipalKey } from "../lib/identity/forum-check";
import { signForumRecord } from "../lib/forum-sign";

async function main() {
  const directory = process.argv[2]; if (!directory) throw Error("Private state directory required");
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const path = resolve(directory, "credentials.json");
  const fresh = !existsSync(path);
  if (fresh && existsSync(resolve(directory, "squad.sqlite"))) throw Error("Missing synthetic credentials; refusing to replace identities");
  if (fresh) {
    const identities = Array.from({ length: 4 }, () => {
      const secret = p256.utils.randomSecretKey(), key = p256.getPublicKey(secret, false);
      return { pub: Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url"),
        secret: Buffer.from(secret).toString("hex"), token: randomBytes(32).toString("hex") };
    });
    writeFileSync(path, JSON.stringify({ identities, entropy: randomBytes(16).toString("hex") }), { mode: 0o600, flag: "wx" });
  }
  const { identities, entropy } = JSON.parse(readFileSync(path, "utf8")) as { identities: { pub: string; secret: string; token: string }[]; entropy: string };
  const owner = identities[0].pub, agents = identities.slice(1).map(x => x.pub);
  const forum = `forum_${seaToPrincipalKey(owner)}_${entropy}`, child = `update_${seaToPrincipalKey(owner)}_${entropy}`;
  const db = new DatabaseSync(resolve(directory, "squad.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL)");
  let fault = "", signatures = 0;
  function store(name: string) {
    return {
      async read() { const row = db.prepare("SELECT value, revision FROM documents WHERE name=?").get(name) as { value: string; revision: number } | undefined;
        return row ? { text: row.value, etag: String(row.revision) } : null; },
      async compareAndSwap(etag: string | null, text: string) {
        if (Buffer.byteLength(text) > 2_097_152) throw Error("capacity");
        const previous = name === "journal" ? await this.read() : null;
        const changed = etag === null ? db.prepare("INSERT OR IGNORE INTO documents VALUES (?, ?, 1)").run(name, text).changes
          : db.prepare("UPDATE documents SET value=?, revision=revision+1 WHERE name=? AND revision=?").run(text, name, Number(etag)).changes;
        if (changed && previous && fault) {
          const old = JSON.parse(previous.text), next = JSON.parse(text), appended = next.rows?.slice(old.rows.length) ?? [];
          const hit = fault === "child-ack" ? JSON.stringify(next.children) !== JSON.stringify(old.children) : fault === "commit-ack" ? next.operation?.phase === "complete" && old.operation?.phase !== "complete"
            : appended.some((r: { record: { stated: number } }) => r.record.stated === (fault === "grant-ack" ? 1 : 0));
          if (hit) { fault = ""; throw Error("synthetic lost acknowledgement"); }
        }
        return !!changed;
      },
    };
  }
  function immutable(prefix: string) { return {
    async read(id: string) { return (await store(`${prefix}/${id}`).read())?.text ?? null; },
    async create(id: string, text: string) { await store(`${prefix}/${id}`).compareAndSwap(null, text); },
  }; }
  const config = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
  const history = async (at: number) => ({ completeThrough: at, links: [], accounts: identities.map(i => ({ principal: i.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) });
  function sign(kind: AuthorityKind, fields: Record<string, unknown>) {
    const record = { ...fields, sig: "pending" }, parsed = parseForumAuthority(kind, record); if (!parsed) throw Error("invalid signed row");
    const identity = identities.find(i => i.pub === parsed.signer); if (!identity) throw Error("uncontrolled signer");
    record.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(identity.secret, "hex"), { prehash: true, format: "compact" })).toString("base64url");
    signatures++; return { kind, soul: parsed.soul, record };
  }
  const journal = createAssignmentJournal(store("journal"));
  if (!await store("journal").read()) {
    if (!fresh) throw Error("Missing live synthetic journal; refusing to reset assignments");
    const at = Math.floor(Date.now() / 1000);
    await journal.initialize({ forum, owner, assignee: agents[0], destinations: [child], rows: [
      ...[forum, child].map(object => sign("object", { owner, object, issuedAt: at })),
      ...(["see", "post"] as const).map(kind => sign(kind, { owner, object: child, accessor: agents[0], stated: 1, hamState: 1, issuedAt: at, from: at, until: at + 86400 })),
    ] });
  }
  const runtime = createDelegationRuntime({ journal, config, history,
    operationStores(id) { if (!/^[0-9a-f]{32}$/.test(id)) throw Error("invalid operation"); return {
      inventory: store(`inventory/${id}`), cancellations: immutable("cancellations"), grants: immutable("grants"),
    }; }, async sign(kind, fields) { return sign(kind, fields); } });
  const bundle = await build({ entryPoints: [resolve("scripts/fixtures/squad-acceptance-client.tsx")], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (req.url === "/" && req.method === "GET") { res.writeHead(200, { "Content-Type": "text/html" }); res.end('<!doctype html><html><head><title>Isolated test Squad</title></head><body><div id="root"></div><script src="/client.js"></script></body></html>'); return; }
    if (req.url === "/client.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/config") { reply(200, { forum, owner, agents, child }); return; }
    const identity = identities.find(i => req.headers.authorization === `Bearer ${i.token}`);
    if (!identity) { reply(403, { error: "authenticated synthetic identity required" }); return; }
    try {
      let text = ""; for await (const chunk of req) { text += chunk.toString(); if (text.length > 65536) throw Error("request too large"); }
      const body = text ? JSON.parse(text) : {};
      if (body.forum !== undefined && (body.forum !== forum || body.owner !== owner)) throw Error("scope mismatch");
      const action = req.url?.split("/").at(-1);
      if (action === "read") {
        const s = await runtime.read(identity.pub); reply(200, { forum, owner, assignee: s.assignee, revision: s.revision, operation: s.operation, receipts: s.receipts });
      } else if (action === "start") reply(200, await runtime.start(identity.pub, body.operationId, body.replacement, body.revision));
      else if (action === "resume") reply(200, await runtime.resume(identity.pub, body.operationId, body.replacement));
      else if (action === "abort") { await runtime.abort(identity.pub, body.operationId); reply(200, { ok: true }); }
      else if (action === "access") {
        let answered = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const state = await journal.load(), at = Math.floor(Date.now() / 1000), authority = createForumAuthority(config);
          const admitted = await authority.refresh({ completeThrough: at, history: await history(at), rows: state.rows }, at);
          if (Math.floor(Date.now() / 1000) !== at) continue;
          if (!admitted.ok || admitted.diagnostics.length) throw Error("unverified access evidence");
          reply(200, { canRead: authority.graph.checkDirectSee(body.destination ?? child, identity.pub, at).allowed,
            canPost: authority.graph.checkPost(body.destination ?? child, identity.pub, at).allowed, owner: authority.graph.ownerOf(body.destination ?? child), child });
          answered = true; break;
        }
        if (!answered) throw Error("access evidence expired; retry");
      } else if (action === "read-child") reply(200, await runtime.readChild(identity.pub, body.id));
      else if (action === "child") {
        await runtime.publishChild(identity.pub, (await journal.load()).revision, body.record, body.signature); reply(200, { ok: true });
      } else if (action === "synthetic-write") {
        const at = Math.floor(Date.now() / 1000), state = await journal.load();
        const record = { domain: "s3rch-forum-child-v1", kind: "update", forumId: forum, agent: owner, writer: identity.pub,
          id: body.destination ?? child, rev: (state.children[body.destination ?? child]?.record.rev ?? -1) + 1, issuedAt: at, stated: 1, body: body.body ?? "Synthetic update", target: "", state: "" };
        const priv = Buffer.from(identity.secret, "hex").toString("base64url");
        const signature = await signForumRecord(record, { pub: identity.pub, priv, epub: identity.pub, epriv: priv });
        if (!signature) throw Error("synthetic signing failed");
        await runtime.publishChild(identity.pub, state.revision, record, signature); reply(200, { ok: true, child: record.id });
      } else if (action === "fault" && identity.pub === owner) {
        if (!["cancellation-ack", "grant-ack", "commit-ack", "child-ack", ""].includes(body.kind)) throw Error("unknown fault");
        fault = body.kind; reply(200, { ok: true });
      } else if (action === "inspect" && identity.pub === owner) reply(200, { state: await journal.load(), signatures });
      else if (action === "register" && identity.pub === owner) {
        const state = await journal.load(), at = Math.floor(Date.now() / 1000);
        const object = `update_${seaToPrincipalKey(owner)}_${body.id}`;
        const rows = [sign("object", { owner, object, issuedAt: at }), ...(["see", "post"] as const).map(kind =>
          sign(kind, { owner, object, accessor: state.assignee, stated: 1, hamState: 1, issuedAt: at, from: at, until: at + 86400 }))];
        await runtime.admit(identity.pub, body.revision, object, rows); reply(200, { object });
      } else reply(404, { error: "unknown action" });
    } catch (error) { reply(error instanceof Error && /owner required|denied/.test(error.message) ? 403 : 409, { error: error instanceof Error ? error.message : "request failed" }); }
  });
  server.listen(Number(process.argv[3] ?? 0), "127.0.0.1", () => {
    const address = server.address(); if (!address || typeof address === "string") throw Error("no listen address");
    writeFileSync(resolve(directory, "ready.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}`, forum, owner, agents, child }), { mode: 0o600 });
    console.log(`Synthetic Squad ready at http://127.0.0.1:${address.port}`); process.send?.({ port: address.port });
  });
  process.on("SIGTERM", () => { server.close(); db.close(); process.exit(0); });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
