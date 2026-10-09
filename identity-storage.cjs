// Production identities must live on an explicitly mounted volume.
const fs = require("node:fs");
const path = require("node:path");
const { parseLinkFile } = require("./identity-link-schema.cjs");

function identityLinkPath(env = process.env, cwd = process.cwd()) {
  if (env.NODE_ENV !== "production") {
    return env.S3RCH_IDENTITY_LINKS || path.join(cwd, "data", "identity-links.json");
  }
  const root = env.S3RCH_IDENTITY_STORAGE_ROOT;
  const file = env.S3RCH_IDENTITY_LINKS;
  if (!root || !file || !path.isAbsolute(root) || !path.isAbsolute(file)) {
    throw new Error("s3r.ch: configure S3RCH_IDENTITY_STORAGE_ROOT and S3RCH_IDENTITY_LINKS on a durable mounted volume");
  }
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || path.resolve(root) === "/") {
    throw new Error("s3r.ch: identity links must be a file inside the durable storage root");
  }
  return path.resolve(file);
}

function mountedRoot(root, mountInfo) {
  // Linux mountinfo escapes whitespace in mount points with octal sequences.
  return mountInfo.split("\n").some((line) => {
    const [fields, filesystem] = line.split(" - ");
    if (!fields || !filesystem) return false;
    const mountPoint = fields.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, value) => String.fromCharCode(parseInt(value, 8)));
    const type = filesystem.split(" ")[0];
    return mountPoint === path.resolve(root) && !["overlay", "tmpfs", "ramfs"].includes(type);
  });
}

function assertIdentityStorage(env = process.env) {
  const file = identityLinkPath(env);
  if (env.NODE_ENV !== "production") return;
  const root = fs.realpathSync(env.S3RCH_IDENTITY_STORAGE_ROOT);
  if (!mountedRoot(root, fs.readFileSync("/proc/self/mountinfo", "utf8"))) {
    throw new Error("s3r.ch: identity storage root is not a durable mount; refusing to start");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const parent = fs.realpathSync(path.dirname(file));
  const relative = path.relative(root, parent);
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("s3r.ch: identity storage parent escapes the mounted root");
  }
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error("s3r.ch: identity store must not be a symlink");
  }
  fs.accessSync(parent, fs.constants.R_OK | fs.constants.W_OK);
  if (!fs.existsSync(file)) {
    throw new Error("s3r.ch: migrate or explicitly initialize the durable identity store before starting");
  }
  if (fs.existsSync(file)) {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    const contents = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parseLinkFile(contents).ok) {
      throw new Error("s3r.ch: identity store is invalid; refusing to start");
    }
  }
}

module.exports = { identityLinkPath, mountedRoot, assertIdentityStorage };
