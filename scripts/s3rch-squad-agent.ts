import { createSquadAgentMcp, openSquadAgentClient } from "../lib/squad-agent-client";
import { generateSquadAgentKey, openSquadAgentIdentity } from "../lib/squad-agent-identity";

async function main() {
  const [config, mode, operation, ...extra] = process.argv.slice(2);
  if (config && !operation && !extra.length && mode === "keygen") {
    process.stdout.write(await generateSquadAgentKey(config) + "\n");
    return;
  }
  if (config && !operation && !extra.length && mode === "session") {
    process.stdout.write(await openSquadAgentIdentity(config).session() + "\n");
    return;
  }
  if (!config || extra.length || (mode === "submit" ? !operation : mode !== "mcp" || !!operation)) {
    throw Error("Usage: s3rch-squad-agent CONFIG submit OPERATION_ID | CONFIG mcp | IDENTITY_CONFIG session | KEY_FILE keygen");
  }
  const client = openSquadAgentClient(config);
  if (mode === "submit") {
    process.stdout.write((await client.submit(operation)) + "\n");
    return;
  }
  const closed = new AbortController();
  const dispatch = createSquadAgentMcp((id, signal) =>
    client.submit(id, signal ? AbortSignal.any([signal, closed.signal]) : closed.signal));
  const pending = new Set<Promise<void>>();
  process.stdin.setEncoding("utf8");
  let line = "";
  for await (const chunk of process.stdin) {
    const frames = (line + String(chunk)).split("\n");
    line = frames.pop() ?? "";
    if (line.length > 8192) throw Error("MCP frame too large");
    for (const frame of frames) {
      if (frame.length > 8192 || pending.size >= 64) throw Error("MCP input exceeds limits");
      const operation = dispatch(frame).then(result => {
        if (result) process.stdout.write(JSON.stringify(result) + "\n");
      });
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
      // Drain completed calls while keeping live cancellations and pings responsive.
      await Promise.resolve();
    }
  }
  closed.abort();
  await Promise.all(pending);
}

void main().catch(() => {
  process.stderr.write("Squad agent request unavailable. Check configuration and Plane task status.\n");
  process.exitCode = 1;
});
