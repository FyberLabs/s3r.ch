// Protected configuration and native signed-history contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredLinkedAdmission } from "./linked-admission-config-server";
import { setup, f } from "./fixtures/agent-delegation";
const canonical = (v:unknown):string => Array.isArray(v)?`[${v.map(canonical).join(",")}]`:
  v!==null&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(",")}}`:JSON.stringify(v);
test("absent protected configuration stays off without IO",async()=>{
  assert.equal(await configuredLinkedAdmission("https://s3r.ch",{},async()=>{throw Error("unexpected IO");}),undefined);
  await assert.rejects(configuredLinkedAdmission("https://s3r.ch",{S3RCH_LINKED_IDENTITY_CONFIG_FILE:"relative"}));
});
test("protected local trust installs the complete source; unsafe or foreign config refuses",async()=>{
  const h=await setup(),directory=await mkdtemp(join(tmpdir(),"linked-config-")),path=join(directory,"identity.json");
  const source={origin:"https://acl.example",tenant:h.sourceConfig.tenant,source:"01234567-89ab-cdef-0123-456789abcdee",apiKey:"private-unit-key"};
  const config={version:1,origin:"https://s3r.ch",source,trust:{...h.trust,pinnedIss:[...h.trust.pinnedIss]},walletChainIds:[],oidc:[]};
  const credential={kind:"oidc" as const,...h.oidc.cred};
  const history={...h.document.snapshot.history,links:[h.oidc]};
  const fetcher:typeof fetch=async()=>Response.json({version:1,tenant:source.tenant,source:source.source,authorityDigest:"a".repeat(64),trust:{},
    snapshot:{completeThrough:f.now,credential,links:[h.oidc],revocations:[],history}});
  const env={S3RCH_LINKED_IDENTITY_CONFIG_FILE:path};
  try {
    await writeFile(path,canonical(config)+"\n",{mode:0o600});
    const admission=await configuredLinkedAdmission(config.origin,env,fetcher,()=>f.now);
    assert.equal((await admission!.resolve(credential,f.now))?.key,h.oidc.principal);
    await assert.rejects(configuredLinkedAdmission("https://foreign.example",env));
    await chmod(path,0o644);await assert.rejects(configuredLinkedAdmission(config.origin,env));
    await chmod(path,0o600);
    const alias=join(directory,"alias");await symlink(path,alias);
    await assert.rejects(configuredLinkedAdmission(config.origin,{S3RCH_LINKED_IDENTITY_CONFIG_FILE:alias}));
    for(const raw of [JSON.stringify(config),canonical({...config,version:2})+"\n","x".repeat(65537),'{"version":1,"version":1}\n']) {
      await writeFile(path,raw);await assert.rejects(configuredLinkedAdmission(config.origin,env));
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
