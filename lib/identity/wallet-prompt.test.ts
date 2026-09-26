import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HYPERMESH_WALLET_PROMPT,
  WALLET_BEFORE_HOPS,
  walletPromptForOAuth,
} from "./wallet-prompt";

const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("hyperme.sh wallet handoff prompt", () => {
  it("asks to connect the existing USDC wallet", () => {
    const prompt = walletPromptForOAuth({ hypermeshWallet: WALLET, declined: false });
    assert.equal(prompt.kind, "hypermesh");
    if (prompt.kind !== "hypermesh") return;
    assert.equal(prompt.copy, HYPERMESH_WALLET_PROMPT);
    assert.equal(prompt.wallet, WALLET);
    assert.match(prompt.copy, /Connect your hyperme\.sh wallet now\?/);
  });

  it("No leaves OAuth-only and does not ask again", () => {
    assert.deepEqual(
      walletPromptForOAuth({ hypermeshWallet: WALLET, declined: true }),
      { kind: "none" },
    );
  });

  it("asks to create or connect when hyperme.sh has no wallet", () => {
    const prompt = walletPromptForOAuth({ hypermeshWallet: null, declined: false });
    assert.equal(prompt.kind, "create");
    if (prompt.kind !== "create") return;
    assert.equal(prompt.copy, WALLET_BEFORE_HOPS);
  });

  it("does not mint a mesh key", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./wallet-prompt.ts", import.meta.url)),
      "utf8",
    );
    const bar = readFileSync(
      fileURLToPath(new URL("../../components/IdentityBar.tsx", import.meta.url)),
      "utf8",
    );
    assert.match(bar, /walletPromptForOAuth/);
    assert.match(bar, /onYesHypermeshWallet/);
    assert.match(bar, /onNoHypermeshWallet/);
    for (const file of [source, bar]) {
      assert.equal(file.includes("privateKey"), false);
      assert.equal(file.includes("generateWallet"), false);
      assert.equal(file.includes("usdc_pubkey"), false);
    }
  });
});
