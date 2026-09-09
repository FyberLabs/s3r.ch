/**
 * ATProto / Bluesky outbound via createSession + createRecord.
 * Inbound AppView pull is lib/atproto.ts — this writes to a PDS.
 * public.api.bsky.app is read-only (405 on createRecord).
 *
 * Server-only env (never NEXT_PUBLIC):
 *   ATPROTO_IDENTIFIER     handle or DID
 *   ATPROTO_APP_PASSWORD   app password (not the account password)
 *   ATPROTO_PDS_BASE       writable PDS (default https://bsky.social)
 *
 * Missing creds fail closed. Share-into-mesh does not call this.
 * Session JWT is per-request and is never written to Gun.
 */

import type { OutboundAdapter, OutboundDraft, OutboundResult } from "./bridges";
import { atprotoPermalink } from "./atproto";
import { PUBLIC_FETCH_MS, PUBLIC_USER_AGENT } from "./public-fetch";
import { asString, isRecord } from "./rss3";

export const ATPROTO_OUTBOUND_NETWORK = "ATProto / Bluesky";
export const ATPROTO_POST_MAX = 300;
export const ATPROTO_PDS_DEFAULT = "https://bsky.social";

export const ATPROTO_NOT_CONFIGURED =
  "Bluesky app password is not configured.";
export const ATPROTO_TOO_LONG = "Post is too long for Bluesky.";
export const ATPROTO_EMPTY = "Write something first.";

export type AtprotoOutboundConfig = {
  pdsBase: string;
  identifier: string;
  appPassword: string;
};

export type AtprotoOutboundOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
};

export function readAtprotoOutboundConfig(
  env: Record<string, string | undefined> = process.env,
): AtprotoOutboundConfig | null {
  if (
    env.NEXT_PUBLIC_ATPROTO_APP_PASSWORD ||
    env.NEXT_PUBLIC_ATPROTO_IDENTIFIER
  ) {
    return null;
  }
  const identifier = env.ATPROTO_IDENTIFIER?.trim() ?? "";
  const appPassword = env.ATPROTO_APP_PASSWORD?.trim() ?? "";
  if (!identifier || !appPassword) return null;
  const pdsBase = (env.ATPROTO_PDS_BASE ?? ATPROTO_PDS_DEFAULT).replace(
    /\/+$/,
    "",
  );
  if (!pdsBase) return null;
  return { pdsBase, identifier, appPassword };
}

export function atprotoPostText(draft: OutboundDraft): string {
  const body = draft.body.trim();
  const permalink = draft.permalink?.trim() ?? "";
  if (!permalink || body.includes(permalink)) return body;
  if (!/^https?:\/\//i.test(permalink)) return body;
  const joined = `${body}\n\n${permalink}`;
  return graphemeLength(joined) <= ATPROTO_POST_MAX ? joined : body;
}

export class AtprotoOutbound implements OutboundAdapter {
  readonly network = ATPROTO_OUTBOUND_NETWORK;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchFn: typeof fetch;

  constructor(options: AtprotoOutboundOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetch ?? fetch;
  }

  get enabled(): boolean {
    return readAtprotoOutboundConfig(this.env) !== null;
  }

  async post(draft: OutboundDraft): Promise<OutboundResult> {
    const text = atprotoPostText(draft);
    if (!text) {
      return fail(ATPROTO_EMPTY);
    }
    if (graphemeLength(text) > ATPROTO_POST_MAX) {
      return fail(ATPROTO_TOO_LONG);
    }

    const config = readAtprotoOutboundConfig(this.env);
    if (!config) {
      return fail(ATPROTO_NOT_CONFIGURED);
    }

    try {
      const session = await createSession(this.fetchFn, config);
      if (!session.ok) return fail(session.reason);

      const created = await createRecord(this.fetchFn, config, session, text);
      if (!created.ok) return fail(created.reason);
      return { ok: true, network: this.network, url: created.url };
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "Bluesky PDS request failed.",
      );
    }
  }
}

type SessionOk = {
  ok: true;
  accessJwt: string;
  did: string;
  handle: string;
};

async function createSession(
  fetchFn: typeof fetch,
  config: AtprotoOutboundConfig,
): Promise<SessionOk | { ok: false; reason: string }> {
  const url = `${config.pdsBase}/xrpc/com.atproto.server.createSession`;
  const response = await fetchFn(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      identifier: config.identifier,
      password: config.appPassword,
    }),
    signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
    cache: "no-store",
  });
  const body: unknown = await readJson(response);
  if (!response.ok) {
    return { ok: false, reason: pdsError(body, response.status, "session") };
  }
  if (!isRecord(body)) {
    return { ok: false, reason: "Bluesky session payload was unexpected." };
  }
  const accessJwt = asString(body.accessJwt);
  const did = asString(body.did);
  const handle = asString(body.handle) ?? config.identifier;
  if (!accessJwt || !did) {
    return { ok: false, reason: "Bluesky session payload was unexpected." };
  }
  return { ok: true, accessJwt, did, handle };
}

async function createRecord(
  fetchFn: typeof fetch,
  config: AtprotoOutboundConfig,
  session: SessionOk,
  text: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const url = `${config.pdsBase}/xrpc/com.atproto.repo.createRecord`;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date().toISOString(),
      },
    }),
    signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
    cache: "no-store",
  });
  const body: unknown = await readJson(response);
  if (!response.ok) {
    return { ok: false, reason: pdsError(body, response.status, "record") };
  }
  const uri = isRecord(body) ? asString(body.uri) : null;
  if (!uri) {
    return { ok: false, reason: "Bluesky PDS did not return a post uri." };
  }
  const posted = atprotoPermalink(session.handle, uri);
  return { ok: true, url: posted || uri };
}

function fail(reason: string): OutboundResult {
  return { ok: false, network: ATPROTO_OUTBOUND_NETWORK, reason };
}

function jsonHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": PUBLIC_USER_AGENT,
  };
}

function pdsError(body: unknown, status: number, step: string): string {
  if (isRecord(body)) {
    const message = asString(body.message) ?? asString(body.error);
    if (message) return message;
  }
  return `Bluesky PDS ${step} HTTP ${status}`;
}

function graphemeLength(value: string): number {
  return [...value].length;
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
