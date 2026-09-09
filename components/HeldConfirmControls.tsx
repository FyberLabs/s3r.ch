"use client";

import { useState } from "react";
import { btnSecondary, field } from "@/lib/brand-ui";
import { FIXTURE_CONFIRM_CODE } from "@/lib/identity/config";
import type { HeldConfirmProof } from "@/lib/identity/confirm-proof";

type Props = {
  address: string;
  proofs: readonly HeldConfirmProof[];
  onHeld: (proof: HeldConfirmProof) => Promise<void>;
};

export function HeldConfirmControls({ address, proofs, onHeld }: Props) {
  const hasEmail = proofs.some((row) => row.kind === "email");
  const hasPhone = proofs.some((row) => row.kind === "phone");
  const hasKyc = proofs.some((row) => row.kind === "kyc");
  if (hasEmail && hasPhone && hasKyc) return null;

  return (
    <div className="mt-4 border-t border-rule pt-4">
      {!hasEmail ? (
        <ConfirmRow kind="email" address={address} onHeld={onHeld} />
      ) : null}
      {!hasPhone ? (
        <ConfirmRow kind="phone" address={address} onHeld={onHeld} />
      ) : null}
      {!hasKyc ? <KycRow address={address} onHeld={onHeld} /> : null}
    </div>
  );
}

function ConfirmRow({
  kind,
  address,
  onHeld,
}: {
  kind: "email" | "phone";
  address: string;
  onHeld: (proof: HeldConfirmProof) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<"fixture" | "sent" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onStart() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/identity/confirm/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, target }),
      });
      const body = (await response.json()) as {
        status?: string;
        error?: string;
      };
      if (response.status === 401) {
        setMessage("Sign in first.");
        return;
      }
      if (body.status === "not_configured") {
        setMessage("Not configured.");
        setPending(null);
        return;
      }
      if (!response.ok) {
        setMessage("Could not confirm.");
        return;
      }
      if (body.status === "fixture" || body.status === "sent") {
        setPending(body.status);
        return;
      }
      setMessage("Could not confirm.");
    } catch {
      setMessage("Could not confirm.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/identity/confirm/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, target, code }),
      });
      const body = (await response.json()) as {
        claimId?: string;
        kind?: "email" | "phone";
        method?: "fixture" | "otp";
        error?: string;
      };
      if (response.status === 401) {
        setMessage("Sign in first.");
        return;
      }
      if (!response.ok || !body.claimId || !body.kind) {
        setMessage("Could not confirm.");
        return;
      }
      await onHeld({
        address,
        claimId: body.claimId,
        kind: body.kind,
        method: body.method ?? "otp",
        confirmedAt: Math.floor(Date.now() / 1000),
        v: 1,
      });
      setPending(null);
      setCode("");
    } catch {
      setMessage("Could not confirm.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <input
        type={kind === "email" ? "email" : "tel"}
        value={target}
        onChange={(event) => setTarget(event.target.value)}
        placeholder={kind === "email" ? "Email" : "Phone"}
        autoComplete="off"
        spellCheck={false}
        disabled={busy || Boolean(pending)}
        className={`min-w-[12rem] flex-1 ${field}`}
      />
      {pending ? (
        <>
          <input
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={pending === "fixture" ? FIXTURE_CONFIRM_CODE : "Code"}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className={`w-24 ${field}`}
          />
          <button
            type="button"
            disabled={busy || !code.trim()}
            onClick={() => void onVerify()}
            className={btnSecondary}
          >
            Confirm
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy || !target.trim()}
          onClick={() => void onStart()}
          className={btnSecondary}
        >
          Confirm
        </button>
      )}
      {message ? <p className="basis-full text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}

function KycRow({
  address,
  onHeld,
}: {
  address: string;
  onHeld: (proof: HeldConfirmProof) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onHold() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/identity/kyc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuer: "fixture" }),
      });
      const body = (await response.json()) as {
        claimId?: string;
        status?: string;
        error?: string;
      };
      if (response.status === 401) {
        setMessage("Sign in first.");
        return;
      }
      if (body.status === "not_configured") {
        setMessage("Not configured.");
        return;
      }
      if (!response.ok || !body.claimId) {
        setMessage("Could not hold.");
        return;
      }
      await onHeld({
        address,
        claimId: body.claimId,
        kind: "kyc",
        method: "fixture",
        confirmedAt: Math.floor(Date.now() / 1000),
        v: 1,
      });
    } catch {
      setMessage("Could not hold.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void onHold()}
        className={btnSecondary}
      >
        Hold attestation
      </button>
      {message ? <p className="basis-full text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
