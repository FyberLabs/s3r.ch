/** Read bounded UTF-8 and stop its stream when the request is cancelled. */
export async function readBoundedIdentityText(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  if (!response.body || !Number.isSafeInteger(maximum) || maximum < 1) throw Error("Invalid identity response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw Error("Identity response too large"); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

export async function readBoundedIdentityJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  return JSON.parse(await readBoundedIdentityText(response, maximum, signal));
}
