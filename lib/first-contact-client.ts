/** Browser consumer composition. Discovery/history and user decisions remain explicit. */
import { acceptFirstContactRequest, prepareFirstContactSubmission, pollFirstContact, restorePendingFirstContacts, type FirstContactSenderState } from 'sociacl-ids/first-contact';
import type { ContactLaneIssuerState } from 'sociacl-ids/contact-lane';
import type { PrincipalId } from 'sociacl-ids';
import type { FirstContactFloor } from 'sociacl-ids/first-contact-floor';
import type { FirstContactStore } from 'sociacl-ids/first-contact-store';
import { createFirstContactTransport } from './contact-lane-transport';

/** Bind only the configured Spanopticon origin. No URL comes from a descriptor or
 * ciphertext response. A prepared send must be retained for exact-byte retries.
 * This API does not publish descriptors, deliver grants or acknowledge outbox rows. */
export function createFirstContactClient(spanopticonOrigin: string, fetcher: typeof fetch = fetch) {
  const transport = createFirstContactTransport(spanopticonOrigin, fetcher);
  return Object.freeze({
    /** Explicit acceptance commits the confidential grant before returning it.
     * The issuer callback must supply the restored keyring and fresh authority;
     * it must throw after lock. A held SEA pair alone is insufficient. Delivery
     * failure must resume the committed outbox, never accept a second time. */
    accept(store: FirstContactStore, replayKey: string, requestId: string,
      recipientEpriv: string, senderState: FirstContactSenderState, issuerState: ContactLaneIssuerState) {
      return acceptFirstContactRequest(store, replayKey, requestId, recipientEpriv, senderState, issuerState);
    },
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
