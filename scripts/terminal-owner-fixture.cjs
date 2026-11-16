require("node:diagnostics_channel").channel("s3rch.terminal.initialization").subscribe(({ error }) => {
  console.error("CI terminal initialization:", error);
});
// CI child process only. No real Auth, replay, storage or telemetry endpoints.
const { createHmac, randomUUID } = require("node:crypto");
const raw = process.env.S3RCH_NIGHTLY_RUN_CONFIG;
let config; try { config = JSON.parse(raw); } catch {}
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target === "https://api.test.hyperme.sh/auth/nightly-run/v1/command" && config) {
    const body = String(init.body), command = JSON.parse(body), headers = new Headers(init.headers);
    if (headers.get("X-Nightly-Owner-Signature") !== createHmac("sha256", Buffer.from(config.ownerKey, "hex")).update(body).digest("hex")) throw Error("Invalid owner signature");
    const suite = command.action === "admit" ? command.grant === "c".repeat(64) ? "flags-s3rch-browser" : command.grant === "f".repeat(64) ? "s3rch-device-transfer" : null : command.run?.endsWith("-s3rch-device-transfer") ? "s3rch-device-transfer" : "flags-s3rch-browser";
    if (!suite) return new Response(null, { status: 403 });
    await new Promise(resolve => setTimeout(resolve, suite === "flags-s3rch-browser" ? 8 : 2));
    const base = { version: 1, owner: "s3rch", run: "1-1-" + suite, generation: (suite === "flags-s3rch-browser" ? "e" : "d").repeat(64) };
    if (command.action === "admit") return Response.json({ ...base, scope: config.scopes[suite], operation: randomUUID() });
    if (command.action === "complete") return Response.json({ ...base, operation: command.operation, completed: true });
    return Response.json({ ...base, active: true });
  }
  if (target.startsWith("https://api.test.hyperme.sh/storage/replays/")) return new Response(null, { status: 204 });
  throw Error("Unexpected external request in terminal CI fixture: " + target);
};
