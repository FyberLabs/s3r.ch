import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {build} from "esbuild";
import {chromium} from "playwright-core";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Live directory browser contracts run in CI only");
const bundle=await build({entryPoints:["scripts/fixtures/live-directory.tsx"],bundle:true,write:false,platform:"browser",format:"esm",jsx:"automatic",define:{"process.env.NODE_ENV":'"test"'}});
const now=1800000000;let ended=false,browser;
const stream={id:"public-stream",author:"a".repeat(64),title:"Fixture public live",url:"https://example.com/stream.mp4",starts:now-120,expires:now+30,participants:7};
const server=createServer((req,res)=>{
 res.setHeader("cache-control","no-store");
 if(req.url==="/api/live"){res.setHeader("content-type","application/json");res.end(JSON.stringify({available:true,streams:ended?[]:[stream]}));return;}
 if(req.url==="/fixture.js"){res.setHeader("content-type","text/javascript");res.end(bundle.outputFiles[0].contents);return;}
 if(req.url==="/"){res.setHeader("content-type","text/html");res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');return;}
 res.writeHead(404).end();
});
try{
 server.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});const page=await browser.newPage();
 const errors=[],external=[];page.on("pageerror",e=>errors.push(e.message));
 await page.route("**/*",route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.clock.install({time:now*1000});await page.goto(origin);await page.getByText("Fixture public live",{exact:true}).waitFor();
 assert.match(await page.locator("section").innerText(),/2 minutes · 7 participants/);
 await page.getByRole("button",{name:"Watch stream"}).click();assert.equal(await page.locator("video").count(),1);
 assert.ok((await page.locator("video").getAttribute("src")).startsWith("/api/feed/media?"));
 await page.clock.fastForward(31_000);await page.getByText("No live streams from these accounts right now.").waitFor();assert.equal(await page.locator("video").count(),0);
 ended=true;await page.clock.fastForward(60_000);assert.equal(await page.getByText("Fixture public live",{exact:true}).count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log("PASS public live directory playback selection, bounded expiry and ended refresh");
}finally{await browser?.close();server.close();}
