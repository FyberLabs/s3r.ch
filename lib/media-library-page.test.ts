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

test("sharing recovery starts as an explicit action without private recipient data",()=>{
  const html=renderToStaticMarkup(createElement(PrivateMediaLibrary,{tenant:"11111111-1111-4111-8111-111111111111"}));
  assert.match(html,/Check saved sharing/);assert.doesNotMatch(html,/Pending sharing with|Resume sharing|Recipient SEA account/);
});

test("group command recovery starts disabled until the current catalog principal is loaded",()=>{
  const html=renderToStaticMarkup(createElement(PrivateMediaLibrary,{tenant:"11111111-1111-4111-8111-111111111111"}));
  assert.match(html,/Group change recovery/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>Check saved group change<\/button>/);
  assert.doesNotMatch(html,/Retry saved group change|Clear reconciled group request|set_p_/);
});

test("group discovery starts without revealing invitations or enabling member writes",()=>{
 const html=renderToStaticMarkup(createElement(PrivateMediaLibrary,{tenant:"11111111-1111-4111-8111-111111111111"}));
 assert.match(html,/Groups and invitations/);assert.match(html,/<button[^>]*disabled=""[^>]*>Refresh groups<\/button>/);
 assert.doesNotMatch(html,/Accept group invitation|Leave group|set_p_/);
});

test("empty group creation starts disabled and explains that it shares no files",()=>{
 const html=renderToStaticMarkup(createElement(PrivateMediaLibrary,{tenant:"11111111-1111-4111-8111-111111111111"}));
 assert.match(html,/<button[^>]*disabled=""[^>]*>Create empty group<\/button>/);
 assert.match(html,/does not share it/);assert.doesNotMatch(html,/Member SEA account|Withdraw invitation/);
});
