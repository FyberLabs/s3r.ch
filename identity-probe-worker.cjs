// Runs the blocking identity storage check off the main thread.
const { parentPort } = require("node:worker_threads");

try {
  require("./identity-storage.cjs").assertIdentityStorage();
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
// The blob bridge worker keeps this thread alive; end it once the answer is sent.
process.exit(0);
