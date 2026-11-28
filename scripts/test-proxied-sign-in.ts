import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSiweMessage } from "../lib/identity/siwe";

async function main() {
  const origin = new URL("https://test.s3r.ch");
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request({
      hostname: "127.0.0.1", port: Number(process.argv[2]), path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: origin.host, "x-forwarded-host": origin.host, "x-forwarded-proto": "https" },
    }, response => {
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  try {
    await once(proxy, "listening");
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    const base = "http://127.0.0.1:" + address.port;
    const post = (path: string, body: object, cookie = "", browserOrigin = origin.origin) => fetch(base + path, {
      method: "POST", headers: { origin: browserOrigin, "content-type": "application/json", cookie }, body: JSON.stringify(body),
    });
    const nonce = await fetch(base + "/api/identity/nonce");
    assert.equal(nonce.status, 200);
    const nonceCookie = nonce.headers.getSetCookie()[0];
    assert.match(nonceCookie, /^__Host-s3rch-nonce=.*; Secure/i);
    const wallet = privateKeyToAccount(generatePrivateKey());
    const message = buildSiweMessage({ domain: origin.host, uri: origin.origin, address: wallet.address,
      chainId: 84532, nonce: (await nonce.json()).nonce, expirationTime: new Date(Date.now() + 300000) });
    const login = await post("/api/identity/verify", { message, signature: await wallet.signMessage({ message }), ageConfirmed: true }, nonceCookie.split(";")[0]);
    assert.equal(login.status, 200);
    assert.equal((await login.json()).address, wallet.address);
    const challenge = await post("/api/identity/sea/challenge", {}, login.headers.getSetCookie().find(value => value.startsWith("__Host-s3rch-session="))?.split(";")[0] ?? "");
    assert.equal(challenge.status, 200);
    assert.equal(typeof (await challenge.json()).challenge, "string");
  } finally {
    proxy.close();
    proxy.closeAllConnections();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });