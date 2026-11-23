// Bound only to the TEST hostname. The existing, more specific peer routes
// keep ownership of /gun, /api/seed and /feed-cache/snapshot.json.
export default {
  async fetch(request, env) {
    const { hostname, pathname, searchParams } = new URL(request.url);
    const fetchOrigin = () =>
      hostname === "test.s3r.ch" && env.WEB_ORIGIN
        ? env.WEB_ORIGIN.fetch(request)
        : fetch(request);
    const read = request.method === "GET" || request.method === "HEAD";
    if (!read || request.headers.has("upgrade") || pathname.startsWith("/api/") ||
        pathname.startsWith("/feed-cache/") || pathname === "/gun" || pathname.startsWith("/gun/")) {
      return fetchOrigin();
    }
    // Router requests depend on the client's current segment tree and build.
    if (request.headers.has("rsc") || request.headers.has("next-router-state-tree") ||
        searchParams.has("_rsc") || request.headers.get("accept")?.includes("text/x-component")) {
      return fetchOrigin();
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) return fetchOrigin();
    return asset;
  },
};
