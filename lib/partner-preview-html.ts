export type PreviewCopy = { title: string; summary: string; highlights: string[]; nextStep: string };
export const previewCsp = "default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'";
const encode = (value: string) => value.replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const format = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function renderPartnerPreview(copy: PreviewCopy, cents: number) {
  const title = encode(copy.title);
  const highlights = copy.highlights.map(item => `<li>${encode(item)}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${previewCsp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body{margin:0;background:#f7f4ec;color:#171915;font:1rem/1.5 system-ui,sans-serif}
    main{box-sizing:border-box;max-width:44rem;margin:auto;padding:clamp(1rem,5vw,3rem);overflow-wrap:anywhere}
    h1{font-size:clamp(1.7rem,5vw,2.8rem);line-height:1.12;margin:0 0 1rem}
    p,li{white-space:pre-wrap}
    .quote{background:#eeeadf;padding:0.8rem 1rem;border-left:3px solid #715d00}
    output{display:block;font-size:clamp(1.5rem,5vw,2rem);font-weight:bold}
    h2{font-size:1.05rem;margin:1.5rem 0 0.25rem}
  </style>
</head>
<body><main>
  <h1>${title}</h1>
  <p>${encode(copy.summary)}</p>
  ${highlights ? `<ul>${highlights}</ul>` : ""}
  <div class="quote"><span>Quote total (USD)</span><output id="quote">${format.format(cents / 100)}</output></div>
  <h2>Next step</h2>
  <p>${encode(copy.nextStep)}</p>
</main></body>
</html>
`;
}
