import { createSquadAgentMcp, openSquadAgentClient } from "../lib/squad-agent-client";
import { generateSquadAgentKey, openSquadAgentIdentity } from "../lib/squad-agent-identity";
import { SQUAD_ARTIFACT_BYTES, SQUAD_ARTIFACT_FRAME_BYTES } from "../lib/squad-agent-artifacts";

async function readToolInput() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > SQUAD_ARTIFACT_BYTES) throw Error("Squad tool input exceeds its limit");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

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
  const usesOperation = mode === "submit" || mode === "resume" || mode === "publish";
  if (!config || extra.length || (usesOperation ? !operation : mode !== "mcp" || !!operation)) {
    throw Error("Usage: s3rch-squad-agent CONFIG submit|resume|publish OPERATION_ID | CONFIG mcp | IDENTITY_CONFIG session | KEY_FILE keygen");
  }
  const client = openSquadAgentClient(config);
  if (mode === "submit") {
    process.stdout.write((await client.submit(operation)) + "\n");
    return;
  }
  if (mode === "resume" || mode === "publish") {
    if (!client.artifacts) throw Error("Managed Squad artifacts unavailable");
    const input = await readToolInput();
    process.stdout.write(await client.artifacts[mode](operation, input));
    return;
  }
  const closed = new AbortController();
  const dispatch = createSquadAgentMcp(client.submit, client.artifacts, closed.signal);
  const pending = new Set<Promise<void>>();
  const frameLimit = client.artifacts ? SQUAD_ARTIFACT_FRAME_BYTES : 8192;
  process.stdin.setEncoding("utf8");
  let line = "";
  for await (const chunk of process.stdin) {
    const frames = (line + String(chunk)).split("\n");
    line = frames.pop() ?? "";
    if (Buffer.byteLength(line) > frameLimit) throw Error("MCP frame too large");
    for (const frame of frames) {
      if (Buffer.byteLength(frame) > frameLimit || pending.size >= 64) throw Error("MCP input exceeds limits");
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
