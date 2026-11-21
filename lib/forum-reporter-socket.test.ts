import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listenForumReporter } from "./forum-reporter-socket";

test("a restarted reporter replaces a stale socket and preserves a live reporter", { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "visor-reporter-"));
  const path = join(dir, "reporter.sock");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e",
    "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))", path],
  { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.ok(lstatSync(path).isSocket());

  const server = createServer(socket => socket.destroy());
  await listenForumReporter(server, path);
  try {
    const inode = lstatSync(path).ino;
    await assert.rejects(listenForumReporter(createServer(), path), /already in use/);
    assert.equal(lstatSync(path).ino, inode);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
