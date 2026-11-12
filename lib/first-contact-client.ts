/** Browser consumer composition. Discovery/history and user decisions remain explicit. */
import { prepareFirstContactSubmission, pollFirstContact, restorePendingFirstContacts, type FirstContactSenderState } from 'sociacl-ids/first-contact';
import type { PrincipalId } from 'sociacl-ids';
import type { FirstContactFloor } from 'sociacl-ids/first-contact-floor';
import type { FirstContactStore } from 'sociacl-ids/first-contact-store';
import { createFirstContactTransport } from './contact-lane-transport';

/** Bind only the configured Spanopticon origin. No URL comes from a descriptor or
 * ciphertext response. A prepared send must be retained for exact-byte retries.
 * This API does not publish descriptors, accept contacts or acknowledge grants. */
export function createFirstContactClient(spanopticonOrigin: string, fetcher: typeof fetch = fetch) {
  const transport = createFirstContactTransport(spanopticonOrigin, fetcher);
  return Object.freeze({
    async prepare(request: unknown, descriptor: unknown, recipient: PrincipalId,
      floor: FirstContactFloor, recipientState: FirstContactSenderState, senderState: FirstContactSenderState) {
      const prepared = await prepareFirstContactSubmission(request, descriptor, recipient, floor, recipientState, senderState);
      return Object.freeze({ ciphertextId: prepared.ciphertextId,
        submit: (timeoutMs?: number) => prepared.submit(transport.append, timeoutMs) });
    },
    /** Reauthenticate the retained inbox without a network read or a new admission. */
    restorePending(store: FirstContactStore, recipientEpriv: string, senderState: FirstContactSenderState) {
      return restorePendingFirstContacts(store, recipientEpriv, senderState);
    },
    poll(store: FirstContactStore, recipientEpriv: string, senderState: FirstContactSenderState, timeoutMs?: number) {
      return pollFirstContact(store, transport.read, recipientEpriv, senderState, timeoutMs);
    },
  });
}
