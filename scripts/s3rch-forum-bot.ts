/** Opt-in client worker; never started by the web server or a package install. */
import { openForumBotRuntime } from "../lib/forum-bot-runtime";
import { readPrivateBotFile } from "../lib/forum-bot-local-access";
// Third-party transport diagnostics must not corrupt private artifact stdout or
// echo untrusted records. This is a dedicated process, never the web server.
console.log = console.info = console.debug = console.warn = console.error = () => {};
const [config, mode, proofFile] = process.argv.slice(2);
if (!config || (mode !== undefined && mode !== "artifact") || (mode === "artifact" && !proofFile)) {
  process.stderr.write("Usage: tsx scripts/s3rch-forum-bot.ts PRIVATE_CONFIG [artifact PRIVATE_SIGNED_REQUEST]\n"); process.exit(2);
}
async function main() {
  const runtime = await openForumBotRuntime(config, mode === "artifact");
  try {
    if (mode === "artifact") {
      const result = await runtime.readArtifact(JSON.parse(readPrivateBotFile(proofFile!, 16384).toString("utf8")));
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(result.bytes, error => error ? reject(error) : resolve());
      });
      return;
    }
    if (!("tick" in runtime) || typeof runtime.tick !== "function") throw Error("Worker unavailable");
    let stopped = false; const stop = () => { stopped = true; };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    while (!stopped) {
      try { await runtime.tick(); } catch { process.stderr.write("Forum worker unavailable; task leases remain bounded.\n"); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally { await runtime.close(); }
}
main().then(() => process.exit(0)).catch(() => { process.stderr.write("Forum bot refused: configuration, identity or current authority unavailable.\n"); process.exit(1); });
