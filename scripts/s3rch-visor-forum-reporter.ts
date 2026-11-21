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
    let text = "", dispatched = false;
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 4096 || dispatched) {
        socket.destroy();
        return;
      }
      if (!text.endsWith("\n")) return;
      dispatched = true;
      void Promise.resolve().then(() => reporter.report(JSON.parse(text), cancelled.signal))
        .then(() => socket.end("ok\n"), () => socket.end("refused\n"))
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
