import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForumDrawerRecords } from "../components/ForumDrawerRecords";
import { createForumAuthority } from "./identity/forum-authority";
import doc from "./identity/vectors/forums.json";

test("unverified drawer renders status-only and cannot publish or substitute sample detail", () => {
  const authority = createForumAuthority({ keys: [], pinnedIssuers: [],
    policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] } });
  const html = renderToStaticMarkup(createElement(ForumDrawerRecords, {
    forum: doc.forumId, agent: doc.seaPubkey, authority, gun: null,
    viewerKey: doc.seaPubkey, active: true, getPair: () => null,
  }));
  assert.match(html, /Only status data is available/);
  assert.match(html, /No writable destinations are available/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Publish/);
  assert.doesNotMatch(html, /<li[ >]|sample operator|waypoint|incident #42/);
});
