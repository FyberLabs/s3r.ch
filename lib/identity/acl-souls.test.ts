import assert from "node:assert/strict";
import { test } from "node:test";
import { aclSoul, grantSoul } from "./check";
import { directGrantSoul } from "./forum-authority-records";
import principals from "./vectors/principal.json";
import objects from "./vectors/object.json";

const [owner, accessor] = principals.accept;
const root = `s3rch/acl/${owner.pathKey}`;
const object = objects.accept.find(row => row.name === "bound-creator")!.canonical;

test("public ACL helpers use canonical principal path keys", () => {
  for (const row of principals.accept) assert.equal(aclSoul(row.input), `s3rch/acl/${row.pathKey}`);
  assert.equal(grantSoul(owner.input, object, accessor.input), `${root}/${object}/${accessor.pathKey}`);
  // A soul constructor addresses a row; it does not grant ownership to its signer.
  assert.equal(grantSoul(accessor.input, object, owner.input), `s3rch/acl/${accessor.pathKey}/${object}/${owner.pathKey}`);
});
for (const row of objects.accept) {
  test(`canonical ACL object: ${row.name}`, () => {
    const id = row.operation === "object-principal" ? row.input as string : row.canonical;
    assert.equal(grantSoul(owner.input, id, accessor.input), `${root}/${id}/${accessor.pathKey}`);
  });
}
for (const row of objects.reject.filter(row => !row.operation || row.operation === "parse")) {
  test(`ACL rejects object ${row.name}`, () => {
    assert.equal(grantSoul(owner.input, row.input as unknown as string, accessor.input), null);
  });
}
for (const row of principals.reject) {
  test(`ACL rejects principal ${row.name}`, () => {
    const input = row.input as unknown as string;
    assert.equal(aclSoul(input), null);
    assert.equal(grantSoul(input, object, accessor.input), null);
    assert.equal(grantSoul(owner.input, object, input), null);
  });
}
test("wallet and encoded principal aliases cannot produce canonical ACL souls", () => {
  for (const value of ["0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718", `s3rch/users/${owner.input}`, owner.pathKey, ` ${owner.input}`]) {
    assert.equal(aclSoul(value), null);
    assert.equal(grantSoul(value, object, accessor.input), null);
  }
  assert.equal(grantSoul(owner.input, "ens:alice.eth", accessor.input), null);
  assert.equal(grantSoul(owner.input, `s3rch/items/${object}`, accessor.input), null);
});
test("signed forum see/post paths share the canonical constructor", () => {
  assert.equal(directGrantSoul("see", owner.input, object, accessor.input), grantSoul(owner.input, object, accessor.input));
  assert.equal(directGrantSoul("post", owner.input, object, accessor.input), `${root}/post/${object}/${accessor.pathKey}`);
  assert.equal(directGrantSoul("see", owner.input, object, "bad"), null);
  assert.equal(directGrantSoul("post", owner.input, "s3rch/meta", accessor.input), null);
});
