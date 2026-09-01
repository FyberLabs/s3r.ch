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
import { getMeshKey } from "@/lib/identity/idb";
import { ensureLocalMeshKey } from "@/lib/identity/mesh";
import { buildSiweMessage } from "@/lib/identity/siwe";

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
    if (!session || meshLine) return;
    void getMeshKey(session.address)
      .then((record) => {
        if (record) setMeshLine("mesh key already present");
      })
      .catch(() => {
        // Private mode / missing IndexedDB — stay quiet.
      });
  }, [session, meshLine]);

  const injected = connectors.find((connector) => connector.id === "injected") ?? connectors[0];

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

  async function onSignIn() {
    if (!address) {
      setMessage("Connect an injected wallet first.");
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
        setMeshLine(mesh.created ? "mesh key ready" : "mesh key already present");
      } catch {
        setMeshLine("mesh key failed");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    setBusy(true);
    setMessage(null);
    try {
      await fetch("/api/identity/logout", { method: "POST" });
      setSession(null);
      setMeshLine(null);
      disconnect();
      // Device mesh key stays in IndexedDB. Do not delete it on sign-out.
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-out failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-10 rounded-xl border border-brand-100 bg-brand-50/40 p-5">
      <h2 className="text-sm font-semibold text-brand-900">Session</h2>
      <p className="mt-2 text-sm text-gray-600">
        Sign in with Ethereum binds this browser to a checksummed address.
        ENS, email, Check, and passkeys are not this slice.
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
          </>
        ) : (
          <>
            {!isConnected ? (
              <button
                type="button"
                disabled={connecting || busy}
                onClick={() => void onConnect()}
                className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                Connect wallet
              </button>
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
      {meshLine ? <p className="mt-3 text-xs text-gray-500">{meshLine}</p> : null}
      {message ? <p className="mt-3 text-xs text-gray-500">{message}</p> : null}
    </div>
  );
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
