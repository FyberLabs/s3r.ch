import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySeeGrant,
  cancelSee,
  checkSee,
  grantSoul,
  itemSoul,
  userSoul,
} from "./check";
import {
  applyGunAclEdge,
  cancelSeeOnMesh,
  createMeshAclIndex,
  fromGunAclNode,
  gunAclWireNode,
  ingestGunAclEdge,
  mergeGunAclEdge,
  nextHamState,
  prepareMeshSeeCancel,
  prepareMeshSeeGrant,
  putMeshSeeGrant,
  stateSeeGrantOnMesh,
  type MeshAclGunRef,
} from "./mesh-acl";
import { createMemorySeeAcl } from "./see-acl";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CLAIM = "ens:alice.eth";
const NOW = 1_000;

function memoryGun(): MeshAclGunRef & { nodes: Map<string, unknown> } {
  const nodes = new Map<string, unknown>();
  const make = (path: string[]): MeshAclGunRef => ({
    get(key) {
      return make([...path, key]);
    },
    put(data) {
      nodes.set(path.join("/"), data);
      return make(path);
    },
  });
  return Object.assign(make([]), { nodes });
}

describe("MeshSeeGrant HAM", () => {
  it("stated grant then cancel with bumped hamState wins the next merge", () => {
    const holder = createMemorySeeAcl();
    const peer = createMemorySeeAcl();
    const holderMesh = createMeshAclIndex();
    const peerMesh = createMeshAclIndex();
    holder.putObject(CLAIM, ALICE);

    const grant = { claimId: CLAIM, accessor: BOB, from: 0, until: 80 };
    const stated = stateSeeGrantOnMesh(holder, holderMesh, ALICE, grant);
    assert.ok(stated);
    assert.equal(stated.grant.stated, 1);
    assert.equal(stated.soul, grantSoul(ALICE, CLAIM, BOB));
    assert.equal(checkSee(holder, CLAIM, BOB, 10).allowed, true);

    const merged = ingestGunAclEdge(peer, peerMesh, gunAclWireNode(stated));
    assert.ok(merged);
    assert.equal(checkSee(peer, CLAIM, BOB, 10).allowed, true);

    const cancelled = cancelSeeOnMesh(holder, holderMesh, ALICE, BOB, CLAIM);
    assert.ok(cancelled);
    assert.equal(cancelled.grant.stated, 0);
    assert.ok(cancelled.hamState > stated.hamState);
    assert.equal(checkSee(holder, CLAIM, BOB, 10).allowed, false);

    const after = ingestGunAclEdge(peer, peerMesh, gunAclWireNode(cancelled));
    assert.ok(after);
    assert.equal(after.grant.stated, 0);
    assert.equal(checkSee(peer, CLAIM, BOB, 10).allowed, false);
  });

  it("stale stated row loses to a later cancel hamState", () => {
    const grant = { claimId: CLAIM, accessor: BOB, from: 0, until: 80 };
    const live = prepareMeshSeeGrant(ALICE, grant, 10, 20);
    const dead = prepareMeshSeeCancel(ALICE, BOB, CLAIM, 10, 21);
    assert.ok(live && dead);
    const won = mergeGunAclEdge(live, dead);
    assert.equal(won.grant.stated, 0);
    assert.equal(won.hamState, dead.hamState);
    const stale = mergeGunAclEdge(dead, live);
    assert.equal(stale.grant.stated, 0);
  });

  it("nextHamState always bumps so cancel cannot tie", () => {
    assert.equal(nextHamState(5, 5), 6);
    assert.equal(nextHamState(5, 100), 100);
    assert.equal(nextHamState(undefined, 3), 3);
  });
});

describe("mesh Check objects", () => {
  it("claim-id objects use the claim id itself — no users/…/claims/ path", () => {
    const acl = createMemorySeeAcl();
    const mesh = createMeshAclIndex();
    for (const claim of ["ens:alice.eth", "fc:dwr", "farcaster:dwr", "lens:vitalik", "rss3:0xabc"]) {
      acl.putObject(claim, ALICE);
      const edge = stateSeeGrantOnMesh(acl, mesh, ALICE, {
        claimId: claim,
        accessor: BOB,
        from: 0,
        until: 80,
      });
      assert.ok(edge);
      assert.equal(edge.soul.includes("/claims/"), false);
      assert.equal(claim.includes("/claims/"), false);
      assert.equal(checkSee(acl, claim, BOB, 10).allowed, true);
    }
  });

  it("feed item souls stay five-segment dest ACL paths", () => {
    const object = itemSoul("rss3:act/1#x");
    const grant = { claimId: object, accessor: BOB, from: 0, until: 80 };
    const edge = prepareMeshSeeGrant(userSoul(ALICE), grant);
    assert.ok(edge);
    assert.equal(edge.soul.split("/").length, 5);
    assert.equal(edge.soul.startsWith(`s3rch/acl/${ALICE}/`), true);
  });

  it("fail closed without dest ACL — hop and hint do not mint", () => {
    const empty = createMemorySeeAcl();
    const mesh = createMeshAclIndex();
    const hop = { channel: "convention-badge" as const };
    assert.equal(checkSee(empty, CLAIM, BOB, NOW, undefined, hop).allowed, false);
    const forged = prepareMeshSeeGrant(ALICE, {
      claimId: CLAIM,
      accessor: BOB,
      from: 0,
      until: 80,
    });
    assert.ok(forged);
    // No putObject / no ingest → still denied.
    assert.equal(checkSee(empty, CLAIM, BOB, NOW).allowed, false);
    assert.equal(mesh.snapshot().length, 0);
  });

  it("owner-only cancel; non-owner mesh cancel does not bump dest ACL", () => {
    const acl = createMemorySeeAcl();
    const mesh = createMeshAclIndex();
    acl.putObject(CLAIM, ALICE);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: 80 });
    const stolen = cancelSeeOnMesh(acl, mesh, BOB, BOB, CLAIM);
    assert.equal(stolen, null);
    assert.equal(checkSee(acl, CLAIM, BOB, 10).allowed, true);
    cancelSee(acl, CAROL, BOB, CLAIM);
    assert.equal(checkSee(acl, CLAIM, BOB, 10).allowed, true);
  });

  it("secret-bearing Gun rows are not MeshSeeGrant", () => {
    assert.equal(
      fromGunAclNode({
        object: CLAIM,
        accessor: BOB,
        from: 0,
        until: 80,
        stated: 1,
        owner: ALICE,
        hamState: 1,
        priv: "nope",
      }),
      null,
    );
    const clean = fromGunAclNode({
      object: CLAIM,
      accessor: BOB,
      from: 0,
      until: 80,
      stated: 1,
      owner: ALICE,
      hamState: 1,
    });
    assert.ok(clean);
    assert.equal(clean.soul, grantSoul(ALICE, CLAIM, BOB));
  });

  it("puts MeshSeeGrant on the locked Gun path", () => {
    const gun = memoryGun();
    const grant = { claimId: CLAIM, accessor: BOB, from: 0, until: 80 };
    const edge = prepareMeshSeeGrant(ALICE, grant, 0, 50);
    assert.ok(edge);
    putMeshSeeGrant(gun, edge);
    assert.deepEqual(gun.nodes.get(`s3rch/acl/${ALICE}/ens:alice_eth/${BOB}`), {
      object: CLAIM,
      accessor: BOB,
      from: 0,
      until: 80,
      stated: 1,
      owner: ALICE,
      hamState: 50,
    });
  });

  it("applyGunAclEdge stated 0 privilege-downs immediately", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: 80 });
    const cancel = prepareMeshSeeCancel(ALICE, BOB, CLAIM, 1, 9);
    assert.ok(cancel);
    applyGunAclEdge(acl, cancel);
    assert.equal(checkSee(acl, CLAIM, BOB, 10).allowed, false);
  });
});
