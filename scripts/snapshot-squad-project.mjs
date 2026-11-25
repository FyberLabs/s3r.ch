import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import postcss from "postcss";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
  throw Error("The Squad snapshot uses the isolated PR CI browser.");
}

const forum = "fixture-partner-squad";
const ids = Object.fromEntries(["task", "root", "node", "brief", "draft", "edit", "delivery"].map((key, index) =>
  [key, `10000000-0000-4000-8000-00000000000${index + 1}`]));
const owner = "person-fixture.person";
const agent = "agent-fixture.agent";
const sources = ["https://example.test/partner-notes"];
const board = {
  cursor: 5, canEdit: true, canDelegate: true, bots: [],
  nodes: [{ id: ids.root, parentId: null, title: "Partner pilot" },
    { id: ids.node, parentId: ids.root, title: "Pilot scope" }],
  tasks: [{ id: ids.task, nodeId: ids.node, owner, outcome: "Draft the partner brief", label: "partner-pilot",
    sources, issue: null, revision: 1 }],
  ledger: [{ taskId: ids.task, taskRevision: 0, cursor: 5, requestedBy: owner, delegate: agent, status: "accepted" }],
};
const draft = { id: ids.draft, parent: null, author: agent, createdAt: 1700000060, sources,
  sha256: "1".repeat(64), run: { taskId: ids.task, deliveryId: ids.delivery } };
const edit = { ...draft, id: ids.edit, parent: ids.draft, author: owner, sha256: "2".repeat(64), run: null };
const briefResponse = { canRevise: true, canReview: true, brief: {
  id: ids.brief, taskId: ids.task, format: "markdown", current: ids.edit, history: [draft, edit], annotations: [],
  selected: { ...edit, markdown: "# Partner pilot\n\nWe’ll start with 10 seats for 30 days.\n\n## Next step\nConfirm the proposed scope with the partner." },
} };
const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import { createRoot } from "react-dom/client";
    import { SquadProjectPanel } from "./components/SquadProjectPanel";
    createRoot(document.getElementById("root")).render(<SquadProjectPanel forum={${JSON.stringify(forum)}} />);
  ` },
  external: ["node:module", "crypto", "@peculiar/webcrypto"], bundle: true,
  write: false, jsx: "automatic", platform: "browser", format: "esm",
  define: { "process.env.NODE_ENV": '"production"' },
});
const filename = path.join(process.cwd(), "app/globals.css");
const css = await postcss([tailwind()]).process(await readFile(filename, "utf8"), { from: filename });
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    return response.end(bundle.outputFiles[0].contents);
  }
  if (pathname === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    return response.end(css.css);
  }
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    return response.end('<!doctype html><html data-ground="dark"><head><meta charset="utf-8"><title>Squad partner pilot</title><link rel="stylesheet" href="/style.css"></head><body class="bg-ground text-ink p-6"><main id="root"></main><script type="module" src="/fixture.js"></script></body></html>');
  }
  response.writeHead(404).end();
});
let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1260, height: 980 } });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname !== "/api/squad/pilot/project") return route.continue();
    const action = route.request().postDataJSON().action;
    return route.fulfill({ json: action === "board" ? board : briefResponse });
  });
  await page.goto(`${origin}/?task=${ids.task}`);
  await page.getByRole("button", { name: "Download Markdown" }).waitFor();
  await page.screenshot({ path: path.join(process.env.RUNNER_TEMP, "squad-partner-brief.png"), fullPage: true });
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
