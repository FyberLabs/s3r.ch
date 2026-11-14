// Render contracts run in CI; authenticated browser acceptance is separate.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateMediaLibrary } from "../components/PrivateMediaLibrary";
import MediaPage from "../app/media/page";
test("media page starts without private catalog entries, plaintext or automatic loads",()=>{
  const html=renderToStaticMarkup(createElement(PrivateMediaLibrary,{tenant:"11111111-1111-4111-8111-111111111111"}));
  assert.match(html,/>My media</);assert.match(html,/Refresh my media/);assert.match(html,/Refresh pending cleanup/);
  assert.doesNotMatch(html,/blob:|Open image|Next page|media_p_/);
});
test("missing or malformed tenant disables private media actions",()=>{
  const original=process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;
  try {
    for(const value of [undefined,"private-config-invalid"]) {
      if(value===undefined)delete process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;else process.env.S3RCH_MEDIA_STORAGE_TENANT_ID=value;
      const html=renderToStaticMarkup(MediaPage());
      assert.match(html,/Private media is not available/);assert.doesNotMatch(html,/Refresh my media|private-config-invalid/);
    }
  } finally {
    if(original===undefined)delete process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;else process.env.S3RCH_MEDIA_STORAGE_TENANT_ID=original;
  }
});

test("private upload UI requires explicit actions and describes recovery and settlement",()=>{
  const html=renderToStaticMarkup(createElement(PrivateMediaLibrary,{tenant:"11111111-1111-4111-8111-111111111111"}));
  assert.match(html,/Upload privately/);assert.match(html,/Check pending upload/);
  assert.match(html,/one-hour settlement/);assert.match(html,/encrypted recovery draft/);
  assert.doesNotMatch(html,/Resume this upload|Discard local recovery draft|private.png/);
});
