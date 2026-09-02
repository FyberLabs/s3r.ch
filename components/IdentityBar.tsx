"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  useSignMessage,
} from "wagmi";
import { IdentityProviders } from "@/components/IdentityProviders";
import { SIWE_MESSAGE_TTL_MS } from "@/lib/identity/config";
import {
  getMeshKey,
  isPlaintextMeshKeyRecord,
  isWrappedMeshKeyRecord,
  type MeshKeyRecord,
} from "@/lib/identity/idb";
import {
  ensureLocalMeshKey,
  persistRewrappedMeshKey,
  persistWrappedMeshKey,
  readLocalMeshPair,
} from "@/lib/identity/mesh";
import {
  ensClaimLine,
  lookupEnsHeldClaimForSession,
  type EnsHeldClaim,
} from "@/lib/identity/ens";
import {
  farcasterClaimLine,
} from "@/lib/identity/farcaster-claim";
import {
  emptyIndicators,
  lookupIndicatorsForSession,
  type PublicIndicators,
} from "@/lib/identity/indicators";
import { lensClaimLine } from "@/lib/identity/lens-claim";
import { rss3ClaimLine } from "@/lib/identity/rss3-claim";
import { buildSiweMessage } from "@/lib/identity/siwe";
import {
  PRF_UNAVAILABLE_MESSAGE,
  PrfUnavailableError,
  createPrfCredential,
  detectPrfAvailability,
  evaluatePrf,
} from "@/lib/identity/webauthn-prf";
import {
  base64UrlToBytes,
  buildSecondaryWrapStatement,
  encodePaperBackup,
  decodePaperBackup,
  quietPaperBackupError,
  randomPaperSecondaryKey,
  secondaryIkmFromWalletSignature,
  wrapSeaPair,
} from "@/lib/identity/wrap";

type SessionPayload = {
  address: string;
  chainId: number;
};

export function IdentityBar() {
  return (
    <IdentityProviders>
      <IdentityBarInner />
    </IdentityProviders>
  );
}

function IdentityBarInner() {
  const { address, chainId, isConnected } = useConnection();
  const { mutateAsync: connect, isPending: connecting } = useConnect();
  const connectors = useConnectors();
  const { mutate: disconnect } = useDisconnect();
  const { mutateAsync: signMessageAsync } = useSignMessage();

  const [session, setSession] = useState<SessionPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [meshLine, setMeshLine] = useState<string | null>(null);
  const [meshKind, setMeshKind] = useState<"plaintext" | "wrapped" | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [prfAvailable, setPrfAvailable] = useState<boolean | null>(null);
  const [ensClaim, setEnsClaim] = useState<string | null>(null);
  const [ensCachedFor, setEnsCachedFor] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<PublicIndicators>(emptyIndicators);
  const [indicatorsCachedFor, setIndicatorsCachedFor] = useState<string | null>(null);
  const [wrapWithPaper, setWrapWithPaper] = useState(false);
  const [paperPaste, setPaperPaste] = useState("");
  const [paperReveal, setPaperReveal] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch("/api/identity/session", { cache: "no-store" });
      if (!response.ok) {
        setSession(null);
        return;
      }
      const payload = (await response.json()) as SessionPayload;
      if (payload.address) setSession(payload);
      else setSession(null);
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    void detectPrfAvailability().then((result) => {
      setPrfAvailable(result.available);
    });
  }, []);

  useEffect(() => {
    if (!session) {
      setEnsClaim(null);
      setEnsCachedFor(null);
      return;
    }
    if (ensCachedFor === session.address) return;
    const sessionAddress = session.address;
    let cancelled = false;
    void lookupEnsHeldClaimForSession({
      session,
      lookup: (address) => fetchEnsHeldClaim(address),
    })
      .then((claim) => {
        if (cancelled) return;
        setEnsClaim(claim.name);
        setEnsCachedFor(sessionAddress);
      })
      .catch(() => {
        if (cancelled) return;
        setEnsClaim(null);
        setEnsCachedFor(sessionAddress);
      });
    return () => {
      cancelled = true;
    };
  }, [session, ensCachedFor]);

  useEffect(() => {
    if (!session) {
      setIndicators(emptyIndicators());
      setIndicatorsCachedFor(null);
      return;
    }
    if (indicatorsCachedFor === session.address) return;
    const sessionAddress = session.address;
    let cancelled = false;
    void lookupIndicatorsForSession({
      session,
      lookup: (address) => fetchPublicIndicators(address),
    })
      .then((claims) => {
        if (cancelled) return;
        setIndicators(claims);
        setIndicatorsCachedFor(sessionAddress);
      })
      .catch(() => {
        if (cancelled) return;
        setIndicators(emptyIndicators());
        setIndicatorsCachedFor(sessionAddress);
      });
    return () => {
      cancelled = true;
    };
  }, [session, indicatorsCachedFor]);

  useEffect(() => {
    if (session) return;
    setWrapWithPaper(false);
    setPaperPaste("");
    setPaperReveal(null);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    void getMeshKey(session.address)
      .then((record) => {
        setMeshKind((current) => {
          if (current) return current;
          if (isWrappedMeshKeyRecord(record)) return "wrapped";
          if (record) return "plaintext";
          return null;
        });
        setMeshLine((current) => {
          if (current) return current;
          if (isWrappedMeshKeyRecord(record)) return "mesh key wrapped";
          if (record) return "mesh key already present";
          return null;
        });
      })
      .catch(() => {
        // Private mode / missing IndexedDB — stay quiet.
      });
  }, [session]);

  const injected = connectors.find((connector) => connector.id === "injected") ?? connectors[0];
  const walletConnectConnector = connectors.find(
    (connector) => connector.id === "walletConnect",
  );
  const wcConfigured = Boolean(walletConnectConnector);

  async function onConnect() {
    setMessage(null);
    if (!injected || !hasInjectedProvider()) {
      setMessage("No injected wallet found.");
      return;
    }
    try {
      await connect({ connector: injected });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Connect failed.");
    }
  }

  async function onWalletConnect() {
    setMessage(null);
    if (!walletConnectConnector) return;
    try {
      await connect({ connector: walletConnectConnector });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Connect failed.");
    }
  }

  async function onSignIn() {
    if (!address) {
      setMessage(
        wcConfigured ? "Connect a wallet first." : "Connect an injected wallet first.",
      );
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const nonceRes = await fetch("/api/identity/nonce", { cache: "no-store" });
      const nonceBody = (await nonceRes.json()) as { nonce?: string; error?: string };
      if (!nonceRes.ok || !nonceBody.nonce) {
        throw new Error(nonceBody.error || "Could not issue a nonce.");
      }

      const walletChainId = chainId ?? (await readInjectedChainId()) ?? 1;

      const prepared = buildSiweMessage({
        domain: window.location.host,
        address,
        uri: window.location.origin,
        chainId: walletChainId,
        nonce: nonceBody.nonce,
        expirationTime: new Date(Date.now() + SIWE_MESSAGE_TTL_MS),
      });

      const signature = await signMessageAsync({ message: prepared });
      const verifyRes = await fetch("/api/identity/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: prepared, signature }),
      });
      const verifyBody = (await verifyRes.json()) as SessionPayload & { error?: string };
      if (!verifyRes.ok) {
        throw new Error(verifyBody.error || "Verify failed.");
      }
      setSession({ address: verifyBody.address, chainId: verifyBody.chainId });
      setMessage(null);
      try {
        const mesh = await ensureLocalMeshKey({
          address: verifyBody.address,
          domain: window.location.host,
          uri: window.location.origin,
          signMessage: (linkMessage) => signMessageAsync({ message: linkMessage }),
        });
        applyMeshRecord(
          mesh.record,
          setMeshKind,
          setMeshLine,
          mesh.created ? "mesh key ready" : undefined,
        );
        setUnlocked(false);
      } catch {
        setMeshLine("mesh key failed");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onWrapWithPasskey() {
    if (!session) return;
    if (prfAvailable === false) {
      setMessage(PRF_UNAVAILABLE_MESSAGE);
      return;
    }
    if (!wrapWithPaper && !isConnected) {
      setMessage(
        wcConfigured
          ? "Connect a wallet to wrap the mesh key."
          : "Connect the injected wallet to wrap the mesh key.",
      );
      return;
    }
    setBusy(true);
    setMessage(null);
    setPaperReveal(null);
    const paperKey = wrapWithPaper ? randomPaperSecondaryKey() : null;
    try {
      const existing = await getMeshKey(session.address);
      if (!existing || !isPlaintextMeshKeyRecord(existing)) {
        throw new Error("No plaintext mesh key to wrap.");
      }
      const prf = await createPrfCredential({
        address: session.address,
        host: window.location.host,
      });
      const secondary = paperKey
        ? {
            secondaryKey: paperKey,
            secondaryKind: "paper" as const,
            paper: encodePaperBackup(paperKey),
          }
        : await walletSecondaryForWrap({
            address: session.address,
            signMessage: (message) => signMessageAsync({ message }),
          });
      const envelope = await wrapSeaPair({
        pair: existing.seaPair,
        address: session.address,
        rpId: prf.rpId,
        credentialId: prf.credentialId,
        prfSalt: prf.prfSalt,
        prfOutput: prf.prfOutput,
        secondaryKey: secondary.secondaryKey,
        secondarySalt: "secondarySalt" in secondary ? secondary.secondarySalt : undefined,
        secondaryKind: secondary.secondaryKind,
      });
      const wrapped = await persistWrappedMeshKey({
        address: session.address,
        envelope,
      });
      setMeshKind("wrapped");
      setMeshLine("mesh key wrapped");
      setUnlocked(true);
      if ("paper" in secondary) setPaperReveal(secondary.paper);
      if (!isWrappedMeshKeyRecord(wrapped) || "seaPair" in wrapped) {
        throw new Error("Plaintext seaPair must not remain after wrap.");
      }
    } catch (error) {
      setUnlocked(false);
      setPaperReveal(null);
      if (error instanceof PrfUnavailableError) {
        setMessage(error.message);
        return;
      }
      setMessage(error instanceof Error ? error.message : "Wrap failed.");
    } finally {
      paperKey?.fill(0);
      setBusy(false);
    }
  }

  async function onUnlockMeshKey() {
    if (!session) return;
    setBusy(true);
    setMessage(null);
    try {
      const existing = await getMeshKey(session.address);
      if (!existing || !isWrappedMeshKeyRecord(existing)) {
        throw new Error("No wrapped mesh key to unlock.");
      }
      try {
        const prfOutput = await evaluatePrf({
          rpId: existing.wrap.rpId,
          credentialId: base64UrlToBytes(existing.wrap.credentialId),
          prfSalt: base64UrlToBytes(existing.wrap.prfSalt),
        });
        await readLocalMeshPair({ record: existing, prfOutput });
      } catch (prfError) {
        if (!isConnected || !existing.wrap.secondarySalt) {
          throw prfError;
        }
        const statement = buildSecondaryWrapStatement({
          domain: window.location.host,
          uri: window.location.origin,
          address: session.address,
          secondarySalt: base64UrlToBytes(existing.wrap.secondarySalt),
        });
        const secondarySignature = await signMessageAsync({ message: statement });
        await readLocalMeshPair({
          record: existing,
          secondaryKey: secondaryIkmFromWalletSignature(secondarySignature),
        });
      }
      setUnlocked(true);
      setMeshLine("mesh key unlocked");
    } catch (error) {
      setUnlocked(false);
      if (error instanceof PrfUnavailableError) {
        setMessage(error.message);
        return;
      }
      setMessage(error instanceof Error ? error.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onUnlockWithPaper() {
    if (!session) return;
    setBusy(true);
    setMessage(null);
    let secondaryKey: Uint8Array | null = null;
    try {
      const existing = await getMeshKey(session.address);
      if (!existing || !isWrappedMeshKeyRecord(existing)) {
        throw new Error("No wrapped mesh key to unlock.");
      }
      try {
        secondaryKey = decodePaperBackup(paperPaste);
      } catch (error) {
        setUnlocked(false);
        setMessage(quietPaperBackupError(error));
        return;
      }
      await readLocalMeshPair({ record: existing, secondaryKey });
      setPaperPaste("");
      setUnlocked(true);
      setMeshLine("mesh key unlocked");
    } catch (error) {
      setUnlocked(false);
      setMessage(quietPaperBackupError(error));
    } finally {
      secondaryKey?.fill(0);
      setBusy(false);
    }
  }

  async function onExportPaperBackup() {
    if (!session) return;
    if (prfAvailable === false) {
      setMessage(PRF_UNAVAILABLE_MESSAGE);
      return;
    }
    setBusy(true);
    setMessage(null);
    setPaperReveal(null);
    const paperKey = randomPaperSecondaryKey();
    try {
      const existing = await getMeshKey(session.address);
      if (!existing || !isWrappedMeshKeyRecord(existing)) {
        throw new Error("No wrapped mesh key to export.");
      }
      const prfOutput = await evaluatePrf({
        rpId: existing.wrap.rpId,
        credentialId: base64UrlToBytes(existing.wrap.credentialId),
        prfSalt: base64UrlToBytes(existing.wrap.prfSalt),
      });
      const pair = await readLocalMeshPair({ record: existing, prfOutput });
      const paper = encodePaperBackup(paperKey);
      const envelope = await wrapSeaPair({
        pair,
        address: session.address,
        rpId: existing.wrap.rpId,
        credentialId: base64UrlToBytes(existing.wrap.credentialId),
        prfSalt: base64UrlToBytes(existing.wrap.prfSalt),
        prfOutput,
        secondaryKey: paperKey,
        secondaryKind: "paper",
      });
      const wrapped = await persistRewrappedMeshKey({
        address: session.address,
        envelope,
      });
      if (!isWrappedMeshKeyRecord(wrapped) || "seaPair" in wrapped) {
        throw new Error("Plaintext seaPair must not remain after wrap.");
      }
      setMeshKind("wrapped");
      setMeshLine("mesh key wrapped");
      setUnlocked(true);
      setPaperPaste("");
      setPaperReveal(paper);
    } catch (error) {
      setPaperReveal(null);
      if (error instanceof PrfUnavailableError) {
        setMessage(error.message);
        return;
      }
      if (error instanceof Error && /Could not unwrap/.test(error.message)) {
        setMessage("Could not export paper backup.");
        return;
      }
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      paperKey.fill(0);
      setBusy(false);
    }
  }

  async function onCopyPaperReveal() {
    if (!paperReveal) return;
    try {
      await navigator.clipboard.writeText(paperReveal);
      setMessage("Paper backup copied. Keep it offline.");
    } catch {
      setMessage("Copy failed. Select the string and copy it yourself.");
    }
  }

  async function onSignOut() {
    setBusy(true);
    setMessage(null);
    try {
      await fetch("/api/identity/logout", { method: "POST" });
      setSession(null);
      setMeshLine(null);
      setMeshKind(null);
      setUnlocked(false);
      setWrapWithPaper(false);
      setPaperPaste("");
      setPaperReveal(null);
      setEnsClaim(null);
      setEnsCachedFor(null);
      setIndicators(emptyIndicators());
      setIndicatorsCachedFor(null);
      disconnect();
      // Device mesh key stays in IndexedDB. Do not delete it on sign-out.
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-out failed.");
    } finally {
      setBusy(false);
    }
  }

  const showWrap =
    Boolean(session) && meshKind === "plaintext" && prfAvailable !== false;
  const showPrfMissing =
    Boolean(session) && meshKind === "plaintext" && prfAvailable === false;
  const showUnlock = Boolean(session) && meshKind === "wrapped" && !unlocked;
  const showPaperUnlock = Boolean(session) && meshKind === "wrapped" && !unlocked;
  const showExportPaper =
    Boolean(session) && meshKind === "wrapped" && prfAvailable !== false;

  return (
    <div className="mt-10 rounded-xl border border-brand-100 bg-brand-50/40 p-5">
      <h2 className="text-sm font-semibold text-brand-900">Session</h2>
      <p className="mt-2 text-sm text-gray-600">
        Sign in with Ethereum binds this browser to a checksummed address
        (EOA or ERC-1271 smart account). ENS, Farcaster, Lens, and RSS3 are
        held claims after sign-in, not the session key. A passkey can wrap
        the local mesh key on this device. A paper backup is recovery, not
        login.
        {wcConfigured
          ? " WalletConnect is a wallet connector (QR / mobile), not a separate identity provider."
          : ""}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {session ? (
          <>
            <p className="text-sm font-medium text-brand-900">
              {truncateAddress(session.address)}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSignOut()}
              className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Sign out
            </button>
            {showWrap ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onWrapWithPasskey()}
                className="rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
              >
                Wrap with passkey
              </button>
            ) : null}
            {showUnlock ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onUnlockMeshKey()}
                className="rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
              >
                Unlock mesh key
              </button>
            ) : null}
            {showExportPaper ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onExportPaperBackup()}
                className="rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
              >
                Export paper backup
              </button>
            ) : null}
          </>
        ) : (
          <>
            {!isConnected ? (
              <>
                <button
                  type="button"
                  disabled={connecting || busy}
                  onClick={() => void onConnect()}
                  className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Connect wallet
                </button>
                {wcConfigured ? (
                  <button
                    type="button"
                    disabled={connecting || busy}
                    onClick={() => void onWalletConnect()}
                    className="rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
                  >
                    WalletConnect
                  </button>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-gray-500">
                Wallet {truncateAddress(address ?? "")} · not signed in
              </p>
            )}
            <button
              type="button"
              disabled={busy || !isConnected}
              onClick={() => void onSignIn()}
              className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Sign in with Ethereum
            </button>
          </>
        )}
      </div>
      {showWrap ? (
        <label className="mt-3 flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={wrapWithPaper}
            disabled={busy}
            onChange={(event) => setWrapWithPaper(event.target.checked)}
          />
          also show a paper backup
        </label>
      ) : null}
      {showPaperUnlock ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={paperPaste}
            onChange={(event) => setPaperPaste(event.target.value)}
            placeholder="s3rch-wrap-v1:…"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className="min-w-[16rem] flex-1 rounded-lg border border-brand-100 bg-white px-3 py-2 font-mono text-xs text-gray-700 disabled:opacity-50"
          />
          <button
            type="button"
            disabled={busy || !paperPaste.trim()}
            onClick={() => void onUnlockWithPaper()}
            className="rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
          >
            Unlock with paper
          </button>
        </div>
      ) : null}
      {paperReveal ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            readOnly
            value={paperReveal}
            className="min-w-[16rem] flex-1 rounded-lg border border-brand-100 bg-white px-3 py-2 font-mono text-xs text-gray-700"
          />
          <button
            type="button"
            onClick={() => void onCopyPaperReveal()}
            className="rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800"
          >
            Copy
          </button>
          <p className="basis-full text-xs text-gray-500">
            Keep this. It will not be shown again.
          </p>
        </div>
      ) : null}
      {meshLine ? <p className="mt-3 text-xs text-gray-500">{meshLine}</p> : null}
      {ensClaimLine(ensClaim) ? (
        <p className="mt-3 text-xs text-gray-500">{ensClaimLine(ensClaim)}</p>
      ) : null}
      {farcasterClaimLine(indicators.farcaster.name) ? (
        <p className="mt-3 text-xs text-gray-500">
          {farcasterClaimLine(indicators.farcaster.name)}
        </p>
      ) : null}
      {lensClaimLine(indicators.lens.name) ? (
        <p className="mt-3 text-xs text-gray-500">{lensClaimLine(indicators.lens.name)}</p>
      ) : null}
      {rss3ClaimLine(indicators.rss3.name) ? (
        <p className="mt-3 text-xs text-gray-500">{rss3ClaimLine(indicators.rss3.name)}</p>
      ) : null}
      {showPrfMissing ? (
        <p className="mt-3 text-xs text-gray-500">{PRF_UNAVAILABLE_MESSAGE}</p>
      ) : null}
      {message ? <p className="mt-3 text-xs text-gray-500">{message}</p> : null}
    </div>
  );
}

async function walletSecondaryForWrap(input: {
  address: string;
  signMessage: (message: string) => Promise<string>;
}): Promise<{
  secondaryKey: Uint8Array;
  secondarySalt: Uint8Array;
  secondaryKind: "wallet";
}> {
  const secondarySalt = crypto.getRandomValues(new Uint8Array(32));
  const statement = buildSecondaryWrapStatement({
    domain: window.location.host,
    uri: window.location.origin,
    address: input.address,
    secondarySalt,
  });
  const secondarySignature = await input.signMessage(statement);
  return {
    secondaryKey: secondaryIkmFromWalletSignature(secondarySignature),
    secondarySalt,
    secondaryKind: "wallet",
  };
}

function applyMeshRecord(
  record: MeshKeyRecord | null,
  setMeshKind: (kind: "plaintext" | "wrapped" | null) => void,
  setMeshLine: (line: string | null) => void,
  createdLine?: string,
) {
  if (!record) {
    setMeshKind(null);
    return;
  }
  if (isWrappedMeshKeyRecord(record)) {
    setMeshKind("wrapped");
    setMeshLine(createdLine ?? "mesh key wrapped");
    return;
  }
  setMeshKind("plaintext");
  setMeshLine(createdLine ?? "mesh key already present");
}

async function fetchEnsHeldClaim(address: string): Promise<EnsHeldClaim> {
  const response = await fetch(
    `/api/identity/ens?address=${encodeURIComponent(address)}`,
    { cache: "no-store" },
  );
  if (!response.ok) return { name: null };
  const body = (await response.json()) as { name?: string | null };
  if (typeof body.name === "string" && body.name) {
    return { name: body.name };
  }
  return { name: null };
}

async function fetchPublicIndicators(address: string): Promise<PublicIndicators> {
  const response = await fetch(
    `/api/identity/indicators?address=${encodeURIComponent(address)}`,
    { cache: "no-store" },
  );
  if (!response.ok) return emptyIndicators();
  const body = (await response.json()) as Partial<PublicIndicators> | null;
  return {
    farcaster: { name: claimName(body?.farcaster?.name) },
    lens: { name: claimName(body?.lens?.name) },
    rss3: { name: claimName(body?.rss3?.name) },
  };
}

function claimName(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function truncateAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function hasInjectedProvider(): boolean {
  const ethereum = (globalThis as { ethereum?: unknown }).ethereum;
  return Boolean(ethereum);
}

async function readInjectedChainId(): Promise<number | null> {
  const ethereum = (
    globalThis as {
      ethereum?: { request?: (args: { method: string }) => Promise<string> };
    }
  ).ethereum;
  if (!ethereum?.request) return null;
  try {
    return Number(await ethereum.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}
