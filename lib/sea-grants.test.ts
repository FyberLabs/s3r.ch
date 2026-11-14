import assert from "node:assert/strict";
import test from "node:test";
import vectors from "./identity/vectors/principal.json";
import { composeNativePost, admitNativePost } from "./compose";
import { applySeeGrant, checkSee, cancelSee, itemSoul } from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import { legacyAclPrincipalKey } from "./identity/legacy-acl-souls";
import { grantedSoul, prepareGrantItemDelivery, acceptGrantDelivery } from "./grant-delivery";
import { prepareMeshSeeGrant, fromGunAclNode, gunAclWireNode } from "./identity/mesh-acl";
const [owner, accessor] = vectors.accept.map(row => row.input);
test("SEA grants follow the exact principal and refuse credential and user-object aliases", () => {
  const acl = createMemorySeeAcl();
  const item = composeNativePost({ address: owner, body: "private", entropy: "abcd", nowSeconds: 100 })!;
  admitNativePost(acl, item, owner);
  const grant = { claimId: item.id, accessor, from: 100, until: 200 };
  applySeeGrant(acl, owner, grant);
  assert.equal(checkSee(acl, itemSoul(item.id), accessor, 101).allowed, true);
  for (const alias of ["0x" + "a".repeat(40), "oidc:subject", `s3rch/users/${accessor}`, accessor.toLowerCase()]) {
    assert.equal(checkSee(acl, itemSoul(item.id), alias, 101).allowed, false);
    assert.throws(() => grantedSoul(alias, "items", item.id));
    assert.throws(() => legacyAclPrincipalKey(alias));
    assert.equal(prepareMeshSeeGrant(owner, { ...grant, accessor: alias }), null);
  }
  const delivery = prepareGrantItemDelivery(acl, item, owner, grant, 101);
  assert.ok(!("denied" in delivery));
  assert.ok(!("denied" in acceptGrantDelivery(createMemorySeeAcl(), delivery.node, accessor, 101)));
  cancelSee(acl, owner, accessor, itemSoul(item.id));
  assert.equal(checkSee(acl, itemSoul(item.id), accessor, 101).allowed, false);
});
test("mesh grant decoding binds canonical SEA principal path keys", () => {
  const grant = { claimId: "claim", accessor, from: 100, until: 200 };
  const edge = prepareMeshSeeGrant(owner, grant)!;
  const parts = edge.soul.split("/");
  assert.ok(fromGunAclNode(gunAclWireNode(edge), parts[2], parts[3], parts[4]));
  assert.equal(fromGunAclNode(gunAclWireNode(edge), "wallet-owner", parts[3], parts[4]), null);
  assert.equal(fromGunAclNode(gunAclWireNode(edge), parts[2], parts[3], "wallet-accessor"), null);
});


test("mixed legacy and SEA forum storage preserves old rows without wallet authority", async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { emptyForumFile, FileForumStore, openForum, handleForumGet, handleForumPost } = await import("./forum");
  const dir = mkdtempSync(join(tmpdir(), "sea-forum-mixed-")), file = join(dir, "forum.json");
  const wallet = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const oldChannel = { id: `s3rch:forum:${wallet}`, owner: wallet, created: 100, v: 1 };
  try {
    writeFileSync(file, JSON.stringify({ ...emptyForumFile(), channels: [oldChannel] }));
    const forum = openForum(new FileForumStore(file));
    assert.equal(handleForumPost(forum, owner, { action: "register", label: "new", entropy: "abcd" }).status, 200);
    assert.equal(handleForumGet(forum, wallet).status, 400);
    assert.equal(handleForumPost(forum, wallet, { action: "register", label: "legacy", entropy: "bcde" }).status, 400);
    const reopened = openForum(new FileForumStore(file));
    assert.equal(handleForumGet(reopened, owner).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).channels.find((row: {owner:string}) => row.owner === wallet), oldChannel);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
