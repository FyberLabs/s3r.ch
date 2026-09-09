/**
 * Farcaster outbound via hub submitMessage (signed CastAdd).
 * Inbound hub pull is lib/farcaster.ts — this does not seed or ingest.
 *
 * Server-only env (never NEXT_PUBLIC):
 *   FARCASTER_FID            protocol FID (positive integer)
 *   FARCASTER_SIGNER_KEY     32-byte ed25519 signer hex
 *   FARCASTER_HUB_BASE       writable hub (default same as inbound)
 *   FARCASTER_HUB_AUTH       optional HTTP Basic user:pass
 *
 * Missing creds fail closed. Share-into-mesh does not call this.
 */

import "./faker-v7-compat";
import {
  CastType,
  FarcasterNetwork,
  Message,
  NobleEd25519Signer,
  makeCastAdd,
} from "@farcaster/core";
import { hexToBytes } from "viem";
import type { OutboundAdapter, OutboundDraft, OutboundResult } from "./bridges";
import { FARCASTER_HUB_BASE, castPermalink } from "./farcaster";
import { PUBLIC_FETCH_MS, PUBLIC_USER_AGENT } from "./public-fetch";
import { asString, isRecord } from "./rss3";

export const FARCASTER_OUTBOUND_NETWORK = "Farcaster";
export const FARCASTER_CAST_MAX = 320;

export const FARCASTER_NOT_CONFIGURED =
  "Farcaster hub is not configured.";
export const FARCASTER_TOO_LONG = "Post is too long for Farcaster.";
export const FARCASTER_EMPTY = "Write something first.";

export type FarcasterOutboundConfig = {
  hubBase: string;
  fid: number;
  signerKey: Uint8Array;
  hubAuth: string | null;
};

export type EncodeCastInput = {
  text: string;
  embeds: { url: string }[];
  fid: number;
  signerKey: Uint8Array;
};

export type OutboundEnv = Record<string, string | undefined>;

export type FarcasterOutboundOptions = {
  env?: OutboundEnv;
  fetch?: typeof fetch;
  encodeCast?: (input: EncodeCastInput) => Promise<Uint8Array>;
};

export function readFarcasterOutboundConfig(
  env: OutboundEnv = process.env,
): FarcasterOutboundConfig | null {
  if (env.NEXT_PUBLIC_FARCASTER_SIGNER_KEY || env.NEXT_PUBLIC_FARCASTER_FID) {
    return null;
  }
  const fid = Number.parseInt(env.FARCASTER_FID ?? "", 10);
  if (!Number.isInteger(fid) || fid <= 0) return null;
  const signerKey = parseSignerKey(env.FARCASTER_SIGNER_KEY);
  if (!signerKey) return null;
  const hubBase = (env.FARCASTER_HUB_BASE ?? FARCASTER_HUB_BASE).replace(
    /\/+$/,
    "",
  );
  if (!hubBase) return null;
  const hubAuth = env.FARCASTER_HUB_AUTH?.trim() || null;
  return { hubBase, fid, signerKey, hubAuth };
}

export function parseSignerKey(raw: string | undefined): Uint8Array | null {
  const value = raw?.trim() ?? "";
  if (!value || value.length > 130) return null;
  try {
    const bytes = hexToBytes(value.startsWith("0x") ? (value as `0x${string}`) : `0x${value}`);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export async function encodeCastAdd(input: EncodeCastInput): Promise<Uint8Array> {
  const signer = new NobleEd25519Signer(input.signerKey);
  const result = await makeCastAdd(
    {
      text: input.text,
      embeds: input.embeds,
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
      type: CastType.CAST,
    },
    { fid: input.fid, network: FarcasterNetwork.MAINNET },
    signer,
  );
  if (result.isErr()) {
    throw new Error(result.error.message);
  }
  return Message.encode(result.value).finish();
}

export function farcasterResultUrl(body: unknown, username: string | null): string {
  if (!isRecord(body)) return "";
  const hash = asString(body.hash);
  if (!hash) return "";
  return castPermalink(username, hash);
}

export class FarcasterOutbound implements OutboundAdapter {
  readonly network = FARCASTER_OUTBOUND_NETWORK;
  private readonly env: OutboundEnv;
  private readonly fetchFn: typeof fetch;
  private readonly encodeCast: (input: EncodeCastInput) => Promise<Uint8Array>;

  constructor(options: FarcasterOutboundOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetch ?? fetch;
    this.encodeCast = options.encodeCast ?? encodeCastAdd;
  }

  get enabled(): boolean {
    return readFarcasterOutboundConfig(this.env) !== null;
  }

  async post(draft: OutboundDraft): Promise<OutboundResult> {
    const text = draft.body.trim();
    if (!text) {
      return fail(FARCASTER_EMPTY);
    }
    if (new TextEncoder().encode(text).length > FARCASTER_CAST_MAX) {
      return fail(FARCASTER_TOO_LONG);
    }

    const config = readFarcasterOutboundConfig(this.env);
    if (!config) {
      return fail(FARCASTER_NOT_CONFIGURED);
    }

    const embeds: { url: string }[] = [];
    const permalink = draft.permalink?.trim();
    if (permalink && /^https?:\/\//i.test(permalink)) {
      embeds.push({ url: permalink });
    }

    let payload: Uint8Array;
    try {
      payload = await this.encodeCast({
        text,
        embeds,
        fid: config.fid,
        signerKey: config.signerKey,
      });
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "Could not sign the cast.",
      );
    }

    const url = `${config.hubBase}/v1/submitMessage`;
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "user-agent": PUBLIC_USER_AGENT,
    };
    if (config.hubAuth) {
      headers.authorization = `Basic ${Buffer.from(config.hubAuth).toString("base64")}`;
    }

    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: Buffer.from(payload),
        signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
        cache: "no-store",
      });
      const body: unknown = await readJson(response);
      if (!response.ok) {
        return fail(hubError(body, response.status));
      }
      const posted = farcasterResultUrl(body, null);
      if (!posted) {
        return fail("Farcaster hub did not return a cast hash.");
      }
      return { ok: true, network: this.network, url: posted };
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "Farcaster hub request failed.",
      );
    }
  }
}

function fail(reason: string): OutboundResult {
  return { ok: false, network: FARCASTER_OUTBOUND_NETWORK, reason };
}

function hubError(body: unknown, status: number): string {
  if (isRecord(body)) {
    const details =
      asString(body.details) ?? asString(body.message) ?? asString(body.errCode);
    if (details) return details;
  }
  return `Farcaster hub HTTP ${status}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 180) };
  }
}
