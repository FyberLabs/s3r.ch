/** Keep the signed first-login attempt only in memory while age is confirmed. */
export type WalletProof = { message: string; signature: string };
export function walletAgeAttempt() {
  let held: { key: string; proof: WalletProof } | undefined;
  return {
    clear() { held = undefined; },
    async submit<T extends { error?: string }>(input: {
      key: string;
      ageConfirmed: boolean;
      sign: () => Promise<WalletProof>;
      verify: (proof: WalletProof, ageConfirmed: boolean) => Promise<T>;
    }): Promise<T> {
      const previous = held;
      held = undefined;
      // Only an explicit age continuation can reuse an attempt. The server
      // still checks signature, nonce cookie, host and expiry on every request.
      const proof = input.ageConfirmed && previous?.key === input.key
        ? previous.proof : await input.sign();
      const result = await input.verify(proof, input.ageConfirmed);
      if (result.error === 'age-confirmation-required') held = { key: input.key, proof };
      return result;
    },
  };
}
