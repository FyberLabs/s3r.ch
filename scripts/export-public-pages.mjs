// Produce only browser-facing documents and dependencies from a production build.
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const output = ".next/public-pages";
const staging = await mkdtemp(".next/public-pages-");
try {
  const manifest = JSON.parse(await readFile(".next/prerender-manifest.json", "utf8"));
  // Explicit allowlist: adding a prerendered route does not make it public here.
  const routes = ["/", "/features", "/features/groups", "/features/gun", "/features/sociacl",
    "/features/social", "/feed", "/feed/squad", "/forum", "/saved-view", "/views/picker-preview"];
  for (const route of routes) {
    const entry = manifest.routes[route];
    if (entry?.initialRevalidateSeconds !== false) throw Error("Expected static route " + route);
    const name = route === "/" ? "index" : route.slice(1);
    const destination = path.join(staging, name + ".html");
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(".next/server/app", name + ".html"), destination);
  }
  await cp(".next/server/app/_not-found.html", path.join(staging, "404.html"));
  await cp(".next/static", path.join(staging, "_next/static"), { recursive: true });
  for (const asset of ["brand", "favicon.svg", "og.svg"]) {
    await cp(path.join("public", asset), path.join(staging, asset), { recursive: true });
  }
  await writeFile(path.join(staging, "_redirects"),
    "/design / 307\n/views/picker-preview /views/picker-preview 200\n/views/:id /saved-view 200\n");
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} finally {
  await rm(staging, { recursive: true, force: true });
}
