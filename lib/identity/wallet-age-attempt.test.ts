import test from 'node:test';
import assert from 'node:assert/strict';
import { walletAgeAttempt } from './wallet-age-attempt';
test('age continuation verifies the original proof without a second wallet prompt', async () => {
  const attempt = walletAgeAttempt(); let signatures = 0;
  const proofs: unknown[] = [];
  const input = { key: 'https://s3r.ch:wallet:1', ageConfirmed: false,
    sign: async () => ({ message: 'nonce-bound SIWE', signature: String(++signatures) }),
    verify: async (proof: unknown, age: boolean) => { proofs.push(proof); return age ? {} : { error: 'age-confirmation-required' }; } };
  await attempt.submit(input);
  await attempt.submit({ ...input, ageConfirmed: true });
  assert.equal(signatures, 1); assert.equal(proofs[0], proofs[1]);
  await attempt.submit({ ...input, ageConfirmed: true });
  assert.equal(signatures, 2, 'successful proof is not retained');
});
test('account, origin, chain changes and explicit cleanup discard pending proof', async () => {
  for (const changed of ['other-account', 'other-chain', 'other-origin', 'cleanup']) {
    const attempt = walletAgeAttempt(); let signatures = 0;
    const input = { key: 'original', ageConfirmed: false,
      sign: async () => ({ message: 'SIWE', signature: String(++signatures) }),
      verify: async () => ({ error: 'age-confirmation-required' }) };
    await attempt.submit(input);
    if (changed === 'cleanup') attempt.clear();
    await attempt.submit({ ...input, key: changed === 'cleanup' ? 'original' : changed, ageConfirmed: true });
    assert.equal(signatures, 2);
  }
});
test('expired nonce is reported without silently requesting another signature', async () => {
  const attempt = walletAgeAttempt(); let signatures = 0;
  const input = { key: 'same', ageConfirmed: false,
    sign: async () => ({ message: 'SIWE', signature: String(++signatures) }),
    verify: async () => ({ error: 'age-confirmation-required' }) };
  await attempt.submit(input);
  const result = await attempt.submit({ ...input, ageConfirmed: true, verify: async () => ({ error: 'Nonce cookie is invalid or expired.' }) });
  assert.match(result.error, /expired/); assert.equal(signatures, 1);
  await attempt.submit(input); assert.equal(signatures, 2);
});
