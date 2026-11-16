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

test('portable composer is controlled and supports a disabled native textarea', async () => {
  const { MessageComposer } = await import('../packages/forum-ui/src/index');
  const html = renderToStaticMarkup(createElement(MessageComposer, {
    value:'Retained draft <script>', onChange:()=>{}, onSend:()=>{throw Error('render must not send');},
    disabled:true, rows:4, maxLength:65536, sendLabel:'Send message',
  }));
  assert.ok(html.includes('<textarea'));
  assert.ok(html.includes('Retained draft &lt;script&gt;'));
  assert.ok(html.includes('disabled=""'));
  assert.ok(!html.includes('action='));
  assert.ok(!html.includes('<script>'));
});
