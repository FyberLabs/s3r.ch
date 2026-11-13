import { OAUTH_REDIRECT_URIS } from "./config";
import { matchesRequestOrigin, requestHost, requestIsSecure } from "../request-origin";
import { getIdentitySecret } from "./secret";
import { configuredIdentityReplay } from "./spanopticon-replay-server";
import { identitySessionNamespace } from "./replay-namespace";
import { createIdentitySessions } from "./sea-session";
import { createAclDelegationSource } from "./acl-delegation-source-server";
import { agentSessionConfig } from "./agent-session-config";
import { uniqueJson } from "./forum-witness-json";

const origins = new Set(OAUTH_REDIRECT_URIS.map(uri => new URL(uri).origin).filter(origin => origin.startsWith("https://")));
const reply = (status: number, body: unknown) => Response.json(body, {status, headers:{
  "Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff", Vary:"Origin, Authorization" }});
function engine(request: Request, env: Readonly<Record<string,string|undefined>>, fetcher: typeof fetch, clock: () => number) {
  const origin = "https://" + requestHost(request), browserOrigin = request.headers.get("origin");
  if (!requestIsSecure(request) || !origins.has(origin) || !matchesRequestOrigin(request,new URL(origin)) ||
      (browserOrigin !== null && browserOrigin !== origin)) throw Error("Invalid agent origin");
  const config = agentSessionConfig(origin,env);
  if (!config || config.source.tenant !== env.S3RCH_IDENTITY_REPLAY_TENANT_ID) throw Error("Agent identity unavailable");
  const boundedFetch: typeof fetch = (url, options) => fetcher(url,{...options,
    signal:AbortSignal.any([request.signal,...(options?.signal ? [options.signal] : [])])});
  const replay = configuredIdentityReplay(identitySessionNamespace(origin),env,boundedFetch,clock);
  if (!replay) throw Error("Agent replay unavailable");
  return createIdentitySessions({origin,secret:getIdentitySecret({...env,NODE_ENV:"production"}),clock,
    consume:replay.consume,challengeDomain:replay.challengeDomain,
    delegationSource:createAclDelegationSource(config.source,origin,config.trust,boundedFetch,clock)});
}
async function body(request: Request) {
  if (!request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
      ![null,"identity"].includes(request.headers.get("content-encoding"))) throw Error("Invalid body");
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(1500)]), reader=request.body.getReader();
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",cancel,{once:true});
  const chunks:Uint8Array[]=[]; let size=0;
  try {
    while(true) {
      signal.throwIfAborted(); const part=await reader.read(); signal.throwIfAborted();
      if(part.done) break;
      size+=part.value.length; if(size>49152) throw Error("Request too large");
      chunks.push(new Uint8Array(part.value));
    }
    return uniqueJson(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
  } finally {signal.removeEventListener("abort",cancel);cancel();reader.releaseLock();}
}
/** Native agents prove possession and receive a bearer token, never a browser cookie. */
export async function siteAgentSession(request: Request, action: string,
  env: Readonly<Record<string,string|undefined>> = process.env, fetcher: typeof fetch = fetch,
  clock = () => Math.floor(Date.now()/1000)) {
  if(request.method !== "POST" || !["challenge","exchange"].includes(action)) return reply(404,{error:"not-found"});
  try {
    const sessions=engine(request,env,fetcher,clock), supplied=await body(request);
    if(!supplied || typeof supplied!=="object" || Array.isArray(supplied)) return reply(400,{error:"request"});
    const row=supplied as Record<string,unknown>, keys=Object.keys(row).sort().join();
    if(action==="challenge") {
      if(keys!=="delegationId,scopes" || typeof row.delegationId!=="string" || !Array.isArray(row.scopes)) return reply(400,{error:"request"});
      const challenge=await sessions.agentChallenge(row.delegationId,row.scopes);
      request.signal.throwIfAborted();
      return challenge ? reply(200,{challenge}) : reply(403,{error:"delegation"});
    }
    if(keys!=="challenge,signature" || typeof row.challenge!=="string" || typeof row.signature!=="string") return reply(400,{error:"request"});
    const token=await sessions.exchangeAgent(row.challenge,row.signature);
    request.signal.throwIfAborted();
    return token ? reply(200,{token,tokenType:"Bearer"}) : reply(403,{error:"proof"});
  } catch {return reply(503,{error:"agent-identity-unavailable"});}
}
/** Every object consumer supplies its own required scopes and still checks ACL. */
export async function authenticateAgentRequest(request: Request, scopes: readonly string[],
  env: Readonly<Record<string,string|undefined>> = process.env, fetcher: typeof fetch = fetch,
  clock = () => Math.floor(Date.now()/1000)) {
  try {
    const header=request.headers.get("authorization");
    if(!header || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(header)) return null;
    const result=await engine(request,env,fetcher,clock).authenticateAgent(header.slice(7),scopes);
    request.signal.throwIfAborted();return result;
  } catch {return null;}
}
