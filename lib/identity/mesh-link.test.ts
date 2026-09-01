import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MESH_LINK_STATEMENT } from "./config";
import { assertMeshLinkBinding, buildMeshLinkStatement } from "./mesh-link";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SEA_PUB = "abc.def";

describe("mesh link statement builder", () => {
  it("builds a short domain-bound statement with checksummed address and SEA pub", () => {
    const statement = buildMeshLinkStatement({
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      address: ADDRESS.toLowerCase(),
      seaPub: SEA_PUB,
    });

    assert.equal(
      statement,
      [
        MESH_LINK_STATEMENT,
        "Domain: localhost:3000",
        "URI: http://localhost:3000",
        `Address: ${ADDRESS}`,
        `SEA pub: ${SEA_PUB}`,
      ].join("\n"),
    );
    assert.match(statement, /s3r\.ch binds this Gun SEA pub/);
    assert.doesNotMatch(statement, /\bpriv\b/);
    assert.doesNotMatch(statement, /epriv/);
  });

  it("binds s3r.ch the same way", () => {
    const statement = buildMeshLinkStatement({
      domain: "s3r.ch",
      uri: "https://s3r.ch",
      address: ADDRESS,
      seaPub: SEA_PUB,
    });
    assert.match(statement, /^s3r\.ch binds this Gun SEA pub to this Ethereum address\./);
    assert.match(statement, /Domain: s3r\.ch/);
    assert.match(statement, /URI: https:\/\/s3r\.ch/);
  });

  it("rejects a lookalike domain", () => {
    assert.throws(
      () =>
        buildMeshLinkStatement({
          domain: "s3r.ch.evil.com",
          uri: "https://s3r.ch.evil.com",
          address: ADDRESS,
          seaPub: SEA_PUB,
        }),
      /domain is not allowed/,
    );
  });

  it("rejects a domain / URI host mismatch", () => {
    assert.throws(
      () =>
        assertMeshLinkBinding({
          domain: "s3r.ch",
          uri: "http://localhost:3000",
          address: ADDRESS,
        }),
      /does not match URI/,
    );
  });

  it("rejects an invalid URI", () => {
    assert.throws(
      () =>
        buildMeshLinkStatement({
          domain: "localhost",
          uri: "not-a-uri",
          address: ADDRESS,
          seaPub: SEA_PUB,
        }),
      /URI is not valid/,
    );
  });
});
