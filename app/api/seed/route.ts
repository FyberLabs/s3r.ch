import { authorizeSeed } from "@/lib/auth";
import { seedPublicGraph } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!authorizeSeed(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const report = await seedPublicGraph();
    const empty = report.sourcesOk === 0 && report.written === 0;
    return Response.json(
      {
        seededAt: report.seededAt,
        sourcesOk: report.sourcesOk,
        sourcesTried: report.sourcesTried,
        written: report.written,
        error: report.error,
      },
      { status: empty && report.error ? 503 : 200 },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Seed failed.",
        written: 0,
      },
      { status: 500 },
    );
  }
}
