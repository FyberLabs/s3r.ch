import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ForumShell } from '../packages/forum-ui/src/index';

test('portable forum has no implicit navigation or fabricated data source', () => {
  const html = renderToStaticMarkup(createElement(ForumShell, {
    forum: {label:'Squad',href:'https://untrusted.invalid'}, tab:'memory', onTab:()=>{},
    header:null,sidebar:null,controls:null,board:'Board content',list:null,chat:null,
  }));
  assert.ok(!html.includes('href='));
  assert.ok(!html.includes('untrusted.invalid'));
  assert.ok(html.includes('No shared memory'));
  assert.ok(!html.includes('Board content'));
});
