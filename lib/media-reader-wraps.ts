import { openItemDekReaderWrap, wrapItemDekToReaders, type ItemReaderWrap, type ItemWrapContext } from "sociacl-ids";
import { openMedia, sealMedia, type MediaBinding } from "./media-crypto";

export type MediaReader = Readonly<{ account: string; pub: string; identityPub: string; epub: string }>;

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid media grant material");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(name => typeof name !== "string" || !keys.includes(name))) throw Error("Invalid media grant material");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !("value" in field)) throw Error("Invalid media grant material");
    result[key] = field.value;
  }
  return result;
}
function list(input: unknown): unknown[] {
  if (!Array.isArray(input)) throw Error("Invalid media readers");
  const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<string, PropertyDescriptor>;
  const size = descriptors.length?.value;
  if (!Number.isSafeInteger(size) || size < 0 || size > 64 || Reflect.ownKeys(descriptors).length !== size + 1) throw Error("Invalid media readers");
  return Array.from({ length: size }, (_, index) => {
    const field = descriptors[String(index)];
    if (!field || !("value" in field)) throw Error("Invalid media readers");
    return field.value;
  });
}
function scope(binding: MediaBinding, expected: ItemWrapContext) {
  const address = record(binding, ["tenant", "object"]), epoch = record(expected, ["epoch", "object", "revisionId"]);
  if (typeof address.tenant !== "string" || typeof address.object !== "string" || epoch.object !== address.object ||
      typeof epoch.epoch !== "number" || !Number.isSafeInteger(epoch.epoch) || epoch.epoch < 0 || Object.is(epoch.epoch, -0) ||
      typeof epoch.revisionId !== "string" || !/^[a-f0-9]{64}$/.test(epoch.revisionId)) throw Error("Invalid media grant material");
  return { binding: Object.freeze({ tenant: address.tenant, object: address.object }),
    expected: Object.freeze({ epoch: epoch.epoch, object: address.object, revisionId: epoch.revisionId }) };
}

/** Call only after Check and fresh epoch status authorize the supplied enrolled
 * readers. Store bytes through the object-store interface; keep wraps inside
 * confidential grant material, never public post metadata or provider URLs. */
export async function sealMediaForReaders(plaintext: Uint8Array, binding: MediaBinding, expected: ItemWrapContext,
  readers: readonly MediaReader[], named: readonly string[]) {
  const saved = scope(binding, expected);
  const recipients = list(readers).map(value => {
    const copy = record(value, ["account", "pub", "identityPub", "epub"]);
    if (Object.values(copy).some(field => typeof field !== "string")) throw Error("Invalid media readers");
    return Object.freeze(copy);
  });
  if (!recipients.length) throw Error("At least one media reader is required");
  const authorized = list(named);
  if (authorized.some(value => typeof value !== "string")) throw Error("Invalid media readers");
  const sealed = await sealMedia(plaintext, saved.binding);
  try {
    const result = await wrapItemDekToReaders(sealed.key, saved.expected, recipients, authorized);
    if (!result.ok) throw Error("Media reader wrapping refused");
    return Object.freeze({ bytes: sealed.bytes, sha256: sealed.sha256, wraps: result.value });
  } finally { sealed.key.fill(0); }
}

/** This verifies ciphertext and wrapping, not entitlement. The caller must
 * supply the currently authorized object/epoch/revision before opening. */
export async function openMediaForReader(stored: Uint8Array, sha256: string, wrap: ItemReaderWrap,
  epriv: string, epub: string, binding: MediaBinding, expected: ItemWrapContext): Promise<Uint8Array> {
  const saved = scope(binding, expected);
  const opened = await openItemDekReaderWrap(wrap, epriv, epub, saved.expected);
  if (!opened.ok) throw Error("Media reader wrapping refused");
  try { return await openMedia(stored, sha256, opened.value, saved.binding); }
  finally { opened.value.fill(0); }
}
