import { createServer } from "node:net";
import { listenForumReporter } from "../lib/forum-reporter-socket";
import { openVisorForumReporter } from "../lib/forum-visor-reporter";

async function main() {
  const [config, ...extra] = process.argv.slice(2);
  if (!config || extra.length) throw Error("Visor reporter configuration required");
  const reporter = openVisorForumReporter(config);
  let active = false;
  const server = createServer(socket => {
    socket.on("error", () => socket.destroy());
    if (active) {
      socket.destroy();
      return;
    }
    active = true;
    const cancelled = new AbortController();
    socket.once("close", () => cancelled.abort());
    socket.once("end", () => cancelled.abort());
    socket.setTimeout(10000, () => socket.destroy());
    const chunks: Buffer[] = [];
    let bytes = 0, dispatched = false;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      const boundary = chunk.indexOf(10);
      if (bytes > 65_536 || dispatched || (boundary !== -1 && boundary !== chunk.length - 1)) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (boundary === -1) return;
      dispatched = true;
      void Promise.resolve().then(() => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
        return reporter.report(JSON.parse(text), cancelled.signal);
      })
        .then(result => socket.end(result ? JSON.stringify(result) + "\n" : "ok\n"), () => socket.end("refused\n"))
        .finally(() => { active = false; });
    });
    socket.once("close", () => { if (!dispatched) active = false; });
  });
  server.on("error", () => {
    process.stderr.write("Visor forum reporter socket unavailable.\n");
    process.exitCode = 1;
  });
  await listenForumReporter(server, reporter.socket);
}

void main().catch(() => {
  process.stderr.write("Visor forum reporter configuration unavailable.\n");
  process.exitCode = 1;
});
