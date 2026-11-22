import { once } from "node:events";
import { lstatSync, unlinkSync } from "node:fs";
import { createConnection, type Server } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { privateBotDirectory } from "./forum-bot-local-access";

async function stale(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(path);
    peer.once("connect", () => { peer.destroy(); resolve(false); });
    peer.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(true);
      else reject(error);
    });
    peer.setTimeout(750, () => { peer.destroy(); reject(Error("Reporter socket probe timed out")); });
  });
}

export async function listenForumReporter(server: Server, path: string) {
  const directory = dirname(path);
  privateBotDirectory(directory);
  // SQLite releases this interprocess startup lock on process exit. A second
  // reporter cannot race a stale unlink with another reporter's new listener.
  const startup = new DatabaseSync(join(directory, "reporter-startup.sqlite"), { timeout: 1000 });
  try {
    startup.exec("BEGIN EXCLUSIVE");
    const existing = (() => {
      try { return lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    })();
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid!() || !await stale(path)) {
        throw Error("Reporter socket is already in use");
      }
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.dev === existing.dev && current.ino === existing.ino) unlinkSync(path);
    }
    const listening = once(server, "listening");
    server.listen(path);
    await listening;
    startup.exec("COMMIT");
  } finally {
    startup.close();
  }
}
