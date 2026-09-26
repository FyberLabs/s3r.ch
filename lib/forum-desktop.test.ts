import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deskPanels, type DeskRead } from "./forum-desktop";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const desktop = {
  session: "11111111-1111-4111-8111-111111111111",
  snapshot: { handle: "abc123", mime: "image/png", seq: 2 },
  thinking: [
    { kind: "prompt", text: "count the sheep" },
    { kind: "type", text: "cargo test --locked" },
  ],
  files: [{ handle: "notes.txt" }],
  secrets: [{ handle: "password" }],
};

describe("forum desktop panels", () => {
  it("shows the owner their snapshot and thinking, and a renter only shared channels", () => {
    const owner = deskPanels({
      channel: { id: `s3rch:forum:${ALICE}`, owner: ALICE },
      desktop,
      shared: [],
    });
    assert.equal(owner.length, 1);
    assert.equal(owner[0]?.role, "owner");
    assert.equal(owner[0]?.snapshotUrl, "/api/forum?snapshot=abc123");
    assert.deepEqual(
      owner[0]?.thinking.map((row) => row.text),
      ["count the sheep", "cargo test --locked"],
    );
    assert.deepEqual(owner[0]?.files, ["notes.txt"]);
    assert.deepEqual(owner[0]?.secrets, ["password"]);

    const renter = deskPanels({
      channel: null,
      desktop: null,
      shared: [{ channel: { id: `s3rch:forum:${ALICE}`, owner: ALICE }, desktop }],
    });
    assert.equal(renter.length, 1);
    assert.equal(renter[0]?.role, "renter");
    assert.equal(renter[0]?.owner, ALICE);
    assert.equal(renter[0]?.snapshotHandle, "abc123");

    const neither: DeskRead = { channel: null, desktop: null, shared: [] };
    assert.deepEqual(deskPanels(neither), []);

    const ownEmpty = deskPanels({
      channel: { id: `s3rch:forum:${BOB}`, owner: BOB },
      desktop: null,
      shared: [],
    });
    assert.equal(ownEmpty.length, 1);
    assert.equal(ownEmpty[0]?.owner, BOB);
    assert.equal(ownEmpty[0]?.snapshotUrl, null);
    assert.equal(
      ownEmpty.some((panel) => panel.owner === ALICE),
      false,
    );
  });

  it("keeps the page off Gun and off a visor door", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../app/forum/page.tsx", import.meta.url)),
      "utf8",
    );
    const desk = readFileSync(
      fileURLToPath(new URL("../components/ForumDesk.tsx", import.meta.url)),
      "utf8",
    );
    const joined = `${page}\n${desk}`;
    assert.equal(joined.includes("gun"), false);
    assert.equal(joined.includes("127.0.0.1"), false);
    assert.equal(joined.includes("X-Api-Key"), false);
    assert.equal(joined.includes("flex-col"), true);
    assert.equal(joined.includes("md:flex-row"), true);
  });
});
