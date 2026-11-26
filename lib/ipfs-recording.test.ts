import assert from "node:assert/strict";
import test from "node:test";
import { rawMediaBlockCid } from "./ipfs-media-blocks";
import { openIpfsRecording, uploadIpfsRecording } from "./ipfs-recording";

const binding = { tenant: "11111111-1111-4111-8111-111111111111",
  object: "media_p_" + "a".repeat(128) + "_" + "b".repeat(32) };

function fixture() {
  const blocks = new Map<string, Uint8Array>();
  const origins: string[] = [];
  const transport: typeof fetch = async (request, init) => {
    const url = new URL(String(request));
    origins.push(url.origin);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    if (url.pathname.endsWith("/put")) {
      const body = init?.body as FormData;
      const bytes = new Uint8Array(await (body.get("file") as Blob).arrayBuffer());
      const cid = await rawMediaBlockCid(bytes);
      blocks.set(cid, bytes);
      return Response.json({ Key: cid, Size: bytes.byteLength });
    }
    const bytes = blocks.get(url.searchParams.get("arg") ?? "");
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  };
  const options = { endpoint: "https://writer.invalid", binding, signal: new AbortController().signal, transport };
  return { blocks, origins, options };
}

test("recording descriptor carries a private manifest and key, while the provider sees ciphertext", async () => {
  const f = fixture();
  const recording = new TextEncoder().encode("synthetic recording");
  const descriptor = await uploadIpfsRecording(recording, "audio/webm", f.options);
  assert.equal(f.blocks.size, 1);
  const [stored] = [...f.blocks.values()];
  assert.notDeepEqual(stored, recording);
  assert.equal(new TextDecoder().decode(descriptor).includes("writer.invalid"), false);
  const opened = await openIpfsRecording(descriptor, { ...f.options, endpoint: "https://reader.invalid" });
  assert.deepEqual(opened, { bytes: recording, mediaType: "audio/webm" });
  assert.deepEqual(f.origins, ["https://writer.invalid", "https://reader.invalid"]);
});

test("invalid or unavailable IPFS recordings never switch to an alternate route", async () => {
  const f = fixture();
  await assert.rejects(uploadIpfsRecording(new Uint8Array([1]), "image/png", f.options));
  await assert.rejects(openIpfsRecording(new TextEncoder().encode('{"endpoint":"https://other.invalid"}'), f.options));
  assert.deepEqual(f.origins, []);
  const descriptor = await uploadIpfsRecording(new Uint8Array([1]), "video/webm", f.options);
  f.blocks.clear();
  await assert.rejects(openIpfsRecording(descriptor, f.options));
  assert.deepEqual(f.origins, ["https://writer.invalid", "https://writer.invalid"]);
});
