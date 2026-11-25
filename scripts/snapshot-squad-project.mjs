import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import postcss from "postcss";
import { renderPartnerPreview } from "../lib/partner-preview-html.ts";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
  throw Error("The Squad snapshot uses the isolated PR CI browser.");
}

const forum = "fixture-partner-squad";
const ids = Object.fromEntries(["task", "root", "node", "brief", "draft", "edit", "delivery", "preview", "firstPreview", "secondPreview"].map((key, index) =>
  [key, `10000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`]));
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
const pricing = { quantity: 10, unitPriceCents: 12_000, discountBps: 1000 };
const pricingRevision = { ...edit, inputs: pricing, formula: "ROUND(B2*B3*(1-B4),2)" };
const workbookResponse = { canRevise: true, canReview: true, workbook: {
  id: ids.task, taskId: ids.task, sheet: "Pricing", totalCell: "B5", current: ids.edit, history: [draft, edit],
  selected: pricingRevision, totalCents: 108_000, comments: [],
} };
const copy = { title: "Partner pilot", summary: "Start with 10 seats for 30 days.",
  highlights: ["Confirm the rollout scope with the partner."], nextStep: "Schedule the pilot kickoff." };
const previewRevision = (id, version, cents, inputs) => ({ ...draft, id, title: copy.title, nextStep: copy.nextStep,
  html: renderPartnerPreview(copy, cents),
  inputs: { brief: { artifactId: ids.brief, revisionId: version.id, author: version.author },
    workbook: { artifactId: ids.task, revisionId: version.id, author: version.author, sheet: "Pricing", cell: "B5",
      assumptions: inputs, cents } },
});
const firstPreview = previewRevision(ids.firstPreview, draft, 120_000, { ...pricing, discountBps: 0 });
const secondPreview = previewRevision(ids.secondPreview, edit, 108_000, pricing);
const workbookAt = id => id === ids.draft ? { ...workbookResponse, workbook: { ...workbookResponse.workbook,
  totalCents: 120_000, selected: { ...draft, inputs: firstPreview.inputs.workbook.assumptions, formula: pricingRevision.formula } } }
  : workbookResponse;
const previewAt = id => {
  const older = id === firstPreview.id;
  return { preview: { id: ids.preview, taskId: ids.task, owner, current: secondPreview.id,
    selected: older ? firstPreview : secondPreview, history: [firstPreview, secondPreview],
    newerBrief: older, newerWorkbook: older } };
};
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
    const { action, revisionId } = route.request().postDataJSON();
    const json = action === "board" ? board : action === "workbook-read" ? workbookAt(revisionId)
      : action === "preview-read" ? previewAt(revisionId) : briefResponse;
    return route.fulfill({ json });
  });
  await page.goto(`${origin}/?task=${ids.task}`);
  await page.getByRole("button", { name: "Download Markdown" }).waitFor();
  const discount = page.getByLabel("B4 · Discount (%)");
  await discount.fill("20");
  await page.getByText("$960.00", { exact: true }).waitFor();
  await discount.fill("10");
  await page.getByText("$1,080.00", { exact: true }).waitFor();
  const previewFrame = page.locator('iframe[title="Private partner one-pager"]');
  await previewFrame.waitFor();
  assert.equal(await previewFrame.getAttribute("sandbox"), "");
  const previewDocument = page.frameLocator('iframe[title="Private partner one-pager"]');
  const quote = previewDocument.locator("#quote");
  await quote.filter({ hasText: "$1,080.00" }).waitFor();
  assert.equal(await previewDocument.locator("script, form, iframe, a, img, link").count(), 0);
  await page.getByLabel("Preview revision").selectOption(ids.firstPreview);
  await quote.filter({ hasText: "$1,200.00" }).waitFor();
  await page.getByText("A newer pricing revision is available.", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Pricing!B5 · " + ids.draft }).click();
  await page.getByLabel("Pricing revision").waitFor();
  assert.equal(await page.getByLabel("Pricing revision").inputValue(), ids.draft);
  await page.goto(`${origin}/?task=${ids.task}`);
  await page.frameLocator('iframe[title="Private partner one-pager"]').getByText("$1,080.00", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(process.env.RUNNER_TEMP, "squad-partner-brief.png"), fullPage: true });
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
