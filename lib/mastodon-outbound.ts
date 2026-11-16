/** Server-only Mastodon publishing; the provider owns ActivityPub signing/delivery. */
import { isSeaPubkey } from "./identity/forum-check";
import type { OutboundAdapter, OutboundDraft, OutboundResult } from "./bridges";
export type MastodonOutboundOptions = {
  env?: Record<string,string|undefined>; owner?: string; fetch?: typeof fetch;
  signal?: AbortSignal; timeoutMs?: number;
};
const NETWORK = "Mastodon (ActivityPub)";
const fail = (): OutboundResult => ({ok:false,network:NETWORK,reason:"Mastodon did not confirm publication. Check the account before retrying."});
const object = (value:unknown): value is Record<string,unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value:unknown): value is string => typeof value === "string" && /^[0-9]{1,40}$/.test(value);
async function boundedJson(response:Response, signal:AbortSignal):Promise<unknown> {
  if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw Error("response"); }
  const reader = response.body.getReader(), chunks:Uint8Array[] = []; let size = 0;
  const cancel = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener("abort",cancel,{once:true});
  try {
    if(signal.aborted) throw Error("aborted");
    while(true) {
      const {done,value} = await reader.read();
      if(signal.aborted) throw Error("aborted");
      if(done) break;
      size += value.byteLength; if(size > 65536) throw Error("response too large"); chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener("abort",cancel); cancel(); reader.releaseLock(); }
}
export class MastodonOutbound implements OutboundAdapter {
  readonly network = NETWORK;
  constructor(private readonly options:MastodonOutboundOptions = {}) {}
  private config() {
    const env = this.options.env ?? process.env, owner = this.options.owner;
    if(!owner || !isSeaPubkey(owner) || owner !== env.MASTODON_OUTBOUND_OWNER ||
       !id(env.MASTODON_OUTBOUND_ACCOUNT_ID) || !/^[\x21-\x7e]{1,4096}$/.test(env.MASTODON_ACCESS_TOKEN ?? "") || env.NEXT_PUBLIC_MASTODON_ACCESS_TOKEN) return null;
    try {
      const url = new URL(env.MASTODON_OUTBOUND_ORIGIN ?? "");
      if(url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
      return {origin:url.origin,account:env.MASTODON_OUTBOUND_ACCOUNT_ID,token:env.MASTODON_ACCESS_TOKEN!};
    } catch { return null; }
  }
  get enabled() { return this.config() !== null; }
  async post(draft:OutboundDraft):Promise<OutboundResult> {
    const config = this.config();
    if(!config) return {ok:false,network:NETWORK,reason:"Mastodon is not configured for this owner."};
    const content = draft.body.trim();
    if(!content || !content.isWellFormed() || Array.from(content).length > 500 || this.options.signal?.aborted) return fail();
    const controller = new AbortController(), cancel = () => controller.abort();
    const timer = setTimeout(cancel,Math.min(10000,Math.max(1,this.options.timeoutMs ?? 10000)));
    this.options.signal?.addEventListener("abort",cancel,{once:true});
    const fetchFn = this.options.fetch ?? fetch;
    const request = async (path:string,body?:string) => boundedJson(await fetchFn(config.origin+path,{
      method:body === undefined ? "GET" : "POST",redirect:"error",cache:"no-store",signal:controller.signal,
      headers:{authorization:`Bearer ${config.token}`,accept:"application/json",...(body === undefined ? {} : {"content-type":"application/json"})},body,
    }),controller.signal);
    try {
      if(this.options.signal?.aborted) cancel();
      const account = await request("/api/v1/accounts/verify_credentials");
      if(!object(account) || account.id !== config.account || controller.signal.aborted) return fail();
      // Recheck operator binding after the asynchronous read, before any mutation.
      const current = this.config();
      if(!current || JSON.stringify(current) !== JSON.stringify(config)) return fail();
      const status = await request("/api/v1/statuses",JSON.stringify({status:content,visibility:"public"}));
      if(!object(status) || !id(status.id) || !object(status.account) || status.account.id !== config.account ||
         status.visibility !== "public" || typeof status.url !== "string" || status.url.length > 2048 || controller.signal.aborted) return fail();
      const url = new URL(status.url);
      if(url.origin !== config.origin || url.username || url.password || url.search || url.hash) return fail();
      return {ok:true,network:NETWORK,url:url.href};
    } catch { return fail(); }
    finally {clearTimeout(timer); this.options.signal?.removeEventListener("abort",cancel); controller.abort();}
  }
}
