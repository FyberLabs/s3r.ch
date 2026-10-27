/**
 * Read org.opencontainers.image.version for a GHCR tag.
 * Missing tag returns null. A private package or a tag without that label throws.
 */

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function versionFromImageConfig(config) {
  const labels = config?.config?.Labels ?? config?.Labels ?? {};
  const version = String(labels["org.opencontainers.image.version"] ?? "").trim();
  return SEMVER.test(version) ? version : null;
}

export function platformManifestDigest(manifest) {
  if (manifest?.config?.digest) return null;
  const list = manifest?.manifests;
  if (!Array.isArray(list)) {
    throw new Error("unrecognized image manifest");
  }
  const hit = list.find(
    (item) => item.platform?.os === "linux" && item.platform?.architecture === "amd64",
  );
  if (!hit?.digest) throw new Error("linux/amd64 manifest is missing");
  return hit.digest;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function registryRepo(image) {
  const name = String(image ?? "").trim();
  if (!/^ghcr\.io\/[a-z0-9._/-]+$/.test(name)) {
    throw new Error(`unexpected image name ${image}`);
  }
  return name.slice("ghcr.io/".length);
}

export function imageForRepository(repository) {
  const name = String(repository ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name)) return null;
  return `ghcr.io/${name}`;
}

export async function registryToken(repo, githubToken, actor) {
  const url = new URL("https://ghcr.io/token");
  url.searchParams.set("service", "ghcr.io");
  url.searchParams.set("scope", `repository:${repo}:pull`);
  const headers = {};
  if (githubToken) {
    const user = actor || "github";
    headers.Authorization = `Basic ${Buffer.from(`${user}:${githubToken}`).toString("base64")}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GHCR token request failed (${response.status})`);
  }
  const body = await response.json();
  if (!body.token) throw new Error("GHCR token response had no token");
  return body.token;
}

async function fetchManifest(repo, reference, token) {
  const response = await fetch(`https://ghcr.io/v2/${repo}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
  });
  const digest = String(response.headers.get("docker-content-digest") ?? "").trim();
  if (response.status === 404) return { status: 404, digest: "", body: null };
  if (!response.ok) return { status: response.status, digest, body: null };
  return { status: response.status, digest, body: await response.json() };
}

async function readConfig(repo, digest, token) {
  const response = await fetch(`https://ghcr.io/v2/${repo}/blobs/${digest}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`GHCR config blob returned ${response.status}`);
  }
  return response.json();
}

/**
 * Read the tag's manifest digest and version label.
 * A missing tag returns null. A private package, a missing digest, or a tag
 * without an X.Y.Z version label throws so the caller does not overwrite it.
 * Pass githubToken so a private tag is visible to this job.
 * @returns {Promise<{ digest: string, versionLabel: string } | null>}
 */
export async function fetchTagRelease(image, tag, options = {}) {
  const repo = registryRepo(image);
  const token = await registryToken(repo, options.githubToken, options.actor);
  const first = await fetchManifest(repo, tag, token);
  if (first.status === 404) return null;
  if (first.status !== 200) {
    throw new Error(`GHCR manifest ${tag} returned ${first.status}`);
  }
  if (!DIGEST.test(first.digest)) {
    throw new Error(`GHCR tag ${tag} did not return a sha256 digest`);
  }
  let manifest = first.body;
  const nested = platformManifestDigest(manifest);
  if (nested) {
    const child = await fetchManifest(repo, nested, token);
    if (child.status !== 200) throw new Error(`GHCR manifest ${nested} returned ${child.status}`);
    manifest = child.body;
  }
  const configDigest = manifest?.config?.digest;
  if (!configDigest) throw new Error(`GHCR tag ${tag} has no config digest`);
  const versionLabel = versionFromImageConfig(await readConfig(repo, configDigest, token));
  if (!versionLabel) {
    throw new Error(`${image}:${tag} has no X.Y.Z org.opencontainers.image.version label`);
  }
  return { digest: first.digest, versionLabel };
}

/** @returns {Promise<string | null>} */
export async function fetchTagVersion(image, tag) {
  const found = await fetchTagRelease(image, tag);
  return found?.versionLabel ?? null;
}
