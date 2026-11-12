import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { readSiwePolicy, policyAllowsMessage } from "./siwe-policy";
import { buildSiweMessage, verifySiweLogin, createMainnetSiweVerifyClient } from "./siwe";

const declared = {
  allowed_hosts: ["s3r.ch", "www.s3r.ch"],
  allowed_origins: ["https://s3r.ch", "https://www.s3r.ch"],
  contract_chain_id: 1,
};
const env = (value: unknown) => ({ S3RCH_SIWE_POLICY: JSON.stringify(value) });

describe("SIWE deployment policy", () => {
  it("preserves unconfigured hosts and narrows configured hosts and exact origins", () => {
    assert(readSiwePolicy({}).hosts.has("test.s3r.ch"));
    const policy = readSiwePolicy(env(declared));
    assert(policyAllowsMessage(policy, "s3r.ch", "https://s3r.ch"));
    assert(policyAllowsMessage(policy, "www.s3r.ch", "https://www.s3r.ch"));
    for (const [host, uri] of [["test.s3r.ch","https://test.s3r.ch"],
      ["s3r.ch","https://www.s3r.ch"], ["s3r.ch","https://s3r.ch/other"],
      ["s3r.ch:444","https://s3r.ch:444"], ["s3r.ch","https://evil.invalid"]]) {
      assert.equal(policyAllowsMessage(policy, host, uri), false);
    }
  });

  it("rejects malformed, foreign, incomplete and wrong-chain configuration", () => {
    for (const value of [null, [], {}, {...declared, contract_chain_id:8453},
      {...declared, allowed_hosts:["evil.invalid"]}, {...declared, allowed_hosts:["s3r.ch","s3r.ch"]},
      {...declared, allowed_origins:["https://s3r.ch"]},
      {...declared, allowed_origins:["http://s3r.ch", "https://www.s3r.ch"]},
      {...declared, rpc_url:"http://rpc.invalid"}, {...declared, rpc_url:"https://user:secret@rpc.invalid"},
      {...declared, extra:true}]) assert.throws(() => readSiwePolicy(env(value)));
    assert.throws(() => readSiwePolicy({S3RCH_SIWE_POLICY:"{"}));
  });

  it("enforces declared URI and host before accepting a valid EOA signature", async () => {
    const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    async function verify(uri: string, settings: Record<string,string|undefined>) {
      const message = buildSiweMessage({domain:"s3r.ch",uri,address:account.address,
        chainId:31337,nonce:"abcdef123456",issuedAt:new Date()});
      const signature = await account.signMessage({message});
      return verifySiweLogin({message,signature,expectedNonce:"abcdef123456",requestHost:"s3r.ch",verifyClient:null},settings);
    }
    assert.equal((await verify("https://s3r.ch",env(declared))).ok,true);
    assert.equal((await verify("https://www.s3r.ch",env(declared))).ok,false);
    assert.equal((await verify("https://s3r.ch",env({...declared,contract_chain_id:8453}))).ok,false);
  });

  it("refuses an RPC reporting another chain before contract verification", async () => {
    const methods: string[] = [];
    const fetch = mock.method(globalThis,"fetch",async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(String(options.body)); methods.push(request.method);
      return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,result:"0x2105"}),
        {headers:{"content-type":"application/json"}});
    });
    try {
      const client = createMainnetSiweVerifyClient("https://rpc.invalid");
      assert.equal(await client.verifyMessage({address:"0xcccccccccccccccccccccccccccccccccccccccc",message:"unit",signature:"0x00"}),false);
      assert.deepEqual(methods,["eth_chainId"]);
    } finally { fetch.mock.restore(); }
  });
});
