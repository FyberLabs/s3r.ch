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

export function registryRepo(image) {
  const name = String(image ?? "").trim();
  if (!/^ghcr\.io\/[a-z0-9._/-]+$/.test(name)) {
    throw new Error(`unexpected image name ${image}`);
  }
  return name.slice("ghcr.io/".length);
}

async function anonymousToken(repo) {
  const url = new URL("https://ghcr.io/token");
  url.searchParams.set("service", "ghcr.io");
  url.searchParams.set("scope", `repository:${repo}:pull`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GHCR token request failed (${response.status})`);
  }
  const body = await response.json();
  if (!body.token) throw new Error("GHCR token response had no token");
  return body.token;
}

async function readManifest(repo, reference, token) {
  const response = await fetch(`https://ghcr.io/v2/${repo}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GHCR manifest ${reference} returned ${response.status}`);
  }
  return response.json();
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

/** @returns {Promise<string | null>} */
export async function fetchTagVersion(image, tag) {
  const repo = registryRepo(image);
  const token = await anonymousToken(repo);
  let manifest = await readManifest(repo, tag, token);
  if (!manifest) return null;
  const nested = platformManifestDigest(manifest);
  if (nested) {
    manifest = await readManifest(repo, nested, token);
    if (!manifest) throw new Error(`GHCR manifest ${nested} is missing`);
  }
  const digest = manifest.config?.digest;
  if (!digest) throw new Error(`GHCR tag ${tag} has no config digest`);
  const version = versionFromImageConfig(await readConfig(repo, digest, token));
  if (!version) {
    throw new Error(`${image}:${tag} has no X.Y.Z org.opencontainers.image.version label`);
  }
  return version;
}
