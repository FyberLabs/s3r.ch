import assert from 'node:assert/strict';
import {test} from 'node:test';
import {contactText} from './contact-inbox-view';
test('contact drafts enforce UTF-8 bounds and reject malformed/control text',()=>{
  assert.equal(contactText('  hello\nthere  '),'hello\nthere');
  assert.equal(contactText('é'.repeat(512)).length,512);
  for(const input of ['', '  ', 'é'.repeat(513), '\ud800', 'a\u0000b'])assert.throws(()=>contactText(input));
});
