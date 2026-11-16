/** Server-only NIP-01 publishing. A configured signer belongs to exactly one SEA owner. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { isSeaPubkey } from "./identity/forum-check";
import type { OutboundAdapter, OutboundDraft, OutboundResult } from "./bridges";

type Socket = Pick<WebSocket, "addEventListener" | "removeEventListener" | "send" | "close"> & {terminate: () => void};
const NodeSocket = createRequire(import.meta.url)("ws") as new (url:string, options:{maxPayload:number;handshakeTimeout:number;perMessageDeflate:false}) => Socket;
export type NostrOutboundOptions = {
  env?: Record<string, string | undefined>;
  owner?: string;
  connect?: (url: string) => Socket;
  signal?: AbortSignal;
  timeoutMs?: number;
};
const failure = (): OutboundResult => ({ok:false, network:"Nostr", reason:"Nostr did not confirm publication."});
export class NostrOutbound implements OutboundAdapter {
  readonly network = "Nostr";
  constructor(private readonly options: NostrOutboundOptions = {}) {}
  private config() {
    const env = this.options.env ?? process.env, owner = this.options.owner;
    if (!owner || !isSeaPubkey(owner) || env.NOSTR_OUTBOUND_OWNER !== owner ||
        env.NEXT_PUBLIC_NOSTR_SIGNER_KEY || !/^[a-f0-9]{64}$/.test(env.NOSTR_SIGNER_KEY ?? "")) return null;
    try {
      const relay = new URL(env.NOSTR_OUTBOUND_RELAY ?? "");
      if (relay.protocol !== "wss:" || relay.username || relay.password || relay.hash || relay.search) return null;
      const key = Buffer.from(env.NOSTR_SIGNER_KEY!, "hex");
      try { const pubkey = Buffer.from(schnorr.getPublicKey(key)).toString("hex"); return {relay:relay.href, pubkey}; }
      finally { key.fill(0); }
    } catch { return null; }
  }
  get enabled() { return this.config() !== null; }
  async post(draft: OutboundDraft): Promise<OutboundResult> {
    const config = this.config();
    if (!config) return {ok:false, network:this.network, reason:"Nostr is not configured for this owner."};
    const content = draft.body.trim();
    if (!content || !content.isWellFormed() || new TextEncoder().encode(content).length > 16384 || this.options.signal?.aborted) return failure();
    // Only the explicit note body is published. Metadata and private URLs are not copied.
    const created_at = Math.floor(Date.now() / 1000), tags: string[][] = [];
    const hash = createHash("sha256").update(JSON.stringify([0,config.pubkey,created_at,1,tags,content])).digest();
    const id = hash.toString("hex"), key = Buffer.from((this.options.env ?? process.env).NOSTR_SIGNER_KEY!, "hex");
    let sig: string;
    try { sig = Buffer.from(schnorr.sign(hash,key)).toString("hex"); } catch { return failure(); } finally { key.fill(0); }
    const event = {id,pubkey:config.pubkey,created_at,kind:1,tags,content,sig};
    return new Promise(resolve => {
      let socket: Socket | undefined, settled = false, frames = 0, sent = false;
      const finish = (ok = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", cancelled);
        if (socket) {
          socket.removeEventListener("open", opened); socket.removeEventListener("message", message);
          // Keep error/close handlers until termination finishes, including during handshake.
          try { socket.terminate(); } catch { /* already terminated */ }
        }
        resolve(ok ? {ok:true, network:this.network, url:`https://njump.me/${id}`} : failure());
      };
      const cancelled = () => finish();
      const closed = () => {
        socket?.removeEventListener("error", cancelled); socket?.removeEventListener("close", closed);
        finish();
      };
      const opened = () => { if (settled || sent) return; try { sent = true; socket!.send(JSON.stringify(["EVENT",event])); } catch { finish(); } };
      const message = (incoming: Event) => {
        if (settled) return;
        const data = (incoming as MessageEvent).data;
        if (++frames > 32 || typeof data !== "string" || data.length > 4096) { finish(); return; }
        try {
          const frame = JSON.parse(data);
          if (sent && Array.isArray(frame) && frame[0] === "OK" && frame[1] === id) {
            finish(frame.length >= 4 && frame.length <= 5 && frame[2] === true && typeof frame[3] === "string");
          }
        } catch { finish(); }
      };
      const timer = setTimeout(cancelled, Math.min(10000, Math.max(1, this.options.timeoutMs ?? 10000)));
      try {
        socket = (this.options.connect ?? (url => new NodeSocket(url, {maxPayload:16384, handshakeTimeout:10000, perMessageDeflate:false})))(config.relay);
        socket.addEventListener("open", opened); socket.addEventListener("message", message);
        socket.addEventListener("error", cancelled); socket.addEventListener("close", closed);
        this.options.signal?.addEventListener("abort", cancelled, {once:true});
        if (this.options.signal?.aborted) finish();
      } catch { finish(); }
    });
  }
}
