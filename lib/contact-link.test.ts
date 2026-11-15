import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contactHref,contactTarget} from './contact-link';
import fixture from './identity/vectors/contact-acceptance.json';
test('directed forum navigation selects only the account in the shared inbox',()=>{
 const peer=fixture.genesis.principal,href=contactHref(peer)!;
 assert.equal(href.split('#')[0],'/contacts');assert.equal(contactTarget(href.slice(href.indexOf('#'))),peer);
 assert.equal(contactHref('https://attacker.example'),null);assert.equal(contactTarget('#to=invalid&message=private'), '');
 assert.equal(contactTarget('#to='+encodeURIComponent(peer)+'&message=private'),peer);
});
