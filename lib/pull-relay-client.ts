"use client";

import { useEffect, useState } from "react";
import type { SourcePull } from "./feed-types";
import {
  PULL_RELAY_EXTENSION_COPY,
  PULL_RELAY_LOCAL_COPY,
  PULL_RELAY_LOCAL_ORIGIN,
  PULL_RELAY_LOCAL_PATH,
  canUsePullRelay,
  materializePullRelayResult,
  parsePullRelayMessage,
  pullRelayHello,
  pullRelayPull,
  type PullRelayVia,
} from "./pull-relay";

const HELLO_MS = 400;
const PULL_MS = 15_000;

export function usePullRelay(): { via: PullRelayVia | null } {
  const [via, setVia] = useState<PullRelayVia | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const parsed = parsePullRelayMessage(event.data);
      if (parsed.kind !== "ready") return;
      if (!cancelled) setVia(parsed.message.via);
    }

    window.addEventListener("message", onMessage);
    window.postMessage(pullRelayHello(), window.location.origin);

    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
    }, HELLO_MS);

    if (canProbeLocalRelay()) {
      void fetch(`${PULL_RELAY_LOCAL_ORIGIN}${PULL_RELAY_LOCAL_PATH}/hello`, {
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(HELLO_MS)]),
      })
        .then(async (response) => {
          if (!response.ok) return;
          const parsed = parsePullRelayMessage(await response.json());
          if (parsed.kind !== "ready") return;
          if (!cancelled) {
            setVia((current) => current ?? parsed.message.via);
          }
        })
        .catch(() => {
          /* no local relay */
        });
    }

    return () => {
      cancelled = true;
      ac.abort();
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  return { via };
}

export async function requestPullRelay(
  body: unknown,
  via: PullRelayVia,
): Promise<SourcePull> {
  if (!canUsePullRelay(body)) {
    throw new Error("That host is not allowed.");
  }
  if (via === "extension") {
    return requestExtension(body);
  }
  return requestLocalRelay(body);
}

function canProbeLocalRelay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.protocol !== "http:") return false;
  const host = window.location.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

async function requestExtension(body: unknown): Promise<SourcePull> {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `pull-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Extension did not answer."));
    }, PULL_MS);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const parsed = parsePullRelayMessage(event.data);
      if (parsed.kind === "invalid") return;
      if (parsed.kind === "denied" && parsed.message.id === id) {
        cleanup();
        reject(new Error(parsed.message.error));
        return;
      }
      if (parsed.kind === "result" && parsed.message.id === id) {
        cleanup();
        resolve(materializePullRelayResult(body, parsed.message));
      }
    }

    function cleanup() {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    window.addEventListener("message", onMessage);
    window.postMessage(pullRelayPull(id, body), window.location.origin);
  });
}

async function requestLocalRelay(body: unknown): Promise<SourcePull> {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `pull-${Date.now()}`;
  const response = await fetch(`${PULL_RELAY_LOCAL_ORIGIN}${PULL_RELAY_LOCAL_PATH}/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pullRelayPull(id, body)),
    signal: AbortSignal.timeout(PULL_MS),
  });
  const payload: unknown = await response.json();
  const parsed = parsePullRelayMessage(payload);
  if (parsed.kind === "denied") {
    throw new Error(parsed.message.error);
  }
  if (parsed.kind !== "result") {
    throw new Error("Relay did not answer.");
  }
  return materializePullRelayResult(body, parsed.message);
}

export function pullRelayStatusCopy(via: PullRelayVia | null): string | null {
  if (via === "extension") return PULL_RELAY_EXTENSION_COPY;
  if (via === "localhost") return PULL_RELAY_LOCAL_COPY;
  return null;
}

