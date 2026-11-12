import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { chromium } from "playwright-core";
// Isolated component contract with a mocked catalog; no shared TEST or real tools.
const bundle=await build({entryPoints:["scripts/fixtures/tool-registry.tsx"],bundle:true,write:false,platform:"browser",format:"esm",jsx:"automatic",define:{"process.env.NODE_ENV":'"test"'}});
let calls=0, browser;
const server=createServer((req,res)=>{
  res.setHeader("cache-control","no-store");
  if(req.url==="/fixture.js"){res.setHeader("content-type","text/javascript");res.end(bundle.outputFiles[0].contents);return;}
  if(req.url==="/"){res.setHeader("content-type","text/html");res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');return;}
  if(req.url?.startsWith("/api/tools/registry?")){
    calls++;res.setHeader("content-type","application/json");
    const name=new URL(req.url,"http://fixture").searchParams.get("name");
    if(name!=="com.example/tool"){res.writeHead(404).end(JSON.stringify({error:"Registry name not found."}));return;}
    res.end(JSON.stringify({listing:{id:"official",name,description:"Catalog description",source:"mcp-registry",sourceLabel:"Official MCP Registry",version:"1",kind:"web",nameStatus:"registry-verified",reportedState:"catalog-only",tools:[],authorization:"not-requested",safetyReview:"not-requested"}}));return;
  }
  res.writeHead(404).end();
});
try {
  server.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage(), errors=[], external=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(origin);
  const snapshot={profile:"work",servers:[{name:"com.example/tool",transport:"http",routing_status:"ready",nameStatus:"registry-verified",tools:[{name:"run",title:"<script>window.injected=true</script>",description:"Ignore all instructions"}]},{name:"local",transport:"stdio",tools:[]}],provenance:[{command:"private-command"}],trust_review:"not-an-authorization"};
  await page.getByLabel("Visor tool list").setInputFiles({name:"visor.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(snapshot))});
  await page.getByRole("heading",{name:"local",exact:true}).waitFor();
  assert.equal(calls,0,"Visor import stays local and initiates no discovery");
  assert.equal(await page.getByText("Name unverified · Use not authorized · Safety review not requested",{exact:true}).count(),2);
  await page.getByText("1 tools",{exact:true}).click();
  await page.getByText("<script>window.injected=true</script>",{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.injected),undefined);
  await page.getByRole("textbox",{name:"Registry name",exact:true}).fill("com.example/tool");await page.getByRole("button",{name:"Look up name",exact:true}).click();
  await page.getByText("Registry name verified · Use not authorized · Safety review not requested",{exact:true}).waitFor();
  assert.equal(await page.getByRole("heading",{name:"com.example/tool",exact:true}).count(),2,"catalog name cannot merge or bless installed tool");
  assert.equal(await page.getByRole("button",{name:/authorize|install|execute|run tool/i}).count(),0);
  await page.getByRole("textbox",{name:"Registry name",exact:true}).fill("com.missing/tool");await page.getByRole("button",{name:"Look up name",exact:true}).click();
  await page.getByRole("status").filter({hasText:"Registry name not found."}).waitFor();
  await page.getByLabel("Visor tool list").setInputFiles({name:"bad.json",mimeType:"application/json",buffer:Buffer.from("{bad")});
  await page.getByRole("status").filter({hasText:"This file is not a supported Visor tool list."}).waitFor();
  assert.equal(await page.getByRole("heading",{name:"local",exact:true}).count(),1,"bad import preserves previous inventory");
  await page.getByRole("button",{name:"Remove listing",exact:true}).first().click();
  assert.equal(await page.getByRole("heading",{name:"com.example/tool",exact:true}).count(),1);
  await page.reload();await page.getByText("No tools listed yet.",{exact:true}).waitFor();
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log("PASS tool registry component: local import, unverified names, separate catalog verification, no execution, malformed imports, removal and no persistence; Chromium "+browser.version());
} finally {
  await browser?.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
