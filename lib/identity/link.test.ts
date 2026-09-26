import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  FileLinkStore,
  linkLoginPaths,
  openLinks,
  ownerForOAuth,
  ownerForWallet,
  type Links,
} from "./link";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "s3rch-links-"));
  return { dir, file: join(dir, "identity-links.json") };
}

function openAt(file: string): Links {
  return openLinks(new FileLinkStore(file));
}

describe("login handles", () => {
  it("makes the first wallet the sociacl owner and keeps a second broker on that owner", () => {
    const { dir, file } = tempFile();
    try {
      const links = openAt(file);
      const first = links.link({
        wallet: ALICE.toLowerCase(),
        sub: "kc-github",
        idp: "github",
      });
      assert.deepEqual(first, { owner: ALICE });
      const second = links.link({ wallet: ALICE, sub: "kc-microsoft", idp: "microsoft" });
      assert.deepEqual(second, { owner: ALICE });
      const again = links.link({ wallet: ALICE, sub: "kc-github", idp: "github" });
      assert.deepEqual(again, { owner: ALICE });

      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        v: number;
        people: { owner: string; handles: { kind: string; sub?: string; address?: string }[] }[];
      };
      assert.equal(raw.v, 1);
      assert.equal(raw.people.length, 1);
      assert.equal(raw.people[0]?.owner, ALICE);
      assert.deepEqual(
        raw.people[0]?.handles.map((handle) => handle.sub ?? handle.address),
        [ALICE, "kc-github", "kc-microsoft"],
      );
      assert.equal(links.ownerForOAuth("kc-microsoft"), ALICE);
      assert.equal(links.ownerForWallet(ALICE), ALICE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a later wallet as a handle on the first owner", () => {
    const { dir, file } = tempFile();
    try {
      const links = openAt(file);
      assert.deepEqual(links.link({ wallet: ALICE, sub: "kc-1", idp: "google" }), { owner: ALICE });
      assert.deepEqual(links.link({ wallet: BOB, sub: "kc-1", idp: "google" }), { owner: ALICE });
      assert.equal(links.ownerForWallet(BOB.toLowerCase()), ALICE);
      assert.equal(links.ownerForWallet(ALICE), ALICE);
      const raw = JSON.parse(readFileSync(file, "utf8")) as { people: { owner: string }[] };
      assert.deepEqual(
        raw.people.map((person) => person.owner),
        [ALICE],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to merge two owners", () => {
    const { dir, file } = tempFile();
    try {
      const links = openAt(file);
      links.link({ wallet: ALICE, sub: "kc-alice", idp: "github" });
      links.link({ wallet: BOB, sub: "kc-bob", idp: "microsoft" });
      assert.deepEqual(links.link({ wallet: ALICE, sub: "kc-bob", idp: "microsoft" }), {
        denied: true,
        reason: "already-linked",
      });
      assert.equal(links.ownerForOAuth("kc-bob"), BOB);
      assert.equal(links.ownerForWallet(CAROL), CAROL);
      assert.equal(links.ownerForOAuth("kc-carol"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an address-shaped subject and a bad wallet", () => {
    const { dir, file } = tempFile();
    try {
      const links = openAt(file);
      assert.deepEqual(links.link({ wallet: ALICE, sub: ALICE, idp: null }), {
        denied: true,
        reason: "bad-handle",
      });
      assert.deepEqual(links.link({ wallet: "not-an-address", sub: "kc-1", idp: "github" }), {
        denied: true,
        reason: "bad-handle",
      });
      assert.equal(links.ownerForOAuth(ALICE), null);
      let raw = "";
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        raw = "";
      }
      assert.equal(raw.includes("people"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown file version without rewriting it", () => {
    const { dir, file } = tempFile();
    try {
      writeFileSync(file, JSON.stringify({ v: 2, people: [{ owner: "keep" }] }), "utf8");
      const links = openAt(file);
      assert.deepEqual(links.link({ wallet: ALICE, sub: "kc-1", idp: "github" }), {
        denied: true,
        reason: "store-unreadable",
      });
      assert.equal(links.ownerForOAuth("kc-1"), null);
      assert.equal(links.ownerForWallet(ALICE), ALICE);
      const raw = readFileSync(file, "utf8");
      assert.match(raw, /"v":2/);
      assert.match(raw, /keep/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the env path on each call and does not store tokens", () => {
    const { dir, file } = tempFile();
    const previous = process.env.S3RCH_IDENTITY_LINKS;
    process.env.S3RCH_IDENTITY_LINKS = file;
    try {
      const bound = linkLoginPaths({ wallet: ALICE, sub: "kc-env", idp: "github" });
      assert.deepEqual(bound, { owner: ALICE });
      assert.equal(ownerForOAuth("kc-env"), ALICE);
      assert.equal(ownerForWallet(ALICE), getAddress(ALICE));
      const src = readFileSync(new URL("./link.ts", import.meta.url), "utf8");
      assert.equal(src.includes("client_secret"), false);
      assert.equal(src.includes("access_token"), false);
      assert.equal(src.includes("refresh_token"), false);
      assert.equal(src.includes('from "gun"'), false);
      const raw = readFileSync(file, "utf8");
      assert.equal(raw.includes("access_token"), false);
      assert.equal(raw.includes("client_secret"), false);
    } finally {
      if (previous === undefined) delete process.env.S3RCH_IDENTITY_LINKS;
      else process.env.S3RCH_IDENTITY_LINKS = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
