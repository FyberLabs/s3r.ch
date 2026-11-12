import { parseCrashReport, type CrashReport } from "./crash-report";
export async function ingestCrash(request: Request, record: (kind: "browser-crash", report: CrashReport) => boolean): Promise<Response> {
  const reply = (status: number) => new Response(null, {status,headers:{"Cache-Control":"no-store"}});
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      request.headers.get("content-type")?.split(";",1)[0].trim() !== "application/json") return reply(403);
  if (!request.body) return reply(400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 1024) throw Error();
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    };
    const value = await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error()), 2000); })]);
    const report = parseCrashReport(value);
    if (!report) return reply(400);
    return reply(record("browser-crash",report) ? 204 : 429);
  } catch { return reply(400); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
