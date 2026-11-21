/** Opt-in client worker; never started by the web server or a package install. */
import { openForumBotRuntime } from "../lib/forum-bot-runtime";
import { readPrivateBotFile } from "../lib/forum-bot-local-access";
// Third-party transport diagnostics must not corrupt private artifact stdout or
// echo untrusted records. This is a dedicated process, never the web server.
console.log = console.info = console.debug = console.warn = console.error = () => {};
const [config, mode, arg1, arg2] = process.argv.slice(2);
const usage = "Usage: tsx scripts/s3rch-forum-bot.ts PRIVATE_CONFIG [artifact PRIVATE_SIGNED_REQUEST | update TASK_UUID MESSAGE]\n";
if (!config || (mode !== undefined && mode !== "artifact" && mode !== "update") ||
    (mode === "artifact" && !arg1) || (mode === "update" && (!arg1 || !arg2))) {
  process.stderr.write(usage); process.exit(2);
}
async function main() {
  const runtime = await openForumBotRuntime(config, mode === "artifact" ? "artifact" : "worker");
  try {
    if (mode === "update") {
      if (!("postTaskUpdate" in runtime)) throw Error("Worker unavailable");
      await runtime.postTaskUpdate(arg1!, arg2!);
      return;
    }
    if (mode === "artifact") {
      const result = await runtime.readArtifact(JSON.parse(readPrivateBotFile(arg1!, 16384).toString("utf8")));
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
