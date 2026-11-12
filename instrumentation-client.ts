import { createBrowserReporter } from "./lib/browser-crash-report";
const report = createBrowserReporter();
// Do not read event.error, reason, URL, stack, cookies or user identifiers.
window.addEventListener("error", () => report("browser-error"));
window.addEventListener("unhandledrejection", () => report("unhandled-rejection"));
window.addEventListener("s3rch:render-error", () => report("render-error"));
