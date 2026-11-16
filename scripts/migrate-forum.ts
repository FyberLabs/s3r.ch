/** Run only in the old owner after writes are quiesced, before enabling blob mode. */
import { readFileSync } from "node:fs";
import { configuredForumBlobClient, configuredAdmissions, admitForumOwners, migrateForum } from "../lib/forum-blob";
async function main() {
const [source] = process.argv.slice(2);
if (!source || process.argv.length !== 3) throw new Error("Usage: tsx scripts/migrate-forum.ts SOURCE.json");
const client = configuredForumBlobClient();
try {
  if(source==="--admit-owners") admitForumOwners(client,configuredAdmissions());
  else migrateForum(client, JSON.parse(readFileSync(source, "utf8")),configuredAdmissions());
}
finally { await client.close?.(); }

}
main().catch(() => { console.error("Forum migration did not confirm success; inspect the destination before retrying."); process.exitCode = 1; });
