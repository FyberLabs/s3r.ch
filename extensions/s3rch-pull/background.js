/**
 * Allowlisted fetch only. Keep hosts in sync with lib/pull-relay.ts.
 * Redirects that leave the allowlist are dropped. Not a general proxy.
 */
const CHANNEL = "s3rch-pull";
const V = 1;
const ALLOWED_HOSTS = new Set([
  "hub.pinata.cloud",
  "public.api.bsky.app",
  "blog.ethereum.org",
  "github.com",
  "w3c.social",
  "fosstodon.org",
  "nos.lol",
  "gi.rss3.io",
]);
const FARCASTER_HUB = "https://hub.pinata.cloud";
const ATPROTO = "https://public.api.bsky.app";
const NOSTR = "wss://nos.lol";
const GI = "https://gi.rss3.io";
const ACTIVITY_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json';
const RSS_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml, text/xml, */*";
const ACTORS = [
  "https://w3c.social/users/w3c",
  "https://fosstodon.org/users/Fosstodon",
];
const NOSTR_PUBKEYS = [
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2",
];

function allowedUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!ALLOWED_HOSTS.has(host)) return false;
  if (url.port) {
    const https = url.protocol === "https:" || url.protocol === "wss:";
    if (https && url.port !== "443") return false;
    if (!https && url.port !== "80") return false;
  }
  return true;
}

function denied(error, id) {
  return { channel: CHANNEL, type: "denied", v: V, ...(id ? { id } : {}), error };
}

function result(id, fetches) {
  return { channel: CHANNEL, type: "result", v: V, id, fetches };
}

async function fetchAllowed(url, accept) {
  if (!allowedUrl(url)) return { url, status: 0, body: "" };
  try {
    const response = await fetch(url, {
      headers: { accept: accept || "application/json" },
      redirect: "follow",
      cache: "no-store",
    });
    const finalUrl = response.url || url;
    if (!allowedUrl(finalUrl)) return { url: finalUrl, status: 0, body: "" };
    return { url: finalUrl, status: response.status, body: await response.text() };
  } catch {
    return { url, status: 502, body: "" };
  }
}

function hrefOf(value, base) {
  if (typeof value === "string" && value.trim()) {
    try {
      return new URL(value, base).toString();
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = hrefOf(entry, base);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    return hrefOf(value.href || value.id || value.url, base);
  }
  return null;
}

function seedUrls(body) {
  if (body.rssUrl) return [String(body.rssUrl).trim()];
  if (body.rss3Account) {
    return [`${GI}/decentralized/${encodeURIComponent(String(body.rss3Account).trim())}`];
  }
  switch (body.allowedSource) {
    case "farcaster":
      return [1, 2, 3].map(
        (fid) => `${FARCASTER_HUB}/v1/castsByFid?fid=${fid}&pageSize=20&reverse=true`,
      );
    case "atproto":
      return [
        `${ATPROTO}/xrpc/app.bsky.feed.getAuthorFeed?actor=ethereum.bsky.social&limit=20`,
        `${ATPROTO}/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent("at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot")}&limit=20`,
      ];
    case "rss":
      return [
        "https://blog.ethereum.org/en/feed.xml",
        "https://github.com/farcasterxyz/protocol/commits/main.atom",
      ];
    case "activitypub":
      return ACTORS;
    case "nostr":
      return [NOSTR];
    case "rss3-gi":
      return [
        ["/decentralized/network/ethereum", "social"],
        ["/decentralized/network/ethereum", "transaction"],
        ["/decentralized/network/base", "transaction"],
        ["/decentralized/network/farcaster", "social"],
        ["/decentralized/platform/Farcaster", "social"],
        ["/decentralized/platform/Lens", "social"],
      ].map(([path, tag]) => {
        const url = new URL(path, GI);
        url.searchParams.set("limit", "50");
        url.searchParams.set("action_limit", "10");
        url.searchParams.set("tag", tag);
        return url.toString();
      });
    default:
      return null;
  }
}

async function pullNostr() {
  const events = [];
  let ok = 0;
  for (const pubkey of NOSTR_PUBKEYS) {
    try {
      const got = await queryNostr(pubkey);
      events.push(...got);
      ok += 1;
    } catch {
      /* empty */
    }
  }
  return [{ url: NOSTR, status: ok > 0 ? 200 : 502, body: JSON.stringify(events) }];
}

function queryNostr(pubkey) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(NOSTR);
    const sub = `s3rch-${Math.random().toString(16).slice(2, 10)}`;
    const events = [];
    let settled = false;
    const timer = setTimeout(() => finish(events.length ? resolve : reject, events.length ? events : new Error("timeout")), 8000);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn(value);
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(["REQ", sub, { authors: [pubkey], kinds: [1], limit: 20 }]));
    });
    ws.addEventListener("message", (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT" && parsed[1] === sub && parsed[2]) events.push(parsed[2]);
      if (parsed[0] === "EOSE" && parsed[1] === sub) finish(resolve, events);
    });
    ws.addEventListener("error", () => finish(events.length ? resolve : reject, events.length ? events : new Error("ws")));
    ws.addEventListener("close", () => {
      if (!settled) finish(events.length ? resolve : reject, events.length ? events : new Error("closed"));
    });
  });
}

async function pullActivityPub() {
  const fetches = [];
  for (const actor of ACTORS) {
    const actorFetch = await fetchAllowed(actor, ACTIVITY_ACCEPT);
    fetches.push(actorFetch);
    if (actorFetch.status < 200 || actorFetch.status >= 300) continue;
    let json;
    try {
      json = JSON.parse(actorFetch.body);
    } catch {
      continue;
    }
    const outbox = hrefOf(json && json.outbox, actorFetch.url);
    if (!outbox || !allowedUrl(outbox)) continue;
    const outboxFetch = await fetchAllowed(outbox, ACTIVITY_ACCEPT);
    fetches.push(outboxFetch);
    if (outboxFetch.status < 200 || outboxFetch.status >= 300) continue;
    let page;
    try {
      page = JSON.parse(outboxFetch.body);
    } catch {
      continue;
    }
    const embedded = (page && (page.orderedItems || page.items)) || [];
    if (Array.isArray(embedded) && embedded.length) continue;
    const first = hrefOf(page && page.first, outboxFetch.url);
    if (first && allowedUrl(first)) fetches.push(await fetchAllowed(first, ACTIVITY_ACCEPT));
  }
  return fetches;
}

async function handlePull(msg) {
  if (!msg || msg.channel !== CHANNEL || msg.v !== V || msg.type !== "pull") {
    return denied("Unknown protocol v.", msg && msg.id);
  }
  const body = msg.body && typeof msg.body === "object" ? msg.body : {};
  const selected = [Boolean(body.rssUrl), Boolean(body.rss3Account), Boolean(body.allowedSource)].filter(Boolean).length;
  if (selected !== 1) return denied("Send rssUrl, rss3Account, or allowedSource — not more than one.", msg.id);

  if (body.allowedSource === "nostr") {
    if (!allowedUrl(NOSTR)) return denied("That host is not allowed.", msg.id);
    return result(msg.id, await pullNostr());
  }
  if (body.allowedSource === "activitypub") {
    return result(msg.id, await pullActivityPub());
  }

  const urls = seedUrls(body);
  if (!urls) return denied("Unknown allowedSource.", msg.id);
  const accept =
    body.rssUrl || body.allowedSource === "rss" ? RSS_ACCEPT : "application/json";
  const fetches = [];
  for (const url of urls) {
    if (!allowedUrl(url)) return denied("That host is not allowed.", msg.id);
    fetches.push(await fetchAllowed(url, accept));
  }
  return result(msg.id, fetches);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handlePull(msg)
    .then(sendResponse)
    .catch((error) =>
      sendResponse(denied(error instanceof Error ? error.message : "Pull failed.", msg && msg.id)),
    );
  return true;
});
