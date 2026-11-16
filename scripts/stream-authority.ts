/** Explicit private backend process; never imported by Next or started by default. */
import { readFileSync, lstatSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { createStreamAuthority } from "../lib/stream-authority-server";
function privateFile(path: string): Buffer {
  if (typeof path !== "string" || resolve(path) !== path) throw Error();
  const stat=lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || (stat.mode & 0o077) || stat.size>65536) throw Error();
  return readFileSync(path);
}
try {
  if(process.argv.length!==3)throw Error();
  const config=JSON.parse(privateFile(process.argv[2]).toString());
  if(config.version!==1 || config.enabled!==true || !Number.isSafeInteger(config.port) || config.port<1024 || config.port>65535 ||
    Object.keys(config).sort().join()!=="authority,enabled,forum,origin,port,serviceKey,sessionSecret,signingKey,source,tenant,tlsCertificate,tlsKey,version")throw Error();
  const handler=createStreamAuthority({...config,signingKey:createPrivateKey(privateFile(config.signingKey))});
  const server=createServer({key:privateFile(config.tlsKey),cert:privateFile(config.tlsCertificate),maxHeaderSize:8192},async(req,res)=>{
    try {
      const headers=new Headers();
      for(let i=0;i<req.rawHeaders.length;i+=2){if(headers.has(req.rawHeaders[i]))throw Error();headers.set(req.rawHeaders[i],req.rawHeaders[i+1]);}
      const request=new Request(`https://localhost:${config.port}${req.url}`,{method:req.method,headers,
        ...(req.method==="POST"?{body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:"half"}: {})} as RequestInit);
      const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(403,{"Cache-Control":"private, no-store"});res.end();}
  });
  server.headersTimeout=1000;server.requestTimeout=1000;server.maxConnections=64;
  server.on("error",()=>process.exit(1));
  server.listen(config.port,"127.0.0.1");
  for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{server.close();server.closeAllConnections();});
} catch {process.stderr.write("Private stream authority unavailable\n");process.exitCode=1;}
