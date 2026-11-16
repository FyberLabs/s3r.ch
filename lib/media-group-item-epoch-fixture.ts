// Shape-only fixture. Signatures are placeholders, not cryptographic proofs.
export const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
export const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
export const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
export const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const grant={object,owner,accessor:owner,from:0,until:10_000_000,stated:1,epoch:2,grantRevision:2,itemCiphertextDigest:"a".repeat(64)};
const direct={accessor:owner,from:0,until:grant.until,stated:1,grantRevision:2,scope:"direct",setId:"",hamState:0};
const group={...direct,accessor:reader,scope:scope.predicate,setId:scope.set,hamState:2};
export const plan={at:100,fence:"b".repeat(64),owner,ownerPub:owner,...scope,previousEpoch:1,previousFinalizationId:"c".repeat(64),
  settleWindowMs:3600000,keyCommitment:"d".repeat(64),grants:[grant],bindings:{[owner]:{pub:owner,epub:owner,head:0}},groupReaders:[reader],
  snapshot:{entries:[direct,group],objectSet:{predicate:scope.predicate,setId:scope.set,stated:1,hamState:1}}};

export function savedEpoch(){
  const manifest={object,previousEpoch:1,epoch:2,deviceId:"browser",keyCommitment:plan.keyCommitment,
    settleWindowMs:plan.settleWindowMs,aclSnapshot:"e".repeat(64),revisionId:"f".repeat(64),signature:"a".repeat(128)};
  return structuredClone({ownerPub:owner,plan:structuredClone(plan),body:{object,...scope,at:100,fence:plan.fence,payload:{
    grants:plan.grants.map(claims=>({claims,proof:{grantBytes:"aa",signature:"b".repeat(128)}})),
    document:{manifest,snapshot:plan.snapshot},finalization:{object,previousEpoch:1,epoch:2,revisionId:manifest.revisionId,
      candidateRevisionIds:[manifest.revisionId],previousFinalizationId:plan.previousFinalizationId,finalizationId:"c".repeat(64),signature:"d".repeat(128)}}}});
}
