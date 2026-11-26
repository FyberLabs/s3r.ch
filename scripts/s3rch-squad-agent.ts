import { createSquadAgentMcp, openSquadAgentClient } from "../lib/squad-agent-client";
import { maxSquadToolBytes } from "../lib/squad-visor-client";

async function readArtifactArguments() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxSquadToolBytes) throw Error("Artifact request too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

async function main() {
  const [config, mode, operation, ...extra] = process.argv.slice(2);
  if (!config || extra.length || (mode === "submit" ? !operation : !["mcp", "resume", "publish"].includes(mode) || !!operation)) {
    throw Error("Usage: s3rch-squad-agent CONFIG submit OPERATION_ID | CONFIG mcp | CONFIG resume | CONFIG publish");
  }
  const client = openSquadAgentClient(config);
  if (mode === "submit") {
    process.stdout.write((await client.submit(operation)) + "\n");
    return;
  }
  if (mode === "resume" || mode === "publish") {
    const invoke = client.artifacts?.[mode];
    if (!invoke) throw Error("Artifact tools unavailable");
    process.stdout.write(JSON.stringify(await invoke(await readArtifactArguments())) + "\n");
    return;
  }
  const closed = new AbortController();
  const dispatch = createSquadAgentMcp(client.submit, client.artifacts, closed.signal);
  const pending = new Set<Promise<void>>();
  process.stdin.setEncoding("utf8");
  let line = "";
  for await (const chunk of process.stdin) {
    const frames = (line + String(chunk)).split("\n");
    line = frames.pop() ?? "";
    if (Buffer.byteLength(line) > maxSquadToolBytes) throw Error("MCP frame too large");
    for (const frame of frames) {
      if (Buffer.byteLength(frame) > maxSquadToolBytes || pending.size >= 64) throw Error("MCP input exceeds limits");
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
