// Route component contracts; deployed HTTP checks run in the CI image job.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Privacy from "../app/privacy/page";
import Terms from "../app/terms/page";
import { SiteFooter } from "../components/SiteFooter";
test("legal pages identify the operator, effective date and adult-only service",()=>{
  for(const component of [Privacy,Terms]){
    const html=renderToStaticMarkup(createElement(component));
    assert.match(html,/Fyber Labs TN LLC/);assert.match(html,/Effective date: November 13, 2026/);assert.match(html,/under 18/);
    assert.doesNotMatch(html,/TEST offering|test-only service|Fyber Labs LLC/);
  }
});
test("privacy covers the disclosed data flows and consumer rights",()=>{
  const html=renderToStaticMarkup(createElement(Privacy));
  for(const text of ["Categories, sources and purposes","Recipients and disclosures","Retention by category","California privacy rights",
    "Virginia privacy rights and appeals","Request methods, verification and authorized agents","Global Privacy Control, Do Not Track and browser storage",
    "WalletConnect","Coinbase","SIWE","Cloudflare","Azure","Hypermesh","Spanopticon","45 calendar days","60 days","opt-in consent"])
    assert.ok(html.includes(text),text);
  assert.match(html,/mailto:legal@s3r.ch/);assert.match(html,/Privacy%20appeal/);
});
test("shared footer exposes legal and contact links without sign-in",()=>{
  const html=renderToStaticMarkup(createElement(SiteFooter));
  assert.match(html,/href="\/privacy"[^>]*>Privacy Policy/);assert.match(html,/href="\/terms"[^>]*>Terms of Use/);
  assert.match(html,/mailto:legal@s3r.ch/);
});
